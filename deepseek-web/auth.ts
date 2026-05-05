import { execSync } from "node:child_process";
import type { Credentials } from "./types.js";

const CDP_URL = "http://127.0.0.1:9222";

/**
 * 在 Android 上通过 am 命令打开 Chrome 并跳转到指定 URL。
 * 桌面端或执行失败时静默跳过。
 */
function openInChrome(url: string): void {
  if (process.platform === "android") {
    try {
      execSync(
        `am start -a android.intent.action.VIEW -d "${url}"` +
          ` -n com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity`,
        { stdio: "ignore", timeout: 3000 }
      );
    } catch {
      // Chrome 未安装或无法启动，用户可手动打开
    }
  }
}

/**
 * 通过已打开的 Chrome 调试端口捕获 DeepSeek 凭证。
 * - 桌面端：Chrome 已启动并监听 9222
 * - Android 端：已通过 adb forward 将手机端口映射到本机 9222
 *
 * 登录完成后 Chrome 可立即关闭，后续对话不需要它。
 *
 * @param onProgress 进度回调，用于向调用者报告状态
 * @returns 凭证对象 { cookie, bearer, userAgent }
 */
export async function loginDeepseek(
  onProgress: (msg: string) => void
): Promise<Credentials> {
  // 动态导入 playwright-core，确保在平台伪装（如 Termux）之后才加载
  const { chromium } = await import("playwright-core");

  // ─── 1. 检查 CDP 端口 ─────────────────────────────────
  onProgress("正在检查 Chrome 调试端口...");
  let versionRes: Response;
  try {
    versionRes = await fetch(`${CDP_URL}/json/version`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error(
      "无法连接 Chrome。请先启动带 --remote-debugging-port=9222 的 Chrome，或确认 adb forward 已配置"
    );
  }
  const versionData: any = await versionRes.json();
  const wsUrl = versionData.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error("未找到 WebSocket 调试 URL");

  // ─── 2. 附加到浏览器 ─────────────────────────────────
  onProgress("正在连接浏览器...");
  const browser = await chromium.connectOverCDP(wsUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());

  // ─── 3. 动态提取 User-Agent（不硬编码）─────────────────
  let userAgent = "";
  try {
    const pages = context.pages();
    if (pages.length > 0) {
      userAgent = await pages[0].evaluate(() => navigator.userAgent);
    } else {
      // 没有已打开的页面，临时创建一个空白页用于提取 UA
      const tempPage = await context.newPage();
      userAgent = await tempPage.evaluate(() => navigator.userAgent);
      await tempPage.close();
    }
  } catch {
    throw new Error(
      "无法从浏览器获取 User-Agent，请确认 Chrome 已正常启动"
    );
  }
  if (!userAgent) {
    throw new Error("从浏览器获取的 User-Agent 为空，请检查 Chrome 状态");
  }

  // ─── 4. 先检查是否已有有效登录态 ──────────────────────
  const existingCookies = await context.cookies([
    "https://chat.deepseek.com",
    "https://deepseek.com",
  ]);
  const cookieStr = existingCookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  onProgress("正在检查现有登录态...");
  let bearer = "";

  try {
    const checkRes = await fetch(
      "https://chat.deepseek.com/api/v0/users/current",
      {
        headers: {
          Cookie: cookieStr,
          "User-Agent": userAgent,
          Accept: "application/json",
          Referer: "https://chat.deepseek.com/",
          Origin: "https://chat.deepseek.com",
        },
      }
    );
    if (checkRes.ok) {
      const data: any = await checkRes.json();
      bearer = data?.data?.biz_data?.token || "";
      if (bearer) {
        onProgress("发现有效登录态，无需重新登录！");
        await browser.close();
        return { cookie: cookieStr, bearer, userAgent };
      }
    }
  } catch {
    // 请求失败，继续登录流程
  }

  onProgress("未发现有效登录态，开始登录流程...");

  // ─── 5. 查找或打开 DeepSeek 页面 ──────────────────────
  let page = context.pages().find((p) =>
    p.url().includes("chat.deepseek.com")
  );
  if (!page) {
    // Android 下用 am 命令自动打开 Chrome
    openInChrome("https://chat.deepseek.com");

    onProgress("等待 DeepSeek 页面在 Chrome 中打开...");
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      page = context.pages().find((p) =>
        p.url().includes("chat.deepseek.com")
      );
      if (page) break;
    }
    if (!page) {
      throw new Error(
        "无法自动打开 DeepSeek 页面，请手动在 Chrome 中打开 chat.deepseek.com 后重试"
      );
    }
  } else {
    onProgress("切换到已有的 DeepSeek 标签页...");
    await page.bringToFront();
  }

  // ─── 6. 提示用户登录并捕获凭证 ────────────────────────
  onProgress("请在浏览器窗口中登录 DeepSeek，凭证会自动捕获...");

  let capturedBearer = "";
  let resolved = false;

  // 捕获请求中的 Authorization header
  page.on("request", (req) => {
    if (resolved) return;
    if (req.url().includes("/api/v0/")) {
      const auth = req.headers()["authorization"];
      if (auth?.startsWith("Bearer ") && !capturedBearer) {
        capturedBearer = auth.slice(7);
        onProgress("✅ 已捕获 Bearer Token");
      }
    }
  });

  // 从 users/current 响应中获取 token（备用路径）
  page.on("response", async (resp) => {
    if (resolved || capturedBearer) return;
    if (resp.url().includes("/api/v0/users/current") && resp.ok()) {
      try {
        const body: any = await resp.json();
        const token = body?.data?.biz_data?.token;
        if (token) {
          capturedBearer = token;
          onProgress("✅ 从 API 响应中提取到 Bearer Token");
        }
      } catch {
        // 忽略解析错误
      }
    }
  });

  // ─── 7. 轮询等待 Bearer + 有效 Cookie 都就绪 ──────────
  try {
    const result = await new Promise<Credentials>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("登录超时（5 分钟）")),
        300_000
      );

      const interval = setInterval(async () => {
        if (resolved) return;

        // ⚠️ Bearer 必须存在，否则不视为登录成功
        if (!capturedBearer) return;

        const cookies = await context.cookies([
          "https://chat.deepseek.com",
          "https://deepseek.com",
        ]);
        const cookieStr = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        if (
          cookieStr.includes("d_id=") ||
          cookieStr.includes("ds_session_id=")
        ) {
          resolved = true;
          clearTimeout(timeout);
          clearInterval(interval);
          resolve({
            cookie: cookieStr,
            bearer: capturedBearer,
            userAgent,
          });
        }
      }, 2000);
    });

    return result;
  } finally {
    // 断开 CDP 连接，不关闭浏览器（用户自行决定）
    await browser.close();
  }
}