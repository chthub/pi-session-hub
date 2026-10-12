/**
 * Blank new sessions.
 *
 * Each harness starts an empty interactive conversation when its CLI runs with
 * no arguments. Hosts offer only executables found on PATH, and Pi once per
 * configured environment so the account identity is explicit, never inherited.
 */

import fs from "node:fs";
import path from "node:path";
import { HARNESS_LABEL, HARNESS_ORDER, type HarnessId } from "../types.ts";
import { loadPiEnvironments } from "./config.ts";
import type { PiEnvironment } from "./pi-environment.ts";

const NEW_SESSION_COMMAND: Record<HarnessId, string> = {
  pi: "pi",
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  crush: "crush",
  jcode: "jcode",
};

export interface NewSessionTarget {
  id: string;
  harness: HarnessId;
  label: string;
  /** Absolute executable resolved from PATH; launched with no arguments. */
  executable: string;
  env?: Record<string, string>;
  piEnvironment?: PiEnvironment;
}

/** First executable regular file named `command` on PATH, or null. */
export function findExecutable(command: string, searchPath = process.env.PATH ?? ""): string | null {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, command);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* not here */ }
  }
  return null;
}

export function newSessionTargets(home: string, searchPath = process.env.PATH ?? ""): NewSessionTarget[] {
  const targets: NewSessionTarget[] = [];
  for (const harness of HARNESS_ORDER) {
    const executable = findExecutable(NEW_SESSION_COMMAND[harness], searchPath);
    if (!executable) continue;
    if (harness === "pi") {
      for (const profile of loadPiEnvironments(home)) {
        targets.push({ id: `pi:${profile.id}`, harness, label: profile.label, executable,
          env: { PI_CODING_AGENT_DIR: profile.agentDir }, piEnvironment: profile });
      }
    } else {
      targets.push({ id: harness, harness, label: HARNESS_LABEL[harness], executable });
    }
  }
  return targets;
}

/** Directory existence is checked at launch; a missing Pi dir never falls back. */
export function assertNewSessionLaunchable(target: NewSessionTarget, cwd: string | undefined): void {
  if (target.piEnvironment) {
    let ok = false;
    try { ok = fs.statSync(target.piEnvironment.agentDir).isDirectory(); } catch { /* reported below */ }
    if (!ok) throw new Error("Pi 配置目录不可用，不会切换到默认账号");
  }
  if (cwd) {
    let ok = false;
    try { ok = fs.statSync(cwd).isDirectory(); } catch { /* reported below */ }
    if (!ok) throw new Error("启动目录不可用");
  }
}
