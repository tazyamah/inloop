import { useEffect, useState } from "react";
import "./share.css";

interface Status {
  state: "unavailable" | "off" | "connecting" | "online" | "offline" | "joining" | "stopped";
  role: "owner" | "member" | null;
  members: { id: string; name: string; role: "owner" | "member"; isMe: boolean }[];
  requests: { id: string; name: string; digits: string | null }[];
  joiningDigits: string | null;
  alert: string | null;
  error: string | null;
  pending: number;
  lastSyncAt: number | null;
}

const label: Record<Status["state"], string> = {
  unavailable: "",
  off: "共有していません",
  connecting: "つないでいます…",
  online: "同期しています",
  offline: "オフラインです（つながったら、自動で同期します）",
  joining: "オーナーの承認を待っています",
  stopped: "同期を止めました",
};

/** 共有（同期）の画面。リストは端末の中に残り、共有しなくても、オフラインでも使える。 */
export function Share() {
  const [status, setStatus] = useState<Status | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [invite, setInvite] = useState<{ code: string; expiresAt: number } | null>(null);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = async () => setStatus(await (await fetch("/api/sync")).json());
  useEffect(() => {
    void load().catch(() => undefined);
    const on = () => void load().catch(() => undefined);
    window.addEventListener("local-api-changed", on);
    return () => window.removeEventListener("local-api-changed", on);
  }, []);

  if (!status) return null;
  if (status.state === "unavailable") return <><h2>共有</h2><p className="muted">この版では、共有を使えません。</p></>;

  const post = async (path: string, body?: unknown) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = r.ok && r.status !== 204 ? await r.json().catch(() => null) : null;
    setMessage(r.ok ? "" : "うまくいきませんでした。オンラインか、入力を確かめてください");
    await load();
    return r.ok ? (data ?? {}) : null;
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setMessage("コピーしました"); } catch { setMessage("コピーできませんでした。選んでコピーしてください"); }
  };

  const inRoom = status.role !== null;
  const last = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <>
      <h2>共有</h2>

      {status.alert && (
        <section className="card share-alert" role="alert">
          <h3>同期を止めました</h3>
          <p>{status.alert}</p>
          <div className="actions"><button type="button" onClick={() => void post("/api/sync/leave")}>この端末の共有をやめる</button></div>
        </section>
      )}

      {!inRoom && status.state !== "joining" && !status.alert && (
        <>
          <section className="card">
            <h3>共有を始める</h3>
            <p className="muted">あなたが、この共有のオーナー（管理者）になります。参加する人は、あなたが承認します。共有しなくても、リストは使えます。</p>
            <form className="share-row" onSubmit={(e) => { e.preventDefault(); void post("/api/sync/create-room", { name }); }}>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="この端末の名前（例: 私のiPhone）" aria-label="この端末の名前" maxLength={40} />
              <button type="submit" className="primary" disabled={name.trim() === ""}>共有を始める</button>
            </form>
          </section>
          <section className="card">
            <h3>招待コードで参加する</h3>
            <p className="muted">オーナーから、招待コードを教えてもらってください。参加には、オーナーの承認が要ります。</p>
            <form className="share-form" onSubmit={(e) => { e.preventDefault(); void post("/api/sync/join", { code, name }); }}>
              <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="招待コード" aria-label="招待コード" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="この端末の名前（例: 妻のAndroid）" aria-label="この端末の名前（参加）" maxLength={40} />
              <button type="submit" className="primary" disabled={code.trim() === "" || name.trim() === ""}>参加を申し込む</button>
            </form>
          </section>
        </>
      )}

      {status.state === "joining" && (
        <section className="card">
          <h3>オーナーの承認を待っています</h3>
          {status.joiningDigits ? (
            <>
              <p>オーナーの画面に、次の数字が出ているか、見比べてください。違っていたら、承認しないよう伝えてください。</p>
              <p className="share-digits" aria-label="確認の数字">{status.joiningDigits}</p>
            </>
          ) : <p className="muted">オーナーにつないでいます…</p>}
          {status.error && <p className="error" role="alert">{status.error}</p>}
          <div className="actions"><button type="button" onClick={() => void post("/api/sync/leave")}>参加をやめる</button></div>
        </section>
      )}

      {inRoom && !status.alert && (
        <>
          <section className="card">
            <p role="status">
              {label[status.state]}
              {status.pending > 0 && `（未送信 ${status.pending}件）`}
              {status.state === "online" && last && `　最後の同期 ${last}`}
            </p>
            {status.error && <p className="error" role="alert">{status.error}</p>}
          </section>

          {status.role === "owner" && status.requests.length > 0 && (
            <section className="card">
              <h3>参加の申し込み</h3>
              {status.requests.map((r) => (
                <div key={r.id} className="share-request">
                  <p><strong>{r.name}</strong> が、参加を求めています。</p>
                  {r.digits ? (
                    <p>相手の画面に、この数字が出ているか見比べてください: <span className="share-digits" aria-label="確認の数字">{r.digits}</span></p>
                  ) : <p className="error">この招待は、この端末で作ったものではありません。断ってください。</p>}
                  <div className="actions">
                    <button type="button" className="primary" disabled={!r.digits} onClick={() => void post("/api/sync/approve", { id: r.id })}>数字が同じなので、承認する</button>
                    <button type="button" onClick={() => void post("/api/sync/reject", { id: r.id })}>断る</button>
                  </div>
                </div>
              ))}
            </section>
          )}

          <section className="card">
            <h3>参加者</h3>
            <ul className="share-members">
              {status.members.map((m) => (
                <li key={m.id}>
                  <span>{m.name}{m.isMe && "（この端末）"}<span className="badge">{m.role === "owner" ? "オーナー" : "参加者"}</span></span>
                  {status.role === "owner" && !m.isMe && (
                    confirm === m.id ? (
                      <span className="actions">
                        <button type="button" onClick={() => { setConfirm(null); void post("/api/sync/remove", { id: m.id }); }}>外す</button>
                        <button type="button" onClick={() => setConfirm(null)}>戻る</button>
                      </span>
                    ) : <button type="button" onClick={() => setConfirm(m.id)}>外す</button>
                  )}
                </li>
              ))}
            </ul>
            {confirm && <p className="muted">外すと、その端末は、以後の変更を読めなくなります。鍵は自動で新しくなります。</p>}
          </section>

          {status.role === "owner" && (
            <section className="card">
              <h3>人を招待する</h3>
              <p className="muted">招待コードは、10分で切れて、1回だけ使えます。参加には、あなたの承認が要ります。</p>
              <div className="actions">
                <button type="button" className="primary" disabled={status.state !== "online"} onClick={() => void post("/api/sync/invite").then((d) => d && setInvite(d as { code: string; expiresAt: number }))}>招待コードを作る</button>
              </div>
              {invite && invite.expiresAt > Date.now() && (
                <div className="share-code">
                  <code aria-label="招待コード">{invite.code}</code>
                  <button type="button" onClick={() => void copy(invite.code)}>コピー</button>
                </div>
              )}
              {status.state !== "online" && <p className="muted">オンラインのときだけ、作れます。</p>}
            </section>
          )}

          <div className="actions">
            {confirm === "leave" ? (
              <>
                <span className="muted">この端末の共有をやめます。リストは、この端末に残ります。</span>
                <button type="button" onClick={() => { setConfirm(null); void post("/api/sync/leave"); }}>やめる</button>
                <button type="button" onClick={() => setConfirm(null)}>戻る</button>
              </>
            ) : <button type="button" onClick={() => setConfirm("leave")}>この端末の共有をやめる</button>}
          </div>
        </>
      )}
      {message && <p className="muted" role="status">{message}</p>}
    </>
  );
}
