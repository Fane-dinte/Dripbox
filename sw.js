// Dripbox service worker: keeps the app shell offline-ready and receives things from Android's Share menu.
const V = "dripbox-8";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V && k !== "dripbox-share").map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function takeShare(req) {
  const fd = await req.formData();
  const c = await caches.open("dripbox-share");
  let i = 0;
  for (const f of fd.getAll("f")) {
    if (typeof f === "string" || !f.size) continue;
    await c.put(`/_share/${Date.now()}-${i++}`, new Response(f, { headers: { "x-name": encodeURIComponent(f.name || "fisier"), "content-type": f.type || "application/octet-stream" } }));
  }
  let parts = [...new Set(["title", "text", "url"].map((k) => fd.get(k)).filter((v) => typeof v === "string" && v.trim()))];
  // with files, Android adds a label like "Screenshot (26 Oct 2026 21:40)": keep only a real link, as the caption
  if (i) parts = parts.filter((v) => /https?:\/\//.test(v));
  // Android often sends the page title and the link together: keep the link on its own line
  if (parts.length) await c.put("/_share/text", new Response(parts.join("\n")));
  return Response.redirect("/?share=1", 303);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.method === "POST" && url.pathname === "/share") { e.respondWith(takeShare(req)); return; }
  if (req.method !== "GET") return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/f/") || url.pathname.startsWith("/s/")) return;
  // the shell: network first (always fresh when online), cache when offline
  e.respondWith(
    fetch(req).then((r) => {
      if (r.ok && SHELL.includes(url.pathname)) { const cp = r.clone(); caches.open(V).then((c) => c.put(req, cp)); }
      return r;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("/")))
  );
});
