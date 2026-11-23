// Keeps game saves from ever being lost.
//  - navigator.storage.persist(): the browser won't evict this site's data (IndexedDB/OPFS)
//    under storage pressure.
//  - Rolling backups of the whole app-data folder (saves, settings) in a separate IndexedDB
//    database: one at every start before the game runs, then every 10 minutes while playing;
//    the newest KEEP are kept.
//  - If the save folder is empty at start but a backup exists, the newest backup is restored
//    before the game starts.
//  - window.SaveGuard.list() / .restore(i) for manual recovery (from the log console).
(() => {
  'use strict';
  const DB = 'game-save-backups', STORE = 'snapshots', KEEP = 12, EVERY_MS = 10 * 60 * 1000;
  let FS = null, ROOT = '', log = () => {};

  const openDb = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'time' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await openDb();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode), s = t.objectStore(STORE);
      let out;
      Promise.resolve(fn(s)).then(v => { out = v; });
      t.oncomplete = () => { db.close(); res(out); };
      t.onerror = () => { db.close(); rej(t.error); };
    });
  };
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  // every file under ROOT -> {path: Uint8Array}
  function collect() {
    const files = {};
    const walk = p => {
      let names;
      try { names = FS.readdir(p); } catch (e) { return; }
      for (const n of names) {
        if (n === '.' || n === '..') continue;
        const q = p + '/' + n;
        let st;
        try { st = FS.stat(q); } catch (e) { continue; }
        if (FS.isDir(st.mode)) walk(q);
        else if (FS.isFile(st.mode)) { try { files[q] = FS.readFile(q); } catch (e) {} }
      }
    };
    walk(ROOT);
    return files;
  }
  const saveBytes = files => Object.values(files).reduce((n, b) => n + b.length, 0);

  async function snapshot(reason) {
    const files = collect();
    if (!Object.keys(files).length) return;
    const time = Date.now();
    await tx('readwrite', async s => {
      s.put({ time, reason, files });
      const keys = await req(s.getAllKeys());
      keys.sort((a, b) => a - b);
      for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) s.delete(k);
    });
    log(`[save] backup (${reason}): ${Object.keys(files).length} files, ${(saveBytes(files) / 1024).toFixed(0)} KB`);
  }

  async function list() {
    const all = await tx('readonly', s => req(s.getAll()));
    return (all || []).sort((a, b) => b.time - a.time)
      .map((b, i) => ({ i, time: new Date(b.time).toLocaleString(), reason: b.reason, files: Object.keys(b.files).length }));
  }

  async function restore(i = 0) {
    const all = (await tx('readonly', s => req(s.getAll())) || []).sort((a, b) => b.time - a.time);
    const b = all[i];
    if (!b) throw new Error('no such backup');
    for (const [p, data] of Object.entries(b.files)) {
      FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));
      FS.writeFile(p, data);
    }
    await new Promise(res => FS.syncfs(false, () => res()));
    log(`[save] restored backup from ${new Date(b.time).toLocaleString()} (${Object.keys(b.files).length} files)`);
    return b.time;
  }

  async function start(fs, root, out) {
    FS = fs; ROOT = root; log = out || log;
    // a .township save was just loaded: confirm it is what the game is starting with (and don't
    // let the empty-folder auto-restore below replace it)
    let loaded = null;
    try { loaded = await verifyAfterLoad(); } catch (e) {}
    if (loaded !== null) {
      window.dispatchEvent(new CustomEvent('tw-save-loaded', { detail: { ok: loaded } }));
    }
    try {
      if (navigator.storage && navigator.storage.persist) {
        const ok = (await navigator.storage.persisted()) || (await navigator.storage.persist());
        log(ok ? '[save] storage is persistent (browser will not evict saves)' : '[save] browser did not grant persistent storage; backups still kept', ok ? 'o' : 'w');
      }
    } catch (e) {}
    try {
      const have = collect();
      const hasSave = Object.keys(have).some(p => /\/saves\//.test(p));
      if (!hasSave) {
        const all = await list();
        if (all.length) { log('[save] save folder empty: restoring the newest backup', 'w'); await restore(0); }
      } else {
        await snapshot('start');
      }
    } catch (e) { log('[save] backup failed: ' + e, 'w'); }
    setInterval(() => { snapshot('periodic').catch(e => log('[save] backup failed: ' + e, 'w')); }, EVERY_MS);
  }

  // ------------------------------------------------------------ save files (.township)
  // Format: JSON {format, version, created, root, files: {relative path: base64}, server}
  // ("server" = the in-page game server's state, localStorage tw.server: town id/version).
  const FORMAT = 'township-web-save', SERVER_KEY = 'tw.server', CHECK_KEY = 'tw.loadcheck';
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  const same = (a, b) => { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  const digest = async files => {
    const keys = Object.keys(files).sort(), parts = [];
    for (const k of keys) parts.push(new TextEncoder().encode(k + '\0' + files[k].length + '\0'), files[k]);
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map(x => x.toString(16).padStart(2, '0')).join('');
  };

  function exportSave() {
    if (!FS) throw new Error('the game has not started yet');
    const files = collect(), out = {};
    for (const [p, data] of Object.entries(files)) out[p.slice(ROOT.length + 1)] = b64(data);
    if (!Object.keys(out).some(p => /^saves\//.test(p))) throw new Error('there is no town save yet');
    let server = null;
    try { server = localStorage.getItem(SERVER_KEY); } catch (e) {}
    return JSON.stringify({ format: FORMAT, version: 1, created: new Date().toISOString(), root: ROOT, files: out, server });
  }

  function parseSave(text) {
    let s;
    try { s = JSON.parse(text); } catch (e) { throw new Error('this is not a .township save file'); }
    if (!s || s.format !== FORMAT || !s.files || typeof s.files !== 'object') throw new Error('this is not a .township save file');
    const files = {};
    for (const [rel, data] of Object.entries(s.files)) {
      if (rel.includes('..') || rel.startsWith('/')) throw new Error('bad path in save: ' + rel);
      files[rel] = unb64(data);
    }
    if (!Object.keys(files).some(p => /^saves\//.test(p))) throw new Error('the file has no town save in it');
    return { files, server: s.server, created: s.created };
  }

  // read what IndexedDB (IDBFS, database named after the mount point) really holds
  function readIdbfs() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(ROOT);
      r.onerror = () => rej(r.error);
      r.onsuccess = () => {
        const db = r.result;
        try {
          const t = db.transaction('FILE_DATA', 'readonly'), st = t.objectStore('FILE_DATA'), got = {};
          const c = st.openCursor();
          c.onsuccess = () => {
            const cur = c.result;
            if (!cur) return;
            const v = cur.value;
            if (v && v.contents) got[cur.key] = v.contents instanceof Uint8Array ? v.contents : new Uint8Array(v.contents);
            cur.continue();
          };
          t.oncomplete = () => { db.close(); res(got); };
          t.onerror = () => { db.close(); rej(t.error); };
        } catch (e) { db.close(); rej(e); }
      };
    });
  }

  // Replace the app-data folder with a save file's contents and make sure it is in IndexedDB.
  // Throws (and leaves a backup of the previous town) if anything does not match.
  async function importSave(text, say = () => {}) {
    if (!FS) throw new Error('the game has not started yet');
    const save = parseSave(text);
    say('Backing up the current town…');
    try { await snapshot('before load'); } catch (e) {}
    say('Writing the save…');
    // clear the folder so nothing from the old town mixes in
    for (const p of Object.keys(collect())) { try { FS.unlink(p); } catch (e) {} }
    const want = {};
    for (const [rel, data] of Object.entries(save.files)) {
      const p = ROOT + '/' + rel;
      FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));
      FS.writeFile(p, data);
      want[p] = data;
    }
    // 1) in memory
    const mem = collect();
    for (const [p, data] of Object.entries(want)) if (!same(mem[p], data)) throw new Error('write failed: ' + p);
    // 2) into IndexedDB
    say('Saving to the browser…');
    await new Promise((res, rej) => FS.syncfs(false, err => err ? rej(new Error('browser storage refused the save: ' + err)) : res()));
    // 3) read IndexedDB back and compare every byte; nothing extra may be left
    say('Checking the save…');
    const idb = await readIdbfs();
    for (const [p, data] of Object.entries(want)) if (!same(idb[p], data)) throw new Error('the save did not reach browser storage: ' + p);
    const extra = Object.keys(idb).filter(p => !(p in want));
    if (extra.length) throw new Error('old files are still in browser storage: ' + extra.join(', '));
    if (save.server != null) {
      localStorage.setItem(SERVER_KEY, save.server);
      if (localStorage.getItem(SERVER_KEY) !== save.server) throw new Error('could not store the town server data');
    }
    // checked again after the reload, from what the game actually mounts
    try { sessionStorage.setItem(CHECK_KEY, JSON.stringify({ digest: await digest(want), files: Object.keys(want).length, created: save.created })); } catch (e) {}
    return Object.keys(want).length;
  }

  // after a reload that followed importSave: compare what was mounted with what was loaded
  async function verifyAfterLoad() {
    let c = null;
    try { c = JSON.parse(sessionStorage.getItem(CHECK_KEY)); sessionStorage.removeItem(CHECK_KEY); } catch (e) {}
    if (!c) return null;
    const ok = (await digest(collect())) === c.digest;
    log(ok ? `[save] loaded save verified: ${c.files} files are in place` : '[save] LOADED SAVE DOES NOT MATCH what was loaded', ok ? 'o' : 'e');
    return ok;
  }

  window.SaveGuard = { start, snapshot, list, restore, exportSave, importSave, verifyAfterLoad,
    get ready() { return !!FS; } };
})();
