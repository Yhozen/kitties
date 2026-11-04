// Test-only entry: exercise the actual desktop component without application data.
import { h, render } from "preact";
import WSDesktop from "../src/WSDesktop.tsx";
const id = new URLSearchParams(location.search).get("id")!;
render(h(WSDesktop, { id, onClose() {} }), document.body);
