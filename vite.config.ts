import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/gateway/**/*.test.ts"],
    passWithNoTests: true,
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["internal/**", "desktop/**", "android/**", "deploy/**", "site/**", "docs/**"],
  },
  fmt: {
    ignorePatterns: [
      "internal/**",
      "desktop/**",
      "android/**",
      "deploy/**",
      "site/**",
      "docs/**",
      "pnpm-lock.yaml",
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
