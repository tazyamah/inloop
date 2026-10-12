import { useEffect, useState } from "react";

interface Note { uid: string; body: string }

/** 最初からあるメモの画面（例）。不要なら消して、`inloop generate scaffold`で作った画面に置き換える。 */
export function Notes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState("");

  const load = async () => setNotes(await (await fetch("/api/notes")).json());
  useEffect(() => {
    void load();
    // 他の端末の変更を取り込んだら、読み直す。
    const on = () => void load();
    window.addEventListener("local-api-changed", on);
    return () => window.removeEventListener("local-api-changed", on);
  }, []);

  const add = async () => {
    const r = await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
    if (r.ok) { setBody(""); await load(); }
  };
  const remove = async (uid: string) => {
    await fetch(`/api/notes/${uid}`, { method: "DELETE" });
    await load();
  };

  return (
    <>
      <h2>メモ</h2>
      <form className="card actions" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input type="text" value={body} onChange={(e) => setBody(e.target.value)} placeholder="メモ" aria-label="メモ" style={{ flex: 1 }} />
        <button type="submit" className="primary" disabled={body.trim() === ""}>追加</button>
      </form>
      <div className="card">
        {notes.length === 0 ? <p className="muted">まだメモがありません。</p> : (
          <ul className="note-list">
            {notes.map((n) => (
              <li key={n.uid}>
                <span>{n.body}</span>
                <button type="button" onClick={() => void remove(n.uid)} aria-label={`${n.body}を消す`}>消す</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
