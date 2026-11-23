// Java side of Township (com.playrix.engine.* from the decompiled 9.7.5 APK), reimplemented
// for the browser. The engine reads its assets from the APK zip (Engine.getAppPath), which
// the page mounts at APK_PATH from the downloaded assets.data.
cfg.java = cfg.java || {methods: {}, fields: {}, ctors: {}, objects: {}, seen: {}};
cfg.game = {
  pkg: 'com.playrix.township',
  apk: '/data/app/com.playrix.township-1/base.apk',
  dirs: ['files', 'cache', 'shared_prefs', 'databases'],
  chdir: '/data/data/com.playrix.township',
  fill: false,         // borderless fill mode (off: user wants the border back)
};
(() => {
  const J = cfg.java, m = J.methods;
  const PKG = cfg.game.pkg;
  const DATA = '/data/data/' + PKG;
  const EXT = '/sdcard/Android/data/' + PKG;
  const M = () => cfg;
  const S = h => M().jget(h);
  const str = s => M().jstr(s);
  const E = 'com/playrix/engine/Engine';

  // ---------------------------------------------------------------- paths
  m[E + '.getAppPath'] = () => cfg.game.apk;
  m[E + '.getWriteablePath'] = () => DATA;
  m[E + '.getInternalStoragePath'] = () => DATA + '/files';
  m[E + '.getCachesPath'] = () => DATA + '/cache';
  m[E + '.getExternalStoragePath'] = () => EXT + '/files';
  m[E + '.getRemovableExternalStoragePath'] = () => '';
  m[E + '.GetAvailableSpace'] = () => 4n << 30n;

  // ---------------------------------------------------------------- app / device
  m[E + '.getAppId'] = () => PKG;
  m[E + '.getAppName'] = () => 'Township';
  m[E + '.getAppVersion'] = () => '9.7.5';
  m[E + '.getAppVersionCode'] = () => 1009750;
  m[E + '.getInstaller'] = () => 'com.android.vending';
  m[E + '.getFlavor'] = () => 'gplay';
  m[E + '.getLaunchActivityName'] = () => 'com.playrix.township.lib.GameActivity';
  m[E + '.getOsVer'] = () => '11';
  m[E + '.getVersionSDK'] = () => 30;
  m[E + '.getDeviceModel'] = () => 'Pixel 4';
  m[E + '.getDeviceManufacturer'] = () => 'Google';
  m[E + '.getDeviceAbiList'] = () => {
    const a = M().ccall('jni_new_object_array', 'number', ['number', 'string'], [1, 'java/lang/String']);
    M().ccall('jni_object_array_set', null, ['number', 'number', 'number'], [a, 0, str('arm64-v8a')]);
    return a;
  };
  const lang = (navigator.language || 'en-US').split('-');
  m[E + '.getDeviceLanguage'] = () => lang[0];
  m[E + '.getDeviceCountry'] = () => (lang[1] || 'US').toUpperCase();
  m[E + '.getDeviceScript'] = () => '';
  m[E + '.getFirstSupportedLanguage'] = () => lang[0];
  m[E + '.getFirstSupportedCountry'] = () => (lang[1] || 'US').toUpperCase();
  m[E + '.getFirstSupportedScript'] = () => '';
  const devId = () => { try { let d = localStorage.getItem('tw_devid'); if (!d) { d = crypto.randomUUID().replace(/-/g, '').slice(0, 16); localStorage.setItem('tw_devid', d); } return d; } catch (e) { return '0123456789abcdef'; } };
  m[E + '.getAndroidId'] = () => devId();
  m[E + '.getSecureAndroidId'] = () => devId();
  m[E + '.getDeviceSerialNumber'] = () => 'unknown';
  m[E + '.getDisplayPpi'] = () => 320;
  m[E + '.getDisplayRefreshRate'] = () => 60.0;
  m[E + '.getDeviceRotation'] = () => 1;
  m[E + '.getResolutionScale'] = () => 1.0;
  m[E + '.getResolutionScaleW'] = () => 1.0;
  m[E + '.getResolutionScaleH'] = () => 1.0;
  m[E + '.isDeviceTablet'] = () => false;
  m[E + '.isDevicePhablet'] = () => false;
  m[E + '.isEmulator'] = () => false;
  m[E + '.isJailbroken'] = () => false;
  m[E + '.isProductionBuild'] = () => true;
  m[E + '.isInteractive'] = () => true;
  m[E + '.isPackageInstalled'] = () => false;
  m[E + '.hasVibrator'] = () => !!navigator.vibrate;
  m[E + '.performHapticFeedback'] = () => {};
  m[E + '.getLongPressTimeout'] = () => 500;
  m[E + '.getScaledTouchSlop'] = () => 8;
  m[E + '.GetCurrentThreadPriority'] = () => 0;
  m[E + '.SetCurrentThreadPriority'] = () => true;
  // Report Wi-Fi: with "no network" a returning player gets a blocking "No internet
  // connection [Try again]" dialog; with a network whose server can't be reached the
  // game offers "can't connect to the server -> OK" and continues offline.
  J.netState = J.netState === undefined ? (/[?&]net=0/.test(location.search) ? 0 : 1) : J.netState;
  m[E + '.getConnectedNetworks'] = () => J.netState;
  m[E + '.getConnectedNetworksDeprecated'] = () => J.netState;
  m[E + '.getClipboardContent'] = () => '';
  m[E + '.registerThermalStatusListener'] = () => {};
  m[E + '.checkDisplayChanged'] = () => {};
  // the engine queues work for its GL thread (e.g. dialog results) and asks Java to run
  // nativeExecuteGlThread there; our GL thread is the frame loop
  m[E + '.executeGlThread'] = () => { J.later.push(() => callStatic(E, 'nativeExecuteGlThread')); };
  m[E + '.enableTls12'] = () => {};
  m[E + '.CloseApplication'] = () => { console.log('[app] CloseApplication'); };
  let lastError = '';
  m[E + '.GetLastError'] = () => lastError;
  m[E + '.SetLastError'] = (self, [s]) => { lastError = S(s) || ''; };
  m[E + '.ClearLastError'] = () => { lastError = ''; };

  // ---------------------------------------------------------------- network: offline, like a phone with no connection
  // httpRequestAsync accepts the request, then okhttp's onFailure reports it as failed
  J.httpLog = J.httpLog || [];
  // The engine fills HttpRequest fields with SetObjectField and then deletes its local
  // refs (Java would keep the strings alive through the field), so copy each value the
  // moment it is stored.
  const arrBytes = h => {
    const n = M().ccall('jni_array_length', 'number', ['number'], [h]);
    const p = M().ccall('jni_array_data', 'number', ['number'], [h]);
    return M().heap().slice(p, p + n);
  };
  const arrStrings = h => {
    const n = M().ccall('jni_array_length', 'number', ['number'], [h]), out = [];
    for (let i = 0; i < n; i++) { const e = M()._jni_object_array_get(h, i); out.push(e ? S(e) : null); }
    return out;
  };
  J.ctors['com/playrix/engine/HttpManager$HttpRequest'] = function (h) {
    const snap = {};
    J.objects[h] = new Proxy({}, {
      set(t, k, v) {
        t[k] = v;
        try {
          if (k === 'url' || k === 'method' || k === 'contentType') snap[k] = v ? S(v) : null;
          else if (k === 'content') snap.content = v ? arrBytes(v) : null;
          else if (k === 'headers') snap.headers = v ? arrStrings(v) : [];
        } catch (e) { console.warn('[http] field copy', k, e); }
        return true;
      },
    });
    J.httpSnaps = J.httpSnaps || {};
    J.httpSnaps[h] = snap;
  };
  const describeRequest = (req) => {
    const s = (J.httpSnaps || {})[req] || {};
    if (J.httpSnaps) delete J.httpSnaps[req];
    return { url: s.url || null, method: s.method || null, type: s.contentType || null,
             headers: s.headers || [], body: s.content || null };
  };
  m['com/playrix/engine/HttpManager.httpRequestAsync'] = (self, [id, req]) => {
    const r = describeRequest(req);
    J.httpLog.push(r);
    out('[http] ' + (r.method || 'GET') + ' ' + r.url + (r.body ? ' (' + r.body.length + ' bytes)' : ''));
    const fail = () => J.later.push(() => {
      if (cancelled.delete(String(id))) return;
      callStatic(HM, 'nativeHttpRequestFinished', id, -1, str('java.net.UnknownHostException: offline'));
    });
    const answer = window.FakeServer && window.FakeServer.handle(r);
    if (!answer) { fail(); return true; }
    answer.then(res => J.later.push(() => deliverResponse(id, res)), e => { console.warn('[server]', e); fail(); });
    return true;
  };
  // an okhttp response, delivered the way HttpManager's callback does: headers, body chunks, finish
  const HM = 'com/playrix/engine/HttpManager';
  const cancelled = new Set();
  const deliverResponse = (id, res) => {
    if (cancelled.delete(String(id))) return;
    const hs = res.headers || [];
    const arr = M().ccall('jni_new_object_array', 'number', ['number', 'string'], [hs.length, 'java/lang/String']);
    hs.forEach((s, i) => M()._jni_object_array_set(arr, i, str(s)));
    callStatic(HM, 'nativeHttpRequestOnHeaders', id, res.code, arr, BigInt(Date.now()));
    const body = res.body || new Uint8Array(0);
    for (let off = 0; off < body.length; off += 65536) {
      const chunk = body.subarray(off, Math.min(body.length, off + 65536));
      const p = M()._malloc(chunk.length);
      M().heap().set(chunk, p);
      const ba = M()._jni_new_byte_array(p, chunk.length);
      M()._free(p);
      callStatic(HM, 'nativeHttpRequestOnAppendContent', id, ba, chunk.length);
    }
    callStatic(HM, 'nativeHttpRequestFinished', id, res.code, str(res.code === 200 ? 'OK' : 'Not Found'));
  };
  m['com/playrix/engine/HttpManager.cancelRequest'] = (self, [id]) => { cancelled.add(String(id)); };

  // ---------------------------------------------------------------- callbacks Android delivers later
  const callStatic = (cls, name, ...args) => {
    const f = M().java_native(cls, name);
    if (!f) { console.warn('[tw] no native', cls + '.' + name); return; }
    const k = BigInt(M().ccall('jni_find_class', 'number', ['string'], [cls]));
    const a = args.map(BigInt);
    while (a.length < 6) a.push(0n);
    M()._rt_call8(f, BigInt(M().envAddr), k, ...a);
  };
  // ---------------------------------------------------------------- system dialogs (android AlertDialog)
  // The engine blocks on these (e.g. connection or account messages) until a button is
  // chosen; shown over the game with the engine's own title, text and buttons.
  const SD = 'com/playrix/engine/SystemDialog';
  let dialogEl = null;
  const closeDialog = () => { if (dialogEl) { dialogEl.remove(); dialogEl = null; } };
  m[SD + '.isPresent'] = () => !!dialogEl;
  m[SD + '.close'] = () => closeDialog();
  m[SD + '.show'] = (self, [t, msg, arr, cancelable, pause, id]) => {
    const title = t ? S(t) : '', text = msg ? S(msg) : '';
    const labels = [];
    const n = arr ? M().ccall('jni_array_length', 'number', ['number'], [arr]) : 0;
    for (let i = 0; i < n; i++) {
      const h = M()._jni_object_array_get ? M()._jni_object_array_get(arr, i) : 0;
      labels.push(h ? S(h) : (n === 1 ? 'OK' : 'Button ' + (i + 1)));
    }
    out('[app] dialog: ' + title + ' | ' + text + ' | [' + labels.join(', ') + ']');
    try {   // which game code asked (lifted function names on the wasm stack)
      Error.stackTraceLimit = 40;
      out('[app] dialog from: ' + (new Error().stack || '').split('\n').map(l => (/(f_[0-9a-f]+)/.exec(l) || [])[1]).filter(Boolean).join(' <- '));
    } catch (e) {}
    // Playrix's Dialog buttons don't dismiss: the engine closes the dialog itself
    // (SystemDialog.close) once a choice is final, so link buttons such as
    // "Terms of Use" leave it open. Only a cancel (tap outside) closes it here.
    const answer = i => {
      if (i < 0) closeDialog();
      out('[app] dialog button ' + i + (i >= 0 ? ' (' + labels[i] + ')' : ' (cancel)'));
      J.later.push(() => callStatic(SD, 'buttonClickHandler', i, id));
    };
    if (dialogEl) { J.later.push(() => callStatic(SD, 'buttonClickHandler', -1, id)); return; }
    const host = (cfg.canvas && cfg.canvas.parentElement) || document.body;
    dialogEl = document.createElement('div');
    dialogEl.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);z-index:20;font:15px system-ui,sans-serif';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;color:#222;border-radius:10px;max-width:min(420px,90%);padding:20px 22px 12px;box-shadow:0 10px 40px rgba(0,0,0,.4)';
    if (title) { const h = document.createElement('div'); h.textContent = title; h.style.cssText = 'font-weight:600;font-size:17px;margin-bottom:10px'; box.appendChild(h); }
    const p = document.createElement('div'); p.textContent = text; p.style.cssText = 'white-space:pre-wrap;line-height:1.4;margin-bottom:14px'; box.appendChild(p);
    const row = document.createElement('div'); row.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap';
    labels.forEach((l, i) => {
      const b = document.createElement('button'); b.textContent = l;
      b.style.cssText = 'background:none;border:0;color:#1a73e8;font:600 14px system-ui,sans-serif;text-transform:uppercase;padding:8px 10px;cursor:pointer';
      b.onclick = () => answer(i); row.appendChild(b);
    });
    box.appendChild(row); dialogEl.appendChild(box);
    if (cancelable) dialogEl.onclick = e => { if (e.target === dialogEl) answer(-1); };
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(dialogEl);
  };

  // Facebook: no Facebook SDK or signed-in account here. Requests carry a request id and
  // are answered on the GL thread like the SDK does when nobody is logged in
  // (nativeOnFinishRequest result: 0 ok, 1 canceled, 2 failed, 3 connection error).
  const FB = 'com/playrix/engine/EngineFacebook';
  const fbFinish = (id, res) => J.later.push(() => callStatic(FB, 'nativeOnFinishRequest', id, res, 0));
  m[FB + '.silentLogin'] = (self, [id]) => fbFinish(id, 2);
  m[FB + '.loginForPermissions'] = (self, [id]) => fbFinish(id, 3);
  m[FB + '.reauthorizeDataAccess'] = (self, [id]) => fbFinish(id, 3);
  m[FB + '.refreshAccessToken'] = (self, [id]) => { fbFinish(id, 3); return true; };
  m[FB + '.request'] = (self, [id]) => fbFinish(id, 3);
  m[FB + '.messageWithDialog'] = (self, [id]) => fbFinish(id, 3);
  m[FB + '.postWithDialog'] = (self, [id]) => fbFinish(id, 3);
  // asked once the town scene is up: the loading screen is gone (hide the page's credit line)
  m[FB + '.processDeferredDeeplink'] = (self, [id]) => {
    if (window.TWExtras) TWExtras.hideCredit();
    J.later.push(() => callStatic(FB, 'nativeOnDeferredAppLinkDataFetched', id, 0));
  };
  m[FB + '.isLoggedIn'] = () => false;

  // ---------------------------------------------------------------- in-app purchases
  // A Google Play store that grants everything: products are listed as free and every
  // purchase succeeds immediately; the receipt is then validated by the page's fake
  // server (fake_server.js, ValidateIap), which approves it.
  const EB = 'com/playrix/engine/EngineBilling';
  const ITEM = EB + '$ItemDetails', PURCHASE = EB + '$PurchaseDetails';
  const newObj = (cls, fields) => {
    const h = M().ccall('jni_java_object', 'number', ['string'], [cls]);
    J.objects[h] = Object.assign(J.objects[h] || {}, fields);
    return h;
  };
  const objArray = (cls, items) => {
    const a = M().ccall('jni_new_object_array', 'number', ['number', 'string'], [items.length, cls]);
    items.forEach((h, i) => M()._jni_object_array_set(a, i, h));
    return a;
  };
  // fields hold JS values; a String getter returns a fresh Java string each call
  const jfield = (self, k) => (J.objects[self] || {})[k];
  for (const [g, k] of [['getSku', 'sku'], ['getPrice', 'price'], ['getPriceNumeric', 'priceNumeric'], ['getTitle', 'title'],
                         ['getDescr', 'descr'], ['getCurrencyCode', 'currency'], ['getOwnInfo', 'owned']])
    m[ITEM + '.' + g] = self => jfield(self, k);
  for (const [g, k] of [['getSku', 'sku'], ['getOrderId', 'orderId'], ['getQuantity', 'quantity'], ['getData', 'data'],
                         ['getDataSignature', 'signature'], ['getPayload', 'payload'], ['getAcknowledged', 'acknowledged']])
    m[PURCHASE + '.' + g] = self => jfield(self, k);
  const purchases = J.purchases = J.purchases || {};     // token -> details (until consumed)
  const purchaseObj = p => newObj(PURCHASE, {
    sku: p.sku, orderId: p.orderId, quantity: 1, data: p.data, signature: p.signature,
    payload: p.payload || '', acknowledged: p.acknowledged ? 1 : 0 });
  const billing = {
    marketInitialize: (self, [id]) => { J.later.push(() => callStatic(EB, 'nativeOnMarketInitializeFinished', id, 0)); },
    marketStatus: () => 0,
    marketDisconnect: () => {},
    marketCancelRequest: () => {},
    marketRequestProducts: (self, [id, skus]) => {
      const list = skus ? arrStrings(skus) : [];
      out('[billing] products: ' + list.join(', '));
      J.later.push(() => {
        const items = list.map(s => newObj(ITEM, { sku: s, price: 'Free', priceNumeric: 0, title: s,
                                                   descr: '', currency: 'USD', owned: 0 }));
        callStatic(EB, 'nativeOnMarketProductsResponse', id, objArray(ITEM, items), 1);
      });
    },
    marketRequestActivePurchases: (self, [id]) => {
      J.later.push(() => {
        const items = Object.values(purchases).map(purchaseObj);
        callStatic(EB, 'nativeOnMarketActivePurchasesResponse', id, objArray(PURCHASE, items), 1);
      });
    },
    marketRequestPurchase: (self, [id, sku, s2, payload]) => {
      const p = { sku: S(sku), payload: payload ? S(payload) : '', acknowledged: false };
      const n = (J.orderSeq = (J.orderSeq || 0) + 1) + Date.now();
      p.orderId = 'GPA.0000-0000-0000-' + String(n).slice(-5);
      p.token = 'free' + n.toString(36);
      p.data = JSON.stringify({ orderId: p.orderId, packageName: cfg.game.pkg, productId: p.sku, purchaseTime: Date.now(),
                                purchaseState: 0, purchaseToken: p.token, quantity: 1, acknowledged: false });
      p.signature = 'free';
      purchases[p.token] = p;
      out('[billing] purchase ' + p.sku + ' -> granted (' + p.orderId + ')');
      J.later.push(() => callStatic(EB, 'nativeOnMarketPurchaseResponse', id, purchaseObj(p), 0));
    },
    marketConsumeProduct: (self, [id, sku, token]) => {
      const t = token ? S(token) : '';
      const p = purchases[t] || Object.values(purchases).find(x => x.sku === (sku ? S(sku) : ''));
      if (p) delete purchases[p.token];
      J.later.push(() => callStatic(EB, 'nativeOnMarketConsumeResponse', id, p ? purchaseObj(p) : 0, 0));
    },
    marketAcknowledgeProduct: (self, [id, sku, token]) => {
      const t = token ? S(token) : '';
      const p = purchases[t] || Object.values(purchases).find(x => x.sku === (sku ? S(sku) : ''));
      if (p) p.acknowledged = true;
      J.later.push(() => callStatic(EB, 'nativeOnMarketAcknowledgeResponse', id, p ? purchaseObj(p) : 0, 0));
    },
  };
  for (const [k, f0] of Object.entries(billing)) {
    const f = function (self, args, info) {
      if (k !== 'marketStatus') out('[billing] ' + k + '(' + [...args].map(a => typeof a === 'bigint' ? a.toString() : a).join(', ') + ')');
      return f0.call(this, self, args, info);
    };
    m['com/playrix/gplay/Billing.' + k] = f;
    m[EB + '$IBilling.' + k] = f;
  }
  m[EB + '.getStoreType'] = () => 1;                       // Google Play
  m['com/playrix/engine/MarketCreator.create'] = () => newObj('com/playrix/gplay/Billing', {});

  // ---------------------------------------------------------------- text input (osk.js)
  // The engine's text field lives in Java (DummyEdit): it sets the text with setInputText and
  // shows/hides the soft keyboard with toggleKeyboard; edits go back as nativeTextFieldChanged
  // (text, selStart, selEnd, changeId, fieldId), Enter as nativeVirtualKeyDown(66 = KEYCODE_ENTER).
  const KM = 'com/playrix/engine/KeyboardManager';
  const kb = { field: 0n, change: 0n };
  if (window.OSK) {
    OSK.onChange = (t, s, e) => {
      kb.change += 1n;
      const ch = kb.change, fld = kb.field;
      J.later.push(() => callStatic(KM, 'nativeTextFieldChanged', str(t), s, e, ch, fld));
    };
    OSK.onEnter = () => J.later.push(() => callStatic(KM, 'nativeVirtualKeyDown', 66));
    OSK.onHide = () => J.later.push(() => {
      callStatic(KM, 'nativeKeyboardImeChangeVisibility', 0);
      callStatic(KM, 'nativeKeyboardHide');
    });
  }
  m[KM + '.setInputText'] = (self, [t, s, e, change, field]) => {
    kb.field = BigInt(field || 0); kb.change = BigInt(change || 0);
    if (window.OSK) OSK.setText(t ? S(t) : '', s, e);
  };
  m[KM + '.toggleKeyboard'] = (self, [on]) => {
    if (!window.OSK) return;
    if (on) {
      OSK.open();
      J.later.push(() => callStatic(KM, 'nativeKeyboardImeChangeVisibility', 1));
    } else OSK.close(false);
  };
  for (const k of ['setInputFieldEnabled', 'setInputFieldVisible', 'setInputFlags', 'init', 'onPlayrixActivityCreated'])
    m[KM + '.' + k] = () => {};

  // links (Terms of Use, Privacy Policy, ...) open in a new browser tab
  m['com/playrix/engine/Marketing.openUrl'] = (self, [u]) => {
    const url = u ? S(u) : '';
    out('[app] open link: ' + url);
    if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
  };

  // the splash fades out (200 ms), then the engine is told it's gone and continues
  m['com/playrix/engine/SplashView.hide'] = () => {
    setTimeout(() => J.later.push(() => callStatic('com/playrix/engine/SplashView', 'nativeOnSplashWasHidden')), 200);
  };
  m['com/playrix/engine/SplashView.show'] = () => {};
  // advertising ids: the all-zero id Android reports when ad tracking is limited (an empty
  // one leaves parts of the engine waiting: "Wait for IsAdvertisingIdReady or IsReady")
  const ZERO_AD_ID = '00000000-0000-0000-0000-000000000000';
  m[E + '.requestAdvertisingId'] = () => {
    out('[app] advertising id requested');
    J.later.push(() => {
      callStatic(E, 'nativeOnGoogleAdvertisingIdReady', 0);
      callStatic(E, 'nativeOnMarketAdvertisingIdReady', 0, 0);
    });
  };
  m['android/content/Context.getPackageName'] = () => PKG;
  m[E + '.getDisplayDiagonal'] = () => 6.0;
  m['com/playrix/engine/EglContextManager.createAuxContextsAndSurfaces'] = () => 0;   // no shared contexts in WebGL

  // ---------------------------------------------------------------- FMOD's Java helper (org.fmod.FMOD)
  // FMOD.init(context) ran in the app; output goes through OpenSL ES (no AAudio)
  const FM = 'org/fmod/FMOD';
  m[FM + '.checkInit'] = () => true;
  m[FM + '.getOutputSampleRate'] = () => 48000;
  m[FM + '.getOutputBlockSize'] = () => 480;
  m[FM + '.supportsAAudio'] = () => false;
  m[FM + '.supportsLowLatency'] = () => false;
  m[FM + '.lowLatencyFlag'] = () => false;
  m[FM + '.proAudioFlag'] = () => false;
  m[FM + '.isBluetoothOn'] = () => false;
  m[FM + '.fileDescriptorFromUri'] = () => -1;
  // FMOD opens "file:///android_asset/..." banks through AAssetManager_fromJava(this)
  m[FM + '.getAssetManager'] = () => M().ccall('jni_java_object', 'number', ['string'], ['android/content/res/AssetManager']);
  m['android/content/Context.getAssets'] = m[FM + '.getAssetManager'];

  // ---------------------------------------------------------------- EGL / clock / build constants
  m['com/playrix/engine/EglContextManager.getAPIVersion'] = () => 3;
  m['com/playrix/engine/EglContextManager.getMainDepthSurfaceInfo'] = () => {
    const h = M().ccall('jni_java_object', 'number', ['string'], ['com/playrix/engine/EglContextManager$DepthSurfaceInfo']);
    J.objects[h] = {depthBits: 24, stencilBits: 8};
    return h;
  };
  m['com/playrix/engine/EglContextManager.getGlRenderer'] = () => 'WebGL 2.0';
  m['com/playrix/engine/EglContextManager.getGlVendor'] = () => 'Browser';
  m['com/playrix/engine/EglContextManager.getGlVersion'] = () => 'OpenGL ES 3.0 (WebGL 2.0)';
  m['android/os/SystemClock.elapsedRealtime'] = () => BigInt(Math.floor(performance.now()));
  m['android/os/SystemClock.uptimeMillis'] = () => BigInt(Math.floor(performance.now()));
  // GlobalConstants: build-time settings from resources; the caller's default is right offline
  m['com/playrix/engine/GlobalConstants.getBool'] = (self, [k, d]) => !!d;
  m['com/playrix/engine/GlobalConstants.getInt'] = (self, [k, d]) => d | 0;
  m['com/playrix/engine/GlobalConstants.getString'] = (self, [k, d]) => d ? S(d) : '';

  // ---------------------------------------------------------------- shared preferences (localStorage)
  const PREF = 'tw_pref_';
  const pget = k => { try { return localStorage.getItem(PREF + k); } catch (e) { return null; } };
  const pset = (k, v) => { try { if (v === null) localStorage.removeItem(PREF + k); else localStorage.setItem(PREF + k, v); return true; } catch (e) { return false; } };
  m[E + '.containsSharedPreferencesValue'] = (self, [k]) => pget(S(k)) !== null;
  m[E + '.getSharedPreferencesInt'] = (self, [k, d]) => { const v = pget(S(k)); return v === null ? d : (parseInt(v, 10) | 0); };
  m[E + '.getSharedPreferencesString'] = (self, [k, d]) => { const v = pget(S(k)); return v === null ? (d ? S(d) : '') : v; };
  m[E + '.putSharedPreferencesInt'] = (self, [k, v]) => pset(S(k), String(v));
  m[E + '.putSharedPreferencesString'] = (self, [k, v]) => pset(S(k), S(v) || '');
  m[E + '.removeSharedPreferencesValue'] = (self, [k]) => pset(S(k), null);

  // ---------------------------------------------------------------- logging
  m['com/playrix/engine/Logger.logInfo'] = (self, a) => console.log('[tw]', ...a.map(x => typeof x === 'number' ? S(x) : x));
  m['android/util/Log.i'] = (self, [t, s]) => console.log('[' + S(t) + ']', S(s));
  m['android/util/Log.w'] = (self, [t, s]) => console.warn('[' + S(t) + ']', S(s));
  m['android/util/Log.e'] = (self, [t, s]) => console.error('[' + S(t) + ']', S(s));

  // ---------------------------------------------------------------- generic JVM bits the engine touches
  const obj = cls => M().ccall('jni_java_object', 'number', ['string'], [cls]);
  const loadClass = (self, [n]) => M().ccall('jni_find_class', 'number', ['string'], [S(n) || '']);
  m['java/lang/ClassLoader.loadClass'] = loadClass;
  m['java/lang/Class.forName'] = loadClass;
  m['java/lang/Class.getName'] = (self) => (M().UTF8ToString(M()._jni_class_of(self)) || '').replace(/\//g, '.');
  let threadObj = 0;
  m['java/lang/Thread.currentThread'] = () => threadObj || (threadObj = obj('java/lang/Thread'));
  m['java/lang/Thread.getName'] = () => 'GLThread';
  m['java/lang/Thread.getId'] = () => 1n;
  J.fields['android/os/Build$VERSION.SDK_INT'] = 30;
  J.fields['android/os/Build$VERSION.RELEASE'] = () => str('11');
  J.fields['android/os/Build.MODEL'] = () => str('Pixel 4');
  J.fields['android/os/Build.MANUFACTURER'] = () => str('Google');
  J.fields['android/os/Build.BRAND'] = () => str('google');
  J.fields['android/os/Build.DEVICE'] = () => str('flame');
  J.fields['android/os/Build.PRODUCT'] = () => str('flame');
  J.fields['android/os/Build.FINGERPRINT'] = () => str('google/flame/flame:11/RQ3A.211001.001/7641976:user/release-keys');
  J.fields['android/os/Build.HARDWARE'] = () => str('flame');
  J.fields['android/os/Build.TAGS'] = () => str('release-keys');
  J.fields['android/os/Build.TYPE'] = () => str('user');
  J.fields['android/content/pm/PackageManager.MATCH_UNINSTALLED_PACKAGES'] = 8192;
  m['android/os/SystemProperties.get'] = (self, [k, d]) => (d ? S(d) : '');
  m['android/os/SystemProperties.getInt'] = (self, [k, d]) => d | 0;
  m['android/os/SystemProperties.getBoolean'] = (self, [k, d]) => !!d;

  // ---------------------------------------------------------------- app lifecycle
  window.startApp = async (Mod) => {
    const env = BigInt(Mod.envAddr);
    const fn = (cls, name) => {
      const a = Mod.java_native(cls, name);
      if (!a) throw new Error('native not found: ' + cls + '.' + name);
      return a;
    };
    const klass = cls => BigInt(Mod.ccall('jni_find_class', 'number', ['string'], [cls]));
    const call = (f, ...args) => {
      while (args.length < 7) args.push(0n);
      return Mod._rt_call8(f, env, ...args.map(BigInt));
    };
    const eng = klass(E);
    const nat = name => fn(E, name);
    const callE = (name, ...a) => call(nat(name), eng, ...a);
    J.callE = callE;
    const canvas = cfg.canvas;

    out('[app] nativeOnLaunchConfig');
    callE('nativeOnLaunchConfig');
    callE('nativeSetupCommandLineArguments', Mod.jstr(''));
    out('[app] nativeOnStart / nativeOnResume');
    callE('nativeOnStart');
    callE('nativeOnResume');
    // Render at the size the canvas is shown at (times the screen's pixel density), so a
    // big window or fullscreen isn't a stretched 1280x720 picture. The engine re-lays-out
    // on nativeResize like on an Android surface change.
    // Township reloads all of its content (back to the loading screen, re-checking packs and
    // purchases) on ANY size change, so the engine gets one size at startup and never
    // another: the picture is made at the size the game area has with the window maximized
    // (so growing the window doesn't blur it), and the browser scales it to the window,
    // with bars at the sides or top if the window's shape changes (object-fit: contain).
    const MAX_W = 2560;
    const fitCanvas = () => {
      const r = canvas.getBoundingClientRect();
      if (r.width < 16 || r.height < 16) return false;
      const dpr = window.devicePixelRatio || 1;
      const grow = Math.max(1, Math.min(screen.availWidth / r.width, screen.availHeight / r.height));
      let w = Math.round(r.width * grow * dpr), h = Math.round(r.height * grow * dpr);
      if (w > MAX_W) { h = Math.round(h * MAX_W / w); w = MAX_W; }
      w &= ~1; h &= ~1;
      if (w === canvas.width && h === canvas.height) return false;
      canvas.width = w; canvas.height = h;
      return true;
    };
    fitCanvas();
    canvas.style.objectFit = 'contain';
    canvas.style.background = '#000';
    out(`[app] nativeResize(${canvas.width}, ${canvas.height}) (fixed for the session)`);
    callE('nativeResize', canvas.width, canvas.height);

    const renderFn = nat('nativeRender'), touchFn = nat('nativeTouch');
    J.pending = [];
    // pointer -> game pixels, inside the scaled picture (object-fit: contain may add bars)
    const pos = e => {
      const r = canvas.getBoundingClientRect();
      const s = Math.min(r.width / canvas.width, r.height / canvas.height);
      const ox = (r.width - canvas.width * s) / 2, oy = (r.height - canvas.height * s) / 2;
      const x = (e.clientX - r.left - ox) / s, y = (e.clientY - r.top - oy) / s;
      return [Math.round(Math.max(0, Math.min(canvas.width - 1, x))), Math.round(Math.max(0, Math.min(canvas.height - 1, y)))];
    };
    let mainId = null;
    let audioStarting = false;
    // Sound: the game's FMOD calls are served by the FMOD shim (fmod_shim.js); the
    // OpenSL ES output (audio_out.js) is only used by builds without the shim.
    const useShim = !!(window.FmodShim && Mod._fmod_shim_take);
    if (useShim) FmodShim.init(Mod).then(n => out(`[audio] FMOD shim: ${n} sounds indexed`, 'o'));
    const startAudio = () => {
      if (audioStarting) return;
      audioStarting = true;
      if (useShim) {
        FmodShim.start();
        J.audio = { setMuted: m => FmodShim.setMuted(m), pump: () => {} };
        if (J.onAudio) J.onAudio(J.audio);
        out('[audio] started (FMOD shim, Web Audio)', 'o');
        return;
      }
      AudioOut.start(Mod).then(a => {
        J.audio = a;
        if (J.onAudio) J.onAudio(a);
        out('[audio] started at ' + a.ctx.sampleRate + ' Hz (worklet)', 'o');
      }).catch(e => { out('[audio] could not start: ' + e, 'e'); audioStarting = false; });
    };
    J.startAudio = startAudio;
    // single main finger, like GLSurfaceView: 0 down, 2 move, 1 up
    canvas.addEventListener('pointerdown', e => {
      startAudio();
      if (mainId !== null) return;
      mainId = e.pointerId; canvas.setPointerCapture(e.pointerId);
      J.pending.push([0, ...pos(e)]); e.preventDefault();
    });
    canvas.addEventListener('pointermove', e => { if (e.pointerId === mainId) { J.pending.push([2, ...pos(e)]); e.preventDefault(); } });
    const up = e => { if (e.pointerId === mainId) { J.pending.push([1, ...pos(e)]); mainId = null; e.preventDefault(); } };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', e => { if (e.pointerId === mainId) { mainId = null; J.later.push(() => callE('nativeCancelMouse')); } });
    canvas.addEventListener('wheel', e => { J.later.push(() => callE('nativeMouseWheel', Math.sign(e.deltaY) * -120)); e.preventDefault(); }, {passive: false});
    addEventListener('keydown', e => {
      if (e.key === 'Escape' && !e.repeat) J.later.push(() => call(fn('com/playrix/township/lib/GameActivity', 'nativeOnBackPressed'), klass('com/playrix/township/lib/GameActivity')));
    });
    // The game always counts as focused: switching tabs or windows is not "leaving the app"
    // (no nativeOnPause), and the frame loop keeps ticking on a timer while the tab is hidden
    // (browsers stop requestAnimationFrame in background tabs).

    // GoogleGameCenter.setActivity(): GameCenter reports itself ready, then sign-in reports
    // the player; with no Play Games account that is "no user". The main loop waits for
    // this (MyApplication::MainLoop waitForGCAuth).
    const gameCenterReady = () => {
      callStatic('com/playrix/engine/GameCenter', 'nativeOnInitializationFinished');
      callStatic('com/playrix/engine/GameCenter', 'nativeOnChangeUser', 0);
      out('[app] GameCenter initialised (no signed-in player)');
    };

    // Offline server time. This release build never falls back to the device clock
    // (its "use local time" switch is compiled to false); the loader waits for a server
    // time sync that can't arrive offline. When a sync is missing or pending, answer
    // it with the local clock through the game's own setter (int seconds -> sync path).
    const TIME_FLAG = 0x922c000 + 56, TIME_MGR = 0x91c2000 + 1400, SET_SERVER_TIME = 0x5fed09c;
    let lastTimeCheck = 0;
    const offlineTime = (now) => {
      if (now - lastTimeCheck < 500) return;
      lastTimeCheck = now;
      const dv = new DataView(Mod.heap().buffer);
      const mgr = Number(dv.getBigUint64(TIME_MGR, true));
      if (!mgr) return;
      const st = Number(dv.getBigUint64(TIME_FLAG, true));
      const synced = st && dv.getUint8(st + 282);
      if (synced && !dv.getUint8(mgr + 192)) return;
      Mod._rt_call8(SET_SERVER_TIME, 0n, BigInt(Math.floor(Date.now() / 1000)), 0n, 0n, 0n, 0n, 0n, 0n);
      if (!J.timeNoted) { J.timeNoted = true; out('[app] server time: using the device clock (offline)'); }
    };

    // "RequireServer" (a global bool setting) makes a returning player's main loop show a
    // blocking "Connection Lost [Try again]" dialog until the server answers. Offline,
    // keep it off with the game's own settings setter (getBool 0x7484fbc / setBool 0x7485c24
    // on the settings table at 0x91c10a8).
    const SETTINGS = 0x91c10a8n, GET_BOOL = 0x7484fbc, SET_BOOL = 0x7485c24;
    // a libc++ std::string in wasm memory, kept for the session (short form up to 22 chars,
    // else long form: cap|1, size, data pointer)
    const stdStrings = {};
    const stdString = s => {
      if (stdStrings[s]) return stdStrings[s];
      const h = Mod.heap(), p = Mod._malloc(24);
      h.fill(0, p, p + 24);
      if (s.length <= 22) {
        h[p] = s.length * 2;
        for (let i = 0; i < s.length; i++) h[p + 1 + i] = s.charCodeAt(i);
      } else {
        const d = Mod._malloc(s.length + 1);
        for (let i = 0; i < s.length; i++) h[d + i] = s.charCodeAt(i);
        h[d + s.length] = 0;
        const dv = new DataView(h.buffer);
        dv.setBigUint64(p, BigInt((s.length + 16) | 1), true);
        dv.setBigUint64(p + 8, BigInt(s.length), true);
        dv.setBigUint64(p + 16, BigInt(d), true);
      }
      return (stdStrings[s] = BigInt(p));
    };
    // def: value reported when the setting is not stored (the game passes its own default)
    const getSetting = (name, def = 0) => Number(Mod._rt_call8(GET_BOOL, SETTINGS, stdString(name), BigInt(def ? 1 : 0), 0n, 0n, 0n, 0n, 0n)) & 1;
    const setSetting = (name, v) => Mod._rt_call8(SET_BOOL, SETTINGS, stdString(name), BigInt(v ? 1 : 0), 0n, 0n, 0n, 0n, 0n);
    J.getSetting = getSetting; J.setSetting = setSetting;
    // settings kept at fixed values while the game runs (the game reloads them from its
    // config and saves); J.forcedSettings can be extended by later code
    // ShowNeedUpdate: the blocking "Update Needed / unofficial source" window; the installer
    // checks judge where the APK came from (meaningless in a browser)
    J.forcedSettings = Object.assign({ RequireServer: 0, IgnoreIAPValidation: 1, ShowNeedUpdate: 0,
      SkipInstallerCheck: 1, SkipPlatformInstallerCheck: 1,
      // the "NotSupported" (unofficial source) window shows when the package-name / CR
      // integrity flags are set and these are on (default on)
      MVEnabled1: 0, MVEnabled2: 0, AbortAppOnUnknownVer: 0, BanMessageOnUnknownVer: 0,
      // "You're using an emulator" window (gate f_64596c8 reads this bool)
      EmulatorAlert: 0,
      // No ads, events, sales or Season Pass (user choice; their packs are not in
      // assets.data). The schedules are never served either; these are the game's own
      // switches, so nothing tries to open a feature whose art is missing.
      PlayableEnabled: 0, PlayableAdditionalEnable: 0, VideoAdDisabled: 1,
      EventCalendarDisabled: 1, EventPanelDisabled: 1, NotificationEventDisabled: 1,
      ShowLowLevelEventCloudDisabled: 1, CascadeEventEnabled: 0, CascadeSaleEnabled: 0,
      MagicBeansEnabled: 0, SaleDisabled: 1,
      CasinoDisabled: 0,    // House of Luck is a normal building (user), kept on
      SeasonStoreDisabled: 1, SeasonStoreMsgDisabled: 1 }, J.forcedSettings || {});
    if (/[?&]amz=0/.test(location.search)) J.forcedSettings.AmazonDisabled = 1;   // test: no game server at all
    // The game's integrity flags (certificate / package-name checks fail in a browser, and a
    // purchase re-runs them) live in a separate key-value store, singleton at *0x9229be8,
    // vtable [2] getBool(this, chars, len, def) / [3] setBool(this, chars, len, v). Any of
    // them set brings up the blocking "unofficial source" window, so keep them cleared.
    const FLAG_STORE = 0x9229be8, FLAG_GET = 0x7c2b474, FLAG_SET = 0x7c2b49c;
    const flagNames = ['CRFailed', 'PNCheckFailed', 'IsUnknownVer', 'Engine_IsEmulator'];
    const flagChars = {};
    const clearIntegrityFlags = () => {
      const obj = new DataView(Mod.heap().buffer).getBigUint64(FLAG_STORE, true);
      if (!obj) return;
      for (const n of flagNames) {
        let p = flagChars[n];
        if (!p) {
          const a = Mod._malloc(n.length + 1), h = Mod.heap();
          for (let i = 0; i < n.length; i++) h[a + i] = n.charCodeAt(i);
          h[a + n.length] = 0;
          p = flagChars[n] = BigInt(a);
        }
        const len = BigInt(n.length);
        if (Number(Mod._rt_call8(FLAG_GET, obj, p, len, 0n, 0n, 0n, 0n, 0n)) & 1) {
          Mod._rt_call8(FLAG_SET, obj, p, len, 0n, 0n, 0n, 0n, 0n);
          out(`[app] cleared integrity flag ${n}`);
        }
      }
    };
    // "Update Recommended": the CDN config says a newer app version exists, which the app
    // object keeps as a flag (byte +2666, read by f_5e66958; the window chooser f_78963d8).
    // This port can't be updated, so the flag stays clear. (The CDN config itself is needed:
    // it decides which downloaded packs - e.g. the sound packs - get loaded.)
    const clearUpdateFlag = () => {
      const h = Mod.heap(), app = Number(new DataView(h.buffer).getBigUint64(0x91b5000 + 224, true));
      if (app > 0x10000 && h[app + 2666]) h[app + 2666] = 0;
    };
    let lastReqCheck = 0;
    const offlineServer = (now) => {
      if (now - lastReqCheck < 250) return;
      lastReqCheck = now;
      clearIntegrityFlags();
      clearUpdateFlag();
      for (const [name, v] of Object.entries(J.forcedSettings)) {
        // ask with the opposite default so an unset setting gets written too
        if (getSetting(name, !v) !== v) {
          setSetting(name, v);
          if (!(J.forceNoted = J.forceNoted || {})[name]) { J.forceNoted[name] = 1; out(`[app] setting ${name} = ${v}`); }
        }
      }
    };

    let created = false, frames = 0;
    // make the game write its save files right now (it saves on pause, like on Android);
    // resumed at once so the game keeps running
    J.saveNow = () => {
      if (!created) return false;
      try { callE('nativeOnPause'); } catch (e) { console.warn(e); }
      try { callE('nativeOnResume'); } catch (e) { console.warn(e); }
      return true;
    };
    let wasPaused = false;
    const frame = (now) => {
      // Township: while game files download (fake_server.js shows the download screen) the
      // game is paused; replies still get delivered so the game sees them on its next step
      // (window.TW_HOLD: a save file is being loaded)
      const paused = !!(created && ((window.FakeServer && FakeServer.downloading) || window.TW_HOLD));
      if (paused !== wasPaused) {
        wasPaused = paused;
        if (useShim && FmodShim.setPaused) FmodShim.setPaused(paused);
        out(paused ? '[app] paused: downloading game files' : '[app] resumed');
      }
      if (paused) {
        try { for (const f of J.later.splice(0)) f(); } catch (e) { console.error(e); }
        J.pending.length = 0;                 // taps on the download screen don't reach the game
        nextFrame();
        return;
      }
      try {
        for (const f of J.later.splice(0)) f();
        for (const t of J.pending.splice(0)) call(touchFn, eng, ...t);
        if (!created) { lastReqCheck = -1e9; offlineServer(now); out('[app] nativeOnCreate'); callE('nativeOnCreate'); created = true; lastReqCheck = -1e9; offlineServer(now); J.later.push(gameCenterReady); }
        Mod._rt_call8(renderFn, env, eng, 0n, 0n, 0n, 0n, 0n, 0n);
        if (created) { offlineTime(now); offlineServer(now); }
        if (useShim) FmodShim.frame(); else if (J.audio) J.audio.pump(); else Mod._sl_pump();
        if (J.afterStep) J.afterStep(now);
      } catch (e) {
        out('[app] frame threw: ' + e, 'e');
        console.error(e);
        return;
      }
      frames++;
      if (J.onFrame) J.onFrame(frames, now);
      nextFrame();
    };
    const nextFrame = () => {
      if (document.hidden) setTimeout(() => frame(performance.now()), 33);
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    out('[app] frame loop started', 'o');
  };
  J.later = J.later || [];
  // ?jtrace=1: record the first calls of every Java method (name + page time) in J.trace
  if (/[?&]jtrace=1/.test(location.search)) {
    J.trace = [];
    const seen = {};
    for (const k of Object.keys(m)) {
      const f = m[k];
      if (typeof f !== 'function') continue;
      m[k] = function (...a) {
        if ((seen[k] = (seen[k] || 0) + 1) <= 3) J.trace.push([Math.round(performance.now()), k]);
        return f.apply(this, a);
      };
    }
  }
  window.TWJ = J;
})();
