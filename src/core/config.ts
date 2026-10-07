import fs from "node:fs";
import path from "node:path";
import { indexDir, isDeniedPath } from "../security.ts";
import { defaultPiEnvironments, type PiEnvironment } from "./pi-environment.ts";

export class HubConfigError extends Error {}
export function hubConfigPath(home: string): string {
  return path.join(indexDir(home), "config.json");
}
function invalid(): never {
  throw new HubConfigError("Invalid Session Hub config: piEnvironments must contain unique ids, labels and absolute or ~/ agentDir paths (no credentials)");
}
function pathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** User-owned, non-secret configuration. Never discover accounts by reading
 * auth.json or shell startup files; never execute a configured shell command. */
export function parsePiEnvironments(config: unknown, home: string): PiEnvironment[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return invalid();
  const value = config as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "piEnvironments")) return invalid();
  if (value.piEnvironments === undefined) return defaultPiEnvironments(home);
  if (!Array.isArray(value.piEnvironments) || value.piEnvironments.length === 0) return invalid();
  const ids = new Set<string>();
  const directories = new Set<string>();
  return value.piEnvironments.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid();
    const profile = item as Record<string, unknown>;
    if (Object.keys(profile).some(key => !["id", "label", "agentDir"].includes(key)) ||
        typeof profile.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile.id) ||
        typeof profile.agentDir !== "string" || !profile.agentDir || /[\x00-\x1f]/.test(profile.agentDir)) return invalid();
    if (profile.label !== undefined && (typeof profile.label !== "string" || !profile.label.trim() || /[\x00-\x1f]/.test(profile.label))) return invalid();
    const label = typeof profile.label === "string" ? profile.label.trim() : profile.id;
    const directory = profile.agentDir.startsWith("~/") || profile.agentDir.startsWith("~\\")
      ? path.join(home, profile.agentDir.slice(2)) : profile.agentDir;
    if (!path.isAbsolute(directory) || isDeniedPath(directory)) return invalid();
    const agentDir = path.resolve(directory);
    if (ids.has(profile.id) || directories.has(pathKey(agentDir))) return invalid();
    ids.add(profile.id); directories.add(pathKey(agentDir));
    return { id: profile.id, label, agentDir };
  });
}

export function loadPiEnvironments(home: string): PiEnvironment[] {
  const file = hubConfigPath(home);
  try { fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultPiEnvironments(home);
    throw new HubConfigError(`Could not inspect Session Hub config: ${file}`);
  }
  try {
    if (isDeniedPath(fs.realpathSync(file))) throw new HubConfigError("Refusing credential-like Session Hub config target");
    return parsePiEnvironments(JSON.parse(fs.readFileSync(file, "utf8")), home);
  } catch (error) {
    if (error instanceof HubConfigError) throw error;
    throw new HubConfigError(`Could not read Session Hub config: ${file}`);
  }
}
