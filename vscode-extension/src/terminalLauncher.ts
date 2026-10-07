import * as vscode from "vscode";
import fs from "node:fs";
import type { NativeResumeAction } from "../../src/native.ts";
import type { ResumeLauncher } from "../../src/core/types.ts";
import { redact } from "../../src/security.ts";
import { assertPiEnvironmentAvailable } from "../../src/core/pi-environment.ts";

export class TerminalLauncher implements ResumeLauncher {
  async launch(action: NativeResumeAction): Promise<void> {
    if (!action.verified) throw new Error("拒绝启动未经验证的命令");
    assertPiEnvironmentAvailable(action);
    if (action.cwd && !fs.statSync(action.cwd).isDirectory()) throw new Error("源会话的工作目录不可用");
    const answer = await vscode.window.showWarningMessage(
      redact([action.description, `${action.command} ${action.args.join(" ")}`,
        `工作目录：${action.cwd || "来源未记录（使用终端默认目录）"}`,
        ...(action.piEnvironment?.selected ? [
          `Pi 环境：${action.piEnvironment.selected.label}`,
          `PI_CODING_AGENT_DIR=${action.piEnvironment.selected.agentDir}`,
          action.piEnvironment.reason,
        ] : []),
      ].join("\n")),
      { modal: true }, "在终端中继续");
    if (answer !== "在终端中继续") return;
    // shellPath + argv, not shell command text: source IDs/paths can't inject
    // shell syntax. The CLI runs its original interactive TUI in a native PTY.
    const terminal = vscode.window.createTerminal({ name: `Session Hub · ${action.piEnvironment?.selected?.label ?? action.command}`,
      cwd: action.cwd, env: action.env, shellPath: action.command, shellArgs: action.args, isTransient: true });
    terminal.show();
  }
}
