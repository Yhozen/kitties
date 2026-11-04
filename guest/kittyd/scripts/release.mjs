import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run("bun", [
  "build",
  "src/index.ts",
  "--compile",
  "--target=bun-linux-x64-baseline",
  "--outfile",
  "dist/kittyd",
]);
const work = mkdtempSync(join(tmpdir(), "kittyd-release-"));
try {
  const versions = JSON.parse(readFileSync("perception-versions.json", "utf8"));
  for (const [name, spec] of Object.entries(versions)) {
    const response = await fetch(spec.url);
    if (!response.ok) throw Error("Perception download failed");
    const data = Buffer.from(await response.arrayBuffer());
    if (
      spec.integrity &&
      "sha512-" + createHash("sha512").update(data).digest("base64") !== spec.integrity
    )
      throw Error("Perception checksum mismatch");
    if (spec.sha256 && createHash("sha256").update(data).digest("hex") !== spec.sha256)
      throw Error("Perception checksum mismatch");
    const archive = join(work, name + ".tgz");
    writeFileSync(archive, data);
    if (name === "agentBrowser")
      run("tar", [
        "-xzf",
        archive,
        "-C",
        work,
        "--strip-components=2",
        "package/bin/agent-browser-linux-x64",
      ]);
    else if (name === "agentDesktopFfi") {
      run("tar", ["-xzf", archive, "-C", work]);
      const root = join(work, `agent-desktop-ffi-v${spec.version}-x86_64-unknown-linux-gnu`);
      cpSync(join(root, "lib/libagent_desktop_ffi.so"), join(work, "libagent_desktop_ffi.so"));
      cpSync(join(root, "LICENSE"), join(work, "agent-desktop-LICENSE"));
      rmSync(root, { recursive: true });
    } else
      run("tar", [
        "-xzf",
        archive,
        "-C",
        work,
        "agent-desktop",
        "agent-desktop-linux-clipboard-owner",
      ]);
    rmSync(archive);
  }
  cpSync("dist/kittyd", join(work, "kittyd"));
  for (const name of ["install.sh", "kitty-grab.c", "kitty-quiesce.sh", "perception-helper.py"])
    cpSync(join("files", name), join(work, name));
  cpSync("../desktop", join(work, "desktop"), { recursive: true });
  run("tar", [
    "--sort=name",
    "--mtime=2026-11-01",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-czf",
    resolve("dist/kittyd.tgz"),
    "-C",
    work,
    ".",
  ]);
  const sha256 = createHash("sha256").update(readFileSync("dist/kittyd.tgz")).digest("hex");
  writeFileSync(
    "dist/release.json",
    JSON.stringify({ key: sha256 + ".tgz", sha256 }, null, 2) + "\n",
  );
  console.log("Guest release:", sha256);
} finally {
  rmSync(work, { recursive: true, force: true });
}
