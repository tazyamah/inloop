import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installLocalApi } from "./local-api.ts";
import { registerOffline } from "./offline.ts";
import "./style.css";
import "./extension.css";

// 拡張機能のポップアップ（?popup=1）は、幅を決める。
if (new URLSearchParams(location.search).has("popup")) document.documentElement.classList.add("popup");

installLocalApi();
registerOffline();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
