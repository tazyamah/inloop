import { useRef, useState } from "react";

/** データの書き出しと読み込み。端末のブラウザの中だけにあるデータを、ファイルに残し、戻せる。 */
export function Backup() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{ text: string; rows: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const stamp = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");

  const exportData = async () => {
    setError("");
    const res = await fetch("/api/backup");
    if (!res.ok) return setError("書き出せませんでした");
    const text = JSON.stringify(await res.json(), null, 2);
    const name = `${document.title}-backup-${stamp()}.json`;
    const file = new File([text], name, { type: "application/json" });
    // スマートフォンでは、共有メニューから「ファイルに保存」できる。使えない、または失敗したときは、ダウンロードにする。
    if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return setMessage("書き出しました");
      } catch (e) {
        // 利用者が取り消したときは、何もしない。
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    setMessage("書き出しました");
  };

  const choose = async (file: File | undefined) => {
    setError("");
    setMessage("");
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text) as { tables?: Record<string, { rows?: unknown[] }> };
      const rows = Object.values(data.tables ?? {}).reduce((n, t) => n + (t.rows?.length ?? 0), 0);
      setPending({ text, rows });
    } catch {
      setError("バックアップのファイルとして読めませんでした");
    }
  };

  const importData = async () => {
    if (!pending) return;
    const res = await fetch("/api/backup/import", { method: "POST", headers: { "content-type": "application/json" }, body: pending.text });
    const data = (await res.json().catch(() => null)) as { error?: string; rows?: number } | null;
    setPending(null);
    if (input.current) input.current.value = "";
    if (!res.ok) return setError(data?.error ?? "読み込めませんでした");
    setMessage(`${data?.rows ?? 0}行を読み込みました`);
    window.dispatchEvent(new Event("local-api-changed"));
  };

  return (
    <>
      <h2>データ</h2>
      <section className="card">
        <h3>書き出す</h3>
        <p className="muted">このアプリのデータを、ファイルに保存します。端末を替えるときや、ブラウザのデータを消す前の、バックアップに使えます。共有の鍵は含まれません。</p>
        <div className="actions"><button type="button" className="primary" onClick={() => void exportData()}>データを書き出す</button></div>
      </section>
      <section className="card">
        <h3>読み込む</h3>
        <p className="muted">書き出したファイルを読み込みます。共有している表は、新しい変更を残して合わせ、そのほかの表は、中身が入れ替わります。</p>
        <input ref={input} type="file" accept="application/json,.json" aria-label="バックアップのファイル" onChange={(e) => void choose(e.target.files?.[0])} />
        {pending && (
          <div className="actions">
            <span>{pending.rows}行を読み込みます。</span>
            <button type="button" className="primary" onClick={() => void importData()}>読み込む</button>
            <button type="button" onClick={() => { setPending(null); if (input.current) input.current.value = ""; }}>やめる</button>
          </div>
        )}
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </>
  );
}
