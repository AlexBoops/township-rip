const CACHE_NAME = "township-ghpages-v5";

const CHUNKED_FILES = {
  "assets.data": 18,
  "image.bin.gz": 2,
  "game.wasm.gz": 3
};

const COI_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin"
};

function withCoiHeaders(response) {
  if (!response || response.status === 0 || response.type === "opaque") return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
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
    if (!headOnly) return withCoiHeaders(cached);
    const len = cached.headers.get("Content-Length") || String(cached.size || 0);
    return new Response(null, {
      status: 200,
      headers: {
        ...COI_HEADERS,
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
    ...COI_HEADERS,
    "Content-Type": "application/octet-stream",
    "Content-Length": String(mergedBlob.size || totalBytes)
  };

  const fullRes = new Response(mergedBlob, { status: 200, headers });
  try {
    await cache.put(cacheKey, fullRes.clone());
  } catch (e) {}

  if (headOnly) return new Response(null, { status: 200, headers });
  return fullRes;
}

async function handleWasmRequest(request, relPath) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return withCoiHeaders(cached);

  let buf;
  if (Object.prototype.hasOwnProperty.call(CHUNKED_FILES, relPath)) {
    const mergedRes = await buildMergedChunkResponse(relPath, CHUNKED_FILES[relPath], false);
    buf = await mergedRes.arrayBuffer();
  } else {
    const res = await fetch(request.url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${request.url}`);
    buf = await res.arrayBuffer();
  }

  const u8 = new Uint8Array(buf);
  if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b && typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("gzip");
    buf = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
  }

  const outRes = new Response(buf, {
    status: 200,
    headers: {
      ...COI_HEADERS,
      "Content-Type": "application/wasm",
      "Content-Length": String(buf.byteLength)
    }
  });

  try {
    await cache.put(request, outRes.clone());
  } catch (e) {}
  return outRes;
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
    if (/\.wasm(?:\.gz)?$/i.test(relPath)) {
      if (method === "HEAD") {
        return await buildMergedChunkResponse(relPath, CHUNKED_FILES[relPath] || 1, true);
      }
      return await handleWasmRequest(req, relPath);
    }
    if (Object.prototype.hasOwnProperty.call(CHUNKED_FILES, relPath)) {
      return await buildMergedChunkResponse(relPath, CHUNKED_FILES[relPath], method === "HEAD");
    }
    if (method === "HEAD") {
      return withCoiHeaders(await fetch(req));
    }
    const netRes = await fetch(req);
    return withCoiHeaders(netRes);
  })();

  event.respondWith(
    handler.catch((err) => {
      console.error("[SW Fetch Failed]", relPath, err);
      return new Response(String(err && err.message ? err.message : err), {
        status: 502,
        statusText: "Service Worker Fetch Error",
        headers: COI_HEADERS
      });
    })
  );
});
