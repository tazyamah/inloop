// ブラウザで開く経路のホスト（ADR-0010）。MCP Appsのホストの役を務め、レビューUIを
// iframeに読み込む。UIのツール呼び出しはサーバーのHTTPへ転送する。会話へのメッセージは
// 届けられないので、回答はAIがget_review_resultで受け取る。
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const token = new URLSearchParams(location.search).get("t") ?? "";
const id = location.pathname.split("/").pop() ?? "";
const dark = matchMedia("(prefers-color-scheme: dark)");

const notice = document.getElementById("notice")!;
const iframe = document.getElementById("view") as HTMLIFrameElement;
document.title = `inloop ${id}`;

const bridge = new AppBridge(
  null,
  { name: "inloop-browser-host", version: "0.0.0" },
  { serverTools: {}, message: { text: {} }, openLinks: {} },
  { hostContext: { theme: dark.matches ? "dark" : "light", displayMode: "inline", availableDisplayModes: ["inline"] } },
);

bridge.oncalltool = async (params) => {
  const res = await fetch(`/api/call?t=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: params.name, arguments: params.arguments ?? {} }),
  });
  if (!res.ok) return { isError: true, content: [{ type: "text", text: `${res.status} ${await res.text()}` }] };
  return res.json();
};

bridge.onmessage = async () => {
  // 回答は記録済み。AIはget_review_resultで受け取る。
  notice.textContent = "回答を記録しました。AIが待っていなければ、会話で「回答した」と伝えてください。";
  notice.hidden = false;
  return {};
};

// 再依頼済みの依頼から、引き継ぎ先の依頼のページへ移る。
bridge.onopenlink = async ({ url }) => {
  const m = /^inloop:review\/(R\d+(?:-\d+)?)$/.exec(url);
  if (m) location.href = `/r/${m[1]}?t=${encodeURIComponent(token)}`;
  else window.open(url, "_blank", "noopener");
  return {};
};

bridge.oninitialized = async () => {
  await bridge.sendToolInput({ arguments: {} });
  await bridge.sendToolResult({ content: [{ type: "text", text: id }], structuredContent: { ids: [id] } });
};

dark.addEventListener("change", () => bridge.setHostContext({ theme: dark.matches ? "dark" : "light" }));

// 内容に合わせてiframeの高さを変える。
bridge.onsizechange = ({ height }) => {
  if (height) iframe.style.height = `${Math.ceil(height)}px`;
};

await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
iframe.src = `/ui/review.html?t=${encodeURIComponent(token)}`;
