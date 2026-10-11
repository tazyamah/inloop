import { useEffect, useState } from "react";

interface Note { id: number; body: string; created_at: string }

export function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState("");

  const load = async () => setNotes(await (await fetch("/api/notes")).json());
  useEffect(() => { void load(); }, []);

  const add = async () => {
    const r = await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
    if (r.ok) { setBody(""); await load(); }
  };

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>__APP_NAME__</h1>
      <p>
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="メモ" />{" "}
        <button type="button" onClick={() => void add()} disabled={body.trim() === ""}>追加</button>
      </p>
      <ul>{notes.map((n) => <li key={n.id}>{n.body}</li>)}</ul>
    </main>
  );
}
