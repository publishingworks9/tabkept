// Pure helpers shared by the service worker and the pages. No chrome.* calls in here,
// so everything can be unit tested in Node.

export const DEFAULTS = {
  sleepOn: false,         // sleep tabs nobody has looked at for a while
  sleepAfter: 60,         // minutes
  protectRecent: 10,      // minutes the tab you just left stays awake
  sleepExcept: '',        // one pattern per line: host, *.host, or /regex/
  ignoreHash: true,       // duplicates: treat page#a and page#b as the same page
  backupOn: true,         // hourly files in Downloads
  backupKeep: 48,         // how many hourly backup files to keep
  saveIncognito: false,
  restoreAsleep: true,    // restored tabs load when clicked; off = load them all now
};

export const SAVE_DEBOUNCE_MS = 2_000;
export const STALE_MS = 5 * 60_000;     // no check for this long → badge warns
export const BIG_RESTORE = 50;          // ask before opening more tabs than this
export const TRASH_DAYS = 30;
const HOUR = 3_600_000, DAY = 24 * HOUR;

export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

// ---------- snapshots ----------

// windows: chrome.windows.getAll({ populate: true }); groups: chrome.tabGroups.query({})
// Pages not worth saving: blank and new-tab pages, and this extension's own pages.
export function isNoise(url, own = '') {
  return !url || url === 'about:blank' || /^(chrome|edge|brave):\/\/(newtab|new-tab-page)\/?$/.test(url) || (own && url.startsWith(own));
}

export function snapshotFrom(windows, groups, { incognito = false, now = Date.now(), own = '' } = {}) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out = [];
  for (const w of windows) {
    if (w.type && w.type !== 'normal') continue;
    if (w.incognito && !incognito) continue;
    const tabs = (w.tabs || []).filter((t) => !isNoise(t.url || t.pendingUrl, own));
    if (!tabs.length) continue;
    const gIndex = new Map();
    const wg = [];
    const wt = tabs.map((t) => {
      const tab = { url: t.url || t.pendingUrl, title: t.title || '' };
      if (t.pinned) tab.pinned = true;
      if (t.active) tab.active = true;
      if (t.mutedInfo?.muted) tab.muted = true;
      if (t.groupId != null && t.groupId !== -1 && byId.has(t.groupId)) {
        if (!gIndex.has(t.groupId)) {
          const g = byId.get(t.groupId);
          gIndex.set(t.groupId, wg.length);
          wg.push({ title: g.title || '', color: g.color || 'grey', collapsed: !!g.collapsed });
        }
        tab.g = gIndex.get(t.groupId);
      }
      return tab;
    });
    const win = { tabs: wt };
    if (wg.length) win.groups = wg;
    if (w.incognito) win.incognito = true;
    if (w.state && w.state !== 'normal') win.state = w.state;
    for (const k of ['left', 'top', 'width', 'height']) if (Number.isFinite(w[k])) win[k] = w[k];
    if (w.focused) win.focused = true;
    out.push(win);
  }
  return { v: 1, t: now, windows: out };
}

// Structure only: titles change all the time ("(3) Inbox") and are not worth a new snapshot.
export function fingerprint(snap) {
  let s = '';
  for (const w of snap.windows) {
    s += '|W' + (w.incognito ? 'i' : '') + (w.name ? '~' + w.name : '');
    for (const g of w.groups || []) s += `|G${g.title}~${g.color}~${g.collapsed ? 1 : 0}`;
    for (const t of w.tabs) s += `|${t.pinned ? 'p' : ''}${t.g ?? ''}>${t.url}`;
  }
  return hash(s);
}

export function hash(str) {
  // FNV-1a 32-bit, two passes with different seeds → 64 bits as hex. Not crypto, just identity.
  let a = 0x811c9dc5, b = 0x01000193 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

export function counts(snap) {
  let tabs = 0, groups = 0;
  for (const w of snap.windows) { tabs += w.tabs.length; groups += (w.groups || []).length; }
  return { windows: snap.windows.length, tabs, groups };
}

// What changed between two snapshots, for the timeline ("+3 tabs, 1 window closed").
export function diff(prev, next) {
  if (!prev) return { added: allUrls(next).length, removed: 0 };
  const a = countUrls(prev), b = countUrls(next);
  let added = 0, removed = 0;
  for (const [u, n] of b) added += Math.max(0, n - (a.get(u) || 0));
  for (const [u, n] of a) removed += Math.max(0, n - (b.get(u) || 0));
  return { added, removed };
}
const allUrls = (s) => s.windows.flatMap((w) => w.tabs.map((t) => t.url));
function countUrls(s) {
  const m = new Map();
  for (const u of allUrls(s)) m.set(u, (m.get(u) || 0) + 1);
  return m;
}

// Retention for automatic snapshots: every one for 24 h, the newest per hour for 7 days,
// the newest per day for 90 days. Named sessions live in a different store and are never thinned.
// items: [{ id, t }] in any order. Returns the ids to delete.
export function thin(items, now = Date.now()) {
  const keep = new Set(), seen = new Set();
  const sorted = [...items].sort((x, y) => y.t - x.t);
  if (sorted.length) keep.add(sorted[0].id); // never delete the newest, whatever its age
  for (const it of sorted) {
    const age = now - it.t;
    if (age < DAY) { keep.add(it.id); continue; }
    if (age > 90 * DAY) continue;
    const bucket = age < 7 * DAY ? 'h' + Math.floor(it.t / HOUR) : 'd' + dayKey(it.t);
    if (!seen.has(bucket)) { seen.add(bucket); keep.add(it.id); }
  }
  return sorted.filter((it) => !keep.has(it.id)).map((it) => it.id);
}
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

// ---------- duplicates ----------

export function normUrl(url, { ignoreHash = true } = {}) {
  try {
    const u = new URL(url);
    if (ignoreHash) u.hash = '';
    let s = u.href;
    if (u.pathname === '/' && !u.search && !u.hash && s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch { return url; }
}

// tabs: live chrome tabs. Keeps one copy of each page: the active one, else a pinned one,
// else the oldest (lowest id). Pinned tabs are never closed. Returns ids to close.
export function findDuplicates(tabs, opts) {
  const groups = new Map();
  for (const t of tabs) {
    if (!t.url || !/^(https?|file|ftp):/.test(t.url)) continue;
    const k = (t.incognito ? 'i:' : '') + normUrl(t.url, opts);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const close = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keeper = list.find((t) => t.active) || list.find((t) => t.pinned) || [...list].sort((a, b) => a.id - b.id)[0];
    for (const t of list) if (t !== keeper && !t.pinned) close.push(t.id);
  }
  return close;
}

// ---------- sleeping ----------

export function parsePatterns(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((p) => {
    if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) {
      try { return { re: new RegExp(p.slice(1, -1), 'i') }; } catch { return null; }
    }
    return { host: p.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') };
  }).filter(Boolean);
}

export function matchesAny(url, patterns) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* not a URL */ }
  return patterns.some((p) => {
    if (p.re) return p.re.test(url);
    if (p.host.startsWith('*.')) { const base = p.host.slice(2); return host === base || host.endsWith('.' + base); }
    return host === p.host || host === 'www.' + p.host;
  });
}

// Why a tab may not be slept, or '' if it may. lastAccessed is Chrome's own timestamp (Chrome 121+).
export function sleepBlocker(tab, { now = Date.now(), cfg = DEFAULTS, patterns = [], manual = false } = {}) {
  if (tab.active) return 'in front';
  if (tab.discarded) return 'asleep';
  if (tab.pendingUrl || !tab.url) return 'loading';
  if (!/^(https?|file):/.test(tab.url || '')) return 'browser page';
  if (tab.audible) return 'playing sound';
  if (manual) return '';
  if (tab.pinned) return 'pinned';
  if (matchesAny(tab.url, patterns)) return 'on your list';
  const idle = now - (tab.lastAccessed || now);
  if (idle < cfg.protectRecent * 60_000) return 'used recently';
  if (idle < cfg.sleepAfter * 60_000) return 'not idle yet';
  return '';
}

// ---------- restore ----------

// Which saved groups can reuse a group already open in the target window (same title and colour),
// so restoring twice never doubles a group. open: chrome.tabGroups.query({ windowId }).
export function matchGroups(saved = [], open = []) {
  const used = new Set();
  return saved.map((g) => {
    const hit = open.find((o) => !used.has(o.id) && (o.title || '') === (g.title || '') && o.color === g.color);
    if (hit) { used.add(hit.id); return hit.id; }
    return null;
  });
}

// Tabs of a saved window that are not already open in the target window (by URL), so a restore
// into a window that already has some of them does not duplicate them.
export function missingTabs(savedTabs, openTabs, opts) {
  const have = new Map();
  for (const t of openTabs) { const k = normUrl(t.url || '', opts); have.set(k, (have.get(k) || 0) + 1); }
  return savedTabs.filter((t) => {
    const k = normUrl(t.url, opts);
    const n = have.get(k) || 0;
    if (n > 0) { have.set(k, n - 1); return false; }
    return true;
  });
}

// URLs Chrome refuses to open from an extension. They are kept in backups but skipped on restore.
export function restorable(url) {
  return /^(https?|ftp|file|chrome|edge|brave|about):/.test(url || '') && !/^chrome:\/\/(kill|hang|crash|quit|restart)/.test(url)
    && !/^about:blank$/.test(url);
}

// ---------- search ----------

export function search(query, items, limit = 50) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored = [];
  for (const it of items) {
    const title = (it.title || '').toLowerCase(), url = (it.url || '').toLowerCase();
    let score = 0, ok = true;
    for (const w of words) {
      const inT = title.indexOf(w), inU = url.indexOf(w);
      if (inT < 0 && inU < 0) { ok = false; break; }
      score += inT === 0 ? 6 : inT > 0 ? (/\W/.test(title[inT - 1]) ? 4 : 2) : 1;
    }
    if (ok) scored.push([score + (it.open ? 2 : 0), it]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map((s) => s[1]);
}

// ---------- backups ----------

export const BACKUP_FORMAT = 'tab-saver-backup';

export function backupJson(payload) {
  return JSON.stringify({ format: BACKUP_FORMAT, version: 1, ...payload }, null, 1);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A page anyone can open without the extension: every window, group and link, nothing else.
export function backupHtml(snap, { appName = 'Tab backup', when = new Date(snap.t) } = {}) {
  const c = counts(snap);
  let body = '';
  snap.windows.forEach((w, i) => {
    body += `<h2>Window ${i + 1} <small>${w.tabs.length} tabs</small></h2>\n<ul>\n`;
    let open = null;
    for (const t of w.tabs) {
      const g = t.g != null ? w.groups?.[t.g] : null;
      if (g !== open) {
        if (open) body += '</ul></li>\n';
        if (g) body += `<li class="g"><b class="c-${esc(g.color)}">${esc(g.title || 'Unnamed group')}</b><ul>\n`;
        open = g;
      }
      body += `<li><a href="${esc(t.url)}">${esc(t.title || t.url)}</a>${t.pinned ? ' <i>pinned</i>' : ''}</li>\n`;
    }
    if (open) body += '</ul></li>\n';
    body += '</ul>\n';
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(appName)}, ${esc(when.toLocaleString())}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#1d1b18}
h1{font-size:22px;margin:0}p{color:#6b655c}h2{font-size:15px;margin:28px 0 6px}small,i{color:#6b655c;font-weight:400;font-style:normal}
ul{padding-left:20px}li{margin:3px 0}a{color:#1f4fd1;word-break:break-word}.g>b{display:inline-block;margin:6px 0 2px}</style></head>
<body><h1>${esc(appName)}</h1><p>Saved ${esc(when.toLocaleString())}. ${c.windows} windows, ${c.tabs} tabs, ${c.groups} groups. Open any link to get it back.</p>
${body}</body></html>`;
}

// Hourly file name; overwriting the same name within an hour keeps the folder tidy.
export function backupName(folder, t = Date.now()) {
  const d = new Date(t), p = (n) => String(n).padStart(2, '0');
  return `${folder}/${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.00.json`;
}

// ---------- labels ----------

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
