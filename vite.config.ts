import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/gateway/**/*.test.ts"],
    passWithNoTests: true,
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: [
      "internal/**",
      "desktop/**",
      "android/**",
      "deploy/**",
      "site/**",
      "docs/**",
      "apps/web/e2e/**",
      "apps/web/src/**",
      "!apps/web/src/NextShell.tsx",
      "!apps/web/src/main.tsx",
    ],
  },
  fmt: {
    ignorePatterns: [
      "internal/**",
      "desktop/**",
      "android/**",
      "deploy/**",
      "site/**",
      "docs/**",
      "apps/web/e2e/**",
      "apps/web/src/**",
      "pnpm-lock.yaml",
      "apps/web/e2e/**",
      "apps/web/src/**",
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "souls/**",
      "configs/**",
      "scripts/**",
      "docker/**",
    ],
  },
  run: {
    tasks: {
      verify: { command: "vp check", cache: true },
      unit: { command: "vp test --run", cache: true },
    },
  },
});
