// Test-only entry; no user data is needed to mount the actual file UI.
import { h, render } from "preact";
import { DesktopFiles } from "../src/DesktopFiles";
import { LibraryPanel } from "../src/WorkspacePanel";
const params = new URL(location.href).searchParams;
render(
  params.has("library")
    ? h(LibraryPanel, {})
    : h(DesktopFiles, { id: params.get("id") ?? "files-fixture" }),
  document.getElementById("app")!,
);
