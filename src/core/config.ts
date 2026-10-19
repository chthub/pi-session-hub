import fs from "node:fs";
import path from "node:path";
import { indexDir, isDeniedPath } from "../security.ts";
import { defaultPiEnvironments, type PiEnvironment } from "./pi-environment.ts";

export class HubConfigError extends Error {}
export interface HubConfig {
  piEnvironments: PiEnvironment[];
  /** Codex home directories, each containing its own sessions/ tree. */
  codexHomes: string[];
}
export function hubConfigPath(home: string): string {
  return path.join(indexDir(home), "config.json");
}
function invalid(field = "piEnvironments"): never {
  throw new HubConfigError(`Invalid Session Hub config: ${field} must contain unique, valid directory entries (absolute or ~/ paths; no commands or credentials)`);
}
function pathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function directoryPath(value: unknown, home: string, field: string): string {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value)) return invalid(field);
  const directory = value.startsWith("~/") || value.startsWith("~\\") ? path.join(home, value.slice(2)) : value;
  if (!path.isAbsolute(directory)) return invalid(field);
  const resolved = path.resolve(directory);
  if (isDeniedPath(resolved)) return invalid(field);
  return resolved;
}
function piEnvironmentsFrom(value: unknown, home: string): PiEnvironment[] {
  if (value === undefined) return defaultPiEnvironments(home);
  if (!Array.isArray(value) || value.length === 0) return invalid();
  const ids = new Set<string>();
  const directories = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid();
    const profile = item as Record<string, unknown>;
    if (Object.keys(profile).some(key => !["id", "label", "agentDir"].includes(key)) ||
        typeof profile.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile.id)) return invalid();
    if (profile.label !== undefined && (typeof profile.label !== "string" || !profile.label.trim() || /[\x00-\x1f\x7f]/.test(profile.label))) return invalid();
    const label = typeof profile.label === "string" ? profile.label.trim() : profile.id;
    const agentDir = directoryPath(profile.agentDir, home, "piEnvironments");
    if (ids.has(profile.id) || directories.has(pathKey(agentDir))) return invalid();
    ids.add(profile.id); directories.add(pathKey(agentDir));
    return { id: profile.id, label, agentDir };
  });
}
function codexHomesFrom(value: unknown, home: string): string[] {
  if (value === undefined) return [path.join(home, ".codex")];
  if (!Array.isArray(value) || value.length === 0) return invalid("codexHomes");
  const seen = new Set<string>();
  return value.map(item => {
    const directory = directoryPath(item, home, "codexHomes");
    if (seen.has(pathKey(directory))) return invalid("codexHomes");
    seen.add(pathKey(directory));
    return directory;
  });
}

/** User-owned directory metadata only. Never read credentials or shell startup
 * files to discover accounts, and never execute a configured shell command. */
export function parseHubConfig(config: unknown, home: string): HubConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) return invalid("root");
  const value = config as Record<string, unknown>;
  if (Object.keys(value).some(key => !["piEnvironments", "codexHomes"].includes(key))) return invalid("root");
  return { piEnvironments: piEnvironmentsFrom(value.piEnvironments, home), codexHomes: codexHomesFrom(value.codexHomes, home) };
}
export function parsePiEnvironments(config: unknown, home: string): PiEnvironment[] {
  return parseHubConfig(config, home).piEnvironments;
}
export function parseCodexHomes(config: unknown, home: string): string[] {
  return parseHubConfig(config, home).codexHomes;
}
export function loadHubConfig(home: string): HubConfig {
  const file = hubConfigPath(home);
  try { fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseHubConfig({}, home);
    throw new HubConfigError(`Could not inspect Session Hub config: ${file}`);
  }
  try {
    if (isDeniedPath(fs.realpathSync(file))) throw new HubConfigError("Refusing credential-like Session Hub config target");
    return parseHubConfig(JSON.parse(fs.readFileSync(file, "utf8")), home);
  } catch (error) {
    if (error instanceof HubConfigError) throw error;
    throw new HubConfigError(`Could not read Session Hub config: ${file}`);
  }
}
export function loadPiEnvironments(home: string): PiEnvironment[] {
  return loadHubConfig(home).piEnvironments;
}
export function loadCodexHomes(home: string): string[] {
  return loadHubConfig(home).codexHomes;
}
