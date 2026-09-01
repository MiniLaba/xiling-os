import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/chat.css";
import "./styles/canvas.css";
import "./styles/views.css";
import "./styles/legacy-27ebdf7-workspaces.css";
import "./styles/devtools.css";
import "./home/home.css";
import { App } from "./App.js";
import { ensureLocalAccessToken, installLocalTokenFetch } from "./lib/api-client.js";
import { initializeTheme } from "./lib/theme.js";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

initializeTheme();

// Fetch the local access token before the first mutation can be issued, and
// route every fetch through the token adapter (ADR 0042 §5: API 客户端层适配).
installLocalTokenFetch();
void ensureLocalAccessToken().catch(() => undefined);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
