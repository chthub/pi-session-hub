import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
await build({ entryPoints: [path.join(root, "src/extension.ts")], outfile: path.join(root, "dist/extension.cjs"),
  bundle: true, platform: "node", format: "cjs", target: "node22", external: ["vscode"],
  nodePaths: [path.join(root, "node_modules")], alias: { katex: require.resolve("katex"), "markdown-it": require.resolve("markdown-it") }, sourcemap: true });
const media = path.join(root, "dist/media");
await fs.mkdir(media, { recursive: true });
for (const file of ["index.html", "app.js", "transport.js", "style.css"]) {
  await fs.copyFile(path.join(root, "../src/web/public", file), path.join(media, file));
}
const katex = path.join(path.dirname(require.resolve("katex/package.json")), "dist");
await fs.mkdir(path.join(media, "katex"), { recursive: true });
await fs.copyFile(path.join(katex, "katex.min.css"), path.join(media, "katex/katex.min.css"));
await fs.cp(path.join(katex, "fonts"), path.join(media, "katex/fonts"), { recursive: true });
console.log("Built shared core + viewer into dist/ (no HTTP server).");
