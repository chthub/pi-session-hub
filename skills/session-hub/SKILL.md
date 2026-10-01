---
name: session-hub
description: Search and read past conversations with coding agents across harnesses (Pi, Claude Code, Codex, OpenCode, Crush, JCode). Use only when the user explicitly requests searching or reading those conversations, e.g. "find the agent session where we discussed X" or "read my previous Codex conversation". Do not use merely because the user says "continue working on X", mentions previous work, or wants project context.
---

# Session Hub

`pi-session-hub` indexes the local session stores of every coding harness on this
machine and exposes them through one list.

## When to use it

Use the hub **only when the user explicitly requests searching or reading past
conversations with coding agents**, for example:

- "Find the agent session where we discussed the db layer."
- "In which chat with Codex did we fix this bug?"
- "Read my previous Claude Code conversation about this project."
- "Load that previous agent conversation so we can continue from it."

Do **not** infer permission to access session history from "continue working on X",
"what did we do on this project recently", a mention of previous work, or a request
for project context alone. If a request is ambiguous, clarify whether the user
wants past agent conversations searched or read before enabling or using the hub.

Do **not** use it for reading project source files. It reads agent transcripts, not
code.

## Tools and commands

| Surface | Use |
|---|---|
| `session_hub_enable` tool | Enable unavailable search and context-loading tools only for an explicit request to search or read past agent conversations. Does not read transcripts. |
| `session_hub_search` tool | Search the local index after enabling the hub. |
| `session_hub_context` tool | Load a session's context after enabling the hub. |
| `/session-hub` | Open the interactive two-pane browser (also `/hub`, or `alt+r`). |
| `/session-search <query>` | Same search, printed into the chat. Supports `--harness <id>` and `--limit <n>`. |
| `/session-open <id>` | Read-only metadata + transcript preview. |
| `/session-handoff <id>` | Handoff draft in the editor, to review before sending. |
| `/session-native <id>` | Resume the session in its original harness. Asks for confirmation first. |

In the hub, `Enter` loads the selected session's conversation into the current chat
as a collapsed `imported transcript` message. The context is tiered and budgeted
(~10k tokens by default): recent turns verbatim, older ones condensed to one line,
tool output compressed, and anything omitted is counted rather than hidden. `v`
reads the transcript for free, `o` switches Pi to a Pi session, `n` reopens it in
its original tool. The hub is a full-screen replacement UI; `?` shows the keyboard
reference.

Harness ids: `pi`, `claude-code`, `codex`, `opencode`, `crush`, `jcode`.

## Search query syntax

- bare terms use prefix matching: `pliego` matches `pliego-prod`
- `"exact phrase"` for phrases
- `-term` to exclude

## Working rules

1. **Never claim a session is Pi-native when it is not.** Session ids are namespaced
   `harness:nativeId`. Report the harness honestly.
2. **Prefer loading the context over pasting transcript text.** `Enter` in the hub
   (or `session_hub_context`) produces a structured document that is labelled as
   imported and lists what the source could not provide.
3. **Respect "not available".** Some sources do not record changed files, commands or
   working directories. Report that as unavailable rather than guessing.
4. **`/session-native` for OpenCode is intentionally unavailable.** There is no
   verified resume-by-id command, so the hub refuses rather than inventing one.
5. **Nothing outside `~/.pi/agent/pi-session-hub/` is written.** Do not attempt to
   modify any harness's session store.

## Rebuilding the index

The index is rebuilt automatically when empty. To force a refresh, open `/session-hub`
and press `r`. The index lives at `~/.pi/agent/pi-session-hub/index.sqlite`.
