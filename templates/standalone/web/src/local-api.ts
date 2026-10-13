// 画面の fetch("/api/...") を、端末内のWorker（Hono）へ向ける。/api 以外は、そのまま fetch に渡す。
interface Reply { id: number; status: number; headers: [string, string][]; body: string }

export function installLocalApi(): void {
  const worker = new Worker(new URL("../../server/worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, (r: Response) => void>();
  let n = 0;
  const ready = new Promise<void>((resolve) => {
    worker.addEventListener("message", (e: MessageEvent<Reply | { ready: true; storage: string } | { changed: true }>) => {
      // Workerで、他の端末の変更の取り込みや同期の状態の変化があった。画面に知らせる。
      if ("changed" in e.data) return void window.dispatchEvent(new Event("local-api-changed"));
      if ("ready" in e.data) {
        // 保存先の状態を、画面の下に出す（保存できないときに、気づけるように）。
        const status = document.createElement("p");
        status.id = "storage-status";
        status.textContent = e.data.storage;
        status.style.cssText = "margin:1rem;font-size:.75rem;opacity:.7";
        document.body.append(status);
        return resolve();
      }
      const done = pending.get(e.data.id);
      pending.delete(e.data.id);
      // 204などの本文のない応答は、本文を付けない。
      const empty = e.data.status === 204 || e.data.status === 304;
      done?.(new Response(empty ? null : e.data.body, { status: e.data.status, headers: e.data.headers }));
    });
  });

  // 画面に戻ったとき、同期をすぐつなぎ直す。
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && worker.postMessage({ wake: true }));
  addEventListener("online", () => worker.postMessage({ wake: true }));

  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return real(input, init);
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.text();
    await ready;
    const id = ++n;
    return new Promise<Response>((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ id, url: url.pathname + url.search, method: req.method, headers: [...req.headers], body });
    });
  };
}
