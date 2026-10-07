import { redact } from "../security.ts";
import type { ExternalSession, SessionDetail } from "../types.ts";
import { renderMarkdown, renderPlainText } from "./markdown.ts";

/** Shared redacted wire model for HTTP and VS Code hosts. */
export function sanitize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item));
}
export function sessionSummary(session: ExternalSession) {
  return sanitize({ uid: session.uid, harness: session.harness, title: session.title, preview: session.preview,
    repo: session.repo ?? session.cwd, model: session.model, updatedAt: session.updatedAt ?? session.createdAt,
    messageCount: session.messageCount });
}
export function viewerDetail(detail: SessionDetail) {
  const { searchText: _searchText, ...metadata } = detail;
  return sanitize({ ...metadata, messages: detail.messages.map(message => ({ ...message,
    html: /tool|function/i.test(message.role) ? renderPlainText(message.text) : renderMarkdown(message.text) })) });
}
