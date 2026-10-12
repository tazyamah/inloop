import { useEffect, useState } from "react";

interface Note { id: number; body: string; created_at: string }

/** 最初からあるメモの画面（例）。不要なら消して、`inloop generate scaffold`で作った画面に置き換える。 */
export function Notes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState("");

  const load = async () => setNotes(await (await fetch("/api/notes")).json());
  useEffect(() => { void load(); }, []);

  const add = async () => {
    const r = await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
    if (r.ok) { setBody(""); await load(); }
  };

  return (
    <>
      <h2>メモ</h2>
      <form className="card actions" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input type="text" value={body} onChange={(e) => setBody(e.target.value)} placeholder="メモ" aria-label="メモ" style={{ flex: 1 }} />
        <button type="submit" className="primary" disabled={body.trim() === ""}>追加</button>
      </form>
      <div className="card">
        {notes.length === 0 ? <p className="muted">まだメモがありません。</p> : <ul>{notes.map((n) => <li key={n.id}>{n.body}</li>)}</ul>}
      </div>
    </>
  );
}
