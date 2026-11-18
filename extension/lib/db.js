// Tiny IndexedDB wrapper. Each call is one transaction, and IndexedDB transactions are atomic:
// a crash mid-write leaves the previous copy untouched.
//
// Snapshots and sessions keep their tab lists in a separate store (snapdata, sessiondata), so
// listing thousands of them reads only names, times and counts. Callers never see the split:
// put/get/list/newest/all/del join and split the `data` field.
//
// Schema changes: never migrate in place. Bump VERSION only together with a step that writes a
// backup file first, copies into new stores, checks the counts, and keeps the old stores if the
// check fails (see sw.js onInstalled 'update').
const NAME = 'tabs', VERSION = 1;
const SPLIT = { snaps: 'snapdata', sessions: 'sessiondata' };
let opening = null;

export function open() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // snaps: automatic snapshots. sessions: named saves, never pruned. trash: 30-day bin.
      for (const s of ['snaps', 'sessions', 'trash']) db.createObjectStore(s, { keyPath: 'id', autoIncrement: true }).createIndex('t', 't');
      for (const s of Object.values(SPLIT)) db.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); opening = null; };
      db.onclose = () => { opening = null; };
      resolve(db);
    };
    // A failed open must be loud: the caller reports it as "saving has stopped".
    req.onerror = () => { opening = null; reject(req.error || new Error('Could not open the database')); };
    req.onblocked = () => { opening = null; reject(new Error('database blocked')); };
  });
  return opening;
}

const done = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function tx(store, mode, fn) {
  const db = await open();
  const stores = SPLIT[store] ? [store, SPLIT[store]] : [store];
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode, { durability: 'strict' });
    let out;
    Promise.resolve(fn(t.objectStore(store), SPLIT[store] ? t.objectStore(SPLIT[store]) : null)).then((v) => { out = v; }, (e) => { try { t.abort(); } catch {} reject(e); });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}

export const put = (store, value) => tx(store, 'readwrite', async (s, d) => {
  if (!d) return done(s.put(value));
  const { data, ...meta } = value;
  const id = await done(s.put(meta));
  await done(d.put({ id, data }));
  return id;
});

export const get = (store, id) => tx(store, 'readonly', async (s, d) => {
  const meta = await done(s.get(id));
  if (!meta || !d) return meta;
  return { ...meta, data: (await done(d.get(id)))?.data };
});

export const del = (store, ids) => tx(store, 'readwrite', (s, d) => { for (const id of [].concat(ids)) { s.delete(id); d?.delete(id); } });

export const all = (store) => tx(store, 'readonly', async (s, d) => {
  const metas = await done(s.getAll());
  if (!d) return metas;
  const datas = new Map((await done(d.getAll())).map((x) => [x.id, x.data]));
  return metas.map((m) => ({ ...m, data: datas.get(m.id) }));
});

// Newest first. `light` skips the tab lists (for long lists); split stores never read them then.
export async function list(store, { limit = Infinity, light = false } = {}) {
  return tx(store, 'readonly', (s, d) => new Promise((resolve, reject) => {
    const out = [];
    const req = s.index('t').openCursor(null, 'prev');
    req.onsuccess = async () => {
      const c = req.result;
      if (!c || out.length >= limit) {
        if (d && !light) {
          for (const m of out) m.data = (await done(d.get(m.id)))?.data;
        }
        return resolve(out);
      }
      const v = c.value;
      out.push(light && !d ? { ...v, data: undefined } : { ...v });
      c.continue();
    };
    req.onerror = () => reject(req.error);
  }));
}

export async function newest(store) { return (await list(store, { limit: 1 }))[0] || null; }

export async function count(store) { return tx(store, 'readonly', (s) => done(s.count())); }

// Every saved snapshot, session and bin item, gone. Backup files in Downloads are not touched.
export async function clearAll() {
  const db = await open();
  const stores = ['snaps', 'sessions', 'trash', ...Object.values(SPLIT)];
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    for (const s of stores) t.objectStore(s).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
