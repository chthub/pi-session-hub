import path from "node:path";
import type { ExternalSession } from "../../src/types.ts";

type ProjectSession = Pick<ExternalSession, "cwd" | "repo">;
export type ProjectScope = "current" | "other" | "unscoped";

function normalize(value: string | null): { value: string; windows: boolean } | null {
  if (!value) return null;
  const windows = /^[a-z]:[\\/]|^[\\/]{2}[^\\/]/i.test(value);
  const api = windows ? path.win32 : path.posix;
  if (!api.isAbsolute(value)) return null;
  const normalized = api.normalize(value);
  const root = api.parse(normalized).root;
  const trimmed = normalized.length > root.length ? normalized.replace(/[\\/]+$/, "") : normalized;
  return { value: windows ? trimmed.toLowerCase() : trimmed, windows };
}
function inside(candidate: ReturnType<typeof normalize>, root: ReturnType<typeof normalize>): boolean {
  if (!candidate || !root || candidate.windows !== root.windows) return false;
  const api = root.windows ? path.win32 : path.posix;
  const relative = api.relative(root.value, candidate.value);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
}

export function isSessionInWorkspace(session: ProjectSession, workspaceRoots: readonly string[]): boolean {
  const candidates = [normalize(session.cwd), normalize(session.repo)];
  return workspaceRoots.some(root => candidates.some(candidate => inside(candidate, normalize(root))));
}
export function sessionProjectScope(session: ProjectSession, workspaceRoots: readonly string[]): ProjectScope {
  if (!workspaceRoots.some(root => normalize(root)) || ![session.cwd, session.repo].some(value => normalize(value))) return "unscoped";
  return isSessionInWorkspace(session, workspaceRoots) ? "current" : "other";
}
