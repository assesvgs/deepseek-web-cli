/**
 * 独立的 DeepSeek Web 登录脚本，与 OpenCode AI 对话完全解耦。
 *
 * 用法：
 *   cd .opencode/plugin/deepseek-web
 *   npx tsx login.ts
 *
 * 前置条件：
 *   - Chrome 已启动并监听 9222 调试端口（桌面端）
 *   - 或已通过 adb forward 将手机 Chrome 映射到本机 9222（Android / Termux）
 */

// 平台伪装：支持在 Termux/Android 上运行 Playwright
if (process.platform === 'android') {
  Object.defineProperty(process, 'platform', { value: 'linux' });
}

import { loginDeepseek } from "./auth.js";
import { saveCredentials, CREDENTIALS_PATH } from "./constants.js";

async function main() {
  console.log('🔑 DeepSeek Web 登录工具');
  console.log('='.repeat(40));
  console.log('');

  try {
    const cred = await loginDeepseek((msg: string) => {
      console.log(`  ⏳ ${msg}`);
    });

    saveCredentials(cred);

    console.log('');
    console.log(`✅ 登录成功！凭证已保存到 ${CREDENTIALS_PATH}`);
    console.log('');
    console.log('现在你可以：');
    console.log('  1. 关闭 Chrome 调试窗口（不再需要）');
    console.log('  2. 直接在 OpenCode 中使用 deepseek-web/deepseek-chat 模型');
    console.log('  3. 如果凭证过期，再次运行此脚本即可');
  } catch (err: any) {
    console.error('');
    console.error(`❌ 登录失败: ${err.message}`);
    console.error('');
    console.error('请检查：');
    console.error('  - Chrome 是否已启动并监听 9222 调试端口');
    console.error('  - 对于 Android，adb forward tcp:9222 是否已配置');
    process.exit(1);
  }
}

main();