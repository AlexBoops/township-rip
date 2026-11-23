// In-page stand-in for Township's game server (no network, no server-side code: the page
// answers the game's HTTP requests itself, so any static COEP host works).
//
// Wire format (from the game's PlayrixServerClient):
//   request : POST https://township.playrix.com/api/1/<Method>?..., body =
//             AES-128-GCM(key, gzip(JSON)), header ts-id = "002" + hex(nonce12) + hex(tag16)
//   response: same encoding, ts-id header carries the response nonce/tag;
//             JSON {"result": ...} or {"error": {...}}
// The key is the client's built-in one (read from its PlayrixServerClient config in memory).
//
// State (the "server database") lives in localStorage under tw.server.
(() => {
  'use strict';
  const KEY = 'Wucai6oj0sheiX3p';
  // the game's own API hosts; analytics (stats.playrix.com) is left unanswered like offline
  const API_HOSTS = /^https:\/\/(?!stats\.)[a-z0-9-]+\.playrix\.com\//;
  const te = new TextEncoder(), td = new TextDecoder();
  let keyPromise = null;
  const aesKey = () => keyPromise || (keyPromise = crypto.subtle.importKey('raw', te.encode(KEY), 'AES-GCM', false, ['encrypt', 'decrypt']));
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  const unhex = s => { const o = new Uint8Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; };

  async function pipe(bytes, stream) {
    const s = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  const gzip = b => pipe(b, new CompressionStream('gzip'));
  const gunzip = b => pipe(b, new DecompressionStream('gzip'));

  async function openBody(tsid, body) {
    if (!body || !body.length) return null;
    if (!tsid || tsid.length < 59) return body;
    const nonce = unhex(tsid.slice(3, 27)), tag = unhex(tsid.slice(27, 59));
    const ct = new Uint8Array(body.length + 16);
    ct.set(body); ct.set(tag, body.length);
    let pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, await aesKey(), ct));
    if (pt[0] === 0x1f && pt[1] === 0x8b) pt = await gunzip(pt);
    return pt;
  }
  async function sealBody(plain, compress) {
    const data = compress ? await gzip(plain) : plain;
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, await aesKey(), data));
    const body = out.slice(0, out.length - 16), tag = out.slice(out.length - 16);
    return { body, tsid: '002' + hex(nonce) + hex(tag) };
  }

  // ---------------------------------------------------------------- content packs (CDN)
  // The game downloads its extra content (buildings, sounds, zoo...) from
  // township-cdn.playrix.com/township_gplay/<version>/<file>. Every pack the port keeps is
  // inside assets.data (tools/build_assets.py, with the manifest the game gets), so a
  // "download" is answered at once from that one file - nothing goes over the network.
  const CDN_RE = /^https:\/\/township-cdn(?:-alt)?\.playrix\.com\/township_gplay\/[0-9.]+\/([A-Za-z0-9_.\-]+)(?:\?.*)?$/;
  const NOT_FOUND = () => ({ code: 404, headers: ['content-length', '0'], body: new Uint8Array(0) });
  async function cdnFile(name, head) {
    const A = window.AssetData, r = A && A.packs[name];
    if (!r) return NOT_FOUND();                       // left out (event / ad packs) or unknown
    const data = head ? null : A.read(r[0], r[1]);
    const headers = ['content-type', 'application/octet-stream', 'content-length', String(r[1])];
    return { code: 200, headers, body: head ? new Uint8Array(0) : data };
  }

  // ---------------------------------------------------------------- state
  const STORE = 'tw.server';
  const load = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } };
  const state = load();
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { console.warn('[server] save', e); } };

  // a save from the game: keep it as-is and answer with the version the game sent
  function saveCity(req) {
    req = req || {};
    const prev = state.city;
    const id = (prev && prev.cityId) || req.cityId ||
      ('web' + Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join(''));
    const ver = req.ver !== undefined ? req.ver : (prev ? (prev.ver | 0) + 1 : 1);
    state.city = {
      cityId: id, ver, fver: req.fver !== undefined ? req.fver : (prev && prev.fver) || 0,
      xp: req.xp !== undefined ? req.xp : (prev && prev.xp) || 0,
      dKey: req.dKey || (prev && prev.dKey) || '',
      data: req.data !== undefined ? req.data : (prev && prev.data) || '',
      deviceId: req.deviceId || (prev && prev.deviceId) || '',
      name: req.name || (prev && prev.name) || '',
      saved: Date.now(),
    };
    save();
    return { cityId: id, new_cityId: prev ? undefined : id, ver };
  }

  // ---------------------------------------------------------------- methods
  // Each returns the JSON "result" (or throws {code, message} for an error reply).
  const methods = {
    // ---- the player's town ("city") on the server.
    // Reset-safe by design: the server only ever stores what this game sent and reports
    // back exactly the version the game itself last saved, so its copy can never look
    // newer than the local town, never conflicts, and is never "deleted". The local save
    // (IndexedDB + SaveGuard backups) stays the only real copy.
    FindMyCity: (req) => {
      const c = state.city;
      if (!c) return [];                    // new device: no town on the server yet
      return [{ cityId: c.cityId, ver: c.ver, fver: c.fver, xp: c.xp, name: c.name || '', deviceId: c.deviceId || '' }];
    },
    SaveToServer: (req) => saveCity(req),
    SaveCity: (req) => saveCity(req),
    CheckCity: (req) => {
      const c = state.city;
      if (!c) throw { code: 'NoCity', message: 'no city' };
      return { cityId: c.cityId, ver: c.ver, fver: c.fver, xp: c.xp, dKey: c.dKey, data: c.data };
    },
    // random towns to visit / befriend: nobody else lives on this server
    FetchRandom: () => [],
    RegisterDeviceId: (req) => {
      const c = state.city;
      if (c && req && req.deviceId) { c.deviceId = req.deviceId; save(); }
      return { cityId: c ? c.cityId : '', ok: true };
    },
    // in-app purchase receipt check: every purchase is genuine here
    ValidateIap: (req) => {
      state.iaps = state.iaps || [];
      const token = 'iap-' + Date.now().toString(36) + '-' + (state.iaps.length + 1);
      state.iaps.push({ time: Date.now(), prodId: req && req.prodId, iapId: req && req.iapId, token });
      save();
      return { isValid: true, iapToken: token, message: '' };
    },
  };
  const FakeServer = {
    log: [],
    state,
    methods,
    save,
    compressReplies: true,
    // true while game files are coming over the network (the game is paused meanwhile)
    get downloading() { return false; },   // packs come from assets.data: nothing to wait for
    // req: {url, method, type, headers: [k, v, ...], body: Uint8Array}
    // -> Promise<{code, headers: [k, v, ...], body: Uint8Array}> or null (not ours: network error)
    handle(req) {
      const url = req.url || '';
      (this.requests || (this.requests = [])).push(url);
      if (this.requests.length > 300) this.requests.shift();
      const cdn = CDN_RE.exec(url);
      if (cdn) return cdnFile(cdn[1], (req.method || 'GET').toUpperCase() === 'HEAD');
      if (!API_HOSTS.test(url)) return null;
      if (/\/404$/.test(url)) return Promise.resolve({ code: 404, headers: [], body: new Uint8Array(0) });
      const m = /\/api\/1\/([A-Za-z0-9_\/]+)/.exec(url);
      if (!m) return null;
      const name = m[1];
      if (name === 'GeoIp') return null;
      return this.call(name, req);
    },
    async call(name, req) {
      const hdr = {};
      for (let i = 0; i + 1 < (req.headers || []).length; i += 2) hdr[req.headers[i].toLowerCase()] = req.headers[i + 1];
      let params = null, raw = null;
      try {
        raw = await openBody(hdr['ts-id'], req.body);
        params = raw && raw.length ? JSON.parse(td.decode(raw)) : null;
      } catch (e) {
        console.warn('[server] cannot read request', name, e);
      }
      const entry = { name, url: req.url, params, time: Date.now() };
      this.log.push(entry);
      if (this.log.length > 200) this.log.shift();
      let reply;
      const fn = methods[name];
      if (!fn) {
        entry.unhandled = true;
        console.warn('[server] unhandled method', name, params);
        reply = { error: { code: 'NotImplemented', message: name + ' is not available offline' } };
      } else {
        try { reply = { result: await fn(params, req, hdr) }; }
        catch (e) { reply = { error: { code: e.code || 'Error', message: String(e.message || e) } }; }
      }
      entry.reply = reply;
      const sealed = await sealBody(te.encode(JSON.stringify(reply)), this.compressReplies);
      if (!state.token) { state.token = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''); save(); }
      return { code: 200, headers: ['content-type', 'application/octet-stream', 'ts-id', sealed.tsid, 'ts-token', state.token], body: sealed.body };
    },
  };
  window.FakeServer = FakeServer;
})();
