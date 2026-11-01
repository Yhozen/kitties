import { render } from "preact";
import App from "./NextShell";
import "./index.css";
import "./themes.css";
import { applyMode, savedMode } from "./theme";

applyMode(savedMode());

render(<App />, document.getElementById("root")!);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
