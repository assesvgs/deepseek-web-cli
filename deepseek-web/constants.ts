import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Credentials } from "./types.js";

/**
 * 获取当前文件所在的目录（插件目录 .opencode/plugin/deepseek-web）
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * DeepSeek 网页凭证的存储目录。
 * 存放在插件目录下，即 .opencode/plugin/deepseek-web/
 */
const CRED_DIR = __dirname;

/**
 * 凭证文件的完整路径：
 *   .opencode/plugin/deepseek-web/credentials.json
 */
const CRED_FILE = path.join(CRED_DIR, "credentials.json");

/**
 * 从磁盘读取 DeepSeek 凭证。
 * 如果文件不存在或内容损坏，返回 null。
 */
export function loadCredentials(): Credentials | null {
  try {
    if (!fs.existsSync(CRED_FILE)) return null;
    return JSON.parse(fs.readFileSync(CRED_FILE, "utf-8")) as Credentials;
  } catch {
    return null;
  }
}

/**
 * 将 DeepSeek 凭证写入磁盘。
 * - 会自动创建目录（当前插件目录）
 */
export function saveCredentials(cred: Credentials): void {
  fs.mkdirSync(CRED_DIR, { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify(cred, null, 2));
}

/**
 * 凭证文件的绝对路径，供 login.ts 打印成功信息时使用。
 */
export const CREDENTIALS_PATH = CRED_FILE;