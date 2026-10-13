// オフラインでも開けるようにする。サービスワーカー（public/sw.js）を登録し、読み込み済みのファイルを
// キャッシュに入れる。開発中（vite dev）は登録しない。
// 置き場所に新しい版があれば、画面の下に「更新」を出す。押すとキャッシュを捨てて読み込み直す（データは消えない）。
export function registerOffline(): void {
  if (import.meta.env.DEV || import.meta.env.MODE === "extension" || !("serviceWorker" in navigator)) return;
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
    void checkUpdate();
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void checkUpdate());
  });
}

/** 置き場所の version.txt と、今の版を見比べる。取れない（オフラインなど）ときは何もしない。 */
async function checkUpdate(): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.txt`, { cache: "no-store" });
    if (!res.ok) return;
    const latest = (await res.text()).trim();
    if (/^\d+$/.test(latest) && latest !== __BUILD_ID__) showUpdate();
  } catch {
    // オフライン。
  }
}

function showUpdate(): void {
  if (document.getElementById("update-banner")) return;
  const bar = document.createElement("div");
  bar.id = "update-banner";
  bar.setAttribute("role", "status");
  bar.style.cssText = "position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:10;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 16px;border-radius:8px;background:#1c1f24;color:#fff;font-size:.9rem";
  const text = document.createElement("span");
  text.textContent = "新しい版があります（データは消えません）";
  const button = document.createElement("button");
  button.textContent = "更新";
  button.style.cssText = "font:inherit;padding:6px 14px;border:0;border-radius:6px;background:#fff;color:#1c1f24";
  button.onclick = async () => {
    await caches.delete("app-shell");
    location.reload();
  };
  bar.append(text, button);
  document.body.append(bar);
}
