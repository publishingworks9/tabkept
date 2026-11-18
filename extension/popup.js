import * as db from './lib/db.js';
import { animate } from './vendor/motion.mjs';
import { DEFAULTS, STALE_MS, BIG_RESTORE, counts, ago, plural, search, missingTabs } from './lib/core.js';
import { APP } from './lib/app.js';

const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });
const getLocal = async (k, d) => (await chrome.storage.local.get(k))[k] ?? d;
document.querySelectorAll('[data-app]').forEach((el) => { el.textContent = APP.name; });

let cfg = DEFAULTS, current = null, dupeIds = [], index = [], prevSnap = null;

// ---------- the record ----------

function renderState(s) {
  if (viewing) return;
  const el = $('state');
  $('startBtn').hidden = !!s.started;
  if (!s.started) {
    el.dataset.state = 'off';
    $('stateTitle').textContent = 'Not saving yet';
    $('stateSub').textContent = 'Tabkept saves nothing until you say so.';
    return;
  }
  const stale = s.checked && Date.now() - s.checked > STALE_MS;
  const warn = !!(s.error || stale);
  el.dataset.state = warn ? 'warn' : 'ok';
  if (s.error) {
    $('stateTitle').textContent = 'Saving has stopped';
    $('stateSub').textContent = s.error;
  } else if (stale) {
    $('stateTitle').textContent = 'Saving is late';
    $('stateSub').textContent = `Last check ${ago(s.checked)}. Click Save session to save now.`;
  } else {
    $('stateTitle').textContent = 'Everything is saved';
    $('stateSub').textContent = s.saved ? `Last change saved ${ago(s.saved)}` : 'Saving…';
  }
}

// ---------- moment 1: the card stack ----------

const SPRING = { type: 'spring', bounce: 0, duration: 0.35 };   // apple-design default: critically damped
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
let shown = null; // fingerprint of what the stack shows, so only real changes animate

function renderMap(snap, { animate: anim = true } = {}) {
  const map = $('map');
  if (!snap) { map.replaceChildren(); return; }
  const before = new Map([...map.querySelectorAll('.w')].map((w) => [w.dataset.key, w.querySelectorAll('.t').length]));
  const wins = [...snap.windows].sort((a, b) => (a.focused ? 1 : 0) - (b.focused ? 1 : 0)).slice(-5); // the window you are in sits in front
  map.replaceChildren(...wins.map((w, wi) => {
    const card = document.createElement('div');
    card.className = 'w';
    card.dataset.key = String(w.id ?? wi);
    const chips = document.createElement('div');
    chips.className = 'chips';
    const max = 24;
    for (const t of w.tabs.slice(0, max)) {
      const s = document.createElement('span');
      s.className = 't' + (t.pinned ? ' pin' : '') + (t.active && w.focused ? ' on' : '') + (t.g != null ? ' g-' + (w.groups[t.g]?.color || 'grey') : '');
      chips.append(s);
    }
    if (w.tabs.length > max) {
      const m = document.createElement('span');
      m.className = 'more';
      m.textContent = `+${w.tabs.length - max}`;
      chips.append(m);
    }
    const lines = document.createElement('div');
    lines.className = 'lines';
    lines.innerHTML = '<i></i><i></i>';
    card.append(chips, lines);
    if (w.name) { const n = document.createElement('span'); n.className = 'wname'; n.textContent = w.name; card.append(n); }
    return card;
  }));
  // New tabs grow in from the left of their card; a new window card drops onto the stack.
  if (anim && !still && shown !== null) {
    for (const card of map.querySelectorAll('.w')) {
      const had = before.get(card.dataset.key);
      const chips = [...card.querySelectorAll('.t')];
      if (had == null) animate(card, { opacity: [0, 1], y: [-8, 0] }, SPRING);
      else if (chips.length > had) animate(chips.slice(had), { scaleX: [0, 1], opacity: [0, 1] }, SPRING);
    }
  }
  shown = snap.t;
  const c = counts(snap);
  setCounts(c, snap.windows.length > 5);
}

let lastCounts = null;
function setCounts(c, more) {
  const text = (x) => [plural(x.windows, 'window'), plural(x.tabs, 'tab'), x.groups ? plural(x.groups, 'group') : ''].filter(Boolean).join(' · ') + (more ? ' (5 shown)' : '');
  const from = lastCounts;
  lastCounts = c;
  if (!from || still || from.tabs === c.tabs) { $('counts').textContent = text(c); return; }
  // A changed number counts to its new value instead of swapping (apple-design: continuous feedback).
  animate(from.tabs, c.tabs, { duration: 0.3, ease: 'easeOut', onUpdate: (v) => { $('counts').textContent = text({ ...c, tabs: Math.round(v) }); } });
}

// ---------- moment 2: the ribbon scrubber ----------
// Drag through every save of the last 24 hours; the card stack shows that moment. Let go and the
// ribbon springs back to now, carrying the drag's velocity (apple-design §3, §5, §6).

let ticks = [];            // [{ x (0..1), id, t, boot }]
let notchX = 1;            // position 0..1 along the track
let viewing = null;
const DAY = 24 * 3600_000;

function renderScrubber(snaps) {
  const now = Date.now();
  const recent = snaps.filter((s) => now - s.t < DAY);
  ticks = recent.map((s) => ({ x: 1 - (now - s.t) / DAY, id: s.id, t: s.t, boot: s.boot, d: s.d }));
  $('scrub').hidden = ticks.length < 2;
  const box = $('scrubTicks');
  box.replaceChildren(...ticks.map((k, i) => {
    const el = document.createElement('i');
    const h = Math.min(11, 4 + Math.round(Math.sqrt((k.d?.added || 0) + (k.d?.removed || 0)) * 2));
    el.style.left = `${k.x * 100}%`;
    el.style.height = `${h}px`;
    if (i < ticks.length - 1 && ticks[i + 1].boot !== k.boot) el.className = 'boot';
    return el;
  }));
  $('scrubTrack').setAttribute('aria-valuemax', String(ticks.length - 1));
  $('scrubTrack').setAttribute('aria-valuenow', String(ticks.length - 1));
  placeNotch(1);
}

function placeNotch(x) {
  notchX = Math.max(0, Math.min(1, x));
  const w = $('scrubTrack').clientWidth - 16;
  $('scrubNotch').style.transform = `translateX(${notchX * w}px)`;
}

function nearest(x) {
  let best = ticks[ticks.length - 1];
  for (const k of ticks) if (Math.abs(k.x - x) < Math.abs(best.x - x)) best = k;
  return best;
}

let previewToken = 0;
async function preview(k) {
  if (!k || k === ticks[ticks.length - 1]) return showNow();
  if (viewing?.id === k.id) return;
  viewing = k;
  const token = ++previewToken;
  const snap = await db.get('snaps', k.id);
  if (token !== previewToken || !snap) return;
  $('state').classList.add('viewing');
  $('stateTitle').textContent = `Saved ${timeOf(k.t)}`;
  $('stateSub').textContent = `${ago(k.t)}. Let go to return to now; open the Library to restore it`;
  $('scrubLabel').textContent = timeOf(k.t);
  renderMap(snap.data, { animate: false });
}

function showNow() {
  if (!viewing) return;
  viewing = null;
  previewToken++;
  $('state').classList.remove('viewing');
  $('scrubLabel').textContent = 'Now';
  refresh(false);
  renderMap(current?.data, { animate: false });
}

const timeOf = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

(function scrubber() {
  const track = $('scrubTrack');
  let drag = null, spring = null;
  const xOf = (e) => { const r = track.getBoundingClientRect(); return (e.clientX - r.left - 8) / (r.width - 16); };
  track.addEventListener('pointerdown', (e) => {
    spring?.stop();
    track.setPointerCapture(e.pointerId);
    drag = { hist: [[e.timeStamp, xOf(e)]] };
    placeNotch(xOf(e));                // respond on press, not on release
    preview(nearest(notchX));
  });
  track.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const x = xOf(e);
    drag.hist.push([e.timeStamp, x]);
    if (drag.hist.length > 5) drag.hist.shift();
    placeNotch(x);                     // 1:1 with the pointer
    preview(nearest(notchX));
  });
  const release = () => {
    if (!drag) return;
    const [a, b] = [drag.hist[0], drag.hist[drag.hist.length - 1]];
    const v = b[0] > a[0] ? (b[1] - a[1]) / ((b[0] - a[0]) / 1000) : 0; // track widths per second
    drag = null;
    if (still) { placeNotch(1); return showNow(); }
    // Back to now with the hand's velocity, a little bounce because a drag carried momentum.
    spring = animate(notchX, 1, { type: 'spring', bounce: 0.15, duration: 0.45, velocity: v, onUpdate: placeNotch, onComplete: showNow });
  };
  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', release);
  track.addEventListener('keydown', (e) => {
    if (!ticks.length) return;
    const i = ticks.indexOf(viewing || ticks[ticks.length - 1]);
    const n = e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'End' || e.key === 'Escape' ? ticks.length - 1 : null;
    if (n == null) return;
    e.preventDefault();
    const k = ticks[Math.max(0, Math.min(ticks.length - 1, n))];
    track.setAttribute('aria-valuenow', String(ticks.indexOf(k)));
    track.setAttribute('aria-valuetext', k === ticks[ticks.length - 1] ? 'Now' : timeOf(k.t));
    placeNotch(k.x);
    preview(k);
  });
  track.addEventListener('dblclick', () => { placeNotch(1); showNow(); });
})();

// ---------- sessions and the last session ----------

function sessionRow(s) {
  const li = document.createElement('li');
  li.className = 'row';
  const txt = document.createElement('div');
  txt.className = 'txt';
  const b = document.createElement('b'); b.textContent = s.name;
  const sp = document.createElement('span'); sp.className = 'num';
  sp.textContent = `${plural(s.c.tabs, 'tab')}${s.c.windows > 1 ? ` in ${s.c.windows} windows` : ''} · ${ago(s.t)}`;
  txt.append(b, sp);
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = 'Restore';
  btn.addEventListener('click', async () => {
    const full = await db.get('sessions', s.id);
    await doRestore(full.data, full.c.tabs);
  });
  li.append(txt, btn);
  return li;
}

async function doRestore(data, n) {
  if (n > BIG_RESTORE && !confirm(`Open ${n} tabs? They open asleep, so they load only when you click them.`)) return;
  toast(`Opening ${plural(n, 'tab')}…`);
  const r = await send('restore', { payload: data, into: 'new' });
  toast(r?.error ? `Could not restore: ${r.error}` : `Opened ${plural(r.opened, 'tab')}`);
}

async function loadLists() {
  const [sessions, snaps] = await Promise.all([db.list('sessions', { limit: 4 }), db.list('snaps', { limit: 400, light: true })]);
  const ul = $('sessions');
  ul.replaceChildren(...sessions.map(sessionRow));
  $('noSessions').hidden = sessions.length > 0;
  current = snaps[0] ? await db.get('snaps', snaps[0].id) : null;
  if (!viewing) renderMap(current?.data);
  renderScrubber([...snaps].reverse());
  // "Before Chrome last closed": the newest save from an earlier run of Chrome, shown while
  // some of its tabs are not open now (Chrome restored nothing, or the wrong windows).
  const { boot } = await send('status');
  const prev = snaps.find((x) => x.boot !== boot);
  if (prev) {
    prevSnap = await db.get('snaps', prev.id);
    const open = await chrome.tabs.query({});
    const missing = prevSnap.data.windows.flatMap((w) => missingTabs(w.tabs, open, cfg)).length;
    if (missing > 0) {
      $('prev').hidden = false;
      $('prevSub').textContent = `${plural(prev.c.tabs, 'tab')} in ${plural(prev.c.windows, 'window')} · ${missing} not open now`;
    }
  }
}

$('prevRestore').addEventListener('click', () => doRestore(prevSnap.data, counts(prevSnap.data).tabs));

// ---------- actions ----------

// Consent happens on the welcome page, next to the full description of what is saved.
$('startBtn').addEventListener('click', async () => { await send('openWelcome'); window.close(); });
$('openLib').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });

$('saveSession').addEventListener('click', async () => {
  const r = await send('saveSession', {});
  if (r?.error) return toast(`Could not save: ${r.error}`);
  toast('Kept. It stays until you delete it.');
  loadLists();
});

$('sleepOthers').addEventListener('click', async () => {
  const win = await chrome.windows.getCurrent();
  const r = await send('sleep', { scope: 'others', windowId: win.id });
  toast(r.slept ? `${plural(r.slept, 'tab')} asleep. They load again when you click them.` : 'No tabs could sleep. Tabs playing sound and browser pages stay awake.');
});

async function countDupes() {
  dupeIds = (await send('duplicates'))?.ids || [];
  const b = $('dupes');
  b.disabled = !dupeIds.length;
  b.textContent = dupeIds.length ? `Close ${plural(dupeIds.length, 'duplicate')}` : 'No duplicates';
}

$('dupes').addEventListener('click', async () => {
  const n = dupeIds.length;
  await send('closeTabs', { ids: dupeIds, label: `Closed ${plural(n, 'duplicate tab')}` });
  const [item] = await db.list('trash', { limit: 1, light: true });
  toast(`Closed ${plural(n, 'duplicate')}. One copy of each page is still open.`, 'Undo', async () => {
    await send('restoreTrash', { id: item.id });
    toast('Tabs reopened');
    countDupes();
  });
  countDupes();
});

// ---------- search ----------

async function buildIndex() {
  const [open, sessions] = await Promise.all([chrome.tabs.query({}), db.all('sessions')]);
  const seen = new Set(open.map((t) => t.url));
  index = open.map((t) => ({ title: t.title, url: t.url, open: true, tabId: t.id, windowId: t.windowId, fav: t.favIconUrl }));
  for (const s of sessions) for (const w of s.data.windows) for (const t of w.tabs) {
    if (seen.has(t.url)) continue;
    seen.add(t.url);
    index.push({ title: t.title, url: t.url, where: s.name });
  }
  for (const w of current?.data.windows || []) for (const t of w.tabs) {
    if (!seen.has(t.url)) { seen.add(t.url); index.push({ title: t.title, url: t.url, where: 'Autosave' }); }
  }
}

function fav(url) {
  const img = document.createElement('img');
  img.className = 'fav';
  img.alt = '';
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', '32');
  img.src = u.href;
  return img;
}

function highlight(el, text, words) {
  const lower = text.toLowerCase();
  let i = 0;
  const marks = [];
  for (const w of words) { const at = lower.indexOf(w); if (at >= 0) marks.push([at, at + w.length]); }
  marks.sort((a, b) => a[0] - b[0]);
  for (const [a, b] of marks) {
    if (a < i) continue;
    el.append(text.slice(i, a));
    const m = document.createElement('mark'); m.textContent = text.slice(a, b); el.append(m);
    i = b;
  }
  el.append(text.slice(i));
}

let qTimer;
$('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(runSearch, 60); });
document.addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement !== $('q')) { e.preventDefault(); $('q').focus(); } });
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('results').querySelector('button.open')?.click();
  if (e.key === 'Escape' && $('q').value) { e.preventDefault(); $('q').value = ''; runSearch(); }
});

function runSearch() {
  const q = $('q').value.trim();
  $('home').hidden = !!q;
  $('results').hidden = !q;
  if (!q) return;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = search(q, index, 40);
  const box = $('results');
  box.replaceChildren();
  if (!hits.length) {
    const p = document.createElement('p'); p.className = 'none'; p.textContent = `Nothing open or saved matches "${q}".`;
    return box.append(p);
  }
  const ul = document.createElement('ul');
  for (const h of hits) {
    const li = document.createElement('li'); li.className = 'row';
    const b = document.createElement('button'); b.className = 'open';
    const txt = document.createElement('span'); txt.className = 'txt';
    const t = document.createElement('b'); highlight(t, h.title || h.url, words);
    const u = document.createElement('span'); highlight(u, h.url.replace(/^https?:\/\/(www\.)?/, ''), words);
    txt.append(t, u);
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = h.open ? 'Open' : h.where;
    b.append(fav(h.url), txt, tag);
    b.addEventListener('click', async () => {
      if (h.open) {
        await chrome.tabs.update(h.tabId, { active: true });
        await chrome.windows.update(h.windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: h.url });
      }
      window.close();
    });
    li.append(b);
    ul.append(li);
  }
  box.append(ul);
}

// ---------- footer, toast ----------

function renderBackup(s) {
  const line = $('backupLine');
  line.classList.toggle('warn', !!s.backupError);
  if (!cfg.backupOn) line.textContent = 'Backup files are off';
  else if (s.backupError) line.textContent = `Backup file failed: ${s.backupError}`;
  else line.textContent = s.backup ? `Backup file saved ${ago(s.backup)}` : 'First backup file in a few minutes';
  $('showFolder').hidden = !s.backup;
}
$('showFolder').addEventListener('click', async () => {
  const [id] = await getLocal('backups', []);
  if (id != null) chrome.downloads.show(id); else chrome.downloads.showDefaultFolder();
});

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
  toastTimer = setTimeout(() => t.classList.remove('on'), act ? 6000 : 3200);
}

// ---------- start ----------

async function refresh(pulse) {
  const s = await send('status');
  renderState(s);
  renderBackup(s);
  if (pulse) { $('state').classList.remove('pulse'); void $('state').offsetWidth; $('state').classList.add('pulse'); }
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.status) {
    const was = ch.status.oldValue?.saved, now = ch.status.newValue?.saved;
    renderState({ started: true, ...(ch.status.newValue || {}) });
    renderBackup(ch.status.newValue || {});
    if (now && now !== was) { loadLists(); countDupes(); $('state').classList.add('pulse'); }
  }
});

(async () => {
  cfg = { ...DEFAULTS, ...(await getLocal('cfg', {})) };
  await send('saveNow'); // the popup always shows the state of right now
  await refresh(false);
  await loadLists();
  countDupes();
  buildIndex();
  setInterval(() => refresh(false), 5000);
  $('q').focus();
})();
