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
3. 打开 Activity Bar 的 **Session Hub** → **Session History**。两行卡片按 **Current Project**、**Unassigned**、**Other Projects** 分组，支持多根工作区。第一行完整用于标题，第二行显示工具、时间和星标按钮。长标题省略显示，悬停可查看全文。
4. 点击会话，在编辑器标签页阅读 Markdown、数学公式、分组工具活动；右侧目录可按用户消息跳转，工具栏可切换原文。
5. 点击 **Resume in terminal**，确认命令后进入原生 Pi / Claude 等 CLI 的 TUI。右键菜单也可继续或复制带 harness 前缀的会话 ID。
6. 要开始空白的新对话，点击侧栏顶部刷新按钮旁的 **+**，选择 harness，即在新终端中启动对应 CLI。只列出 `PATH` 中找到的命令；Pi 按每个已配置的 Pi 环境各列一项，并显式传入 `PI_CODING_AGENT_DIR`。工作目录为当前工作区文件夹，多根工作区会先让你选择文件夹。
7. 新会话或历史更新后，点击侧栏顶部的刷新按钮。每个分组先显示 100 条，点击 **Load more** 继续浏览，不限制索引中的历史总量。

扩展生成的菜单、提示、阅读页工具栏、目录和工具活动标签统一使用英文；用户的会话标题、正文、工具原始内容和配置名称保留原文。独立 HTTP Web Viewer 的默认中文界面不变。

侧栏标题栏从左到右为 **Search Sessions**（放大镜）、**New Session**（+）、**Refresh Index**。搜索面板默认收起，点击放大镜才展开搜索框和 **Search in** 范围选择：**User prompts**（默认）、**User + assistant**、**All content, including tools**。输入后自动搜索，切换范围立即重新检索；Enter 立即搜索，Escape 清空关键词。再次点击放大镜或面板内的 × 会收起并清空搜索，避免隐藏的条件继续过滤列表。搜索结果保留项目分组、星标和分页；匹配分组自动展开，清空后恢复原折叠状态。面板打开时，Webview 重建会恢复当前搜索；刷新索引也会沿用当前条件。

搜索基于本地、有大小上限的索引摘要，不是无损全文检索；长会话未保留的中间内容可能搜不到。「仅用户提问」不会因会话标题、项目路径、assistant 回复或嵌在用户记录中的工具输出而命中。扩大范围不会上传历史，也不会在每次输入时重新读取全部源文件。升级后首次刷新会自动重建搜索摘要，可能比平时刷新慢。

无需启动 HTTP 服务、打开浏览器或转发端口。原有 Pi `/session-hub` 与独立 Web Viewer 继续可用；VS Code 是新增 host，不是替代品。

更新同版本安装包时，可在 Remote SSH 终端执行以下命令，然后运行 `Developer: Reload Window`：

```bash
code --install-extension vscode-extension/pi-session-hub-vscode-0.1.0.vsix --force
```

点击卡片第二行始终可见的 **☆** 按钮，即可加星标：按钮变为 **★**，标题和左边框变为金黄色，整张卡片带淡金色背景。再次点击取消高亮。星标按钮不会打开正文或触发重新扫描，已有星标也会自动恢复高亮。按钮支持 Tab 聚焦和空格/Enter 操作。

加星标后，会话自动置顶到**所属项目分组**的顶部；星标会话之间仍按最近更新时间排列，普通会话保持原有顺序。取消星标后恢复原来的时间排序。排序在分页前完成，较旧的星标会话也会出现在第一页，刷新或重启后仍保持置顶。

点击标题、第二行元信息或卡片空白处都能打开会话；星标仍是独立操作，不会误打开正文。卡片右键菜单保留打开、继续、复制 ID、加星标/取消星标，不改变项目归属或原对话正文。

时间最多使用 **3 days ago** 这样的相对描述；超过 72 小时后显示本地日期 **YYYY-MM-DD**，不再显示很大的“几天前”。

颜色会随深色、浅色和高对比度主题调整，也可通过 `workbench.colorCustomizations` 中的 `sessionHub.starredForeground` 自定义；扩展不会修改用户的主题设置。

星标只保存在 VS Code 扩展的 `globalState` 中，以完整的 `harness:nativeId` 为键；同一扩展存储环境内刷新、重启或切换工作区后仍保留。Remote SSH 使用远程扩展宿主的存储，不承诺跨主机或 VS Code Profile 同步。暂时未扫描到的会话不会自动清除星标。加星标/取消星标不会修改来源记录、Hub 索引或工作区设置；保存失败会提示错误，卡片高亮保持不变。

会话卡片第二行使用与 TUI 一致的 harness 图标（Pi π、Claude ✻、Codex ⬡、OpenCode ⌘、Crush ❯、JCode ◆），由本地 SVG 提供明暗两套颜色，不依赖终端字体。

正文保留 HTTP/mailto 超链接。项目内相对文件链接按**来源会话的 cwd** 解析，点击交给 VS Code 打开对应文件（HTML 默认打开源文件，安装预览扩展后可预览）；Remote SSH 时打开远程文件，不在本机拼路径。不启动网页服务。缺少 cwd、越出项目目录、凭据文件或危险协议的链接不启用；文件消失会明确报错。独立 HTTP 阅读器仍禁用本地文件链接。

Session 标签中的标题最多显示 20 个字符，过长显示 `…`，不会拆开 emoji。完整标题仍保留在会话卡片的悬停提示和正文中；扩展不修改 VS Code 的编辑器标签宽度设置。

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

## Codex 多目录配置

同一个 `~/.pi/agent/pi-session-hub/config.json` 还支持 `codexHomes`。例如在保留已有 `piEnvironments` 的同时增加：

```json
{
  "codexHomes": ["~/.codex", "~/.codex-work"]
}
```

- 填的是 Codex **home 目录**，不是 `sessions`；插件会扫描每个目录下的 `sessions`。
- 不配置时只扫描 `~/.codex/sessions`。显式配置会替换默认列表；要保留默认历史，请把 `~/.codex` 也写进去。
- 列表不能为空，支持绝对路径和 `~/`，拒绝规范化后重复的路径、未知字段和凭据类路径。不要在配置中写 token 或 shell 命令。
- 修改后点击「刷新索引」即可生效，不需要重新构建插件；新增目录的首次扫描可能较慢。更改目录不会移动或修改原始记录。同一 Codex session ID 的多份副本仍只占一条索引记录。
- **Resume in terminal** 根据所选会话的来源路径设置对应的 `CODEX_HOME`，保留来源 cwd，并在确认框显示。来源已不属于配置目录、文件消失或符号链接越界时，不会静默换到默认账号。这里只选择目录，不保证该环境的凭据或模型仍可用。
- 此项只影响历史扫描和继续会话，不会给空白新建会话菜单增加 Codex 环境选项，也不会读取 `auth.json`。

## 安全与边界

- 读取远程用户的 `~/.pi`、`~/.claude` 等源记录，刷新时写入 `~/.pi/agent/pi-session-hub/` 索引。星标另存于扩展 `globalState`；扩展浏览记录与标记星标不修改源文件。
- Resume 是明确确认后的独立动作，原生 agent 随后会自行维护会话；其行为不属于历史查看器的只读保证。
- Webview 通过经过校验的 UID 消息与扩展通信，不能提供任意文件路径、命令或 argv。正文页面只访问绑定的会话，侧栏只操作已加载列表中的会话。打开本地链接只能提交正文渲染时由宿主签发的 ID，宿主在点击时检查项目边界、符号链接和受保护路径。
- CSP 禁止 Webview 网络连接；侧栏只允许扩展内置的本地图标，正文禁止图片加载。脚本、KaTeX 样式和字体全部打包在本地；Markdown 禁止原始 HTML，并尽力脱敏。侧栏标题通过纯文本 DOM 插入，不解释为 HTML。
- 在不可信工作区和虚拟工作区中不启用扩展。
- 继续命令使用来源记录的 cwd；不猜测当前工作区或 session-store 父目录。未记录 cwd 时使用终端默认目录，并在确认框中提示；记录的目录已消失则报错，不静默换目录。
- 大文件改为流式扫描，不再在 64 MiB 处截掉后半段。展示最多保留 8,000 个文本块 / 8 Mi 字符；超出时保留开头三个块和最新部分，并提示省略的中间块数量。单条文本仍有 4k–8k 字符限制。单个源记录/JSON 值有 64 MiB 保护：JSONL 超大或损坏记录会被跳过并提示，后续记录继续读取；整体 JSON 无效或单值超限时读取失败。
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

VS Code 自动测试使用真实的共享 core、SQLite 和 Markdown，模拟 VS Code API 验证分组、侧栏/正文 Webview 消息、安全边界和终端选项。`npm run test:vscode:browser` 使用 Chrome 检查真实侧栏布局、星标点击/键盘操作、主题、分页和滚动位置。**它们不等于真正 Remote SSH 验收。**

本次 Remote SSH 工作流已完成用户手工测试。升级、变更配置或发布新版本时，仍应在真实 Remote SSH 窗口检查：

- `Developer: Show Running Extensions` 中 Session Hub 位于远程工作区扩展宿主。
- 当前项目的 Pi / Claude 历史以两行卡片显示，标题独占第一行；未识别项目的记录仍可访问，加载更多能显示较旧记录。
- 点击第二行星标按钮后显示 `★`、整卡高亮并在所属分组置顶，不打开正文、不重新扫描；再次点击取消并恢复时间排序。刷新、Reload Window 和切换工作区后星标仍保留，右键继续/复制 ID 仍可用。
- 默认搜索只匹配用户提问；扩大到 assistant 消息后可搜到回复中的独有词，选择全部内容后可搜到工具参数与输出。放大镜控制展开/收起，关闭会清空筛选；切换范围、清空、加载更多与刷新索引正常。
- 点击历史不会打开浏览器，Ports 面板不新增服务；正文、公式、工具组、原文切换与用户目录正常。
- Pi / Claude 的继续动作分别进入真实原生 TUI，cwd 正确，既有 plugins / skills / 环境继续生效。
- Pi `/session-hub` 和 `npm run web` 均仍正常。

尚不包含运行状态检测、AgentSlot、终端网格、终端持久化或 PSM runtime。
