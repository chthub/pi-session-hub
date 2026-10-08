# Session Hub · VS Code Remote SSH

在 VS Code 编辑器标签页里阅读 Pi、Claude Code、Codex、OpenCode、Crush、JCode 的历史会话，并在原生集成终端中继续。

## 构建与安装

当前是仓库内的独立扩展，尚未发布到 Marketplace。要求 VS Code 1.99+，工作区扩展宿主提供 Node 22.5+ 和 `node:sqlite`。Remote SSH 时，扩展逻辑必须安装到远程服务器，而不是仅安装在本机。

在仓库根目录执行：

```bash
npm ci --prefix vscode-extension
npm run package --prefix vscode-extension
```

然后：

1. 用 Remote SSH 连接 Linux 服务器，打开项目目录。
2. 在扩展面板中执行 **Install from VSIX…**，选择生成的 `pi-session-hub-vscode-0.1.0.vsix`，确认安装位置是远程 SSH 主机。
3. 打开 Activity Bar 的 **Session Hub**。会话树按「当前项目」「项目未识别」「其他项目」分组，支持多根工作区。
4. 点击会话，在编辑器标签页阅读 Markdown、数学公式、分组工具活动；右侧目录可按用户消息跳转，工具栏可切换原文。
5. 点击 **在终端中继续**，确认命令后进入原生 Pi / Claude 等 CLI 的 TUI。右键菜单也可继续或复制带 harness 前缀的会话 ID。
6. 新会话或历史更新后，点击会话树顶部的刷新按钮。

无需启动 HTTP 服务、打开浏览器或转发端口。原有 Pi `/session-hub` 与独立 Web Viewer 继续可用；VS Code 是新增 host，不是替代品。

更新同版本安装包时，可在 Remote SSH 终端执行以下命令，然后运行 `Developer: Reload Window`：

```bash
code --install-extension vscode-extension/pi-session-hub-vscode-0.1.0.vsix --force
```

会话树每条记录使用与 TUI 一致的 harness 图标（Pi π、Claude ✻、Codex ⬡、OpenCode ⌘、Crush ❯、JCode ◆），由本地 SVG 提供明暗两套颜色，不依赖终端字体。

正文保留 HTTP/mailto 超链接。项目内相对文件链接按**来源会话的 cwd** 解析，点击交给 VS Code 打开对应文件（HTML 默认打开源文件，安装预览扩展后可预览）；Remote SSH 时打开远程文件，不在本机拼路径。不启动网页服务。缺少 cwd、越出项目目录、凭据文件或危险协议的链接不启用；文件消失会明确报错。独立 HTTP 阅读器仍禁用本地文件链接。

Session 标签中的标题最多显示 20 个字符，过长显示 `…`，不会拆开 emoji。完整标题仍保留在会话树和正文中；扩展不修改 VS Code 的编辑器标签宽度设置。

## Pi 环境配置

多个 Pi 启动方式可能使用不同的配置目录，即使它们共享同一个 `sessions` 目录。环境列表放在远程用户的 `~/.pi/agent/pi-session-hub/config.json`，不写进扩展代码或项目配置。例如：

```json
{
  "piEnvironments": [
    { "id": "default", "label": "Pi", "agentDir": "~/.pi/agent" },
    { "id": "work", "label": "Pi Work", "agentDir": "~/.pi/agent-work" }
  ]
}
```

- `id` 是唯一标识；`label` 是显示名称（可省略）；`agentDir` 是 Pi 配置目录，支持绝对路径或 `~/`，不支持 shell 命令。
- 没有该文件时，只提供标准 `~/.pi/agent` 环境，不内置任何个人账号名称。配置修改会在下一次 Resume 时重新读取。
- Hub 只从保存的系统消息 `project_context` 中的 Context 文件路径识别已配置环境；也支持压缩记录里的系统 checkpoint。不会从用户正文、工具输出、模型名或共享历史目录猜账号。
- 找到唯一匹配时，终端显式设置 `PI_CODING_AGENT_DIR`，并在确认框中显示名称、目录和识别来源。Pi 内的 `/session-native` 同样使用这套用户配置。
- 缺少信息、存在多个环境、Context 结构不完整或源读取被截断时，由 VS Code / Pi 的原生选择框询问本次使用哪个环境；取消则不启动。手动选择不改写原会话。
- 未配置的环境不会自动采用；已识别的目录消失则报错，不退回默认账号。配置错误会明确报错。
- 这里只恢复配置目录，并不保证凭据仍有效或模型仍可用。不会读取、复制或存储 `auth.json` / token。不要在 Hub 配置里写凭据。
- 本设置不改变 Pi 历史扫描目录，也不执行 shell alias。若环境还依赖其它启动参数，需要另行明确配置设计，不能从历史中猜测。

## 安全与边界

- 读取远程用户的 `~/.pi`、`~/.claude` 等源记录，只写 `~/.pi/agent/pi-session-hub/` 索引。扩展浏览记录不修改源文件。
- Resume 是明确确认后的独立动作，原生 agent 随后会自行维护会话；其行为不属于历史查看器的只读保证。
- Webview 通过经过校验的 UID 消息与扩展通信，不能提供任意文件路径、命令或 argv。每个页面只访问绑定的会话；打开本地链接只能提交正文渲染时由宿主签发的 ID，宿主在点击时检查项目边界、符号链接和受保护路径。
- CSP 禁止 Webview 网络连接及图片加载，脚本、KaTeX 样式和字体全部打包在本地；Markdown 禁止原始 HTML，并尽力脱敏。
- 在不可信工作区和虚拟工作区中不启用扩展。
- 继续命令使用来源记录的 cwd；不猜测当前工作区或 session-store 父目录。未记录 cwd 时使用终端默认目录，并在确认框中提示；记录的目录已消失则报错，不静默换目录。
- 超过 64 MiB 的文件只读取前段，并明确显示 `truncated`：最新消息可能缺失。目前尚未实现分块完整恢复，也保留 adapter 的记录数量与单条文本上限。
- 子 agent 历史可阅读，但 Claude 子 agent 记录不能通过 `--resume` 继续。
- CLI 必须已安装并在远程环境 PATH 中可用；这不是 agent runtime 的安装器。

## 自动测试与人工验收

```bash
npm ci --legacy-peer-deps
npm test
npm run test:web
npm run test:web:browser
npm run test:vscode
```

VS Code 自动测试使用真实的共享 core、SQLite 和 Markdown，模拟 VS Code API 验证会话树、Webview 消息、安全边界和终端选项。**它不等于真正 Remote SSH 验收。**

本次 Remote SSH 工作流已完成用户手工测试。升级、变更配置或发布新版本时，仍应在真实 Remote SSH 窗口检查：

- `Developer: Show Running Extensions` 中 Session Hub 位于远程工作区扩展宿主。
- 当前项目的 Pi / Claude 历史出现在会话树中，未识别项目的记录仍可访问。
- 点击历史不会打开浏览器，Ports 面板不新增服务；正文、公式、工具组、原文切换与用户目录正常。
- Pi / Claude 的继续动作分别进入真实原生 TUI，cwd 正确，既有 plugins / skills / 环境继续生效。
- Pi `/session-hub` 和 `npm run web` 均仍正常。

尚不包含运行状态检测、AgentSlot、终端网格、终端持久化或 PSM runtime。
