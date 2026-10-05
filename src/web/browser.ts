import { execFile } from "node:child_process";
import fs from "node:fs";

/** VS Code/Cursor's $BROWSER routes a remote URL to the local client.
 * Do not substitute `code --open-external`: some remote CLIs silently ignore it.
 * Opening is best-effort and must never shut down the viewer. */
export async function openLocalBrowser(
  url: string,
  options: { browser?: string; timeoutMs?: number } = {},
): Promise<string> {
  const browser = options.browser ?? process.env.BROWSER;
  if (!browser) return "环境里没有 BROWSER；请在 VS Code 端口面板选择“在浏览器中打开”，并补上启动链接的 #token=…。";
  try {
    await fs.promises.access(browser, fs.constants.X_OK);
  } catch {
    return "BROWSER 指向的程序不可执行；请手动使用端口面板中的本地地址和启动链接的 #token=…。";
  }
  return new Promise(resolve => {
    execFile(browser, [url], { timeout: options.timeoutMs ?? 15000, maxBuffer: 64 * 1024, windowsHide: true }, (error, _stdout, stderr) => {
      if (error || /Ignoring option/i.test(stderr)) {
        resolve("调用外部浏览器失败或超时；服务仍在运行，请手动使用端口面板中的本地地址和启动链接的 #token=…。");
      } else {
        resolve("已通过 BROWSER 请求 VS Code/本地客户端打开外部浏览器；若未弹出，请检查客户端的浏览器设置。端口转发仍需保持开启。");
      }
    });
  });
}
