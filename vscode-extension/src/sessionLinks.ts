import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeniedPath } from "../../src/security.ts";

interface LocalTarget { path: string; fragment: string; }
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

/** Only source-rendered links in this panel can be opened; never accept a path
 * from the webview. Keep project/symlink boundaries and credential exclusions. */
export class SessionLinks {
  private readonly targets = new Map<string, LocalTarget>();
  constructor(private readonly cwd: string | null) {}

  register(href: string): string | undefined {
    if (!this.cwd || !path.isAbsolute(this.cwd) ||
        /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href) || /[\x00-\x1f\x7f\\]/.test(href)) return;
    try {
      const url = new URL(href, pathToFileURL(this.cwd + path.sep));
      const file = fileURLToPath(url);
      if (/[\x00-\x1f\x7f\\]/.test(file) || !inside(this.cwd, file) || isDeniedPath(file)) return;
      const id = randomBytes(16).toString("hex");
      this.targets.set(id, { path: file, fragment: decodeURIComponent(url.hash.slice(1)) });
      return id;
    } catch { return; }
  }

  resolve(id: string): LocalTarget {
    const target = this.targets.get(id);
    if (!target || !this.cwd) throw new Error("This link does not belong to the current session. Reload the session.");
    // Revalidate on each click, including symlinks that changed since rendering.
    let root: string, file: string;
    try {
      root = fs.realpathSync(this.cwd);
      file = fs.realpathSync(target.path);
    } catch { throw new Error("The linked file or session working directory no longer exists"); }
    if (isDeniedPath(target.path) || isDeniedPath(file) || !inside(root, file) || !fs.statSync(file).isFile()) {
      throw new Error("The link is outside the session project or points to a protected file");
    }
    return { ...target, path: file };
  }
}
