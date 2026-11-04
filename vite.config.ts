import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/gateway/**/*.test.ts",
      "guest/kittyd/src/**/*.test.ts",
    ],
    passWithNoTests: true,
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: [
      "site/**",
      "docs/**",
      "apps/web/src/**",
      "!apps/web/src/NextShell.tsx",
      "!apps/web/src/main.tsx",
      "!apps/web/src/desktop-viewer.ts",
      "!apps/web/src/desktop-files.ts",
      "!apps/web/src/DesktopFiles.tsx",
    ],
  },
  fmt: {
    ignorePatterns: [
      "site/**",
      "docs/**",
      "apps/web/src/**",
      "!apps/web/src/desktop-viewer.ts",
      "!apps/web/src/desktop-files.ts",
      "!apps/web/src/DesktopFiles.tsx",
      "pnpm-lock.yaml",
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "scripts/**",
    ],
  },
  run: {
    tasks: {
      verify: { command: "vp check", cache: true },
      unit: { command: "vp test --run", cache: true },
    },
  },
});
