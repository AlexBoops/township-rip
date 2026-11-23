// Page side of the FMOD replacement (runtime/hle_fmod.c). The game talks to "FMOD"; the
// runtime keeps all FMOD state and queues what should be heard; this drains that queue
// every frame and plays it with Web Audio. Sounds are the game's own FMOD bank samples,
// converted once to Ogg Opus (tools/sound_build.py) and listed in sound/index.json.
//
// Events are matched to samples by name: event "Effects/UI/Main/ClickButton" plays sample
// "ClickButton"; when there is no exact sample, numbered variants ("PressChicken1".."4")
// are picked at random.
(() => {
  'use strict';
  // Cmd layout in hle_fmod.c: int op, obj, iarg; float f; char s[160]
  const C_PLAY = 1, C_STOP = 2, C_VOL = 3, C_PITCH = 4, C_PAUSE = 5, C_RELEASE = 6, C_VCA = 7, C_MIXER = 8,
        C_CPLAY = 9, C_CSTOP = 10, C_SOUND = 11, C_PARAM = 12, C_FADE = 13, C_LOOP = 14;
  // like FMOD's channel limit: past this many voices the oldest one-shot is cut
  const MAX_VOICES = 64, MAX_PER_SOUND = 6;
  let M = null, ctx = null, master = null, cats = {}, index = null, norm = null, buf = 0, csize = 176;
  let muted = false, started = false;
  const decoded = new Map();      // file -> Promise<AudioBuffer>
  const voices = new Map();       // obj id -> voice
  const sounds = new Map();       // core Sound obj id -> name
  const td = new TextDecoder();
  let hold = false;                // game paused (download screen / loading a save)
  const stats = { stolen: 0, gaveUp: 0, missingPaths: new Set(), streamed: 0, plays: 0, restarts: 0, missing: 0, late: 0, droppedBeforeReady: 0, failed: 0, mixer: 0, voices: 0 };

  const nkey = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  // event name -> sample. Events are usually named after their sample; when not, they differ
  // by a suffix ("BirdsLoop" plays Birds1..7, "WaterFallLoop" plays WaterFall).
  const SUFFIX = /(loop|loops|amb|ambience|sfx|sound|snd|event|single|one|short|long|full|var|v)$/;
  const pick = v => v[(Math.random() * v.length) | 0];
  function find(k) {
    if (!k) return null;
    if (norm.exact.has(k)) return norm.exact.get(k);
    const v = norm.variants.get(k);
    if (v && v.length) return pick(v);
    return null;
  }
  const lookupCache = new Map();
  function lookup(path) {
    if (!index) return null;
    const base = path.split('/').pop().replace(/\.[a-z0-9]+$/i, '');
    if (index[base]) return index[base];
    if (lookupCache.has(path)) { const c = lookupCache.get(path); return c && (Array.isArray(c) ? pick(c) : c); }
    let k = nkey(base), hit = find(k) || find(k.replace(/\d+$/, ''));
    // peel suffixes one at a time: "birdsloop" -> "birds"
    for (let s = k; !hit && SUFFIX.test(s);) { s = s.replace(SUFFIX, ''); hit = find(s) || find(s.replace(/\d+$/, '')); }
    // a sample whose name starts with the event name ("ClickBtn" -> "ClickBtn_01")
    if (!hit && k.length >= 5) {
      const pre = norm.names.filter(n => n.startsWith(k));
      if (pre.length) { const list = pre.map(n => norm.exact.get(n)); lookupCache.set(path, list); return pick(list); }
    }
    if (!hit) { lookupCache.set(path, null); stats.missingPaths.add(path); }
    return hit;
  }
  function category(path) {
    const p = path.toLowerCase();
    if (p.startsWith('music')) return 'music';
    if (p.startsWith('ambience')) return 'ambience';
    return 'sfx';
  }
  // sound files are kept in Cache Storage, so each is downloaded once per browser
  const soundCache = (async () => { try { return await caches.open('tw-sound-v1'); } catch (e) { return null; } })();
  const bytes = new Map();        // file -> Promise<ArrayBuffer> (fetched, not decoded yet)
  function fetchBytes(f) {
    let p = bytes.get(f);
    if (!p) {
      p = (async () => {
        const url = 'sound/' + f, cache = await soundCache;
        let r = cache ? await cache.match(url) : null;
        if (!r) {
          for (let tries = 0; ; tries++) {
            try { r = await fetch(url); if (r.ok) break; } catch (e) {}
            if (tries >= 2) throw new Error('sound fetch failed: ' + f);
            await new Promise(ok => setTimeout(ok, 500 * (tries + 1)));
          }
          if (cache) { try { await cache.put(url, r.clone()); } catch (e) {} }
        }
        return r.arrayBuffer();
      })();
      bytes.set(f, p);
      p.then(() => bytes.delete(f), () => bytes.delete(f));   // only in flight: Cache Storage keeps them
    }
    return p;
  }
  // decoded short sounds: least-recently-used cache within a PCM budget
  const DECODED_BUDGET = 40 * 1048576;
  let decodedBytes = 0;
  const pcmSize = b => b.length * b.numberOfChannels * 4;
  function trimDecoded() {
    for (const [f, rec] of decoded) {             // Map order = least recently used first
      if (decodedBytes <= DECODED_BUDGET) break;
      if (!rec.size) continue;                    // still decoding
      decoded.delete(f); decodedBytes -= rec.size;
    }
  }
  async function buffer(entry) {
    let rec = decoded.get(entry.f);
    if (rec) { decoded.delete(entry.f); decoded.set(entry.f, rec); return rec.p; }   // mark as recent
    rec = { size: 0, p: null };
    rec.p = fetchBytes(entry.f).then(b => ctx.decodeAudioData(b)).then(buf => {
      if (decoded.get(entry.f) === rec) { rec.size = pcmSize(buf); decodedBytes += rec.size; trimDecoded(); }
      return buf;
    });
    decoded.set(entry.f, rec);
    rec.p.catch(() => { if (decoded.get(entry.f) === rec) decoded.delete(entry.f); });
    return rec.p;
  }
  // long tracks (music, ambience beds) stream from the file instead of being decoded whole
  // (a 3-minute track is ~70 MB decoded)
  const STREAM_MS = 15000;
  // background: fetch (not decode) the always-loaded bank so first plays don't wait on the net
  async function prefetch(prefix) {
    const files = [...new Set(Object.values(index).map(e => e.f).filter(f => f.startsWith(prefix)))];
    let k = 0;
    const worker = async () => { while (k < files.length) { const f = files[k++]; try { await fetchBytes(f); } catch (e) {} } };
    await Promise.all([worker(), worker()]);
  }
  // gen: the play generation the runtime sent with the play command (0 on old runtimes)
  function ended(id, gen) { if (M) M._fmod_shim_ended(id, gen | 0); }
  // FMOD Studio loops on the event timeline (not in the samples): music, anything named
  // *Loop* and long ambience beds repeat until the game stops them. Short ambience sounds
  // (hammers, birds chirps... under Ambience/.../Background/) are one-shots the game
  // re-triggers itself: looping those stacked them up forever and the game held back new
  // sounds while it thought they were still playing.
  const loops = (path, e) => !!(e && e.loop) || /loop/i.test(path) || /^music\//i.test(path) ||
    (/^ambience\//i.test(path) && !!e && e.ms >= 8000 &&
     /background|bed|wind|sea|river|forest|amb/i.test(path.split('/').pop()));

  // a voice's gain node is disconnected as soon as the voice is done: leaving finished nodes
  // in the graph made the audio thread process thousands of them (choppy sound, memory)
  function dropVoice(v) {
    if (v.dropped) return;
    v.dropped = true;
    try { v.gain.disconnect(); } catch (e) {}
  }
  function makeVoice(id, path, kind, gen) {
    stats.voices++;
    const g = ctx.createGain();
    g.connect(cats[category(path)] || cats.sfx);
    const v = { id, gen, path, gain: g, src: null, vol: 1, rate: 1, paused: false, offset: 0, t0: 0, stopped: false, entry: null, kind };
    voices.set(id, v);
    return v;
  }
  function startSource(v, at) {
    const e = v.entry;
    const b = e && e.buf;
    if (!b || v.stopped) return;
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.playbackRate.value = v.rate;
    const looping = v.loopCount !== undefined ? v.loopCount !== 0 : loops(v.path, e);
    if (looping) {
      s.loop = true;
      if (e.loop) { s.loopStart = e.loop[0]; s.loopEnd = Math.min(e.loop[1], b.duration); }
    }
    s.connect(v.gain);
    s.onended = () => {
      if (v.src !== s) return;
      v.src = null;
      if (!v.paused && !v.stopped) { voices.delete(v.id); dropVoice(v); ended(v.id, v.gen); }
      else if (v.stopped) dropVoice(v);
    };
    v.src = s; v.t0 = ctx.currentTime - at;
    s.start(0, Math.min(at, Math.max(0, b.duration - 0.001)));
  }
  // the game is told a voice finished when it is cut to make room (FMOD's voice stealing)
  function steal(v) { stats.stolen++; stopVoice(v, true); ended(v.id, v.gen); }
  function makeRoom(path) {
    let same = 0, oldestSame = null, oldest = null;
    for (const v of voices.values()) {
      if (v.path === path) { same++; if (!oldestSame || v.born < oldestSame.born) oldestSame = v; }
      // music and looping beds are never the ones cut
      if (/^music\//i.test(v.path) || (v.src && v.src.loop) || (v.stream && v.stream.a.loop)) continue;
      if (!oldest || v.born < oldest.born) oldest = v;
    }
    if (same >= MAX_PER_SOUND && oldestSame) steal(oldestSame);
    else if (voices.size >= MAX_VOICES && oldest) steal(oldest);
  }
  function fade(v, ms, to) {
    const g = v.gain.gain, t = ctx.currentTime;
    g.cancelScheduledValues(t);
    if (ms < 0) { g.setValueAtTime(v.vol, t); return; }           // fades removed
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(v.vol * to, t + Math.max(ms, 5) / 1000);
  }
  function setLoop(v, n) {
    v.loopCount = n;
    if (v.src) v.src.loop = n !== 0;
    if (v.stream) v.stream.a.loop = n !== 0;
  }
  function play(id, path, vol, kind, gen) {
    stats.plays++;
    const old = voices.get(id);
    if (old) { stats.restarts++; stopVoice(old, true); }
    makeRoom(path);
    const e = lookup(path);
    const v = makeVoice(id, path, kind, gen);
    v.born = ctx.currentTime;
    if (kind === 'event' && loopModes.has(id)) v.loopCount = loopModes.get(id) >= 0.5 ? -1 : 0;
    v.vol = vol; v.gain.gain.value = vol;
    if (!e) {
      if (!play.warned) play.warned = new Set();
      if (!play.warned.has(path)) { play.warned.add(path); console.warn('[fmod] no sound for', path); }
      // nothing to hear: finish right away (one-shot semantics)
      stats.missing++;
      dropVoice(v);
      setTimeout(() => { if (voices.get(id) === v) { voices.delete(id); ended(id, gen); } }, 0);
      return;
    }
    if (e.ms > STREAM_MS) { stats.streamed++; streamStart(v, e); return; }
    const asked = performance.now();
    // a one-shot that can't start soon is given up (the game would otherwise see it as still
    // playing and may hold back further sounds); it is still loaded for next time
    if (!(v.loopCount !== undefined ? v.loopCount !== 0 : loops(path, e))) setTimeout(() => {
      if (voices.get(id) === v && !v.src && !v.stopped && !v.paused) {
        stats.gaveUp++; voices.delete(id); dropVoice(v); ended(id, gen);
      }
    }, 1000);
    buffer(e).then(b => {
      const late = performance.now() - asked;
      if (late > 150) stats.late++;
      if (voices.get(id) !== v || v.stopped) { stats.droppedBeforeReady++; dropVoice(v); return; }
      v.entry = { buf: b, loop: e.loop, ms: e.ms };
      if (!v.paused) startSource(v, 0);
    }, () => { stats.failed++; dropVoice(v); if (voices.get(id) === v) { voices.delete(id); ended(id, gen); } });
  }
  function streamStart(v, e) {
    const a = new Audio();
    a.preload = 'auto';
    a.src = 'sound/' + e.f;
    a.loop = v.loopCount !== undefined ? v.loopCount !== 0 : loops(v.path, e);
    a.preservesPitch = false;
    a.playbackRate = v.rate;
    const node = ctx.createMediaElementSource(a);
    node.connect(v.gain);
    v.stream = { a, node };
    a.onended = () => {
      if (v.stopped || v.paused) return;
      voices.delete(v.id); streamFree(v); ended(v.id, v.gen);
    };
    a.onerror = () => {
      stats.failed++;
      if (voices.get(v.id) === v) { voices.delete(v.id); streamFree(v); ended(v.id, v.gen); }
    };
    if (!v.paused && !hold) a.play().catch(() => {});
  }
  function streamFree(v) {
    const st = v.stream;
    if (!st) return;
    v.stream = null;
    try { st.a.pause(); } catch (e) {}
    st.a.onended = st.a.onerror = null;
    st.a.removeAttribute('src');
    try { st.a.load(); } catch (e) {}           // releases the decoder and its buffers
    try { st.node.disconnect(); } catch (e) {}
    dropVoice(v);
  }
  function stopVoice(v, immediate) {
    v.stopped = true;
    voices.delete(v.id);
    if (v.stream) {
      if (immediate) { streamFree(v); return; }
      const t = ctx.currentTime;
      v.gain.gain.setValueAtTime(v.gain.gain.value, t);
      v.gain.gain.linearRampToValueAtTime(0, t + 0.15);
      setTimeout(() => streamFree(v), 180);
      return;
    }
    const s = v.src; v.src = null;
    if (!s) { dropVoice(v); return; }
    s.onended = () => dropVoice(v);
    if (immediate) { try { s.stop(); } catch (e) {} return; }
    const t = ctx.currentTime;
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.linearRampToValueAtTime(0, t + 0.15);
    try { s.stop(t + 0.16); } catch (e) {}
  }
  function pause(v, on) {
    if (on === v.paused) return;
    v.paused = on;
    if (v.stream) { if (on) v.stream.a.pause(); else if (!hold) v.stream.a.play().catch(() => {}); return; }
    if (on && v.src) {
      v.offset = (ctx.currentTime - v.t0) * v.rate;
      const s = v.src; v.src = null; try { s.stop(); } catch (e) {}
    } else if (!on && v.entry) {
      const d = v.entry.buf.duration;
      const lp = v.loopCount !== undefined ? v.loopCount !== 0 : loops(v.path, v.entry);
      startSource(v, lp ? v.offset % d : Math.min(v.offset, d));
    }
  }
  // mix levels: FMOD Studio's own per-event mixing isn't in the samples, and the music
  // tracks are mastered much louder than the effects
  const MIX = { sfx: 1.6, ambience: 0.9, music: 0.45 };
  function vca(path, vol) {
    const p = path.toLowerCase();
    const set = (k) => { if (cats[k]) cats[k].gain.value = vol * MIX[k]; };
    if (/music/.test(p)) set('music');
    else if (/ambien/.test(p)) set('ambience');
    else if (/sound|sfx|effect/.test(p)) { set('sfx'); set('ambience'); }
    else { set('sfx'); set('ambience'); set('music'); }
  }

  const loopModes = new Map();      // instance id -> its loop_mode parameter
  let trace = null;     // debugging: FmodShim.startTrace() records every command from the game
  function drain() {
    if (!M || !M._fmod_shim_take) return;
    if (!buf) { csize = M._fmod_shim_cmd_size(); buf = M._malloc(csize * 256); }
    for (;;) {
      const n = M._fmod_shim_take(buf, 256);
      if (!n) break;
      const h = M.heap(), dv = new DataView(h.buffer);
      for (let k = 0; k < n; k++) {
        const o = buf + k * csize;
        const op = dv.getInt32(o, true), id = dv.getInt32(o + 4, true), iarg = dv.getInt32(o + 8, true), f = dv.getFloat32(o + 12, true);
        const gen = csize >= 180 ? dv.getInt32(o + 176, true) : 0;
        let e = o + 16; while (h[e] && e < o + 16 + 160) e++;
        const s = td.decode(h.slice(o + 16, e));
        const v = voices.get(id);
        if (trace) { trace.push([Math.round(performance.now()), op, id, iarg, +f.toFixed(3), s]); if (trace.length > 4000) trace.splice(0, 1000); }
        if (!ctx) { if (op === C_PLAY || op === C_CPLAY) setTimeout(() => ended(id, gen), 0); continue; }
        switch (op) {
          case C_PLAY: play(id, s, f, 'event', gen); break;
          case C_CPLAY: play(id, sounds.get(iarg) || s, csize >= 180 ? f : 1, 'channel', gen); break;
          case C_FADE: if (v) fade(v, iarg, f); break;
          case C_LOOP: if (v) setLoop(v, iarg); break;
          case C_STOP: case C_CSTOP: if (v) stopVoice(v, iarg === 1 || op === C_CSTOP); break;
          case C_VOL: if (v) { v.vol = f; v.gain.gain.setTargetAtTime(f, ctx.currentTime, 0.02); } break;
          case C_PITCH: if (v) { v.rate = f || 1; if (v.src) v.src.playbackRate.value = v.rate; if (v.stream) v.stream.a.playbackRate = v.rate; } break;
          case C_PAUSE: if (v) pause(v, !!iarg); break;
          case C_RELEASE: loopModes.delete(id); break;
          case C_VCA: vca(s, f); break;
          case C_MIXER: stats.mixer++; if (iarg) ctx.suspend(); else if (!muted) ctx.resume(); break;
          case C_SOUND: sounds.set(id, s); break;
          case C_PARAM:
            // the game's events loop while their "loop_mode" parameter is 1; set to 0 the
            // sound plays to its end and stops (trains leaving, factories going idle...)
            if (s === 'loop_mode') { loopModes.set(id, f); if (v) setLoop(v, f >= 0.5 ? -1 : 0); }
            break;
        }
      }
    }
  }

  const FmodShim = {
    // attach to the module; sound starts on the first user gesture (browser autoplay rules)
    async init(mod) {
      M = mod;
      try {
        const r = await fetch('sound/index.json');
        index = r.ok ? await r.json() : {};
      } catch (e) { index = {}; }
      norm = { exact: new Map(), variants: new Map(), names: [] };
      for (const [name, e] of Object.entries(index)) {
        const k = nkey(name);
        if (!norm.exact.has(k)) { norm.exact.set(k, e); norm.names.push(k); }
        const b = k.replace(/\d+$/, '');
        if (b !== k) { if (!norm.variants.has(b)) norm.variants.set(b, []); norm.variants.get(b).push(e); }
        if (M._fmod_shim_set_length) {
          const p = M._malloc(name.length * 3 + 1);
          M.stringToUTF8(name, p, name.length * 3 + 1);
          M._fmod_shim_set_length(p, e.ms | 0);
          M._free(p);
        }
      }
      prefetch('Init/');
      return Object.keys(index).length;
    },
    start() {
      if (started) return;
      started = true;
      ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      // the boosted effects must not clip: a gentle limiter sits before the speakers
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6; limiter.knee.value = 6; limiter.ratio.value = 12;
      limiter.attack.value = 0.003; limiter.release.value = 0.15;
      limiter.connect(ctx.destination);
      master = ctx.createGain(); master.connect(limiter);
      for (const k of ['sfx', 'ambience', 'music']) { cats[k] = ctx.createGain(); cats[k].gain.value = MIX[k]; cats[k].connect(master); }
      master.gain.value = muted ? 0 : 1;
      if (ctx.state !== 'running') ctx.resume();
    },
    setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : 1; },
    // game paused (download screen): hold all sound, resume where it was
    setPaused(p) {
      hold = p;
      if (!ctx) return;
      for (const v of voices.values()) if (v.stream && !v.paused) { if (p) v.stream.a.pause(); else v.stream.a.play().catch(() => {}); }
      if (p) ctx.suspend(); else if (!muted) ctx.resume();
    },
    // every frame
    frame() {
      drain();
      if (M && M._fmod_shim_pump) M._fmod_shim_pump();
    },
    get stats() { return Object.assign({ live: voices.size, decoded: decoded.size, decodedMB: +(decodedBytes / 1048576).toFixed(1), state: ctx && ctx.state }, stats, { missingPaths: [...stats.missingPaths] }); },
    // debugging: what is playing right now
    live() { return [...voices.values()].map(v => ({ id: v.id, path: v.path, playing: !!(v.src || v.stream), paused: v.paused, age: ctx ? +(ctx.currentTime - v.t0).toFixed(1) : 0 })); },
    startTrace() { trace = []; },
    get trace() { return trace; },
    get active() { return !!(M && M._fmod_shim_take); },
  };
  window.FmodShim = FmodShim;
})();
