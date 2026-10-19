import type { SearchScope } from "../types.ts";
import { cleanText, redact } from "../security.ts";
import { searchTextFrom } from "./util.ts";

/** Each category has its OWN 20,000-character head/tail excerpt. Within it,
 * retain the first 200 and latest 200 blocks, each sampled to 4,000 characters
 * (head and tail). Tool floods cannot evict user or assistant prose. */
export const SCOPE_BLOCK_BUDGET = 4_000;
type Category = "user" | "assistant" | "calls" | "results" | "system" | "reasoning";

function sample(text: string): string {
  if (text.length <= SCOPE_BLOCK_BUDGET) return text;
  const half = Math.floor((SCOPE_BLOCK_BUDGET - 3) / 2);
  return `${text.slice(0, half)} … ${text.slice(-half)}`;
}

/** Index source fields directly, never the rendered transcript/tool UI. */
export class ScopedSearchText {
  private buckets: Record<Category, string[]> = {
    user: [], assistant: [], calls: [], results: [], system: [], reasoning: [],
  };

  private put(category: Category, value: unknown): void {
    if (value === undefined || value === null) return;
    const text = typeof value === "string" ? value : JSON.stringify(value, (key, item) =>
      /^(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)$/i.test(key)
        ? "[REDACTED]" : item);
    if (!text) return;
    // Prose retains the existing boilerplate cleanup; tool/system/reasoning
    // preserve source text (including XML) but still redact secrets.
    const clean = category === "user" || category === "assistant"
      ? cleanText(text) : redact(text).replace(/\s+/g, " ").trim();
    if (!clean) return;
    const acc = this.buckets[category];
    if (acc.length >= 400) acc.splice(200, acc.length - 399);
    acc.push(sample(clean));
  }

  call(name: unknown, input: unknown): void {
    // Separate blocks keep a huge argument value from hiding the tool name.
    this.put("calls", name);
    if (typeof input === "string") {
      try { input = JSON.parse(input); } catch { /* free-form custom tool input */ }
    }
    this.put("calls", input);
  }

  result(output: unknown): void { this.put("results", output); }
  reasoning(value: unknown): void { this.put("reasoning", value); }
  system(value: unknown): void { this.put("system", value); }

  add(role: string, content: unknown): void {
    if (/tool|function/i.test(role)) { this.result(content); return; }
    const category: Category = role === "user" || role === "assistant" ? role : "system";
    if (typeof content === "string") { this.put(category, content); return; }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (typeof block === "string") { this.put(category, block); continue; }
      if (!block || typeof block !== "object") continue;
      const source = block as Record<string, unknown>;
      const b = source.data && typeof source.data === "object" ? source.data as Record<string, unknown> : source;
      const type = source.type;
      if (["toolCall", "tool_call", "tool_use", "tool", "function", "function_call", "custom_tool_call"].includes(String(type))) {
        const call = b.function && typeof b.function === "object" ? b.function as Record<string, unknown> : b;
        const state = call.state && typeof call.state === "object" ? call.state as Record<string, unknown> : call;
        this.call(call.name ?? call.tool ?? call.toolName, state.arguments ?? state.input ?? state.parameters ?? state);
        if ("output" in state) this.result(state.output);
        if ("error" in state) this.result(state.error);
      } else if (["tool_result", "toolResult", "function_call_output", "custom_tool_call_output"].includes(String(type))) {
        this.result(b.content ?? b.output ?? b.result ?? b.text);
      } else if (["thinking", "reasoning", "reasoning_trace", "open_a_i_reasoning"].includes(String(type))) {
        this.reasoning(b.thinking ?? b.text ?? b.content ?? b.summary);
      } else if (type === undefined || ["text", "input_text", "output_text"].includes(String(type))) {
        this.put(category, b.text ?? b.content);
      }
      // Unknown/media blocks are not prompts. Only recover their textual
      // payload in all scope; do not index images/base64 or signature blobs.
      else this.put("system", b.text ?? b.content);
    }
  }

  finish(): Record<SearchScope, string | null> {
    const excerpts = Object.fromEntries(Object.entries(this.buckets).map(([key, acc]) => [key, searchTextFrom(acc)]));
    const join = (keys: Category[]) => keys.map(key => excerpts[key]).filter(Boolean).join("\n") || null;
    return {
      user: excerpts.user,
      conversation: join(["user", "assistant"]),
      all: join(["user", "assistant", "calls", "results", "system", "reasoning"]),
    };
  }
}
