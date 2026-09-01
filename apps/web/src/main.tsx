import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/chat.css";
import "./styles/canvas.css";
import "./styles/views.css";
import "./styles/devtools.css";
import { App } from "./App.js";
import { ensureLocalAccessToken } from "./lib/api-client.js";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

// Fetch the local access token before the first mutation can be issued; the
// apiJson 403-retry path covers any race while this request is in flight.
void ensureLocalAccessToken().catch(() => undefined);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
