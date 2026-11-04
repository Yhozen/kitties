import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
const result = await Bun.build({
  entrypoints: [process.argv[2] ?? "apps/web/e2e-next/desktop-fixture.tsx"],
  target: "browser",
  outdir: ".context/desktop-benchmark",
  naming: process.argv[3] ?? "viewer.js",
  plugins: [
    {
      name: "vite-dictionaries",
      setup(build) {
        build.onLoad({ filter: /\/i18n\/(es|pt)\/index\.ts$/ }, async ({ path }) => {
          const files = (await readdir(dirname(path))).filter(
            (file) => file.endsWith(".ts") && file !== "index.ts",
          );
          return {
            contents:
              files
                .map((file, i) => `import d${i} from ${JSON.stringify(join(dirname(path), file))};`)
                .join("\n") +
              `\nexport default Object.assign({},${files.map((_, i) => "d" + i).join(",")});`,
            loader: "ts",
          };
        });
      },
    },
  ],
});
if (!result.success) throw Error(result.logs.map((log) => log.message).join("\n"));
