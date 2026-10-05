import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { buildFakeHome } from "./fake-home.mjs";

const { openIndexDb } = await createJiti(import.meta.url).import("../../src/sqlite.ts");
export const webSample = String.raw`

**格式测试**：行内 $x_1^2 + \alpha$。

$$
\frac{1}{2} + \sum_{i=1}^n x_i
$$

中文标签公式：

$$
\mathcal L=\mathcal L_{\mathrm{计数}}+\lambda\sum_{j\in\mathrm{训练集}}\omega_j(\mu_j-\hat r_j)^2
$$

代码里的公式不渲染：

\`\`\`tex
$x$ and $$y$$
\`\`\`

![远程图片](https://example.invalid/tracker)
<script>window.transcriptExecuted = true</script>
password=supersecret
`.replaceAll("\\`", "`");

export async function buildWebHome(home) {
  await buildFakeHome(home);
  const transform = value => JSON.parse(JSON.stringify(value), (key, item) =>
    (key === "text" || key === "content") && typeof item === "string" && item.startsWith("fake ") ? item + webSample : item);
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".jsonl")) {
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.stringify(transform(JSON.parse(line)))).join("\n") + "\n");
      } else if (entry.name.endsWith(".json")) {
        fs.writeFileSync(file, JSON.stringify(transform(JSON.parse(fs.readFileSync(file, "utf8")))));
      }
    }
  }
  walk(home);
  for (const [file, table, column] of [
    [path.join(home, ".crush", "crush.db"), "messages", "parts"],
    [path.join(home, ".local", "share", "opencode", "opencode.db"), "part", "data"],
  ]) {
    const db = await openIndexDb(file);
    try {
      for (const row of db.all(`select id, ${column} as payload from ${table}`)) {
        db.run(`update ${table} set ${column} = ? where id = ?`, [JSON.stringify(transform(JSON.parse(row.payload))), row.id]);
      }
    } finally { db.close(); }
  }
}
