// オフラインでも開けるようにする。サービスワーカー（public/sw.js）を登録し、読み込み済みのファイルを
// キャッシュに入れる。開発中（vite dev）は登録しない。
export function registerOffline(): void {
  if (import.meta.env.DEV || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
      await navigator.serviceWorker.ready;
      // 最初の読み込みで取ったファイル（Workerとwasmを含む）を、サービスワーカーの管理下に入る前でも残す。
      const cache = await caches.open("app-shell");
      const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.startsWith(location.origin));
      await cache.addAll([location.href, ...urls]);
    } catch {
      // キャッシュできなくても、オンラインでは普通に動く。
    }
  });
}
