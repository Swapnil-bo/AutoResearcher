import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.jsx";
import "./index.css";

const container = document.getElementById("root");

if (!container) {
  // index.html owns #root — if it's gone, something has already gone very wrong.
  throw new Error("AutoResearcher: #root element not found in index.html");
}

// Surface async failures that would otherwise vanish into devtools silence.
// The SSE pipeline spawns several long-lived async chains; a swallowed
// rejection here shows up as a frozen UI with no clue why.
if (import.meta.env.DEV) {
  window.addEventListener("unhandledrejection", (event) => {
    console.error(
      "%c[AutoResearcher] unhandled promise rejection",
      "color:#00d4ff;font-weight:600",
      event.reason
    );
  });

  window.addEventListener("error", (event) => {
    console.error(
      "%c[AutoResearcher] runtime error",
      "color:#ef4444;font-weight:600",
      event.error ?? event.message
    );
  });
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
