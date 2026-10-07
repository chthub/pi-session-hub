<div align="center">
  <img src="https://raw.githubusercontent.com/Gateton/pi-session-hub/main/assets/session-hub.png" alt="pi-session-hub: sessions from JCode, OpenCode, Pi, Claude Code, Codex and Crush in one full-screen list, with the selected session's metadata and transcript on the right" width="880">

# pi-session-hub

**One list for every coding-agent session on your machine. Browse, search and continue in Pi, or read conversations in a standalone local Web Viewer with Markdown, math and a persistent message outline.**

[![npm](https://img.shields.io/npm/v/pi-session-hub?label=npm)](https://www.npmjs.com/package/pi-session-hub)
[![Pi extension](https://img.shields.io/badge/Pi-extension-19c7d4)](https://github.com/earendil-works/pi-coding-agent)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-1f8f4d)](package.json)
[![License](https://img.shields.io/badge/license-MIT-f5a623)](LICENSE)

</div>

`pi-session-hub` provides a cross-harness terminal browser for Pi and an independent, read-only Web Viewer:

- **See every agent in one list**: Pi, Claude Code, Codex, OpenCode, Crush and JCode sessions, each row labelled with its harness, project, model and recency.
- **Continue work that started elsewhere**: press `Enter` and the selected session's conversation is loaded into the current chat as a tiered, budgeted context package, so the next thing you type already has it.
- **Read without spending tokens**: `v` opens the full recovered transcript in a read-only terminal viewer for free. The standalone Web Viewer adds Markdown and `$...$` / `$$...$$` math rendering in your browser.
- **Reopen the original tool when you want to**: `n` runs the session's own resume command, with the exact command and its verification basis shown before anything is launched.
- **Follow your questions**: the Web Viewer's always-visible user-message outline supports search, click-to-jump, previous/next navigation and scroll tracking.
- **Inspect agent activity**: consecutive tool calls/results share one compact foldout with tool names, arguments, commands and source call IDs.
- **Stay local and read-only**: source stores are never edited, only `~/.pi/agent/pi-session-hub/` is written by the hub, and transcripts are never uploaded to external services. Web access is authenticated loopback HTTP, optionally through a trusted local tunnel.

## Package facts

| Fact | Value |
| --- | --- |
| Package | `pi-session-hub` |
| Version | `0.2.0` |
| Node engine | `>=22.5.0` |
| Runtime dependencies | `jiti`, `markdown-it`, `katex`; SQLite + FTS5 uses built-in `node:sqlite` |
| Pi entrypoints | `./extensions/session-hub.ts` |
| Standalone CLI | `pi-session-hub-web` (`npm run web` from a checkout) |
| Supported harnesses | 6 |
| Package image | [assets/session-hub.png](https://raw.githubusercontent.com/Gateton/pi-session-hub/main/assets/session-hub.png) |

## Public surfaces

| Surface kind | Count |
| --- | --- |
| command | 6 |
| tool | 3 |
| shortcut | 1 |
| skill | 1 |
| renderer | 1 |

**Pi commands**: `/session-hub`, `/hub`, `/session-search`, `/session-open`, `/session-handoff`, `/session-native`.

**Standalone CLI**: `pi-session-hub-web [--port 43123] [--no-open]`.

**Tools**: `session_hub_enable`, `session_hub_search`, `session_hub_context`.

Only `session_hub_enable` is exposed at startup. Call it to enable search and context
loading for the next model request; no `tool_search` configuration is required.

**Shortcut**: `alt+r`.

**Skill**: `session-hub`, which tells the agent when to enable the hub and search past sessions.

## Why use it?

| You want to... | Use this package because... |
|---|---|
| Find the session where you solved something | `/session-search <query>` searches a local FTS5 index covering titles and a bounded excerpt of each conversation, including both the start and the end. |
| Pick up work that started in another tool | `Enter` loads that session's conversation into the current chat. Recent turns arrive verbatim, older ones condense to one line, tool output compresses to short previews, and anything omitted is counted rather than hidden. |
| Read an old conversation without paying for it | `v` opens the full transcript in a read-only viewer. Zero tokens, zero writes. |
| Resume in the tool that owns the session | `n` shows the exact command and where its verification comes from, then asks before launching anything. |
| Let the agent search your history itself | `session_hub_search` finds sessions; `session_hub_context` loads one session's context document so the agent can actually continue it. |
| Hand a session to a fresh Pi thread for review | `h` puts an `Imported Session Handoff` draft in the editor so you can read and edit it before sending. |

## Choose a viewer

| Mode | Start | Best for |
| --- | --- | --- |
| Pi terminal | `alt+r` or `/session-hub` | Search and continue work inside Pi |
| Standalone Web Viewer | `npm run web` from this checkout | Read Markdown/math, navigate questions and inspect tool calls without sending context to an LLM |

The Web Viewer in this fork is available in this checkout. The npm/gallery links
refer to the upstream package; do not assume an upstream npm release includes
these additions until a corresponding release is published.

## Install

```bash
# From npm
pi install npm:pi-session-hub

# Project-local
pi install npm:pi-session-hub -l

# This fork from git
pi install git:github.com/chthub/pi-session-hub

# Local checkout, run from this package directory
pi install .
```

Try it without installing:

```bash
pi -e /path/to/pi-session-hub
```

## Quick start in Pi

1. Install the package and start Pi in any project.

2. Open the hub:

   ```text
   alt+r
   ```

   Or type `/session-hub`, or `/hub`. The hub replaces Pi's UI area rather than floating over the chat. For a true alternate-screen takeover, set Pi's own `tuiMode` to `"fullscreen"` in `~/.pi/agent/settings.json`.

3. The first run indexes your harnesses. Scan time depends on store size and filesystem speed. Later scans still walk directories and check file size/modification time, but Pi, Claude Code, Codex and JCode reuse unchanged index entries without reading or parsing their source content. OpenCode and Crush continue to read their databases on each scan; an explicit force reindex also rereads every source. Existing indexes upgrade automatically. If multiple files share a session ID, older indexes may need a one-time read to associate those source paths with the session before they can be reused.

4. Pick a session and press `Enter`. The conversation is loaded into the current chat:

   ```text
    imported transcript  ◆ JCode  102/804 messages  ·  ~8,172 tokens
    source: ~/.jcode/sessions/session_example.json
    - Original objective: implement the billing endpoint and its regression tests
    expand this message to read the imported transcript
   ```

   The snippet above is an illustrative example, not a real transcript. Just type what you want to do next. The cost is reported every time, and the message is collapsed until you expand it.

5. To ask the agent directly instead, just ask. It has the tools:

   ```text
   Where did I work on the language switcher?
   ```

## Standalone Web Viewer

The Web Viewer runs independently of Pi. From a checkout:

```bash
npm install --legacy-peer-deps
npm run web
# Choose another port, or use 0 for an available port:
npm run web -- --port 43124
```

When an installed version includes this CLI, use `pi-session-hub-web [--port 43123] [--no-open]`.
No Pi process is required. Startup scans the same six harnesses and prints a URL
such as `http://127.0.0.1:43123/#token=...`. If `$BROWSER` is available (for example,
in a VS Code/Cursor remote terminal), it asks that helper to open the full URL
in your computer's external browser. Otherwise it prints manual instructions.
Use `npm run web -- --no-open` to disable the opening request. A failed opening
request does not stop the server.
Open the **complete URL**, keep it private, and stop the server with `Ctrl+C`.
The URL fragment is removed after the page stores the token for that browser tab.
A server restart generates a new token; open its new link. Refreshing the browser
loads UI changes; changes to the server or adapters require stopping with `Ctrl+C`
and restarting `npm run web`.

The viewer supports:

- Session lists with pagination, FTS search and harness filtering.
- Read-only recovered transcripts with Markdown, inline `$x^2$` and display
  `$$...$$` math, including multiline display equations. Code blocks, inline code
  and tool results stay literal. Escape ordinary dollar signs as `\$`.
- A three-pane reading layout: sessions, conversation and an **always-visible
  user-message outline**. Click any question to jump, filter the outline by its
  full text, or move to the previous/next question. The current question follows
  your scroll position, including while reading the assistant's reply.
- On narrow screens, sessions move into a drawer and the user-message outline
  stays visible below the reading pane, with its own scroll area.
- Distinct user/assistant cards, compact session metadata, a sticky reading
  toolbar and a light/dark theme switch. Connection status lives in a compact
  top bar rather than a separate banner, leaving more height for the transcript.
  Agent replies and tool activity are indented beneath full-width user messages;
  tool-output collapse boxes are narrower and more compact. Consecutive tool
  calls/results share one collapsed group; user or assistant prose ends the group.
  Expand it to read each call's tool name, source arguments and command/argv
  fields, followed by its output in recorded order. Call IDs are shown when the
  source provides them. Missing arguments are labelled rather than inferred.
  Parameters and commands are read-only text, never executable UI actions.
- Raw text (without losing your reading position or closing expanded tool groups),
  jump-to-start/end and an explicit index refresh.
- Web-only reconstruction of tool activity across all six adapters; default
  TUI/context/handoff reads stay unchanged. Recovered **record** counts include
  individual calls/results and can exceed the source's message count.
- Visible scan/read errors, recovery counts and source fidelity notes. It uses
  the existing adapter limits, not an unlimited reader; search still covers
  only the indexed excerpts. Chinese labels in formulas are supported, including
  `\mathrm{计数}` and `\mathrm{训练集}`. Unsupported math shows a visible fallback.
- Local scripts, KaTeX CSS and fonts: no CDN requests, even when viewing formulas.

**Security:** the server binds only to `127.0.0.1`, with no public-bind option.
API requests require a random token, and Host/Origin checks reject foreign browser
origins and DNS rebinding. Transcript HTML is disabled, links are isolated,
remote images are not fetched, and KaTeX runs with `trust: false`. Text and metadata
pass through the existing best-effort secret redactor. This is not a sandbox
against other processes running as your own account; do not share the token.
No HTTP endpoint resumes sessions, executes tools or edits source transcripts.
Only the hub's own local index is updated.

### VS Code port forwarding and an external browser

1. Start the viewer **in the remote VS Code terminal** with `npm run web`.
   `$BROWSER` lets the client resolve the remote URL and request an external
   browser; simply clicking a terminal link may open VS Code's internal browser.
2. Keep the viewer's remote port forwarded in the **Ports** panel. The local port
   may differ from the remote port; the server accepts literal loopback addresses
   (`localhost`, `127.0.0.1`, `[::1]`) on any valid forwarded port.
3. If opening manually, copy the **local address from the Ports panel**, not
   necessarily the remote address printed by the server, and append the original
   `/#token=...`. For example, if remote `43123` maps to local `53123`, use
   `http://127.0.0.1:53123/#token=...`.

The token is removed from an opened tab's address bar and stored only in that
browser tab. Another browser does not inherit it: use the original startup token.
A refused connection means the local forwarding/listener is unavailable; a `403`
means Host/Origin was rejected; a `401` means the API token is missing or stale.

`localhost` on the remote machine is not `localhost` on your computer. Standard
trusted SSH forwarding also works with different local/remote ports. Do not expose
the viewer through a public proxy. When a compute allocation ends, its viewer
process ends too.

## Keyboard reference

Press `?` inside the hub for this list.

| Key | Action |
|---|---|
| `↑` `↓`, `j` `k` | Move the selection |
| `PageUp` `PageDown` | Jump a page |
| `Home` `End` | First or last session |
| `Tab` | Switch between the list and the transcript pane |
| `Enter` | Load this session's context into the current chat |
| `v` | Read the full transcript (read-only, no tokens) |
| `o` | Open in place: switch Pi to that Pi session |
| `h` | Handoff draft in the editor, to review before sending |
| `n` | Reopen the session in its original harness |
| `/` | Search titles, previews, projects and models |
| `f` | Filter by a touched file path |
| `p` | Cycle the project/repo filter |
| `0`–`6` | Filter by harness (`0` clears) |
| `r` | Reindex every harness |
| `?` | Keyboard reference |
| `Esc`, `q` | Close |

Harness markers are plain Unicode, not emoji: `π` Pi, `✻` Claude Code, `⬡` Codex, `⌘` OpenCode, `❯` Crush, `◆` JCode. Set `PI_SESSION_HUB_ASCII=1` for plain ASCII markers on terminals whose font has no symbol coverage.

## How much context `Enter` loads

Loading an entire conversation would be wasteful, and the cost would grow without bound as sessions get longer. The context is therefore **tiered, with a hard budget**:

| Tier | Contents | Cost |
|---|---|---|
| 1. Header | objective, repo, model, files changed and read, commands run, tool usage | ~1k characters, always included |
| 2. Recent tail | the last turns **verbatim**, because that is what you continue from | up to 26k characters |
| 3. Earlier | one line per older message, so the shape of the conversation survives | remainder |
| 4. Omitted | a count, never silence | 0 |

Measured on real sessions with the default 40k-character budget (~10k tokens):

| Session | Source messages | Verbatim | Condensed | Omitted | Cost |
|---|---|---|---|---|---|
| JCode, i18n work | 804 (102 with text) | 73 | 29 | 0 | ~8.2k tokens |
| Pi, a long refactor | 413 (291 with text) | 111 | 69 | 111 | ~9.8k tokens |
| Claude Code, a debug session | 49 (6 with text) | 6 | 0 | 0 | ~2.9k tokens |

Two decisions make that affordable:

- **Tool output is compressed to a short preview in every tier.** Measured here, tool output was 90% of the bytes in a 291-message session and is the least useful part for resuming work.
- **The tail is protected, not the head.** When the budget runs out, the *oldest* messages condense or drop, and the document says how many. Losing the tail is what would make continuation fail.

Tune the ceiling in `~/.pi/agent/settings.json`:

```json
{
  "sessionHub": {
    "contextChars": 40000
  }
}
```

It is a ceiling, not a target: a short session costs far less. For a zero-token look at any session, use `v`.

## The two rules

### Nothing outside the index is written

The only writable path is `~/.pi/agent/pi-session-hub/`. Every harness store is opened read-only, including the SQLite databases. The acceptance suite fingerprints every external store before and after a full scan and fails if anything changed.

### External sessions are never disguised as Pi sessions

A Claude, Codex, OpenCode, Crush or JCode conversation is **never** converted into a Pi session file that pretends Pi created it. There are exactly two paths:

- **Native resume** (`n`): reopen the session in its own harness, using its own command. Every command states its verification basis in the confirmation dialog (`cli-help` means the flag is documented in that tool's own `--help`). All six harnesses have one. The single exception is Claude sub-agent transcripts, whose ids `claude --resume` does not accept, so the hub refuses rather than handing you a command that would fail.
- **Cross-harness handoff** (`h`, or `Enter` for context loading): the conversation arrives in a new message explicitly labelled as imported, naming the source harness, session id and path.

Context loading is generated locally and deterministically. No LLM, no network, no uploading transcripts anywhere. Fields the source format cannot supply are written as `not available` rather than guessed.

## Supported harnesses

| Harness | Store | Format | Native resume |
|---|---|---|---|
| Pi | `~/.pi/agent/sessions/--<cwd>--/*.jsonl` | JSONL tree v3 | `pi --session <path>` |
| Claude Code | `~/.claude/projects/<slug>/*.jsonl` | JSONL (undocumented) | `claude --resume <uuid>` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL (undocumented) | `codex resume <id>` |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite | `opencode --session <id>` |
| Crush | `~/.crush/crush.db` | SQLite | `crush --session <id>` |
| JCode | `~/.jcode/sessions/*.json` | JSON | `jcode --resume <id>` |

Each harness gets its own adapter. A missing, empty or unreadable store degrades to a specific message ("no store at ...", "cannot read ...") instead of an empty list, and one broken adapter never takes down the others.

Adding a harness means adding one file under `src/adapters/` that implements `SessionAdapter` and registering it in `src/adapters/registry.ts`.

## Search

`/session-search <query>` and the `session_hub_search` tool both use a local SQLite FTS5 index.

- bare terms use prefix matching, so `pliego` matches `pliego-prod`
- `"exact phrase"` matches phrases
- `-term` excludes

The index stores each session's title, metadata and a bounded excerpt of the conversation (20k characters, sampled from both the start and the end). It is a second local copy of some conversation text: if you back up `~/.pi`, the index goes with it. Delete `~/.pi/agent/pi-session-hub/index.sqlite` to remove it; it is rebuilt on the next scan.

## Failure behaviour

Two failure modes are explicitly designed against, because both are worse than a crash:

- **A failed read is never reported as "no sessions".** Reads throw, and the error is surfaced in the UI and in tool results. An unreadable index and an empty index are different messages.
- **A failing adapter never deletes data.** Sessions are only dropped from the index for harnesses that were actually read successfully this pass, so one transient failure cannot wipe that harness's history.

Both are covered by regression tests.

## Privacy

- The index is local: `~/.pi/agent/pi-session-hub/index.sqlite`.
- Credential stores are never read. `auth.json`, `.credentials.json`, `.env`, `request_dump_*` and similar are denied by name before any open is attempted.
- Transcript text passes through a best-effort redactor (Bearer tokens, `sk-` keys, JWTs, assignments and quoted JSON credential fields) before indexing, handoff or Web display. This does not guarantee detection of every possible secret.
- Indexing and searching never contact external services. The optional Web Viewer serves records over authenticated loopback HTTP only.

## Architecture

```
extensions/session-hub.ts   command, shortcut, tool and renderer wiring
src/adapters/               one read-only adapter per harness
src/index/                  local SQLite + FTS5 index, incremental scan
src/context.ts              tiered, budgeted transcript context
src/handoff.ts              deterministic handoff document
src/native.ts               native resume resolve and launch
src/security.ts             path guards and secret redaction
src/tui/                    full-screen hub and transcript viewer
src/web/                    loopback server, safe Markdown/math and browser UI
bin/web.mjs                 independent Web Viewer CLI
skills/session-hub/         agent-facing skill
```

Verified against the running binary rather than assumed:

| API | Visible in transcript | In LLM context |
|---|---|---|
| `pi.sendMessage` | yes | yes |
| `pi.appendEntry` | yes | no |
| `ctx.sessionManager.appendCustomMessageEntry` | no | yes |

`pi.sendMessage` is the only one that does both, and it lives on the extension API rather than the command context, so it also works from a keyboard shortcut.

## Development

```bash
node test/scan.mjs         # isolated incremental-scan regression tests
node test/smoke.mjs        # exercise every adapter against real stores
node test/acceptance.mjs   # full requirement suite
npm run test:web          # synthetic-home HTTP, security, math and CLI tests
npm run test:web:browser  # optional real browser checks; requires Chrome or CHROME_BIN
```

The Web tests use temporary, synthetic homes and fake credential values; they do
not require or publish real transcripts. Browser tests use Chrome's debugging
protocol, including a different-port forwarding fixture. Screenshots are optional:
set `WEB_SCREENSHOT`, `WEB_SCREENSHOT_AGENT` or `WEB_SCREENSHOT_MOBILE` to an output
path outside the repository. Never commit real-session captures or debug logs.

The original acceptance suite also depends on the developer's real stores,
specific historical search terms and scan timing, so it is not a portable CI
pass/fail signal on an arbitrary home. Active sessions can change its store
fingerprints during a run; use the synthetic Web suite for isolated regression.

The acceptance suite runs against real stores and against a synthetic foreign home, and asserts among other things: index counts equal detected counts, FTS rows equal session rows with no orphans, uids are unique, the context stays inside its budget regardless of session length, the handoff contains every required field, unavailable fields are reported honestly, all six adapters detect, index, search and read a home this project has never seen, and no external store file is modified.

`test/tools/screen.py` reconstructs a screen from a raw ANSI capture, and `test/tools/png.py` renders one to PNG with font fallback. Both exist because stripping escape codes from a full-screen TUI produces a misleading picture.

## Publishing

The [Pi package gallery](https://pi.dev/packages) indexes npm automatically: it lists every package tagged with the `pi-package` keyword. There is no submission form, no review, and no repository template to follow. Once published, the package has its own page at [pi.dev/packages/pi-session-hub](https://pi.dev/packages/pi-session-hub).

```bash
npm login
npm publish
```

**`npm login` alone is not enough.** npm requires a second factor to publish, and a web-login session cannot satisfy it, so the upload is rejected:

```text
403 Forbidden - Two-factor authentication or granular access token with bypass 2fa
enabled is required to publish packages.
```

Create a **granular access token** at [npmjs.com/settings/&lt;user&gt;/tokens](https://www.npmjs.com/settings) with **Bypass two-factor authentication** checked (it is **unchecked by default**, which is the easy mistake) and **Read and write (publish and stage)** on all packages, then:

```bash
npm config set //registry.npmjs.org/:_authToken npm_...
npm publish
```

Or enable 2FA on the account and publish with `npm publish --otp=<code>`.

Two things worth knowing:

- A token can authenticate (`npm whoami` works) and still be unable to publish, because the bypass flag is missing. `npm token list` labels it a "Publish token" either way, so the label is not proof that the bypass is on.
- npm is removing direct publish from bypass-2FA tokens in **January 2027**. After that, automated publishing has to move to [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) or [staged publishing](https://docs.npmjs.com/staged-publishing).

The gallery's browsable list is a periodic snapshot sorted by download count, so a brand-new package appears in the list only after the next rebuild, while its detail page works immediately.

To ship a change, bump `version` and publish again. Before publishing, verify the artifact rather than the repo:

```bash
npm pack --dry-run
npm pack && tar xzf pi-session-hub-*.tgz && pi -e ./package
```

## Limitations

- **Claude Code and Codex formats are undocumented.** Parsers are defensive and degrade to filename-derived metadata rather than throwing, but a format change may cost fields until the adapter is updated.
- **Crush does not record a session working directory**, so those sessions show no repo and cannot be filtered by project.
- **Claude sub-agent transcripts** are indexed (they contain real work) but marked as not resumable and carry their parent session id in the notes.
- **Recovered transcripts are bounded**: adapter limits vary, and Web calls/results are capped at 8k characters per record. Recovery counts and reading-limit notes are shown; the viewer does not promise an unlimited transcript. Grouping does not remove individual recovered records.
- **Search covers a bounded excerpt**, not the entire history of a very long session. Phrases from beyond the sampled window will not match.
- The screenshot above is the real UI captured from a synthetic home directory so that every harness appears at once. It is illustrative data, not anyone's actual sessions.

## Contributing

Keep user-facing claims tied to source. If you change adapters, the context budget, search behaviour or the TUI, update this README in the same change and run `node test/acceptance.mjs`.

Adding a harness: implement `SessionAdapter` in `src/adapters/<name>.ts`, register it in `src/adapters/registry.ts`, add a badge in `src/tui/badges.ts`, and extend the portability section of the acceptance suite with a fixture for that harness.

## License

[MIT](LICENSE)
