import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installLocalApi } from "./local-api.ts";
import { registerOffline } from "./offline.ts";
import "./style.css";

installLocalApi();
registerOffline();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
