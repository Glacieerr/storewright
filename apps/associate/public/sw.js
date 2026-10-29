// 应用外壳缓存：/api 始终走网络（实时数据由发件箱处理离线）。
// 页面本身先走网络、断网时用缓存：发布新版本后打开一次就是新版本（以前先用缓存，要刷新两次才看到新版本）；
// 带内容哈希的静态资源（assets/xxx-哈希.js）内容不会变，先用缓存；其余资源先用缓存、后台更新。
const CACHE = 'storewright-associate-v2';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest', './icon.svg'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.includes('/api/')) return;
  const page = e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html');
  const hashed = /\/assets\/.+-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(url.pathname);
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      const fromNet = () =>
        fetch(e.request).then((res) => {
          if (res.ok) c.put(e.request, res.clone());
          return res;
        });
      if (page) return fromNet().catch(() => hit || c.match('./index.html'));
      if (hashed && hit) return hit;
      const net = fromNet().catch(() => hit);
      return hit || net;
    }),
  );
});
