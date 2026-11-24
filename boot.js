// Boot sequence for the recompiled engine.
// per-game settings come from that game's java_world.js (cfg.game); Candy Crush Friends otherwise
const GAME = Object.assign(
  { pkg: 'com.king.candycrushfriends', dirs: ['files', 'cache', 'app_storage', 'shared_prefs'], chdir: '/assets' },
  cfg.game || {}
);
const PKG = GAME.pkg;
const DATA_DIR = '/data/data/' + PKG;

function mangle(s) {
  return s.replace(/_/g, '_1').replace(/;/g, '_2').replace(/\[/g, '_3').replace(/\//g, '_');
}

const MB = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0);

const progressFor = (label, base, span) => m => {
  if (!m) return;
  if (m.type === 'inflate') {
    UI.progress(base + span, label.replace('Downloading', 'Unpacking') + '…');
    return;
  }
  const f = m.total ? m.have / m.total : 0;
  UI.progress(
    base + span * f,
    (m.type === 'retry' ? 'Connection lost, resuming… ' : label + ' ') + `${MB(m.have)} / ${MB(m.total)} MB`
  );
};

async function maybeInflateGzip(bytesLike) {
  const u8 = bytesLike instanceof Uint8Array
    ? bytesLike
    : new Uint8Array(bytesLike instanceof ArrayBuffer ? bytesLike : await new Response(bytesLike).arrayBuffer());

  if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b && typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('gzip');
    const inflated = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(inflated);
  }
  return u8;
}

async function fetchDirectBytes(url, onProgress, retries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0 && onProgress) onProgress({ type: 'retry', have: 0, total: 0 });
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

      const total = Number(res.headers.get('content-length')) || 0;
      if (!res.body || !res.body.getReader) {
        const buf = await res.arrayBuffer();
        if (onProgress) onProgress({ type: 'progress', have: buf.byteLength, total: total || buf.byteLength });
        return new Uint8Array(buf);
      }

      const reader = res.body.getReader();
      const chunks = [];
      let have = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        have += value.byteLength;
        if (onProgress) onProgress({ type: 'progress', have, total: Math.max(total, have) });
      }

      const outBuf = new Uint8Array(have);
      let offset = 0;
      for (const c of chunks) {
        outBuf.set(c, offset);
        offset += c.byteLength;
      }
      return outBuf;
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr || new Error(`Failed to fetch ${url}`);
}

async function loadGameWasmBytes(onProgress) {
  const candidates = ['game.wasm.gz', 'game.wasm'];

  for (const name of candidates) {
    if (window.AssetStore && typeof AssetStore.bytes === 'function') {
      try {
        const b = await AssetStore.bytes(name, onProgress);
        if (b && b.byteLength > 0) {
          const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
          return await maybeInflateGzip(u8);
        }
      } catch (e) {}
    }
  }

  for (const name of candidates) {
    if (window.AssetStore && typeof AssetStore.response === 'function') {
      try {
        const r = await AssetStore.response(name, 'application/wasm', onProgress);
        if (r && r.ok) {
          const buf = await r.arrayBuffer();
          if (buf.byteLength > 0) return await maybeInflateGzip(buf);
        }
      } catch (e) {}
    }
  }

  for (const url of candidates) {
    try {
      const raw = await fetchDirectBytes(url, onProgress);
      return await maybeInflateGzip(raw);
    } catch (e) {
      if (url === candidates[candidates.length - 1]) throw e;
    }
  }
  throw new Error('Could not load game.wasm.gz');
}

async function loadImageBytes(onProgress) {
  const candidates = ['image.bin.gz', 'image.bin'];

  for (const name of candidates) {
    if (window.AssetStore && typeof AssetStore.bytes === 'function') {
      try {
        const b = await AssetStore.bytes(name, onProgress);
        if (b && b.byteLength > 0) {
          const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
          return await maybeInflateGzip(u8);
        }
      } catch (e) {}
    }
  }

  for (const url of candidates) {
    try {
      const raw = await fetchDirectBytes(url, onProgress);
      return await maybeInflateGzip(raw);
    } catch (e) {
      if (url === candidates[candidates.length - 1]) throw e;
    }
  }
  throw new Error('Could not load image.bin.gz');
}

// game code: compiled straight from the stored copy, downloaded only when it changed
cfg.instantiateWasm = (imports, receive) => {
  (async () => {
    const onProgress = progressFor('Downloading game code', 0.02, 0.55);
    const wasmBytes = await loadGameWasmBytes(onProgress);
    UI.progress(0.58, 'Compiling game code…');
    const { instance, module } = await WebAssembly.instantiate(wasmBytes, imports);
    receive(instance, module);
  })().catch(e => {
    console.error(e);
    UI.fail('Could not load the game code: ' + (e && e.message || e));
  });
  return {};
};

window.boot = (async () => {
  try {
    UI.progress(0.02, 'Loading game code…');
    const M = await createGame(cfg);
    window.M = M;
    out('[page] module ready', 'o');

    const base = M._rt_reserve();
    if (!base) throw new Error('guest memory reservation failed');
    const img = await loadImageBytes(progressFor('Downloading game image', 0.6, 0.1));
    new Uint8Array(M.wasmMemory.buffer).set(img, base);
    out(`[page] guest image ${MB(img.length)} MB at 0x${base.toString(16)}`);

    // game assets: one download, kept on disk, read on demand
    const assets = await AssetStore.openAssets(progressFor('Downloading game data', 0.7, 0.2));
    const FS = M.FS;
    UI.progress(0.92, 'Preparing files…');
    M.assets = assets.mount(FS);
    out(
      `[page] assets: ${assets.index.apk ? 'APK zip at ' + assets.index.apk : assets.index.files.length + ' files'} (${assets.mode === 'disk' ? 'on disk, loaded on demand' : 'in memory'})`
    );

    // persistent app data (saves, settings) in IndexedDB
    FS.mkdirTree(DATA_DIR);
    try {
      FS.mount(M.IDBFS || FS.filesystems.IDBFS, {}, DATA_DIR);
      await new Promise(res => FS.syncfs(true, err => { if (err) out('[page] save load: ' + err, 'w'); res(); }));
    } catch (e) {
      out('[page] IDBFS unavailable: ' + e, 'w');
    }

    for (const d of [
      ...GAME.dirs.map(x => DATA_DIR + '/' + x),
      '/sdcard/Android/data/' + PKG + '/cache',
      '/sdcard/Android/data/' + PKG + '/files',
      '/tmp'
    ]) {
      FS.mkdirTree(d);
    }

    // Android system fonts: the engine draws user-typed text (town name box, town sign) with
    // the phone's fonts, found through /system/etc/fonts.xml. Without them that text is
    // invisible. Roboto Slab from the game's own APK stands in for Roboto.
    try {
      const [xml, ttf] = await Promise.all(
        ['fonts/system/fonts.xml', 'fonts/system/Roboto-Regular.ttf'].map(u =>
          fetch(u, { cache: 'no-cache' }).then(r => {
            if (!r.ok) throw new Error(u + ' ' + r.status);
            return r.arrayBuffer();
          })
        )
      );
      FS.mkdirTree('/system/etc');
      FS.mkdirTree('/system/fonts');
      FS.writeFile('/system/etc/fonts.xml', new Uint8Array(xml));
      FS.writeFile('/system/fonts/Roboto-Regular.ttf', new Uint8Array(ttf));
      const open0 = FS.open;
      FS.open = function (p, ...a) {
        if (typeof p === 'string' && p.startsWith('/system') && (window.sysOpens = window.sysOpens || []).length < 50) {
          window.sysOpens.push(p);
        }
        return open0.call(this, p, ...a);
      };
    } catch (e) {
      out('[page] system fonts: ' + e, 'w');
    }

    // saves must survive: ask the browser to never evict this site's storage, keep rolling
    // backups of the save folder, and restore the newest one if the saves vanished
    if (window.SaveGuard) await SaveGuard.start(FS, DATA_DIR, out);
    // the game's download folder (content packs) as it was at the end of the last session
    if (window.PackStore && PackStore.restore) {
      try {
        const n = await PackStore.restore(FS);
        if (n) out(`[packs] download folder restored: ${n} files`);
      } catch (e) {
        out('[packs] restore failed: ' + e, 'w');
      }
    }

    // Candy Crush opens assets with relative paths ("res_output/...")
    if (GAME.chdir) FS.chdir(GAME.chdir);

    // save to IndexedDB only after the game changed something under DATA_DIR
    let dirty = false, syncing = false, changedSinceFast = false;
    const inData = p => typeof p === 'string' && p.startsWith(DATA_DIR);
    for (const op of ['write', 'unlink', 'rename', 'mkdir', 'rmdir', 'truncate', 'ftruncate']) {
      const orig = FS[op];
      FS[op] = function (a, ...rest) {
        const p = a && typeof a === 'object' ? a.path : a;
        if (inData(p) || (op === 'rename' && inData(rest[0]))) {
          dirty = true;
          changedSinceFast = true;
          const w = window.saveWrites || (window.saveWrites = []);
          if (w.length < 500) w.push([Math.round(performance.now()), op, String(op === 'rename' ? rest[0] : p).slice(DATA_DIR.length)]);
        }
        return orig.call(this, a, ...rest);
      };
    }

    let again = false, soon = 0;
    const sync = force => {
      if (syncing) {
        again = again || dirty || !!force;
        return;
      }
      if (!dirty && !force) return;
      dirty = false;
      syncing = true;
      FS.syncfs(false, () => {
        syncing = false;
        if (again || dirty) {
          again = false;
          sync(true);
        }
      });
    };

    const syncSoon = () => {
      if (!soon) soon = setTimeout(() => { soon = 0; sync(); }, 250);
    };
    const origDirty = () => dirty;
    setInterval(() => { if (origDirty()) syncSoon(); }, 100);
    if (cfg.java) cfg.java.syncFs = () => sync(true);
    setInterval(sync, 5000);

    // Closing the tab: FS.syncfs is a chain of async steps that a closing page does not
    // finish, so the save files are written to IDBFS's own database directly, in one
    // transaction started synchronously from the close event (a connection opened ahead).
    let fastDb = null;
    try {
      const r = indexedDB.open(DATA_DIR);
      r.onsuccess = () => {
        fastDb = r.result;
        fastDb.onversionchange = () => { fastDb.close(); fastDb = null; };
      };
    } catch (e) {}

    const fastSave = () => {
      if (!fastDb) { sync(true); return; }
      try {
        const t = fastDb.transaction('FILE_DATA', 'readwrite'), st = t.objectStore('FILE_DATA');
        const keep = new Set();
        const walk = p => {
          let st0;
          try { st0 = FS.stat(p); } catch (e) { return; }
          keep.add(p);
          if (FS.isDir(st0.mode)) {
            st.put({ timestamp: st0.mtime, mode: st0.mode }, p);
            for (const n of FS.readdir(p)) if (n !== '.' && n !== '..') walk(p + '/' + n);
          } else if (FS.isFile(st0.mode)) {
            st.put({ timestamp: st0.mtime, mode: st0.mode, contents: FS.readFile(p) }, p);
          }
        };
        walk(DATA_DIR);
        changedSinceFast = false;
        const k = st.getAllKeys();
        k.onsuccess = () => { for (const key of k.result) if (!keep.has(key)) st.delete(key); };
        dirty = false;
      } catch (e) {
        sync(true);
      }
    };

    const saveAndStore = () => {
      if (window.TW_HOLD) return;
      if (cfg.java && cfg.java.saveNow) cfg.java.saveNow();
      fastSave();
    };
    if (cfg.java) cfg.java.saveAndStore = saveAndStore;
    addEventListener('pagehide', saveAndStore);
    addEventListener('visibilitychange', () => { if (document.hidden) saveAndStore(); });
    setInterval(() => { if (!window.TW_HOLD && changedSinceFast) fastSave(); }, 30000);

    // freeze log: a main-thread stall over half a second is written to the log with what the
    // game was calling just before (the page's own hooks run outside these stalls)
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          if (e.duration < 500) continue;
          out(`[freeze] main thread busy ${Math.round(e.duration)} ms`, 'w');
          if (e.duration > 1000 && M._rt_dump_main) M._rt_dump_main();
        }
      }).observe({ type: 'longtask', buffered: false });
    } catch (e) {}

    M.java_native = (cls, name) => {
      let fn = M.ccall('jni_find_native', 'number', ['string', 'string'], [cls, name]);
      if (!fn) fn = M.ccall('rt_lookup_export', 'number', ['string'], ['Java_' + mangle(cls) + '_' + mangle(name)]);
      return fn >>> 0;
    };
    // views over linear memory that stay valid after it grows
    M.heap = () => {
      const b = M.wasmMemory.buffer;
      if (!M._h8 || M._h8.buffer !== b) M._h8 = new Uint8Array(b);
      return M._h8;
    };
    M.jstr = s => M.ccall('jni_new_string', 'number', ['string'], [String(s)]);
    M.jget = h => {
      const p = M._jni_get_string(h);
      return p ? M.UTF8ToString(p) : null;
    };

    if (/[?&]trace=1/.test(location.search)) {
      M._hle_set_log(1);
      if (cfg.java) cfg.java.traceFiles = true;
    }
    if (!M._rt_gl_attach()) throw new Error('WebGL2 is not available in this browser');
    if (/[?&]glcheck=1/.test(location.search)) M._rt_gl_check(1);
    if (/[?&]nosound=1/.test(location.search) && M._rt_sl_disable) M._rt_sl_disable(1);

    UI.progress(0.96, 'Starting…');
    out('[page] running constructors ...');
    M._rt_boot();

    const env = M._jni_env_addr(), vm = M._jni_vm_addr();
    M.envAddr = env;
    M.vmAddr = vm;

    // every library's JNI_OnLoad in load order when the build lists them (jni_onload.json),
    // else the first one found
    let onloads = null;
    try {
      const r = await fetch('jni_onload.json');
      if (r.ok) onloads = await r.json();
    } catch (e) {}
    if (!onloads || !onloads.length) {
      onloads = [M.ccall('rt_lookup_export', 'number', ['string'], ['JNI_OnLoad']) >>> 0];
    }
    for (const jol of onloads) {
      const v = M._rt_call8(jol, BigInt(vm), 0n, 0n, 0n, 0n, 0n, 0n, 0n);
      out('[page] JNI_OnLoad @0x' + jol.toString(16) + ' -> 0x' + BigInt.asUintN(32, v).toString(16), 'o');
    }

    if (window.startApp) await window.startApp(M);
    UI.ready(M);
    if (window.TitleCredit) TitleCredit.init(M, cfg.java, cfg.canvas).catch(e => console.warn('[credit]', e));
  } catch (e) {
    console.error(e);
    out('[page] ' + (e && e.message || e), 'e');
    UI.fail(String(e && e.message || e));
  }
})();
