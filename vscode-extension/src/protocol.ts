export type Operation = "status" | "getSession" | "refresh" | "resume" | "copyId" | "openLink";
export interface ViewerRequest {
  type: "sessionHub.request";
  id: number;
  operation: Operation;
  uid?: string;
  linkId?: string;
}
export interface ViewerResponse {
  type: "sessionHub.response";
  id: number;
  result?: unknown;
  error?: string;
}

/** A panel is bound to one indexed UID. No paths, argv, cwd, shell commands,
 * arbitrary list queries or cross-panel session access are accepted. */
export function parseViewerRequest(value: unknown, boundUid: string): ViewerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("无效的会话请求");
  const message = value as Record<string, unknown>;
  if (Object.keys(message).some(key => !["type", "id", "operation", "uid", "linkId"].includes(key)) ||
      message.type !== "sessionHub.request" || !Number.isSafeInteger(message.id) || Number(message.id) < 1 ||
      !["status", "getSession", "refresh", "resume", "copyId", "openLink"].includes(String(message.operation))) throw new Error("不支持的会话请求");
  const needsUid = ["getSession", "resume", "copyId", "openLink"].includes(String(message.operation));
  if (needsUid ? message.uid !== boundUid : message.uid !== undefined) throw new Error("会话 ID 与当前页面不匹配");
  if (message.operation === "openLink"
    ? typeof message.linkId !== "string" || !/^[a-f0-9]{32}$/.test(message.linkId)
    : message.linkId !== undefined) throw new Error("无效的会话链接");
  return message as unknown as ViewerRequest;
}
