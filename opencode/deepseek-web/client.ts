import crypto from "node:crypto";
import type { Credentials } from "./types.js";
import { SHA3_WASM_B64 } from "./wasm-embedded.js";

/**
 * 递归提取 challenge 对象，防止深层嵌套导致找不到
 */
function extractChallenge(obj: any): any {
  if (!obj || typeof obj !== "object") return null;
  if (obj.challenge && typeof obj.challenge === "object") return obj.challenge;
  for (const key of Object.keys(obj)) {
    const found = extractChallenge(obj[key]);
    if (found) return found;
  }
  return null;
}

export class DeepSeekWebClient {
  private chatSessionId = "";

  constructor(private creds: Credentials) {
    if (!creds.bearer) {
      throw new Error(
        "Bearer token is required. Please re-login using: npx tsx login.ts"
      );
    }
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      Cookie: this.creds.cookie,
      "User-Agent": this.creds.userAgent,
      "Content-Type": "application/json",
      Accept: "*/*",
      Authorization: `Bearer ${this.creds.bearer}`,
      Referer: "https://chat.deepseek.com/",
      Origin: "https://chat.deepseek.com",
      "x-client-platform": "web",
      "x-client-version": "1.7.0",
      "x-app-version": "20241129.1",
      "x-client-locale": "zh_CN",
      "x-client-timezone-offset": "28800",
    };
  }

  async createChatSession(): Promise<string> {
    const targetPath = "/api/v0/chat_session/create";
    const res = await fetch(`https://chat.deepseek.com${targetPath}`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to create chat session (${res.status}): ${text}`);
    }
    const data: any = await res.json();
    const sessionId =
      data?.data?.biz_data?.id ||
      data?.data?.biz_data?.chat_session_id ||
      data?.biz_data?.id ||
      data?.biz_data?.chat_session_id ||
      "";
    if (!sessionId) throw new Error("Empty chat session ID");
    this.chatSessionId = sessionId;
    return sessionId;
  }

  async createPowChallenge(targetPath: string) {
    const res = await fetch(
      "https://chat.deepseek.com/api/v0/chat/create_pow_challenge",
      {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify({ target_path: targetPath }),
      }
    );
    if (!res.ok) throw new Error(`PoW challenge failed (${res.status})`);
    const data: any = await res.json();
    const challenge =
      data?.data?.biz_data?.challenge ||
      data?.data?.challenge ||
      data?.challenge ||
      extractChallenge(data);   // 递归查找，确保不遗漏
    if (!challenge) throw new Error("PoW challenge missing");
    return challenge;
  }

  async solvePow(challenge: any): Promise<number> {
    if (challenge.algorithm === "sha256") return this.solveSha256(challenge);
    if (challenge.algorithm === "DeepSeekHashV1")
      return this.solveDeepSeekHash(challenge);
    throw new Error(`Unsupported algorithm: ${challenge.algorithm}`);
  }

  private solveSha256(challenge: any): number {
    const { challenge: target, salt, difficulty } = challenge;
    let nonce = 0;
    while (true) {
      const hash = crypto
        .createHash("sha256")
        .update(salt + target + nonce)
        .digest("hex");
      let zeroBits = 0;
      for (const ch of hash) {
        const val = parseInt(ch, 16);
        if (val === 0) zeroBits += 4;
        else {
          zeroBits += Math.clz32(val) - 28;
          break;
        }
      }
      const targetDiff =
        difficulty > 1000 ? Math.floor(Math.log2(difficulty)) : difficulty;
      if (zeroBits >= targetDiff) return nonce;
      if (++nonce > 1_000_000) throw new Error("SHA256 PoW timeout");
    }
  }

  private async solveDeepSeekHash(challenge: any): Promise<number> {
    const wasmBuffer = Buffer.from(SHA3_WASM_B64, "base64");
    const { instance } = await WebAssembly.instantiate(wasmBuffer, { wbg: {} });
    const exports = instance.exports as any;
    const memory = exports.memory;
    const alloc = exports.__wbindgen_export_0;
    const addStack = exports.__wbindgen_add_to_stack_pointer;
    const wasmSolve = exports.wasm_solve;

    const encode = (str: string): [number, number] => {
      const buf = Buffer.from(str, "utf8");
      const ptr = alloc(buf.length, 1);
      new Uint8Array(memory.buffer).set(buf, ptr);
      return [ptr, buf.length];
    };

    const prefix = `${challenge.salt}_${challenge.expire_at}_`;
    const [ptrC, lenC] = encode(challenge.challenge);
    const [ptrP, lenP] = encode(prefix);
    const retptr = addStack(-16);
    wasmSolve(retptr, ptrC, lenC, ptrP, lenP, challenge.difficulty);
    addStack(16);

    const view = new DataView(memory.buffer);
    const status = view.getInt32(retptr, true);
    if (status === 0) throw new Error("DeepSeekHashV1 solve failed");
    return view.getFloat64(retptr + 8, true);
  }

  /**
   * 发送聊天消息
   * @param prompt 用户输入文本
   * @param parentMessageId 上一轮消息 ID（用于多轮对话上下文）
   * @param thinkingEnabled 是否启用深度思考（DeepSeek Reasoner）
   * @param signal 可选的 AbortSignal
   */
  async chat(
    prompt: string,
    parentMessageId?: number | null,
    thinkingEnabled?: boolean,
    signal?: AbortSignal
  ): Promise<ReadableStream> {
    if (!this.chatSessionId) {
      await this.createChatSession();
    }

    const targetPath = "/api/v0/chat/completion";
    const challenge = await this.createPowChallenge(targetPath);
    const answer = await this.solvePow(challenge);
    const powResponse = Buffer.from(
      JSON.stringify({ ...challenge, answer, target_path: targetPath })
    ).toString("base64");

    const body = JSON.stringify({
      chat_session_id: this.chatSessionId,
      parent_message_id: parentMessageId ?? null,
      prompt,
      ref_file_ids: [],
      thinking_enabled: thinkingEnabled ?? false,
      search_enabled: false,
      preempt: false,
    });

    const res = await fetch(`https://chat.deepseek.com${targetPath}`, {
      method: "POST",
      headers: {
        ...(await this.headers()),
        "x-ds-pow-response": powResponse,
      },
      body,
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DeepSeek chat failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return res.body!;
  }
}