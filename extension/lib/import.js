// Turns other tools' export files into sessions: { name, t?, data: { windows: [{ name?, tabs, groups? }] } }.
// Pure functions; the Library page reads the file and saves what comes back.
// Formats and field names come from research/competitors/TABS-TEARDOWN.md.
import { BACKUP_FORMAT, GROUP_COLORS } from './core.js';

const isUrl = (s) => /^[a-z][a-z0-9+.-]*:(\/\/)?\S+$/i.test(s || '') && !/^(javascript|data|blob):/i.test(s);

// Placeholder pages of session and suspender extensions carry the real address in a parameter.
export function unwrap(url) {
  const m = /^chrome-extension:\/\/[a-p]{32}\/.*[?&#](?:url|uri)=([^&#]+)/i.exec(url || '');
  if (!m) return url;
  try { return decodeURIComponent(m[1]); } catch { return url; }
}

// Builds one window from tab-like objects. Tabs that share a Chrome groupId but come without
// group details become one unnamed grey group, so the grouping is not lost.
function makeWindow(rawTabs, { name, groups: known = [], bounds } = {}) {
  const groups = [], gi = new Map();
  const tabs = [];
  for (const t of rawTabs) {
    const url = unwrap(String(t.url || '').trim());
    if (!isUrl(url)) continue;
    const tab = { url, title: String(t.title || url).slice(0, 500) };
    if (t.pinned === true) tab.pinned = true;
    const gid = t.groupId;
    if (gid != null && gid !== -1 && gid !== '-1') {
      if (!gi.has(gid)) {
        const g = known.find((x) => x.id === gid) || {};
        gi.set(gid, groups.length);
        groups.push({ title: g.title || '', color: GROUP_COLORS.includes(g.color) ? g.color : 'grey', collapsed: !!g.collapsed });
      }
      tab.g = gi.get(gid);
    }
    tabs.push(tab);
  }
  const w = { tabs };
  if (groups.length) w.groups = groups;
  if (name) w.name = String(name).slice(0, 120);
  if (bounds) for (const k of ['left', 'top', 'width', 'height']) if (Number.isFinite(+bounds[k]) && bounds[k] !== '') w[k] = +bounds[k];
  return w;
}

const when = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : undefined; };

export function parseImport(text, fileName = '') {
  const trimmed = String(text || '').replace(/^﻿/, '').trim();
  if (!trimmed) throw new Error('The file is empty.');
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    let json;
    try { json = JSON.parse(trimmed); } catch { json = undefined; }
    if (json !== undefined) return fromJson(json, fileName);
  }
  if (/^\s*collection\s*,/i.test(trimmed) || (/\.csv$/i.test(fileName) && /(^|,)\s*url\s*(,|$)/im.test(trimmed.split('\n')[0]))) return fromCsv(trimmed);
  if (/<a\s[^>]*href=/i.test(trimmed)) return fromHtml(trimmed, fileName);
  return fromText(trimmed, fileName);
}

function fromJson(j, fileName) {
  // Our own backup or export
  if (j?.format === BACKUP_FORMAT) {
    const out = (j.sessions || []).map((s) => ({ name: s.name, t: s.t, data: { windows: s.data.windows.map((w) => makeWindow(w.tabs.map((t) => ({ ...t, groupId: t.g })), { name: w.name, groups: (w.groups || []).map((g, i) => ({ ...g, id: i })), bounds: w })) } }));
    if (j.snapshot) out.unshift({ name: `Backup from ${new Date(j.saved || j.snapshot.t).toLocaleString()}`, t: j.saved, data: { windows: j.snapshot.windows.map((w) => makeWindow(w.tabs.map((t) => ({ ...t, groupId: t.g })), { name: w.name, groups: (w.groups || []).map((g, i) => ({ ...g, id: i })), bounds: w })) } });
    return valid(out, 'Tabkept backup');
  }
  // Tabs Outliner .tree: an operations log
  if (Array.isArray(j) && j[0]?.type === 2000) return fromTree(j);
  // Tab Manager Plus
  if (j?.format === 'tab-manager-plus-export') {
    return valid((j.sessions || []).map((s) => ({ name: s.customName || s.name || 'Imported session', t: when(s.date), data: { windows: [makeWindow(s.tabs || [], { bounds: s.windowsInfo })] } })), 'Tab Manager Plus');
  }
  // Tab Session Manager: array of sessions, windows keyed by window id, tabs keyed by tab id
  const tsm = Array.isArray(j) ? j : j?.windows && !Array.isArray(j.windows) ? [j] : null;
  if (tsm?.length && tsm.every((s) => s && s.windows && typeof s.windows === 'object' && !Array.isArray(s.windows))) {
    return valid(tsm.map((s) => ({
      name: s.name || `Imported ${new Date(when(s.date) || Date.now()).toLocaleString()}`,
      t: when(s.date),
      data: { windows: Object.entries(s.windows).map(([wid, tabs]) => makeWindow(Object.values(tabs).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)), { groups: s.tabGroups, bounds: s.windowsInfo?.[wid] })) },
    })), 'Tab Session Manager');
  }
  // Session Buddy export and backup (nxs.json.v2): collections of folders of links
  if (Array.isArray(j?.collections)) {
    const out = j.collections.map((c) => ({ name: c.title || 'Imported collection', t: when(c.created), data: { windows: (c.folders || []).map((f) => makeWindow(f.links || [], { name: f.title, bounds: f })) } }));
    const last = Array.isArray(j.history) ? [...j.history].sort((a, b) => (when(b.id) || 0) - (when(a.id) || 0))[0] : null;
    if (last) out.push({ name: 'Session Buddy: last session', t: when(last.id), data: { windows: (last.windows || []).map((w) => makeWindow(w.tabs || [], { bounds: w })) } });
    return valid(out, 'Session Buddy');
  }
  // Session Buddy 3.x: { sessions: [{ type: saved|previous|current, windows: [{ tabs }] }] }
  if (Array.isArray(j?.sessions)) {
    return valid(j.sessions.filter((s) => s.type !== 'current').map((s) => ({
      name: s.name || (s.type === 'previous' ? 'Previous session' : 'Imported session'),
      t: when(s.created || s.generated),
      data: { windows: (s.windows || []).map((w) => makeWindow(w.tabs || [], { name: w.nx_title, bounds: w })) },
    })), 'Session Buddy');
  }
  // Generic: { windows: [{ tabs }] } or a bare array of tabs
  if (Array.isArray(j?.windows)) return valid([{ name: j.name || baseName(fileName), data: { windows: j.windows.map((w) => makeWindow(w.tabs || [], { bounds: w })) } }], 'JSON');
  if (Array.isArray(j) && j.length && j.every((t) => t && isUrl(t.url))) return valid([{ name: baseName(fileName), data: { windows: [makeWindow(j)] } }], 'JSON');
  throw new Error('This JSON file is not a format Tabkept knows.');
}

function fromTree(ops) {
  // Nodes arrive depth first with their path from the root. Windows are win/savedwin nodes;
  // every tab below a window (at any depth, outliner folders flattened) belongs to it.
  const windows = [];
  let cur = null, curDepth = 0, loose = null;
  for (const op of ops) {
    const [type, node, p] = Array.isArray(op) ? op : [op.type, op.node, op.path];
    if (type !== 2001 || !node) continue;
    const kind = node.type || 'savedtab';
    const depth = (p || []).length;
    if (cur && depth <= curDepth) cur = null;
    if (kind === 'win' || kind === 'savedwin' || kind === 'waitingwin') {
      cur = { name: node.marks?.customTitle, tabs: [] };
      curDepth = depth;
      const r = String(node.data?.rect || '').split('_').map(Number);
      if (r.length === 4 && r.every(Number.isFinite)) Object.assign(cur, { top: r[0], left: r[1], width: r[2], height: r[3] });
      windows.push(cur);
    } else if (/tab$/.test(kind) && node.data?.url) {
      const t = { url: node.data.url, title: node.marks?.customTitle || node.data.title, pinned: node.data.pinned };
      if (cur) cur.tabs.push(t);
      else { if (!loose) { loose = { name: 'Tabs outside windows', tabs: [] }; windows.push(loose); } loose.tabs.push(t); }
    }
  }
  return valid([{ name: 'Imported from Tabs Outliner', data: { windows: windows.map((w) => makeWindow(w.tabs, { name: w.name, bounds: w })) } }], 'Tabs Outliner');
}

function csvRows(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  row.push(field); rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

function fromCsv(text) {
  const [head, ...rows] = csvRows(text);
  const col = (...names) => head.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const cU = col('url'), cT = col('title'), cS = col('collection', 'session'), cW = col('folder', 'window'), cP = col('pinned'), cG = col('groupid');
  if (cU < 0) throw new Error('This CSV file has no URL column.');
  const sessions = new Map();
  for (const r of rows) {
    const s = (cS >= 0 && r[cS]) || 'Imported tabs', w = (cW >= 0 && r[cW]) || 'Window 1';
    if (!sessions.has(s)) sessions.set(s, new Map());
    const ws = sessions.get(s);
    if (!ws.has(w)) ws.set(w, []);
    ws.get(w).push({ url: r[cU], title: cT >= 0 ? r[cT] : '', pinned: cP >= 0 && /^true$/i.test(r[cP]), groupId: cG >= 0 && r[cG] !== '' ? r[cG] : undefined });
  }
  return valid([...sessions].map(([name, ws]) => ({ name, data: { windows: [...ws].map(([wn, tabs]) => makeWindow(tabs, { name: /^Window \d+$/.test(wn) ? undefined : wn })) } })), 'CSV');
}

function fromHtml(html, fileName) {
  // Link pages: OneTab's HTML export, our own "Open me" page, Chrome's bookmarks export
  // (folders are <H3>, each becomes a window named after the folder).
  const windows = [];
  let tabs = [], name = '';
  const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
  const flush = () => { if (tabs.length) windows.push(makeWindow(tabs, { name })); tabs = []; };
  const re = /<a\s[^>]*href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>|<h([23])\b[^>]*>([\s\S]*?)<\/h\5>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[5]) { flush(); name = decode(m[6]).replace(/\s+\d+ tabs$/, ''); continue; }
    tabs.push({ url: decode(m[2] ?? m[3]), title: decode(m[4]) });
  }
  flush();
  const bookmarks = /NETSCAPE-Bookmark-file/i.test(html);
  return valid([{ name: bookmarks ? 'Imported bookmarks' : baseName(fileName), data: { windows } }], bookmarks ? 'bookmarks' : 'link page');
}

// OneTab text ("url | title"), Markdown links, title-then-URL pairs and plain URL lists.
// A blank line starts a new window; text lines before a URL become its title.
function fromText(text, fileName) {
  const windows = [];
  let tabs = [], pendingTitle = '';
  const flush = () => { if (tabs.length) windows.push(makeWindow(tabs)); tabs = []; pendingTitle = ''; };
  for (const raw of text.normalize('NFKC').replace(/[​-‍﻿]/g, '').replace(/ /g, ' ').split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) { flush(); continue; }
    const md = /^[-*]?\s*\[([^\]]*)\]\((\S+)\)/.exec(l);
    if (md && isUrl(md[2])) { tabs.push({ url: md[2], title: md[1] }); continue; }
    const one = /^([a-z][a-z0-9+.-]*:(?:\/\/)?\S+)(?: \| ?(.*))?$/i.exec(l);
    if (one && isUrl(one[1])) { tabs.push({ url: one[1], title: one[2]?.trim() || pendingTitle || one[1] }); pendingTitle = ''; continue; }
    const tu = /^(.*?) \| ([a-z][a-z0-9+.-]*:\/\/\S+)$/i.exec(l);
    if (tu) { tabs.push({ url: tu[2], title: tu[1] }); continue; }
    pendingTitle = l === 'Untitled' ? '' : l;
  }
  flush();
  const oneTab = /^\S+ \| /m.test(text);
  return valid([{ name: oneTab ? 'Imported from OneTab' : baseName(fileName), data: { windows } }], oneTab ? 'OneTab' : 'link list');
}

function valid(sessions, source) {
  const ok = sessions
    .map((s) => ({ ...s, data: { windows: s.data.windows.filter((w) => w.tabs.length) } }))
    .filter((s) => s.data.windows.length);
  if (!ok.length) throw new Error('No web addresses were found in this file.');
  return { source, sessions: ok };
}

const baseName = (f) => (f ? `Imported ${f.replace(/\.[a-z0-9]+$/i, '')}` : 'Imported tabs');
