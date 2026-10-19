import * as vscode from "vscode";
import fs from "node:fs";
import type { NativeResumeAction } from "../../src/native.ts";
import type { ResumeLauncher } from "../../src/core/types.ts";
import { redact } from "../../src/security.ts";
import { assertPiEnvironmentAvailable } from "../../src/core/pi-environment.ts";
import { assertNewSessionLaunchable, type NewSessionTarget } from "../../src/core/new-session.ts";

export class TerminalLauncher implements ResumeLauncher {
  async launch(action: NativeResumeAction): Promise<void> {
    if (!action.verified) throw new Error("Refusing to launch an unverified command");
    assertPiEnvironmentAvailable(action);
    if (action.cwd && !fs.statSync(action.cwd).isDirectory()) throw new Error("The source session working directory is unavailable");
    const answer = await vscode.window.showWarningMessage(
      redact([action.description, `${action.command} ${action.args.join(" ")}`,
        `Working directory: ${action.cwd || "Not recorded by the source (using the terminal default directory)"}`,
        ...(action.piEnvironment?.selected ? [
          `Pi environment: ${action.piEnvironment.selected.label}`,
          `PI_CODING_AGENT_DIR=${action.piEnvironment.selected.agentDir}`,
          action.piEnvironment.reason,
        ] : []),
      ].join("\n")),
      { modal: true }, "Resume in terminal");
    if (answer !== "Resume in terminal") return;
    // shellPath + argv, not shell command text: source IDs/paths can't inject
    // shell syntax. The CLI runs its original interactive TUI in a native PTY.
    const terminal = vscode.window.createTerminal({ name: `Session Hub · ${action.piEnvironment?.selected?.label ?? action.command}`,
      cwd: action.cwd, env: action.env, shellPath: action.command, shellArgs: action.args, isTransient: true });
    terminal.show();
  }

  /** Blank session the user just picked from the sidebar: no argv, no history,
   * so no second confirmation. Same native-PTY, no-shell-text launch as resume. */
  startNew(target: NewSessionTarget, cwd: string | undefined): void {
    assertNewSessionLaunchable(target, cwd);
    const terminal = vscode.window.createTerminal({ name: `Session Hub · New session · ${target.label}`,
      cwd, env: target.env, shellPath: target.executable, shellArgs: [], isTransient: true });
    terminal.show();
  }
}
