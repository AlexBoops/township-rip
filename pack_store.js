// The game's download folder, backed by assets.data.
// The game keeps every content pack it "downloads" in its download folder (in memory here).
// All packs come from assets.data (fake_server.js answers the CDN from it), so the game's
// copies are dropped and read back on demand from the same ranges of assets.data (small block
// cache) - like the APK itself. The folder's state (packages.xml and which packs are there)
// is kept between sessions, because the game installs a pack only at the start after it was
// downloaded (packages.xml installOnDownload="0"), like on a phone.
(() => {
  'use strict';
  const DIR = '/sdcard/Android/data/com.playrix.township/files/saves/download';
  const BLOCK = 256 << 10, MAX_BLOCKS = 128;          // 32 MB block cache over all packs
  const packOf = name => {                            // "X.zip" / "X.zip.tmp" -> [offset, size] in assets.data
    const A = window.AssetData;
    return A && A.packs[name.replace(/\.tmp$/, '')];
  };

  // ------------------------------------------------------------ on-demand files
  const blocks = new Map();
  const stats = { packs: 0, freedMB: 0, reads: 0 };
  function block(off, size, i) {
    const key = off + i * BLOCK;                      // absolute position in assets.data
    let b = blocks.get(key);
    if (b) { blocks.delete(key); blocks.set(key, b); return b; }
    b = window.AssetData.read(key, Math.min(BLOCK, size - i * BLOCK));
    stats.reads++;
    blocks.set(key, b);
    if (blocks.size > MAX_BLOCKS) blocks.delete(blocks.keys().next().value);
    return b;
  }
  function readInto(off, size, dst, dOff, pos, len) {
    for (let done = 0; done < len;) {
      const i = Math.floor((pos + done) / BLOCK), inb = pos + done - i * BLOCK;
      const b = block(off, size, i), n = Math.min(len - done, b.length - inb);
      dst.set(b.subarray(inb, inb + n), dOff + done);
      done += n;
    }
  }
  // a MEMFS file node whose contents are assets.data[off, off+size); a write makes it a
  // normal memory file again
  function makeLazy(node, off, size) {
    const plainOps = node.stream_ops;
    const toPlain = v => { delete node.contents; node.contents = v; node.stream_ops = plainOps; node._lazy = false; };
    const whole = () => { const b = new Uint8Array(size); readInto(off, size, b, 0, 0, size); return b; };
    Object.defineProperty(node, 'contents', { configurable: true, get() { return whole(); }, set(v) { toPlain(v); } });
    node.usedBytes = size;
    node._lazy = true;
    node.stream_ops = Object.assign({}, plainOps, {
      read(stream, buffer, offset, length, position) {
        const n = Math.max(0, Math.min(length, size - position));
        if (n) readInto(off, size, buffer, offset, position, n);
        return n;
      },
      write(stream, ...a) { toPlain(whole()); stream.stream_ops = plainOps; return plainOps.write(stream, ...a); },
      mmap(stream, length, position) {
        const ptr = window.M._malloc(length), heap = window.M.heap();
        const n = Math.max(0, Math.min(length, size - position));
        if (n) readInto(off, size, heap, ptr, position, n);
        if (length > n) heap.fill(0, ptr + n, ptr + length);
        return { ptr, allocated: true };
      },
    });
  }

  // a pack the game has just written (it came from assets.data byte for byte): drop the copy
  function scan() {
    if (!window.M || !M.FS || !window.AssetData) return;
    const FS = M.FS;
    let names;
    try { names = FS.readdir(DIR); } catch (e) { return; }
    const open = new Set();
    for (const s of FS.streams) if (s && s.node) open.add(s.node);
    for (const n of names) {
      const r = packOf(n);
      if (!r || r[1] < (1 << 16)) continue;
      let node;
      try { node = FS.lookupPath(DIR + '/' + n).node; } catch (e) { continue; }
      if (!node || node._lazy || !FS.isFile(node.mode) || open.has(node) || (node.usedBytes | 0) !== r[1]) continue;
      makeLazy(node, r[0], r[1]);
      stats.packs++; stats.freedMB += Math.round(r[1] / 1048576);
    }
  }
  setInterval(scan, 3000);

  // ------------------------------------------------------------ keep the folder
  const DB = 'tw-downloads', ST = 'state';
  const db = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const idbGet = async k => { const d = await db(); return new Promise((res, rej) => { const q = d.transaction(ST).objectStore(ST).get(k); q.onsuccess = () => { d.close(); res(q.result); }; q.onerror = () => { d.close(); rej(q.error); }; }); };
  const idbPut = async (k, v) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(ST, 'readwrite'); t.objectStore(ST).put(v, k); t.oncomplete = () => { d.close(); res(); }; t.onerror = () => { d.close(); rej(t.error); }; }); };

  let lastSig = '';
  async function persist() {
    if (!window.M || !M.FS || !window.AssetData) return;
    const FS = M.FS;
    let names;
    try { names = FS.readdir(DIR).filter(n => n !== '.' && n !== '..'); } catch (e) { return; }
    const files = [];
    let sig = '';
    for (const n of names) {
      let st;
      try { st = FS.stat(DIR + '/' + n); } catch (e) { continue; }
      sig += n + ':' + st.size + ':' + st.mtime.getTime() + '|';
      const r = packOf(n);
      if (r && r[1] === st.size) files.push({ name: n, pack: n.replace(/\.tmp$/, ''), size: st.size });
      else if (st.size < (4 << 20)) files.push({ name: n, size: st.size, data: FS.readFile(DIR + '/' + n) });
    }
    if (sig === lastSig || !files.some(f => f.name === 'packages.xml')) return;
    try { await idbPut('folder2', { time: Date.now(), files }); lastSig = sig; }
    catch (e) { console.warn('[packs] keep folder', e); }
  }
  // before the game starts: rebuild the folder (packs read from assets.data on demand)
  async function restore(FS) {
    let st = null;
    try { st = await idbGet('folder2'); } catch (e) {}
    FS.mkdirTree(DIR);
    if (!st || !st.files || !window.AssetData) return 0;
    let n = 0;
    for (const f of st.files) {
      const p = DIR + '/' + f.name;
      try {
        if (f.data) { FS.writeFile(p, f.data); n++; continue; }
        const r = window.AssetData.packs[f.pack];
        if (!r || r[1] !== f.size) continue;        // pack left out or changed: the game fetches it again
        FS.writeFile(p, new Uint8Array(0));
        makeLazy(FS.lookupPath(p).node, r[0], r[1]);
        stats.packs++;
        n++;
      } catch (e) {}
    }
    return n;
  }
  // the old per-pack cache (OPFS "cdn", up to ~1 GB) is no longer used: free that space
  (async () => {
    try { await (await navigator.storage.getDirectory()).removeEntry('cdn', { recursive: true }); console.log('[packs] removed the old pack cache'); }
    catch (e) {}
  })();
  setInterval(() => { persist(); }, 15000);
  addEventListener('visibilitychange', () => { if (document.hidden) persist(); });

  window.PackStore = { scan, persist, restore, get stats() { return Object.assign({ cacheMB: Math.round(blocks.size * BLOCK / 1048576) }, stats); } };
})();
