// Offline file store for the big downloads (game.wasm, image.bin, assets.data).
// Each file is downloaded once (resumable after a dropped connection), kept on disk
// in the browser's private file system (OPFS) and only fetched again when the server
// copy changes. Game assets inside assets.data are then read on demand; only recently
// used files stay in RAM (LRU). Without OPFS everything falls back to plain downloads.
(() => {
  const WORKER_SRC = `
    let root = null;
    async function getRoot() { return root || (root = await navigator.storage.getDirectory()); }
    // a file another page still holds (a reload, a second tab) frees up shortly: wait for it
    async function accessHandle(fh, mode) {
      for (let i = 0; ; i++) {
        try { return mode ? await fh.createSyncAccessHandle({mode}) : await fh.createSyncAccessHandle(); }
        catch (e) {
          if (mode && e instanceof TypeError) return fh.createSyncAccessHandle();   // no read-only mode in this browser
          if (e.name !== 'NoModificationAllowedError' || i >= 40) throw e;
          await new Promise(res => setTimeout(res, 250));
        }
      }
    }
    async function readOk(name) {
      try { return await (await (await (await getRoot()).getFileHandle(name + '.ok')).getFile()).text(); } catch (e) { return null; }
    }
    async function sizeOf(name) {
      try { return (await (await (await getRoot()).getFileHandle(name)).getFile()).size; } catch (e) { return -1; }
    }
    async function writeOk(name, tag) {
      const w = await (await (await getRoot()).getFileHandle(name + '.ok', {create: true})).createWritable();
      await w.write(tag); await w.close();
    }
    async function ensure(m, post) {
      const r = await getRoot();
      const tag = m.total + ':' + m.version;
      const old = await readOk(m.name);
      if (old === tag && await sizeOf(m.name) === m.total) return;   // tag and data both present
      if (old !== null) { try { await r.removeEntry(m.name + '.ok'); } catch (e) {} }
      const fh = await r.getFileHandle(m.name, {create: true});
      const h = await accessHandle(fh);
      try {
        // a partial file from an interrupted download is resumed only if it is the same version
        const partTag = await readOk(m.name + '.part');
        let have = partTag === tag ? h.getSize() : 0;
        if (have === 0 || have > m.total) { h.truncate(0); have = 0; }
        await writeOk(m.name + '.part', tag);
        let tries = 0, since = 0;
        while (have < m.total) {
          try {
            const resp = await fetch(m.url, {headers: {Range: 'bytes=' + have + '-'}, cache: 'no-store'});
            if (resp.status !== 206 && resp.status !== 200) throw new Error('HTTP ' + resp.status);
            if (resp.status === 200 && have > 0) { h.truncate(0); have = 0; }
            const rd = resp.body.getReader();
            for (;;) {
              const {done, value} = await rd.read();
              if (done) break;
              h.write(value, {at: have});
              have += value.byteLength; since += value.byteLength;
              if (since >= (1 << 20)) { since = 0; h.flush(); post({type: 'progress', id: m.id, have, total: m.total}); }
            }
            tries = 0;
          } catch (e) {
            h.flush();
            post({type: 'retry', id: m.id, have, total: m.total, error: String(e), tries: ++tries});
            await new Promise(res => setTimeout(res, Math.min(15000, 1000 * tries)));
          }
        }
        h.truncate(m.total);
        h.flush();
      } finally { h.close(); }
      await writeOk(m.name, tag);
      try { await r.removeEntry(m.name + '.part.ok'); } catch (e) {}
      post({type: 'progress', id: m.id, have: m.total, total: m.total});
    }
    // download name.gz (resumable), inflate it once into m.out, then drop the compressed copy
    async function ensureGz(m, post) {
      const r = await getRoot();
      const tag = m.total + ':' + m.version;
      const have = await readOk(m.out);
      if (have && have.startsWith(tag + '|') && await sizeOf(m.out) === +have.slice(tag.length + 1)) return;
      if (await sizeOf(m.name) !== m.total) { try { await r.removeEntry(m.name + '.ok'); } catch (e) {} }
      await ensure(m, post);
      post({type: 'inflate', id: m.id});
      const src = await (await r.getFileHandle(m.name)).getFile();
      const out = await accessHandle(await r.getFileHandle(m.out, {create: true}));
      try {
        out.truncate(0);
        const rd = src.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
        let at = 0;
        for (;;) {
          const {done, value} = await rd.read();
          if (done) break;
          out.write(value, {at});
          at += value.byteLength;
        }
        out.flush();
        var outSize = at;
      } finally { out.close(); }
      await writeOk(m.out, tag + '|' + outSize);
      for (const n of [m.name, m.name + '.ok', m.name + '.part.ok']) { try { await r.removeEntry(n); } catch (e) {} }
    }
    async function serve(m) {
      // shared read-only access: other pages (a reload, another tab) can read it too
      const h = await accessHandle(await (await getRoot()).getFileHandle(m.name), 'read-only');
      // the request block lives in the game's shared memory, so C threads can use it too
      const c = new Int32Array(m.mem, m.ctl, 8), buf = new Uint8Array(m.mem, m.data, m.dataLen);
      const tmp = new Uint8Array(m.dataLen);
      postMessage({type: 'done', id: m.id});
      for (;;) {                       // c[0]: 1 request, 2 done, 3 error; c[1] offset, c[2] length, c[3] read
        Atomics.wait(c, 0, 0);
        if (Atomics.load(c, 0) !== 1) continue;
        try {
          const n = h.read(tmp.subarray(0, c[2]), {at: c[1]});
          buf.set(tmp.subarray(0, n));
          c[3] = n;
          Atomics.store(c, 0, 2);
        } catch (e) { Atomics.store(c, 0, 3); }
        Atomics.notify(c, 0);
      }
    }
    onmessage = async ev => {
      const m = ev.data;
      try {
        if (m.cmd === 'ensure') { await ensure(m, x => postMessage(x)); postMessage({type: 'done', id: m.id}); }
        else if (m.cmd === 'ensureGz') { await ensureGz(m, x => postMessage(x)); postMessage({type: 'done', id: m.id}); }
        else if (m.cmd === 'tag') postMessage({type: 'done', id: m.id, tag: await sizeOf(m.name) > 0 ? await readOk(m.name) : null});
        else if (m.cmd === 'serve') await serve(m);
      } catch (e) { postMessage({type: 'fail', id: m.id, error: String(e)}); }
    };`;

  const READ_MAX = 8 << 20;          // per read request; larger files are read in pieces
  const CACHE_MAX = 64 << 20;        // bytes of asset files kept in RAM

  let worker = null, nextId = 1;
  const pending = new Map();
  function call(msg, onProgress) {
    if (!worker) {
      worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], {type: 'text/javascript'})));
      worker.onmessage = ev => {
        const m = ev.data, p = pending.get(m.id);
        if (!p) return;
        if (m.type === 'progress' || m.type === 'retry' || m.type === 'inflate') { if (p.onProgress) p.onProgress(m); return; }
        pending.delete(m.id);
        if (m.type === 'fail') p.reject(new Error(m.error)); else p.resolve(m);
      };
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject, onProgress});
      worker.postMessage({...msg, id});
    });
  }

  // (FileSystemSyncAccessHandle exists only inside workers, so it can't be checked here;
  //  if the worker can't use it, its calls fail and we fall back to downloads)
  const opfsOk = !!(navigator.storage && navigator.storage.getDirectory && typeof SharedArrayBuffer !== 'undefined');

  async function head(url) {
    try {
      const h = await fetch(url, {method: 'HEAD', cache: 'no-store'});
      if (h.ok) return {total: +h.headers.get('Content-Length') || 0, version: h.headers.get('Last-Modified') || h.headers.get('ETag') || ''};
    } catch (e) { /* offline */ }
    return null;
  }

  // Make sure `url` is stored on disk and current; returns its File, or null without OPFS.
  // If `url`.gz exists on the server, that is downloaded instead and inflated on disk.
  let persistAsked = false;
  async function cachedFile(url, onProgress) {
    if (!opfsOk) return null;
    if (!persistAsked) {               // big stored downloads: ask the browser not to evict them
      persistAsked = true;
      try { if (navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (e) {}
    }
    const base = url.replace(/[^\w.-]/g, '_');
    const abs = u => new URL(u, location.href).href;
    const gz = await head(url + '.gz');
    let meta = gz && gz.total ? null : await head(url);
    // A file stays locked when a crashed page (or a hung tab) still holds it: then a second
    // copy under another name is used instead of falling back to RAM.
    for (const name of [base, base + '.alt']) {
      try {
        if (gz && gz.total) {
          await call({cmd: 'ensureGz', name: name + '.gz', out: name, url: abs(url + '.gz'), ...gz}, onProgress);
        } else if (!meta || !meta.total) {
          const t = (await call({cmd: 'tag', name})).tag;    // offline: whatever is stored
          if (!t) continue;
        } else {
          await call({cmd: 'ensure', name, url: abs(url), ...meta}, onProgress);
        }
        const root = await navigator.storage.getDirectory();
        return {name, file: await (await root.getFileHandle(name)).getFile()};
      } catch (e) {
        if (!/NoModificationAllowed/.test(String(e)) || name !== base) throw e;
        console.warn('[store] ' + url + ' is locked by another page; using a second copy');
      }
    }
    return null;
  }

  // Build /assets/... in MEMFS with lazily loaded file contents.
  function mountLazy(FS, index, read, onDisk) {
    const lru = new Map();             // node -> bytes; insertion order = recency
    let cached = 0;
    const stats = {reads: 0, bytes: 0, evictions: 0};
    const load = node => {
      let b = lru.get(node);
      if (b) { lru.delete(node); lru.set(node, b); return b; }
      b = read(node._assetOff, node._assetLen);
      stats.reads++; stats.bytes += b.length;
      if (onDisk) {
        lru.set(node, b);
        cached += b.length;
        for (const [n, v] of lru) {
          if (cached <= CACHE_MAX || n === node) break;
          lru.delete(n); cached -= v.length; stats.evictions++;
        }
      }
      return b;
    };
    const dirs = new Set();
    for (const [path, off, len] of index.files) {
      const full = '/assets/' + path;
      const slash = full.lastIndexOf('/');
      const dir = full.slice(0, slash);
      if (!dirs.has(dir)) { FS.mkdirTree(dir); dirs.add(dir); }
      const node = FS.createFile(dir, full.slice(slash + 1), null, true, false);
      node._assetOff = off; node._assetLen = len;
      node.usedBytes = len;
      Object.defineProperty(node, 'contents', {
        get() { return this._own || load(this); },
        set(v) { this._own = v; },
        configurable: true,
      });
    }
    return {stats, cachedBytes: () => cached, clear: () => { lru.clear(); cached = 0; }};
  }

  // plain download (no OPFS); uses url.gz when the server has it
  async function fetchMaybeGz(url) {
    const g = await fetch(url + '.gz').catch(() => null);
    if (g && g.ok && g.body) return new Response(g.body.pipeThrough(new DecompressionStream('gzip')));
    return fetch(url);
  }

  // One big file (e.g. an engine that reads its APK zip itself): served by ranges
  // through a block cache, never loaded whole.
  function mountRanged(FS, path, size, read, onDisk) {
    const BLOCK = 256 << 10, MAXB = onDisk ? 128 : 1 << 30;   // 32 MB of blocks on disk mode
    const blocks = new Map();
    const stats = {reads: 0, bytes: 0, evictions: 0};
    const block = i => {
      let b = blocks.get(i);
      if (b) { blocks.delete(i); blocks.set(i, b); return b; }
      const off = i * BLOCK;
      b = read(off, Math.min(BLOCK, size - off));
      stats.reads++; stats.bytes += b.length;
      blocks.set(i, b);
      if (blocks.size > MAXB) { blocks.delete(blocks.keys().next().value); stats.evictions++; }
      return b;
    };
    const readInto = (dst, dOff, pos, len) => {
      let done = 0;
      while (done < len) {
        const i = Math.floor((pos + done) / BLOCK), inb = (pos + done) - i * BLOCK;
        const b = block(i), n = Math.min(len - done, b.length - inb);
        dst.set(b.subarray(inb, inb + n), dOff + done);
        done += n;
      }
    };
    const slash = path.lastIndexOf('/');
    FS.mkdirTree(path.slice(0, slash));
    const node = FS.createFile(path.slice(0, slash), path.slice(slash + 1), null, true, false);
    node.usedBytes = size;
    Object.defineProperty(node, 'contents', {   // whole-file access (rare): read it all
      get() { const b = new Uint8Array(size); readInto(b, 0, 0, size); return b; },
      set(v) {}, configurable: true,
    });
    node.stream_ops = Object.assign({}, node.stream_ops, {
      read(stream, buffer, offset, length, position) {
        const n = Math.max(0, Math.min(length, size - position));
        if (n) readInto(buffer, offset, position, n);
        return n;
      },
      mmap(stream, length, position, prot, flags) {
        const ptr = Module_.malloc(length);
        const heap = Module_.heap();
        const n = Math.max(0, Math.min(length, size - position));
        if (n) readInto(heap, ptr, position, n);
        if (length > n) heap.fill(0, ptr + n, ptr + length);
        return {ptr, allocated: true};
      },
    });
    return {stats, cachedBytes: () => blocks.size * BLOCK, clear: () => blocks.clear()};
  }
  const Module_ = {malloc: n => window.M._malloc(n), heap: () => window.M.heap()};

  async function downloadToMemory(url, onProgress) {
    const r = await fetchMaybeGz(url);
    const total = +r.headers.get('Content-Length') || 0;
    if (!total || !r.body) return new Uint8Array(await r.arrayBuffer());
    const out = new Uint8Array(total);
    const rd = r.body.getReader();
    let have = 0;
    for (;;) {
      const {done, value} = await rd.read();
      if (done) break;
      out.set(value, have); have += value.byteLength;
      onProgress({type: 'progress', have, total});
    }
    return out;
  }

  window.AssetStore = {
    opfsOk,
    // a stored file as a Response (for WebAssembly streaming compile) or null
    async response(url, type, onProgress) {
      try {
        const c = await cachedFile(url, onProgress);
        if (c) return new Response(c.file, {headers: {'Content-Type': type}});
      } catch (e) { console.warn('[store] ' + url + ':', e); }
      const r = await fetchMaybeGz(url);
      return new Response(r.body, {headers: {'Content-Type': type}});
    },
    async bytes(url, onProgress) {
      try {
        const c = await cachedFile(url, onProgress);
        if (c) return new Uint8Array(await c.file.arrayBuffer());
      } catch (e) { console.warn('[store] ' + url + ':', e); }
      return downloadToMemory(url, onProgress);
    },
    // assets.data: stored on disk and served file by file; call last (the worker then only serves reads)
    async openAssets(onProgress) {
      // never a cached index: it holds the byte positions of everything in assets.data, so an
      // old index with a new assets.data (or the reverse) makes every read land in the wrong place
      const index = await (await fetch('assets_index.json', {cache: 'no-store'})).json();
      let read = null, onDisk = false;
      try {
        const c = await cachedFile('assets.data', onProgress);
        if (c && index.total && c.file.size !== index.total)
          throw new Error(`assets.data is ${c.file.size} bytes but assets_index.json expects ${index.total} ` +
                          '(rebuilt while loading?) - reload the page');
        if (c) {
          // request block + data buffer in the game's shared memory (see runtime/hle_vfile.c):
          // [0] state [1] offset [2] length [3] bytes read [4] lock
          const Mod = window.M;
          const ctlPtr = Mod._malloc(32), dataPtr = Mod._malloc(READ_MAX);
          const mem = Mod.wasmMemory.buffer;
          const ctl = new Int32Array(mem, ctlPtr, 8), data = new Uint8Array(mem, dataPtr, READ_MAX);
          window._apkCtl = ctlPtr;     // debugging: sample [1] offset / [2] length
          ctl.fill(0);
          await call({cmd: 'serve', name: c.name, mem, ctl: ctlPtr, data: dataPtr, dataLen: READ_MAX});
          read = (offset, len) => {     // synchronous, for the file system on the main thread
            const out = new Uint8Array(len);
            while (Atomics.compareExchange(ctl, 4, 0, 1) !== 0) {}      // shared with C threads
            try {
              for (let done = 0; done < len;) {
                const n = Math.min(READ_MAX, len - done);
                ctl[1] = offset + done; ctl[2] = n;
                Atomics.store(ctl, 0, 1);
                Atomics.notify(ctl, 0);
                let st;
                while ((st = Atomics.load(ctl, 0)) === 1) {}
                if (st !== 2) { Atomics.store(ctl, 0, 0); throw new Error('asset read failed'); }
                out.set(data.subarray(0, n), done);
                Atomics.store(ctl, 0, 0);
                done += n;
              }
            } finally { Atomics.store(ctl, 4, 0); }
            return out;
          };
          if (index.apk && Mod._rt_set_apk_store) {
            const p = Mod.stringToNewUTF8 ? Mod.stringToNewUTF8(index.apk) : Mod._malloc(index.apk.length + 1);
            if (!Mod.stringToNewUTF8) Mod.stringToUTF8(index.apk, p, index.apk.length + 1);
            Mod._rt_set_apk_store(p, ctlPtr, dataPtr, READ_MAX, index.size);
          }
          onDisk = true;
        }
      } catch (e) { console.warn('[store] assets.data:', e); }
      if (!read) {
        const all = await downloadToMemory('assets.data', onProgress);
        read = (offset, len) => all.subarray(offset, offset + len);
      }
      // the content packs bundled after the APK (tools/build_assets.py): name -> [offset, size]
      window.AssetData = { read, packs: index.packs || {} };
      return {index, mode: onDisk ? 'disk' : 'memory',
              mount: FS => index.apk ? mountRanged(FS, index.apk, index.size, read, onDisk) : mountLazy(FS, index, read, onDisk)};
    },
  };
})();
