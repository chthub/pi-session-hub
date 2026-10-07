import { redact } from "../../src/security.ts";

const MAX_PROMPT_CHARS = 20;
const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Only the editor label is shortened. Preserve whole Unicode characters,
 * including compound emoji; the tree and transcript keep the original title. */
export function sessionTabTitle(title: string | null, nativeId: string): string {
  const text = redact(title?.trim() || nativeId).replace(/\s+/g, " ");
  const parts = Array.from(characters.segment(text), part => part.segment);
  const label = parts.length > MAX_PROMPT_CHARS
    ? parts.slice(0, MAX_PROMPT_CHARS - 1).join("").trimEnd() + "…"
    : text;
  return `Session: ${label}`;
}
