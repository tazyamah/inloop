// テスト用の最小ホスト。AppBridgeでレビューUIをiframeに読み込み、
// ツール呼び出しとメッセージをPlaywright経由でNode側へ転送する。
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const iframe = document.createElement("iframe");
iframe.id = "view";
iframe.style.cssText = "width:100%;height:1400px;border:0";
document.body.append(iframe);

const bridge = new AppBridge(
  null,
  { name: "inloop-test-host", version: "0" },
  { serverTools: {}, message: { text: {} } },
  { hostContext: { theme: window.__THEME ?? "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] } },
);
bridge.oncalltool = async (params) => window.__callTool(JSON.stringify(params)).then((s) => JSON.parse(s));
bridge.onmessage = async (params) => { await window.__onMessage(JSON.stringify(params)); return {}; };
bridge.onrequestdisplaymode = async (params) => { window.__displayMode = params.mode; return { mode: params.mode }; };
bridge.oninitialized = async () => {
  await bridge.sendToolInput({ arguments: window.__TOOL_INPUT });
  await bridge.sendToolResult(window.__TOOL_RESULT);
  window.__initialized = true;
};
await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
iframe.srcdoc = window.__REVIEW_HTML;
