// Service worker. Saves every window continuously, writes backup files, restores, sleeps tabs.
// Holds nothing important in memory: MV3 stops idle workers after ~30 s, so every save is
// written straight to IndexedDB and every schedule lives in chrome.alarms.
import * as db from './lib/db.js';
import {
  DEFAULTS, SAVE_DEBOUNCE_MS, isNoise, STALE_MS, TRASH_DAYS, snapshotFrom, fingerprint, counts, diff, thin,
  findDuplicates, parsePatterns, sleepBlocker, matchGroups, missingTabs, restorable,
  backupJson, backupHtml, backupName, plural,
} from './lib/core.js';
import { APP } from './lib/app.js';
import { unwrap } from './lib/import.js';

const getLocal = async (k, d) => (await chrome.storage.local.get(k))[k] ?? d;
const setLocal = (o) => chrome.storage.local.set(o);
const getSession = async (k, d) => (await chrome.storage.session.get(k))[k] ?? d;
const cfg = async () => ({ ...DEFAULTS, ...(await getLocal('cfg', {})) });

// ---------- boot ----------

// A boot id marks which snapshots belong to this run of Chrome, so the pages can offer
// "the session before Chrome last closed" even when Chrome restored nothing.
async function bootId() {
  let b = await getSession('boot', null);
  if (!b) { b = Date.now(); await chrome.storage.session.set({ boot: b }); }
  return b;
}

chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  await setup();
  // Updates must never cost data: write a full backup file before anything new runs.
  // It is kept apart from the hourly files and never rotated away.
  if (reason === 'update' && (await getLocal('started', false))) {
    await backup({ manual: true, keep: `${APP.folder}/Before update to ${chrome.runtime.getManifest().version} (from ${previousVersion || 'unknown'}).json` }).catch(fail);
  }
  if (reason === 'install') {
    await setLocal({ cfg: { ...DEFAULTS, ...(await getLocal('cfg', {})) } });
    // Store policy: say what is saved and get a yes before the first save.
    chrome.tabs.create({ url: 'welcome.html' });
  }
  queueSave('install');
});
chrome.runtime.onStartup.addListener(async () => { await setup(); queueSave('startup'); });

async function setup() {
  await bootId();
  const a = await chrome.alarms.getAll();
  const want = { tick: 1, backup: 60, tidy: 360 };
  for (const [name, period] of Object.entries(want)) {
    if (!a.find((x) => x.name === name && x.periodInMinutes === period)) {
      chrome.alarms.create(name, { periodInMinutes: period, delayInMinutes: name === 'backup' ? 2 : period });
    }
  }
  chrome.contextMenus.removeAll(() => {
    const m = (id, title, contexts = ['action', 'page']) => chrome.contextMenus.create({ id, title, contexts });
    m('sleep-tab', 'Sleep this tab');
    m('sleep-others', 'Sleep the other tabs in this window');
    m('never-sleep', 'Never sleep this site');
    m('save-window', 'Save this window as a session');
  });
  await chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' });
}

// ---------- saving ----------

let timer = null;
function queueSave() {
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; save().catch(fail); }, SAVE_DEBOUNCE_MS);
}

for (const ev of [
  chrome.tabs.onCreated, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached,
  chrome.tabs.onReplaced, chrome.windows.onCreated, chrome.tabGroups.onCreated,
  chrome.tabGroups.onUpdated, chrome.tabGroups.onRemoved, chrome.tabGroups.onMoved,
]) ev.addListener(() => queueSave());
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.url || info.pinned !== undefined || info.groupId !== undefined || info.title) queueSave();
});
chrome.tabs.onRemoved.addListener((id, info) => { if (!info.isWindowClosing) queueSave(); });
chrome.windows.onBoundsChanged?.addListener(() => queueSave());
chrome.windows.onRemoved.addListener(async (windowId) => {
  // Keep a copy of the closed window in the bin. The last snapshot still has it.
  try {
    const last = await db.newest('snaps');
    const w = last?.data.windows.find((x) => x.id === windowId);
    if (w && w.tabs.length > 1) {
      await db.put('trash', { t: Date.now(), kind: 'window', label: `Closed window, ${plural(w.tabs.length, 'tab')}`, data: { windows: [w] } });
    }
  } catch (e) { fail(e); }
  queueSave();
});

let saving = null;
function save() { return (saving = (saving || Promise.resolve()).then(saveNow, saveNow)); }

async function saveNow() {
  const c = await cfg();
  if (!(await getLocal('started', false))) return;
  const [windows, groups, names] = await Promise.all([
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    chrome.tabGroups.query({}),
    getLocal('names', {}),
  ]);
  const own = chrome.runtime.getURL('');
  const snap = snapshotFrom(windows, groups, { incognito: c.saveIncognito, own });
  // Remember live window ids (for "closed window" recovery) and the names users gave windows.
  let wi = 0;
  for (const w of windows) {
    if (w.type !== 'normal' || (w.incognito && !c.saveIncognito) || !(w.tabs || []).some((t) => !isNoise(t.url || t.pendingUrl, own))) continue;
    snap.windows[wi].id = w.id;
    if (names[w.id]) snap.windows[wi].name = names[w.id];
    wi++;
  }
  const now = Date.now();
  if (!snap.windows.length) { await status({ checked: now }); return; } // Chrome is closing or has nothing open
  const fp = fingerprint(snap);
  const boot = await bootId();
  const last = await db.newest('snaps');
  if (last && last.fp === fp && last.boot === boot) {
    await db.put('snaps', { ...last, data: snap, checked: now }); // same structure: refresh titles in place
  } else {
    await db.put('snaps', { t: now, checked: now, boot, fp, c: counts(snap), d: diff(last?.data, snap), data: snap });
  }
  await status({ saved: now, checked: now, error: '', ...counts(snap) });
}

async function status(patch) {
  const s = { ...(await getLocal('status', {})), ...patch };
  await setLocal({ status: s });
  badge(s);
}

function badge(s) {
  const bad = s.error || (s.checked && Date.now() - s.checked > STALE_MS);
  chrome.action.setBadgeText({ text: bad ? '!' : '' });
  if (bad) chrome.action.setBadgeBackgroundColor({ color: '#C2410C' });
  chrome.action.setTitle({ title: bad ? `${APP.name}: saving has stopped. Open to see why.` : APP.name });
}

function fail(e) {
  console.error(e);
  status({ error: String(e?.message || e).slice(0, 200) }).catch(() => {});
}

// ---------- alarms ----------

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  try {
    if (name === 'tick') {
      await save();
      await sleepPass();
    } else if (name === 'backup') {
      if ((await cfg()).backupOn) await backup();
    } else if (name === 'tidy') {
      await tidy();
    }
  } catch (e) { fail(e); }
});

async function tidy() {
  const snaps = await db.list('snaps', { light: true });
  const drop = thin(snaps);
  if (drop.length) await db.del('snaps', drop);
  const cut = Date.now() - TRASH_DAYS * 86_400_000;
  const old = (await db.list('trash', { light: true })).filter((x) => x.t < cut).map((x) => x.id);
  if (old.length) await db.del('trash', old);
}

// ---------- sleeping ----------

async function sleepPass() {
  const c = await cfg();
  if (!c.sleepOn) return;
  const patterns = parsePatterns(c.sleepExcept);
  const now = Date.now();
  for (const t of await chrome.tabs.query({ discarded: false })) {
    if (!sleepBlocker(t, { now, cfg: c, patterns })) await chrome.tabs.discard(t.id).catch(() => {});
  }
}

async function sleepTabs(tabs) {
  let n = 0;
  for (const t of tabs) {
    if (sleepBlocker(t, { manual: true })) continue;
    if (await chrome.tabs.discard(t.id).catch(() => null)) n++;
  }
  return n;
}

// A tab discarded before its address is committed comes back blank, and would be saved blank.
// So wait until the tab has a real URL and no pending navigation, then sleep it. Give up after 10 s
// and leave it awake: an awake tab costs memory, a blank one costs the page.
async function sleepWhenReady(id) {
  for (let i = 0; i < 40; i++) {
    const t = await chrome.tabs.get(id).catch(() => null);
    if (!t || t.discarded) return;
    if (t.url && t.url !== 'about:blank' && !t.pendingUrl) { await chrome.tabs.discard(id).catch(() => {}); return; }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------- backups ----------

async function backup({ manual = false, keep = null } = {}) {
  await save();
  const last = await db.newest('snaps');
  const sessions = await db.all('sessions');
  if (!last && !sessions.length) return { ok: false, why: 'Nothing saved yet' };
  const json = backupJson({ saved: last?.t ?? Date.now(), snapshot: last?.data, sessions });
  const html = backupHtml(last?.data || { t: Date.now(), windows: [] }, { appName: `${APP.name} backup` });
  const c = await cfg();
  const hide = chrome.downloads.setUiOptions && !manual;
  if (hide) await chrome.downloads.setUiOptions({ enabled: false }).catch(() => {});
  try {
    if (keep) { await download(json, 'application/json', keep); return { ok: true }; }
    const id = await download(json, 'application/json', backupName(APP.folder));
    const htmlId = await download(html, 'text/html', `${APP.folder}/Open me - latest tabs.html`);
    const lastHtml = await getLocal('htmlBackup', null);
    if (lastHtml != null && lastHtml !== htmlId) await chrome.downloads.erase({ id: lastHtml }).catch(() => {}); // history entry only; the file was overwritten
    await setLocal({ htmlBackup: htmlId });
    // A second backup in the same hour overwrites the same file. Forget the older download entry
    // for that path (without touching the file), or rotating it out later would delete the new file.
    const [mine] = await chrome.downloads.search({ id });
    const prior = [];
    for (const old of await getLocal('backups', [])) {
      const [d] = await chrome.downloads.search({ id: old }).catch(() => []);
      if (d && mine && d.filename === mine.filename) await chrome.downloads.erase({ id: old }).catch(() => {});
      else prior.push(old);
    }
    const kept = [id, ...prior].filter((x, i, a) => a.indexOf(x) === i);
    // Only files this extension downloaded can be removed, and only those are touched.
    for (const old of kept.slice(c.backupKeep)) {
      const [d] = await chrome.downloads.search({ id: old }).catch(() => []);
      if (!d || !d.byExtensionId || d.byExtensionId !== chrome.runtime.id) continue;
      await chrome.downloads.removeFile(old).catch(() => {});
      await chrome.downloads.erase({ id: old }).catch(() => {});
    }
    await setLocal({ backups: kept.slice(0, c.backupKeep) });
    await status({ backup: Date.now(), backupError: '' });
    return { ok: true };
  } catch (e) {
    await status({ backupError: String(e?.message || e).slice(0, 200) });
    return { ok: false, why: String(e?.message || e) };
  } finally {
    if (hide) await chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
  }
}

// data: URLs fail somewhere around 1-2 MB, so big backups get a blob URL from an offscreen page
// (a service worker cannot create blob URLs itself).
async function fileUrl(text, type) {
  if (text.length < 800_000) return { url: `data:${type};charset=utf-8,` + encodeURIComponent(text) };
  if (!(await chrome.offscreen.hasDocument?.())) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Create a file URL for a large backup file' });
  }
  const { url } = await chrome.runtime.sendMessage({ to: 'offscreen', type: 'blob', text, mime: type });
  return { url, revoke: () => chrome.runtime.sendMessage({ to: 'offscreen', type: 'revoke', url }).catch(() => {}) };
}

async function download(text, type, filename) {
  const { url, revoke } = await fileUrl(text, type);
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
  await new Promise((resolve, reject) => {
    const on = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') { chrome.downloads.onChanged.removeListener(on); resolve(); }
      if (d.state.current === 'interrupted') { chrome.downloads.onChanged.removeListener(on); reject(new Error(`Backup file failed: ${d.error?.current || 'interrupted'}`)); }
    };
    chrome.downloads.onChanged.addListener(on);
    setTimeout(() => { chrome.downloads.onChanged.removeListener(on); resolve(); }, 15_000);
  }).finally(() => revoke?.());
  return id;
}

// ---------- restore ----------

// payload: { windows: [...] } as saved. into: 'new' opens new windows; a window id adds the
// tabs to that window. Tabs already open there are not opened twice, open groups are reused.
async function restore(payload, { into = 'new', sleep = true, dedupe = true } = {}) {
  const c = await cfg();
  let opened = 0, skipped = 0;
  for (const w of payload.windows) {
    const tabs = w.tabs.filter((t) => restorable(t.url));
    if (!tabs.length) continue;
    let winId, existing = [], openGroups = [];
    if (into === 'new') {
      const create = { url: tabs[0].url, focused: !!w.focused };
      // A private window only ever comes back as a private window; if that is not allowed, skip it.
      if (w.incognito) {
        if (!(await chrome.extension.isAllowedIncognitoAccess())) { skipped += tabs.length; continue; }
        create.incognito = true;
      }
      if (!w.state || w.state === 'normal') for (const k of ['left', 'top', 'width', 'height']) if (Number.isFinite(w[k])) create[k] = w[k];
      const win = await chrome.windows.create(create).catch(() => (w.incognito ? null : chrome.windows.create({ url: tabs[0].url })));
      if (!win) { skipped += tabs.length; continue; }
      winId = win.id;
      existing = win.tabs;
      if (w.name) await setLocal({ names: { ...(await getLocal('names', {})), [winId]: w.name } });
      if (w.state === 'maximized' || w.state === 'fullscreen') await chrome.windows.update(winId, { state: w.state }).catch(() => {});
    } else {
      winId = into;
      const target = await chrome.windows.get(winId).catch(() => null);
      if (!target || !!target.incognito !== !!w.incognito) { skipped += tabs.length; continue; }
      existing = await chrome.tabs.query({ windowId: winId });
      openGroups = await chrome.tabGroups.query({ windowId: winId });
    }
    const todo = into === 'new' ? tabs.slice(1) : dedupe ? missingTabs(tabs, existing, { ignoreHash: c.ignoreHash }) : tabs;
    const made = into === 'new' ? [{ saved: tabs[0], id: existing[0].id }] : [];
    if (into === 'new' && tabs[0].pinned) await chrome.tabs.update(existing[0].id, { pinned: true });
    // Batches keep a 400-tab restore from freezing the machine; each tab is slept as soon as it exists.
    for (let i = 0; i < todo.length; i += 8) {
      const batch = await Promise.all(todo.slice(i, i + 8).map((t) =>
        chrome.tabs.create({ windowId: winId, url: t.url, pinned: !!t.pinned, active: false }).then((tab) => ({ saved: t, id: tab.id }), () => null)));
      for (const m of batch) if (m) made.push(m);
    }
    opened += made.length;
    // Groups: reuse a matching open group, otherwise create one with the saved title, colour and state.
    const reuse = matchGroups(w.groups || [], openGroups);
    for (let gi = 0; gi < (w.groups || []).length; gi++) {
      const ids = made.filter((m) => m.saved.g === gi && !m.saved.pinned).map((m) => m.id);
      if (!ids.length) continue;
      const g = w.groups[gi];
      const gid = await chrome.tabs.group(reuse[gi] != null ? { tabIds: ids, groupId: reuse[gi] } : { tabIds: ids, createProperties: { windowId: winId } }).catch(() => null);
      if (gid != null && reuse[gi] == null) await chrome.tabGroups.update(gid, { title: g.title, color: g.color, collapsed: !!g.collapsed }).catch(() => {});
    }
    const act = made.find((m) => m.saved.active);
    if (act && into === 'new') await chrome.tabs.update(act.id, { active: true }).catch(() => {});
    // Sleep last: Chrome can give a tab a new id when it is discarded, which would break grouping.
    // In a new window the tab in front stays awake; tabs added to an open window all sleep.
    const awake = into === 'new' ? (act || made[0]) : null;
    if (sleep) await Promise.all(made.filter((m) => m !== awake).map((m) => sleepWhenReady(m.id)));
  }
  queueSave();
  return { opened, skipped };
}

// ---------- messages from the popup and library ----------

const handlers = {
  async openWelcome() { await askToStart(); return { ok: true }; },
  async status() {
    const s = await getLocal('status', {});
    return { ...s, started: await getLocal('started', false), boot: await bootId(), stale: !!(s.checked && Date.now() - s.checked > STALE_MS) };
  },
  async saveNow() { await save(); return handlers.status(); },
  async tick() { await save(); await sleepPass(); return { ok: true }; }, // same work as the 1-minute alarm
  async start() { await setLocal({ started: Date.now() }); await save(); return handlers.status(); },
  async backupNow() { return backup({ manual: true }); },
  async restore({ payload, into, sleep }) { return restore(payload, { into, sleep: sleep ?? (await cfg()).restoreAsleep }); },
  // Tabs left behind by a removed suspender or session tool show that tool's dead page, with the
  // real address inside its own URL. Point each one back at its real page.
  async rescue({ dry }) {
    const own = chrome.runtime.getURL('');
    const found = [];
    for (const t of await chrome.tabs.query({})) {
      const at = t.pendingUrl || t.url || ''; // where the tab is going, if it is mid-navigation
      if (!at.startsWith('chrome-extension://') || at.startsWith(own)) continue;
      const real = unwrap(at);
      if (real !== at && /^(https?|file|ftp):/.test(real)) found.push([t.id, real]);
    }
    if (!dry) for (const [id, url] of found) await chrome.tabs.update(id, { url }).catch(() => {});
    return { count: found.length };
  },
  async sleep({ scope, windowId, tabId, groupId }) {
    let tabs = [];
    if (scope === 'tab') tabs = [await chrome.tabs.get(tabId)];
    if (scope === 'others') tabs = (await chrome.tabs.query({ windowId })).filter((t) => !t.active);
    if (scope === 'group') tabs = await chrome.tabs.query({ groupId });
    if (scope === 'all') tabs = await chrome.tabs.query({});
    return { slept: await sleepTabs(tabs) };
  },
  async duplicates() {
    const c = await cfg();
    const tabs = await chrome.tabs.query({});
    return { ids: findDuplicates(tabs, { ignoreHash: c.ignoreHash }) };
  },
  async closeTabs({ ids, label }) {
    // Everything this extension closes goes to the bin first.
    const tabs = (await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
    if (!tabs.length) return { closed: 0 };
    // Kept per window, so undo puts each tab back in the window it came from.
    const byWin = new Map();
    for (const t of tabs) {
      if (!byWin.has(t.windowId)) byWin.set(t.windowId, { id: t.windowId, tabs: [] });
      byWin.get(t.windowId).tabs.push({ url: t.url, title: t.title, ...(t.pinned ? { pinned: true } : {}) });
    }
    await db.put('trash', { t: Date.now(), kind: 'tabs', label: label || `Closed ${plural(tabs.length, 'tab')}`, data: { windows: [...byWin.values()] } });
    await chrome.tabs.remove(tabs.map((t) => t.id));
    return { closed: tabs.length };
  },
  async saveSession({ name, windowId, payload }) {
    if (!payload && !(await getLocal('started', false))) { await askToStart(); return { error: 'Saving has not been started yet.' }; }
    let data = payload;
    if (!data) {
      await save();
      const last = await db.newest('snaps');
      data = { windows: last.data.windows.filter((w) => windowId == null || w.id === windowId) };
    }
    data = { windows: data.windows.map(({ id, focused, ...w }) => w) };
    const c = counts(data);
    const t = Date.now();
    const id = await db.put('sessions', { t, created: t, name: name || defaultName(t), c, data });
    return { id };
  },
  async restoreTrash({ id, into }) {
    const item = await db.get('trash', id);
    if (!item) return { opened: 0 };
    if (item.kind === 'session') {
      await db.put('sessions', item.data.session);
      await db.del('trash', id);
      return { opened: 0, session: true };
    }
    let opened = 0;
    for (const w of item.data.windows) {
      // Tabs go back to their own window while it is open; otherwise (and for whole windows) a new one.
      const open = into ?? (item.kind === 'tabs' && w.id != null && (await chrome.windows.get(w.id).catch(() => null)) ? w.id : 'new');
      opened += (await restore({ windows: [w] }, { into: open, sleep: false, dedupe: false })).opened;
    }
    await db.del('trash', id);
    return { opened };
  },
  // "Delete all saved data" in Settings: saving stops until the user starts it again.
  async wipe() {
    clearTimeout(timer);
    await db.clearAll();
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    badge({});
    return { ok: true };
  },
  async nameWindow({ windowId, name }) {
    const names = await getLocal('names', {});
    if (name) names[windowId] = name; else delete names[windowId];
    await setLocal({ names });
    queueSave();
    return { ok: true };
  },
};

// Before the user has said yes on the welcome page, actions that need saving open that page.
async function askToStart() {
  const url = chrome.runtime.getURL('welcome.html');
  const [open] = await chrome.tabs.query({ url });
  if (open) await chrome.tabs.update(open.id, { active: true }); else await chrome.tabs.create({ url });
}

const defaultName = (t) => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.to === 'offscreen') return false;
  const h = handlers[msg?.type];
  if (!h || sender.id !== chrome.runtime.id) return false;
  h(msg).then(reply, (e) => reply({ error: String(e?.message || e) }));
  return true;
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'sleep-tab' && tab) await sleepTabs([tab].map((t) => ({ ...t, active: false })));
    if (info.menuItemId === 'sleep-others' && tab) await handlers.sleep({ scope: 'others', windowId: tab.windowId });
    if (info.menuItemId === 'never-sleep' && tab?.url) {
      const host = new URL(tab.url).hostname;
      const c = await cfg();
      if (host && !c.sleepExcept.split('\n').includes(host)) await setLocal({ cfg: { ...c, sleepExcept: (c.sleepExcept ? c.sleepExcept + '\n' : '') + host } });
    }
    if (info.menuItemId === 'save-window' && tab) await handlers.saveSession({ windowId: tab.windowId });
  } catch (e) { fail(e); }
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  try {
    if (cmd === 'save-session') await handlers.saveSession({});
    if (cmd === 'sleep-others') {
      const [t] = tab ? [tab] : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (t) await handlers.sleep({ scope: 'others', windowId: t.windowId });
    }
  } catch (e) { fail(e); }
});

// A worker woken by any event refreshes the badge from stored status, and makes sure the download
// bubble is on: it is only ever hidden while this same worker writes an hourly backup file.
getLocal('status', {}).then(badge);
chrome.downloads.setUiOptions?.({ enabled: true }).catch(() => {});
