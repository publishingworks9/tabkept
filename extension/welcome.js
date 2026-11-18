import * as db from './lib/db.js';
import { animate } from './vendor/motion.mjs';
import { DEFAULTS, counts, plural } from './lib/core.js';
import { parseImport } from './lib/import.js';

const $ = (id) => document.getElementById(id);
const { started } = await chrome.storage.local.get('started');
if (started) document.body.classList.add('started');

$('start').addEventListener('click', async () => {
  const { cfg = {} } = await chrome.storage.local.get('cfg');
  await chrome.storage.local.set({ cfg: { ...DEFAULTS, ...cfg, backupOn: $('backupOn').checked } });
  await chrome.runtime.sendMessage({ type: 'start' });
  document.body.classList.add('started');
});
$('later').addEventListener('click', () => window.close());

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const { source, sessions } = parseImport(await f.text(), f.name);
    const t = Date.now();
    for (const s of sessions) await db.put('sessions', { t: s.t || t, created: t, name: s.name, c: counts(s.data), data: s.data, imported: source });
    const tabs = sessions.reduce((n, s) => n + counts(s.data).tabs, 0);
    $('impMsg').textContent = `Brought back ${plural(sessions.length, 'session')} with ${plural(tabs, 'tab')}. Open any of them from the Tabkept button or the Library.`;
  } catch (err) {
    $('impMsg').textContent = err.message;
  }
});

// One entrance: the three cards settle in from a fanned stack (critically damped, once).
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const cards = [...document.querySelectorAll('dl > div')];
  cards.forEach((c, i) => animate(c, { opacity: [0, 1], y: [14, 0], rotate: [[-1.5, 1, -1, 1.5][i] || 0, 0] }, { type: 'spring', bounce: 0, duration: 0.5, delay: i * 0.06 }));
}
