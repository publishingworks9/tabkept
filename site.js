// Tabkept site v2: the two moments from DESIGN.md (the card stack and the ribbon scrubber),
// the popup's saving loop, the hero demo's pause, and the support links.
// Motion (motion.dev) does the springs; every animation starts from the value on screen, so all of it is interruptible.
import { animate } from './vendor/motion.mjs';
import { pausable } from './assets/ui/ui.js';

const still = matchMedia('(prefers-reduced-motion: reduce)');
const SPRING = { type: 'spring', bounce: 0, duration: 0.35 };          // DESIGN.md 7: the one default spring
const MOMENTUM = { type: 'spring', bounce: 0.15, duration: 0.4 };      // only after a drag, handed the release velocity
const go = (el, kf, opts = SPRING) => (still.matches ? animate(el, kf, { duration: 0 }) : animate(el, kf, opts));

// Links that appear once they exist. Empty means hidden (the same pattern as v1).
const SUPPORT = { sponsor: '', tip: '' };
for (const [id, url] of [['sponsorLink', SUPPORT.sponsor], ['tipLink', SUPPORT.tip]]) {
  const a = document.getElementById(id);
  if (a && url) { a.href = url; a.parentElement.hidden = false; }
}

/* ------------------------------------------------------------------ the card stack */
// Each window is an index card; its tabs are chips along the top edge. The newest window is on top.
// A chip that arrives grows in from the left of its card (scaleX); one that leaves shrinks away and is removed.
function makeStack(host, { titles = [], lines = 3, step = 13 } = {}) {
  const cards = [...host.children];   // the finished picture is in the HTML, for no script; these take it over
  const card = (i) => {
    if (cards[i]) return cards[i];
    const w = document.createElement('div');
    w.className = 'w';
    w.innerHTML = `<div class="chips"></div><div class="w__title"><span>${titles[i]?.[0] ?? ''}</span><span class="num">${titles[i]?.[1] ?? ''}</span></div><div class="w__lines">${'<i></i>'.repeat(lines)}</div>`;
    w.style.zIndex = String(10 - i);
    w.style.opacity = '0';
    host.append(w);
    return (cards[i] = w);
  };
  // index cards in a drawer: the cards behind sit a step higher and 3% narrower, so every window's tab-chips show along the top
  const place = (w, slot, show) => {
    w.style.bottom = `${-slot * step}px`;   // a card behind reaches as low as the front one, so nothing overhangs it
    return go(w, { y: -slot * step, scaleX: 1 - slot * 0.03, opacity: show ? 1 : 0 });
  };
  return function set(windows) {
    let slot = 0;
    windows.forEach((chips, i) => {
      const w = card(i), row = w.querySelector('.chips'), show = chips.length > 0;
      place(w, show ? slot : Math.max(slot, 0), show);
      if (show) slot++;
      const have = [...row.children];
      chips.forEach((g, k) => {
        let c = have[k];
        if (!c) { c = document.createElement('i'); c.className = 't'; c.style.transform = 'scaleX(0.4)'; c.style.opacity = '0'; row.append(c); }
        c.className = 't' + (g === 'pin' ? ' pin' : '') + (k === 1 && i === 0 ? ' on' : '');
        if (g && g !== 'pin') c.dataset.g = g; else delete c.dataset.g;
        if (c.dataset.out || c.style.opacity === '0') { delete c.dataset.out; go(c, { scaleX: 1, opacity: 1 }); }
      });
      have.slice(chips.length).forEach((c) => {
        if (c.dataset.out) return;
        c.dataset.out = '1';
        go(c, { scaleX: 0.4, opacity: 0 }).then(() => { if (c.dataset.out) c.remove(); });
      });
    });
  };
}

/* ------------------------------------------------------------------ the Library timeline */
const W = [
  ['pin', 'blue', 'blue', 'blue', 'blue', 'blue', '', '', 'orange', 'orange', '', '', '', '', '', '', '', '', '', ''],
  ['green', 'green', 'green', '', '', '', '', '', '', '', '', 'pink', 'pink', 'pink', '', ''],
  ['cyan', 'cyan', '', '', '', '', '', '', '', '', '', ''],
];
// minutes ago, tabs per window, kind; the rows the list shows
const LISTED = [
  [0, [17, 14, 10], 'Saved'],
  [3, [17, 14, 9], 'Saved'],
  [17, [16, 13, 9], 'Saved'],
  [55, [17, 14, 0], 'Saved'],
  [125, [16, 13, 0], 'Hourly backup'],
  [165, [15, 12, 0], 'Saved'],
  [291, [19, 16, 12], 'Before restart'],
  [865, [19, 16, 12], 'Saved'],
  [1200, [12, 10, 0], 'Saved'],
];
const NOW = new Date(2026, 10, 18, 14, 5);
const when = (ago) => {
  const d = new Date(NOW - ago * 60000), day = ago <= 14 * 60 + 5 ? 'Today' : 'Yesterday';
  return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const age = (ago) => (ago === 0 ? 'now' : ago < 60 ? `${ago}m` : ago < 1440 ? `${Math.round(ago / 60)}h` : '1d');
// The saves in between: every listed save plus the small ones around it (a tab opened or closed), seeded so every load is the same
const saves = (() => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out = LISTED.map(([ago, counts, kind], row) => ({ ago, counts, kind, row }));
  LISTED.forEach(([ago, counts], i) => {
    const next = LISTED[i + 1]?.[0] ?? 1440;
    const n = 2 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      const a = Math.round(ago + (next - ago) * (k + 1) / (n + 1));
      out.push({ ago: a, counts: counts.map((c) => (c ? Math.max(1, c - Math.floor(rnd() * 3)) : 0)), kind: 'Saved', row: -1 });
    }
  });
  return out.sort((a, b) => a.ago - b.ago);
})();
const tabsOf = (s) => s.counts.reduce((a, b) => a + b, 0);
const winsOf = (s) => s.counts.filter(Boolean).length;
const describe = (s) => `${winsOf(s)} windows · ${tabsOf(s)} tabs`;

(function timeline() {
  const list = document.getElementById('saves'), track = document.getElementById('scrub');
  if (!list || !track) return;
  const ticks = document.getElementById('ticks'), notch = document.getElementById('notch');
  const whenEl = document.getElementById('tlWhen'), whatEl = document.getElementById('tlWhat');
  const stack = makeStack(document.getElementById('tlStack'), { titles: [['Q3 launch', ''], ['Hiring round', ''], ['Reading', '']], lines: 4 });

  // the rows are in the HTML (the same markup, for no script); written again here only if missing
  if (!list.children.length) list.innerHTML = LISTED.map(([ago, counts, kind], i) => {
    const s = { counts };
    const prev = kind === 'Before restart';
    return `<li class="ui-win__row" data-row="${i}"><span class="ui-avatar" data-tone="${(i % 5) + 1}">${winsOf(s)}</span><span class="ui-win__who num">${when(ago)}${prev ? '<span class="notch" aria-hidden="true"></span>' : ''}</span><span class="ui-win__sub num">${describe(s)}</span><span class="ui-win__st${prev ? ' is-prev' : ' is-done'}" data-st>${kind}</span><span class="ui-win__age num">${age(ago)}</span></li>`;
  }).join('');
  const rows = [...list.children];

  const inset = 6;
  const span = () => track.clientWidth - inset * 2;
  const xOf = (ago) => inset + (1 - ago / 1440) * span();
  ticks.innerHTML = saves.map((s) => `<i style="left:${(1 - s.ago / 1440) * 100}%;height:${s.row >= 0 ? 12 : 6}px" class="${s.row >= 0 ? 'big' : ''}"></i>`).join('');

  let sel = 0, x = 0;
  const nearest = (px) => {
    let best = 0, d = Infinity;
    saves.forEach((s, i) => { const e = Math.abs(xOf(s.ago) - px); if (e < d) { d = e; best = i; } });
    return best;
  };
  const show = (i) => {
    if (i === sel && whenEl.dataset.ready) return;
    whenEl.dataset.ready = '1';
    sel = i;
    const s = saves[i];
    whenEl.textContent = when(s.ago);
    whatEl.textContent = describe(s);
    rows.forEach((r) => r.classList.toggle('is-picked', +r.dataset.row === s.row));
    track.setAttribute('aria-valuenow', String(i));
    track.setAttribute('aria-valuemax', String(saves.length - 1));
    track.setAttribute('aria-valuetext', `${when(s.ago)}, ${winsOf(s)} windows, ${tabsOf(s)} tabs`);
    stack(W.map((chips, k) => chips.slice(0, Math.min(chips.length, s.counts[k]))));
  };
  const setX = (px) => { x = px; notch.style.transform = `translateX(${px - 6}px)`; };
  const snapTo = (i, velocity = 0) => {
    show(i);
    const to = xOf(saves[i].ago);
    if (still.matches) return setX(to);
    animate(x, to, { ...(velocity ? MOMENTUM : SPRING), velocity, onUpdate: setX });
  };
  // a single-pointer alternative to dragging (WCAG 2.5.7): a row in the list selects its save
  rows.forEach((r) => r.addEventListener('click', () => snapTo(saves.findIndex((s) => s.row === +r.dataset.row))));
  // the start: now, at the right end
  setX(xOf(0)); show(0);
  addEventListener('resize', () => setX(xOf(saves[sel].ago)));

  // apple-design 2, 5, 6, 9: 1:1 drag with the grab offset kept, rubber-band past the ends,
  // the release projected forward by its velocity, then a spring to the nearest save carrying that velocity
  let drag = null;
  const rubber = (over, dim, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    track.setPointerCapture(e.pointerId);
    const r = track.getBoundingClientRect();
    const px = e.clientX - r.left;
    const grab = Math.abs(px - x) < 14 ? x - px : 0;   // grabbed the notch: keep where it was held
    drag = { r, grab, hist: [[performance.now(), px + grab]] };
    const to = px + grab;
    setX(to);                                          // feedback on pointer-down, never on release
    show(nearest(to));
  });
  track.addEventListener('pointermove', (e) => {
    if (!drag) return;
    let to = e.clientX - drag.r.left + drag.grab;
    const lo = inset, hi = inset + span();
    if (to < lo) to = lo + rubber(to - lo, span()); else if (to > hi) to = hi + rubber(to - hi, span());
    setX(to);
    drag.hist.push([performance.now(), to]);
    if (drag.hist.length > 6) drag.hist.shift();
    show(nearest(to));
  });
  const end = () => {
    if (!drag) return;
    const h = drag.hist, a = h[0], b = h[h.length - 1];
    const v = b[0] - a[0] > 0 ? ((b[1] - a[1]) / (b[0] - a[0])) * 1000 : 0;   // px/s
    const d = 0.99;
    const projected = x + (v / 1000) * d / (1 - d);
    drag = null;
    snapTo(nearest(projected), v);
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('dblclick', () => snapTo(0));
  track.addEventListener('keydown', (e) => {
    const k = { ArrowLeft: 1, ArrowDown: 1, ArrowRight: -1, ArrowUp: -1, Home: Infinity, End: -Infinity, PageUp: 5, PageDown: -5 }[e.key];
    if (k === undefined) return;
    e.preventDefault();
    snapTo(Math.max(0, Math.min(saves.length - 1, sel + (Number.isFinite(k) ? k : k > 0 ? saves.length : -saves.length))));
  });
})();

/* ------------------------------------------------------------------ the popup's saving loop (#saving) */
(function popup() {
  const host = document.getElementById('popStack');
  if (!host) return;
  const seal = document.getElementById('seal'), saved = document.getElementById('popSaved'), counts = document.getElementById('popCounts');
  const stack = makeStack(host, { titles: [['Q3 launch', '3 windows'], ['', ''], ['', '']], lines: 2, step: 9 });
  const base = [['pin', 'blue', 'blue', 'blue', '', ''], ['orange', 'orange', '', '', ''], ['green', 'green', '', '', '', '']];
  const extra = [[2, ''], [0, 'blue'], [1, 'orange'], [2, 'green'], [0, '']];
  let now = base.map((w) => w.slice()), step = 0, timer = 0, paused = false;
  const swapText = (next) => {
    if (saved.textContent === next) return;
    saved.classList.add('is-exit');
    setTimeout(() => { saved.textContent = next; saved.classList.remove('is-exit'); saved.classList.add('is-enter-start'); void saved.offsetHeight; saved.classList.remove('is-enter-start'); }, 150);
  };
  const render = () => {
    stack(now);
    const tabs = now.reduce((a, w) => a + w.length, 0);
    counts.textContent = `3 windows · ${tabs} tabs · 3 groups`;
  };
  render();
  if (still.matches) return;
  // One change a cycle (3.2 s): a tab opens, the seal confirms the save. After the last, the stack is rewritten to its start.
  const tick = () => {
    if (document.hidden || paused) return;
    if (step >= extra.length) { now = base.map((w) => w.slice()); step = 0; }
    else { const [wi, g] = extra[step++]; now[wi].push(g); }
    render();
    swapText('Last change saved just now');
    animate(seal, { scale: [0.82, 1] }, { type: 'spring', bounce: 0, duration: 0.4 });
    setTimeout(() => { if (!paused) swapText('Last change saved 2 s ago'); }, 1600);
  };
  timer = setInterval(tick, 3200);
  const frame = document.getElementById('pop').closest('.frame');
  pausable(frame, { pause: () => { paused = true; }, resume: () => { paused = false; } });
  frame.addEventListener('pointerenter', () => { if (!paused) { clearInterval(timer); tick(); timer = setInterval(tick, 3200); } });
})();

/* ------------------------------------------------------------------ the hero demo's pause button */
(function heroPause() {
  const box = document.querySelector('.hero__window');
  const wire = () => window.tkDemo && pausable(box, window.tkDemo);
  if (window.tkDemo) wire(); else addEventListener('tkdemo', wire, { once: true });
})();
