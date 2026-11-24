const CACHE_NAME = "township-ghpages-v2";

const CHUNKED_FILES = {
  "assets.data": 18,
  "image.bin.gz": 2
};

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([
        "./",
        "./index.html",
        "./township.png",
        "./game.js",
        "./save_guard.js",
        "./township_extras.js",
        "./pack_store.js",
        "./osk.js",
        "./fmod_shim.js",
        "./fake_server.js",
        "./java_world.js",
        "./assets_store.js",
        "./audio_out.js",
        "./boot.js"
      ]).catch(() => {})
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

async function fetchPartWithRetry(partUrl, retries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(partUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${partUrl}`);
      return await res.arrayBuffer();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function buildMergedChunkResponse(relName, partCount, headOnly = false) {
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = new Request(new URL(`./${relName}`, self.registration.scope).href);
  const cached = await cache.match(cacheKey);
  if (cached) {
    if (!headOnly) return cached;
    const len = cached.headers.get("Content-Length") || String(cached.size || 0);
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": len
      }
    });
  }

  const buffers = [];
  let totalBytes = 0;
  for (let i = 1; i <= partCount; i++) {
    const suffix = String(i).padStart(4, "0");
    const partUrl = new URL(`./${relName}.part${suffix}`, self.registration.scope).href;
    const ab = await fetchPartWithRetry(partUrl);
    totalBytes += ab.byteLength;
    buffers.push(ab);
  }

  const mergedBlob = new Blob(buffers, { type: "application/octet-stream" });
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(mergedBlob.size || totalBytes)
  };

  const fullRes = new Response(mergedBlob, { status: 200, headers });
  try {
    await cache.put(cacheKey, fullRes.clone());
  } catch (e) {}

  if (headOnly) {
    return new Response(null, { status: 200, headers });
  }
  return fullRes;
}

async function handleWasmRequest(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(request.url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${request.url}`);
      let buf = await res.arrayBuffer();
      const u8 = new Uint8Array(buf);

      if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b && typeof DecompressionStream !== "undefined") {
        const ds = new DecompressionStream("gzip");
        buf = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
      }

      const outRes = new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": "application/wasm",
          "Content-Length": String(buf.byteLength)
        }
      });

      try {
        await cache.put(request, outRes.clone());
      } catch (e) {}
      return outRes;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const scopePath = new URL("./", self.registration.scope).pathname;
  const relPath = url.pathname.startsWith(scopePath)
    ? url.pathname.slice(scopePath.length)
    : url.pathname.replace(/^\/+/, "");

  const handler = (async () => {
    if (Object.prototype.hasOwnProperty.call(CHUNKED_FILES, relPath)) {
      return await buildMergedChunkResponse(relPath, CHUNKED_FILES[relPath], method === "HEAD");
    }
    if (method === "HEAD") {
      return await fetch(req);
    }
    if (/\.wasm(?:\.gz)?$/i.test(relPath)) {
      return await handleWasmRequest(req);
    }
    const cached = await caches.match(req);
    if (cached) return cached;
    return await fetch(req);
  })();

  event.respondWith(
    handler.catch((err) => {
      console.error("[SW Fetch Failed]", relPath, err);
      return new Response(String(err && err.message ? err.message : err), {
        status: 502,
        statusText: "Service Worker Fetch Error"
      });
    })
  );
});
