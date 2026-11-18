import * as db from './lib/db.js';
import { animate } from './vendor/motion.mjs';
import { DEFAULTS, STALE_MS, BIG_RESTORE, TRASH_DAYS, counts, ago, plural, normUrl, backupJson } from './lib/core.js';
import { parseImport } from './lib/import.js';
import { APP } from './lib/app.js';

const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });
const getLocal = async (k, d) => (await chrome.storage.local.get(k))[k] ?? d;
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((x) => x != null && x !== false));
  return el;
};
document.querySelectorAll('[data-app]').forEach((el) => { el.textContent = APP.name; });

let cfg = DEFAULTS;
const CHEV = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('class', 'chev'); s.innerHTML = '<path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'; return s; };
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const dateLabel = (t) => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const summary = (c) => [plural(c.tabs, 'tab'), c.windows > 1 ? plural(c.windows, 'window') : '', c.groups ? plural(c.groups, 'group') : ''].filter(Boolean).join(' · ');

// ---------- router ----------

const VIEWS = ['now', 'sessions', 'timeline', 'bin', 'backups', 'settings'];
async function route() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'now';
  for (const id of VIEWS) $(`v-${id}`).hidden = id !== v;
  document.querySelectorAll('.rail a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.view === v) || a.removeAttribute('aria-current'));
  document.querySelectorAll('.rail a').forEach((a) => { if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); });
  await ({ now: renderNow, sessions: renderSessions, timeline: renderTimeline, bin: renderBin, backups: renderBackups, settings: renderSettings })[v]();
}
window.addEventListener('hashchange', route);

// ---------- a session tree: windows, groups, tabs, with tick boxes ----------

function tree(data, { pick = false, onPick, onGroup } = {}) {
  const box = h('div', { class: 'tree' });
  const checks = [];
  data.windows.forEach((w, wi) => {
    const wHead = h('div', { class: 'win-h' }, h('span', { text: w.name || `Window ${wi + 1}` }), h('span', { class: 'muted num', text: plural(w.tabs.length, 'tab') }));
    if (pick) wHead.append(h('button', { class: 'btn quiet', text: 'Tick all', onclick: () => { ul.querySelectorAll('input').forEach((c) => { c.checked = true; }); onPick?.(); } }));
    box.append(wHead);
    const ul = h('ul', { class: 'tabs' });
    let lastG = null;
    w.tabs.forEach((t, ti) => {
      const g = t.g != null ? w.groups?.[t.g] : null;
      if (g && g !== lastG) {
        const gIdx = t.g;
        ul.append(h('li', { class: `grp g-${g.color}` }, h('span', { class: 'dot' }), h('span', { text: g.title || 'Unnamed group' }), g.collapsed ? h('span', { class: 'muted', text: '(collapsed)' }) : null,
          onGroup ? h('button', { class: 'btn quiet', text: 'Restore group', onclick: () => onGroup({ windows: [{ ...w, tabs: w.tabs.filter((x) => x.g === gIdx).map((x) => ({ ...x, g: 0 })), groups: [g] }] }) }) : null));
      }
      lastG = g;
      const cb = pick ? h('input', { type: 'checkbox', 'aria-label': `Tick ${t.title || t.url}`, onchange: () => onPick?.() }) : null;
      if (cb) { cb.dataset.w = wi; cb.dataset.t = ti; checks.push(cb); }
      ul.append(h('li', { class: g ? `in-g g-${g.color}` : '' }, cb, favicon(t.url),
        h('a', { href: t.url, target: '_blank', rel: 'noreferrer', text: t.title || t.url, title: t.url }),
        t.pinned ? h('span', { class: 'pin', text: 'pinned' }) : null,
        h('span', { class: 'host', text: host(t.url) })));
    });
    box.append(ul);
  });
  const picked = () => {
    const sel = new Map();
    for (const c of checks) if (c.checked) { const w = +c.dataset.w; if (!sel.has(w)) sel.set(w, []); sel.get(w).push(+c.dataset.t); }
    return sel;
  };
  // A payload with only the ticked tabs, keeping their windows and groups.
  const pickedData = () => {
    const sel = picked();
    return { windows: [...sel].map(([wi, tis]) => {
      const w = data.windows[wi];
      const used = [...new Set(tis.map((ti) => w.tabs[ti].g).filter((g) => g != null))];
      const remap = new Map(used.map((g, i) => [g, i]));
      const tabs = tis.map((ti) => { const t = { ...w.tabs[ti] }; if (t.g != null) t.g = remap.get(t.g); return t; });
      return { ...w, tabs, groups: used.map((g) => w.groups[g]) };
    }) };
  };
  return { el: box, picked, pickedData, count: () => checks.filter((c) => c.checked).length };
}

function favicon(url) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', '32');
  return h('img', { class: 'fav', src: u.href, alt: '', loading: 'lazy', width: 16, height: 16 });
}

// One expandable card. load() returns the payload when first opened.
function item({ title, sub, acts = [], load, pick, selectable, onSelect, extra, onGroup, lead }) {
  const card = h('div', { class: 'item' });
  const body = h('div', { class: 'body' }, h('div'));
  let built = null;
  const toggle = async () => {
    if (!built && load) {
      const data = await load();
      const bar = pick ? h('div', { class: 'picked' }, h('span', { class: 'num', text: 'Tick tabs to restore or remove only those' }), h('div', { class: 'row-act' }, ...pick.map((p) => h('button', { class: 'btn' + (p.primary ? ' primary' : ''), text: p.label, disabled: !p.always, 'data-always': p.always ? '1' : null, onclick: () => p.run(built) })))) : null;
      built = tree(data, { pick: !!pick, onGroup, onPick: () => {
        const n = built.count();
        bar.querySelector('span').textContent = n ? `${plural(n, 'tab')} ticked` : 'Tick tabs to restore or remove only those';
        bar.querySelectorAll('button:not([data-always])').forEach((b) => { b.disabled = !n; });
      } });
      body.firstChild.append(built.el);
      if (bar) built.el.append(bar);
    }
    card.classList.toggle('open');
    head.querySelector('.expand').setAttribute('aria-expanded', card.classList.contains('open'));
  };
  const head = h('div', { class: 'item-head' },
    selectable ? h('input', { type: 'checkbox', class: 'sel', 'aria-label': `Select ${title}`, onchange: (e) => onSelect?.(e.target.checked) }) : null,
    h('button', { class: 'expand', 'aria-expanded': 'false', onclick: toggle }, CHEV(), h('span', { class: 'txt' }, lead || null, h('b', { text: title }), h('span', { class: 'num' }, ...[].concat(sub)))),
    h('div', { class: 'acts' }, ...acts.map((a) => h('button', { class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), text: a.label, onclick: a.run }))),
  );
  card.append(head, body);
  if (extra) card.append(extra);
  card.toggleOpen = toggle;
  return card;
}

async function restore(data, label) {
  const n = counts(data).tabs;
  if (n > BIG_RESTORE && !confirm(`Open ${n} tabs? They open asleep and load when you click them.`)) return;
  toast(`Opening ${plural(n, 'tab')}…`);
  const r = await send('restore', { payload: data, into: 'new' });
  toast(r?.error ? `Could not restore: ${r.error}` : `Opened ${plural(r.opened, 'tab')}${label ? ` from ${label}` : ''}${r.skipped ? `. ${plural(r.skipped, 'private tab')} skipped: allow Tabkept in Incognito to restore them` : ''}`);
}

// ---------- Open now ----------

async function renderNow() {
  const [wins, names] = await Promise.all([chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }), getLocal('names', {})]);
  const groups = await chrome.tabGroups.query({});
  const gmap = new Map(groups.map((g) => [g.id, g]));
  const list = $('nowList');
  list.replaceChildren(...wins.map((w, i) => {
    const name = names[w.id] || '';
    const data = { windows: [{ name, tabs: w.tabs.map((t) => ({ url: t.url || t.pendingUrl || '', title: t.title, pinned: t.pinned, ...(t.groupId > -1 ? { g: t.groupId } : {}) })), groups: [] }] };
    // map live group ids to indexes for the tree
    const ids = [...new Set(w.tabs.map((t) => t.groupId).filter((g) => g > -1))];
    data.windows[0].groups = ids.map((id) => ({ title: gmap.get(id)?.title || '', color: gmap.get(id)?.color || 'grey', collapsed: gmap.get(id)?.collapsed }));
    for (const t of data.windows[0].tabs) if (t.g != null) t.g = ids.indexOf(t.g);
    const asleep = w.tabs.filter((t) => t.discarded).length;
    const lead = h('span', { class: 'chipline', 'aria-hidden': 'true' }, ...w.tabs.slice(0, 40).map((t) => h('i', { class: t.pinned ? 'pin' : t.groupId > -1 ? `g-${gmap.get(t.groupId)?.color || 'grey'}` : null })));
    return item({
      lead,
      title: name || `Window ${i + 1}${w.focused ? ' (this window)' : ''}`,
      sub: `${summary(counts(data))}${asleep ? ` · ${asleep} asleep` : ''}${w.incognito ? ' · incognito' : ''}`,
      acts: [
        { label: name ? 'Rename' : 'Name it', run: async () => { const v = await ask('Name this window', name); if (v != null) { await send('nameWindow', { windowId: w.id, name: v.trim() }); renderNow(); } } },
        { label: 'Sleep tabs', run: async () => { const r = await send('sleep', { scope: 'others', windowId: w.id }); toast(`${plural(r.slept, 'tab')} asleep`); renderNow(); } },
        { label: 'Save', primary: true, run: async () => { await send('saveSession', { windowId: w.id, name: name || undefined }); toast('Window saved as a session'); count(); } },
      ],
      load: async () => data,
    });
  }));
  $('nNow').textContent = wins.length || '';
}
$('nowSave').addEventListener('click', async () => { await send('saveSession', {}); toast('All windows saved as a session'); count(); });
$('nowSleep').addEventListener('click', async () => { const r = await send('sleep', { scope: 'all' }); toast(`${plural(r.slept, 'tab')} asleep. They load again when you click them.`); renderNow(); });

// ---------- Sessions ----------

const selected = new Set();
async function renderSessions() {
  const sessions = await db.list('sessions');
  selected.clear();
  $('merge').disabled = true;
  $('sessEmpty').hidden = sessions.length > 0;
  $('sessList').replaceChildren(...sessions.map((s) => item({
    title: s.name,
    sub: `${summary(s.c)} · saved ${dateLabel(s.t)}`,
    selectable: true,
    onSelect: (on) => { on ? selected.add(s.id) : selected.delete(s.id); $('merge').disabled = selected.size < 2; },
    acts: [
      { label: 'Rename', run: async () => { const v = await ask('Rename session', s.name); if (v) { await db.put('sessions', { ...(await db.get('sessions', s.id)), name: v.trim() }); renderSessions(); } } },
      { label: 'Export', run: async () => exportFile([await db.get('sessions', s.id)], s.name) },
      { label: 'Delete', danger: true, run: () => deleteSession(s.id) },
      { label: 'Restore', primary: true, run: async () => restore((await db.get('sessions', s.id)).data, s.name) },
    ],
    load: async () => (await db.get('sessions', s.id)).data,
    onGroup: (data) => restore(data, s.name),
    pick: [
      { label: 'Add open windows', always: true, run: () => editWithOpen(s.id, 'add') },
      { label: 'Replace with open windows', always: true, run: () => editWithOpen(s.id, 'replace') },
      { label: 'Remove ticked', run: async (t) => {
        const full = await db.get('sessions', s.id);
        const sel = t.picked();
        const windows = full.data.windows.map((w, wi) => ({ ...w, tabs: w.tabs.filter((_, ti) => !sel.get(wi)?.includes(ti)) })).filter((w) => w.tabs.length);
        await db.put('trash', { t: Date.now(), kind: 'tabs', label: `${plural(t.count(), 'tab')} removed from "${s.name}"`, data: t.pickedData() });
        if (windows.length) await db.put('sessions', { ...full, data: { windows }, c: counts({ windows }) });
        else await db.del('sessions', s.id);
        toast('Removed. They are in the bin for 30 days.');
        renderSessions(); count();
      } },
      { label: 'Add ticked to this window', run: async (t) => { const r = await send('restore', { payload: t.pickedData(), into: (await chrome.windows.getCurrent()).id }); toast(`Added ${plural(r.opened, 'tab')} to this window`); } },
      { label: 'Restore ticked', primary: true, run: (t) => restore(t.pickedData(), s.name) },
    ],
  })));
}

// Add the open windows to a session, or replace its tabs with them. The old version goes to the bin.
async function editWithOpen(id, mode) {
  const full = await db.get('sessions', id);
  await send('saveNow');
  const now = (await db.newest('snaps'))?.data.windows.map(({ id: _id, focused, ...w }) => w) || [];
  if (!now.length) return toast('No open web pages to add.');
  await db.put('trash', { t: Date.now(), kind: 'session', label: `Earlier version of "${full.name}"`, data: { session: (({ id: _old, ...rest }) => ({ ...rest, name: `${full.name} (earlier)` }))(full), windows: full.data.windows } });
  let windows;
  if (mode === 'replace') windows = now;
  else {
    const seen = new Set(full.data.windows.flatMap((w) => w.tabs.map((t) => normUrl(t.url, cfg))));
    windows = [...full.data.windows, ...now.map((w) => ({ ...w, tabs: w.tabs.filter((t) => !seen.has(normUrl(t.url, cfg))) })).filter((w) => w.tabs.length)];
  }
  await db.put('sessions', { ...full, t: Date.now(), data: { windows }, c: counts({ windows }) });
  toast(mode === 'replace' ? `"${full.name}" now holds your open windows. The earlier version is in the bin.` : `Added the open windows to "${full.name}". The earlier version is in the bin.`);
  renderSessions(); count();
}

function exportFile(sessions, name) {
  const json = backupJson({ saved: Date.now(), sessions: sessions.map(({ id, ...s }) => s) });
  const a = h('a', { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: `${APP.folder} - ${name.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function deleteSession(id) {
  const s = await db.get('sessions', id);
  await db.put('trash', { t: Date.now(), kind: 'session', label: `Session "${s.name}"`, data: { session: s, windows: s.data.windows } });
  await db.del('sessions', id);
  const [binItem] = await db.list('trash', { limit: 1, light: true });
  toast(`Deleted "${s.name}"`, 'Undo', async () => { await send('restoreTrash', { id: binItem.id }); renderSessions(); count(); });
  renderSessions(); count();
}

$('sessSave').addEventListener('click', async () => { await send('saveSession', {}); toast('Open windows saved'); renderSessions(); count(); });
$('merge').addEventListener('click', async () => {
  const list = await Promise.all([...selected].map((id) => db.get('sessions', id)));
  const name = await ask('Name the merged session', list.map((s) => s.name).join(' + ').slice(0, 120));
  if (!name) return;
  // One window per source window; a tab already in an earlier window is dropped, so nothing appears twice.
  const seen = new Set();
  const windows = [];
  for (const s of list) for (const w of s.data.windows) {
    const tabs = w.tabs.filter((t) => { const k = normUrl(t.url, cfg); if (seen.has(k)) return false; seen.add(k); return true; });
    if (tabs.length) windows.push({ ...w, tabs });
  }
  const t = Date.now();
  await db.put('sessions', { t, created: t, name: name.trim(), c: counts({ windows }), data: { windows } });
  toast(`Merged into "${name.trim()}". The originals are still here.`);
  renderSessions(); count();
});

// ---------- Timeline ----------

async function renderTimeline() {
  const snaps = await db.list('snaps', { light: true });
  const box = $('tlList');
  box.replaceChildren();
  const cards = new Map();
  let day = '', boot = null, wrap = null;
  for (const s of snaps) {
    const d = new Date(s.t).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    if (d !== day) { day = d; box.append(h('h2', { class: 'day', text: d })); wrap = h('div', { class: 'tl' }); box.append(wrap); }
    if (boot != null && s.boot !== boot) wrap.append(h('div', { class: 'restart', text: 'Chrome started' }));
    boot = s.boot;
    const delta = h('span', { class: 'delta' }, s.d?.added ? h('span', { class: 'plus', text: ` +${s.d.added}` }) : null, s.d?.removed ? h('span', { class: 'minus', text: ` −${s.d.removed}` }) : null);
    wrap.append(cards.set(s.id, item({
      title: new Date(s.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      sub: [summary(s.c), delta],
      acts: [
        { label: 'Keep as session', run: async () => { const full = await db.get('snaps', s.id); const v = await ask('Name this session', dateLabel(s.t)); if (v) { await send('saveSession', { name: v.trim(), payload: full.data }); toast('Kept as a session. It will not be thinned out.'); count(); } } },
        { label: 'Restore', primary: true, run: async () => restore((await db.get('snaps', s.id)).data) },
      ],
      load: async () => (await db.get('snaps', s.id)).data,
      onGroup: (data) => restore(data),
      pick: [{ label: 'Restore ticked', primary: true, run: (t) => restore(t.pickedData()) }],
    })).get(s.id));
  }
  if (!snaps.length) return box.append(h('p', { class: 'empty', text: 'Nothing saved yet.' }));
  if (snaps.length > 1) box.prepend(ribbon(snaps, cards));
}

// The big ribbon: every kept save across the whole timeline. Drag the notch; it lands on the save
// nearest to where the drag was heading (apple-design §6 projection) and opens that save below.
function ribbon(snaps, cards) {
  const oldest = snaps[snaps.length - 1].t, newest = snaps[0].t, span = Math.max(1, newest - oldest);
  const ticks = [...snaps].reverse().map((s) => ({ s, x: (s.t - oldest) / span }));
  const tickEls = ticks.map((k) => h('i', { style: `left:${k.x * 100}%;height:${Math.min(26, 8 + Math.round(Math.sqrt((k.s.d?.added || 0) + (k.s.d?.removed || 0)) * 3))}px` }));
  const notch = h('span', { class: 'notch', 'aria-hidden': 'true' });
  const fmt = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const el = h('div', { class: 'ribbon', role: 'slider', tabindex: 0, 'aria-label': 'Move through the timeline', 'aria-valuemin': 0, 'aria-valuemax': ticks.length - 1, 'aria-valuenow': ticks.length - 1 },
    h('div', { class: 'ticks' }, ...tickEls), notch, h('div', { class: 'ends' }, h('span', { text: fmt(oldest) }), h('span', { text: 'Now' })));
  let x = 1, sel = null, spring = null, drag = null;
  const width = () => el.querySelector('.ticks').clientWidth;
  const place = (v) => { x = Math.max(0, Math.min(1, v)); notch.style.transform = `translateX(${x * width() - 6}px)`; };
  const nearest = (v) => ticks.reduce((a, b) => (Math.abs(b.x - v) < Math.abs(a.x - v) ? b : a));
  const select = (k) => {
    if (sel === k) return;
    tickEls[ticks.indexOf(sel)]?.classList.remove('sel');
    sel = k;
    tickEls[ticks.indexOf(k)].classList.add('sel');
    el.setAttribute('aria-valuenow', ticks.indexOf(k));
    el.setAttribute('aria-valuetext', fmt(k.s.t));
  };
  const land = async (k) => {
    for (const c of cards.values()) c.classList.remove('hit');
    const card = cards.get(k.s.id);
    card.classList.add('hit');
    card.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    if (!card.classList.contains('open')) await card.toggleOpen();
  };
  const xOf = (e) => { const r = el.querySelector('.ticks').getBoundingClientRect(); return (e.clientX - r.left) / r.width; };
  el.addEventListener('pointerdown', (e) => { spring?.stop(); el.setPointerCapture(e.pointerId); drag = [[e.timeStamp, xOf(e)]]; place(xOf(e)); select(nearest(x)); });
  el.addEventListener('pointermove', (e) => { if (!drag) return; drag.push([e.timeStamp, xOf(e)]); if (drag.length > 5) drag.shift(); place(xOf(e)); select(nearest(x)); });
  const up = () => {
    if (!drag) return;
    const [a, b] = [drag[0], drag[drag.length - 1]];
    const v = b[0] > a[0] ? (b[1] - a[1]) / ((b[0] - a[0]) / 1000) : 0;
    drag = null;
    const target = nearest(x + (v / 1000) * 0.99 / (1 - 0.99)); // project the throw, then snap
    select(target);
    spring = animate(x, target.x, { type: 'spring', bounce: Math.abs(v) > 0.2 ? 0.15 : 0, duration: 0.4, velocity: v, onUpdate: place });
    land(target);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('keydown', (e) => {
    const i = ticks.indexOf(sel || ticks[ticks.length - 1]);
    const n = e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : null;
    if (n == null || n < 0 || n >= ticks.length) return;
    e.preventDefault();
    select(ticks[n]); place(ticks[n].x); land(ticks[n]);
  });
  requestAnimationFrame(() => place(1));
  return el;
}

// ---------- Bin ----------

async function renderBin() {
  const items = await db.list('trash', { light: true });
  $('binEmpty').hidden = items.length > 0;
  $('binList').replaceChildren(...items.map((b) => {
    const left = Math.max(0, TRASH_DAYS - Math.floor((Date.now() - b.t) / 86_400_000));
    return item({
      title: b.label,
      sub: `${ago(b.t)} · deleted for good in ${plural(left, 'day')}`,
      acts: [
        { label: 'Delete now', danger: true, run: async () => { if (confirm('Delete this for good? It cannot be brought back.')) { await db.del('trash', b.id); renderBin(); count(); } } },
        { label: b.kind === 'session' ? 'Put back' : 'Restore', primary: true, run: async () => { const r = await send('restoreTrash', { id: b.id }); toast(r.session ? 'Session put back' : `Opened ${plural(r.opened, 'tab')}`); renderBin(); count(); } },
      ],
      load: async () => { const full = await db.get('trash', b.id); return { windows: full.data.windows }; },
    });
  }));
}

// ---------- Backups and import ----------

async function renderBackups() {
  const { count: n } = await send('rescue', { dry: true });
  $('rescueInfo').textContent = n ? `${plural(n, 'open tab')} still point at a removed extension's page. Tabkept can send each one back to its real address.` : 'No open tabs point at a removed extension\'s page.';
  $('rescue').disabled = !n;
  const s = await getLocal('status', {});
  $('bkInfo').textContent = !cfg.backupOn ? 'Hourly backup files are off. You can still write one now.'
    : s.backupError ? `The last backup file failed: ${s.backupError}`
    : s.backup ? `Last file written ${ago(s.backup)}, to Downloads/${APP.folder}. The newest ${cfg.backupKeep} are kept, plus "Open me - latest tabs.html", a page of links that opens without the extension.`
    : `The first file is written a few minutes after saving starts, to Downloads/${APP.folder}.`;
}
$('rescue').addEventListener('click', async () => { const r = await send('rescue', {}); toast(`${plural(r.count, 'tab')} sent back to the real page`); renderBackups(); });
$('bkNow').addEventListener('click', async () => { const r = await send('backupNow'); toast(r.ok ? 'Backup file written' : `Backup failed: ${r.why}`); renderBackups(); });
$('bkShow').addEventListener('click', async () => { const [id] = await getLocal('backups', []); if (id != null) chrome.downloads.show(id); else chrome.downloads.showDefaultFolder(); });
$('bkExport').addEventListener('click', async () => {
  const last = await db.newest('snaps');
  const json = backupJson({ saved: last?.t, snapshot: last?.data, sessions: await db.all('sessions') });
  const a = h('a', { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: `${APP.folder} export ${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

async function importText(text, fileName) {
  try {
    const { source, sessions } = parseImport(text, fileName);
    const t = Date.now();
    for (const s of sessions) await db.put('sessions', { t: s.t && Number.isFinite(+new Date(s.t)) ? +new Date(s.t) : t, created: t, name: s.name, c: counts(s.data), data: s.data, imported: source });
    const tabs = sessions.reduce((n, s) => n + counts(s.data).tabs, 0);
    $('impMsg').textContent = `Imported ${plural(sessions.length, 'session')} with ${plural(tabs, 'tab')} from a ${source} file. They are under Sessions.`;
    count();
  } catch (e) {
    $('impMsg').textContent = e.message;
  }
}
$('file').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) importText(await f.text(), f.name); e.target.value = ''; });
$('pasteGo').addEventListener('click', () => importText($('paste').value, ''));

// ---------- Settings ----------

const SETTINGS = { restoreAsleep: 'bool', sleepOn: 'bool', sleepAfter: 'num', protectRecent: 'num', sleepExcept: 'text', backupOn: 'bool', backupKeep: 'num', ignoreHash: 'bool', saveIncognito: 'bool' };
async function renderSettings() {
  for (const [k, type] of Object.entries(SETTINGS)) {
    const el = $(k);
    if (type === 'bool') el.checked = !!cfg[k]; else el.value = String(cfg[k]);
  }
}
for (const [k, type] of Object.entries(SETTINGS)) {
  $(k).addEventListener(type === 'text' ? 'input' : 'change', async (e) => {
    cfg = { ...cfg, [k]: type === 'bool' ? e.target.checked : type === 'num' ? +e.target.value : e.target.value };
    await chrome.storage.local.set({ cfg });
  });
}
// Support links: shown only on this page, only when they exist. Never in the popup, never a notification.
for (const [id, url] of [['tipLink', APP.tipUrl], ['sponsorLink', APP.sponsorUrl], ['sourceLink', APP.sourceUrl]]) {
  if (url) { $(id).href = url; $(id).hidden = false; }
}
$('support').hidden = !(APP.tipUrl || APP.sponsorUrl);
$('wipe').addEventListener('click', async () => {
  if (!confirm('Delete every saved session, the timeline, the bin and your settings from this browser? This cannot be undone. Backup files in Downloads stay.')) return;
  await send('wipe');
  location.hash = '#now';
  location.reload();
});
$('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

// ---------- shared ----------

function ask(title, value = '') {
  const d = $('rename');
  $('rnTitle').textContent = title;
  $('rnInput').value = value;
  d.showModal();
  $('rnInput').select();
  return new Promise((resolve) => { d.onclose = () => resolve(d.returnValue === 'ok' ? $('rnInput').value : null); });
}

let toastTimer;
function toast(text, act, fn) {
  const t = $('toast');
  $('toastText').textContent = text;
  const b = $('toastAct');
  b.hidden = !act;
  b.textContent = act || '';
  b.onclick = fn ? () => { t.classList.remove('on'); fn(); } : null;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), act ? 7000 : 3500);
}

async function count() {
  const [s, t, b] = await Promise.all([db.list('sessions', { light: true }), db.list('snaps', { light: true }), db.list('trash', { light: true })]);
  $('nSessions').textContent = s.length || '';
  $('nTimeline').textContent = t.length || '';
  $('nBin').textContent = b.length || '';
}

function health(s) {
  const stale = s.checked && Date.now() - s.checked > STALE_MS;
  const warn = !s.started || s.error || stale;
  $('health').dataset.state = warn ? 'warn' : 'ok';
  $('hTitle').textContent = !s.started ? 'Not saving yet' : s.error ? 'Saving has stopped' : stale ? 'Saving is late' : 'Everything is saved';
  $('hSub').textContent = !s.started ? 'Open the Tabkept button and press Start saving.' : s.error || (s.saved ? `Last change saved ${ago(s.saved)}` : '');
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && (ch.status || ch.started)) send('status').then(health);
});

(async () => {
  cfg = { ...DEFAULTS, ...(await getLocal('cfg', {})) };
  health(await send('status'));
  setInterval(async () => health(await send('status')), 10_000);
  count();
  route();
})();
