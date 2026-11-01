import { defineConfig } from "vite-plus";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/postcss";

export default defineConfig({
  plugins: [preact()],
  css: { postcss: { plugins: [tailwindcss()] } },
  server: { proxy: { "/v1": "http://localhost:1337", "/guest": "http://localhost:1337" } },
  build: { target: "es2022", sourcemap: false },
  resolve: { alias: { react: "preact/compat", "react-dom": "preact/compat" } },
});
