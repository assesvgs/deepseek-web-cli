#!/usr/bin/env -S npx tsx
/**
 * DeepSeek 网页版聊天脚本 (CLI)
 *
 * 核心概念：
 * - chat_session_id (房间号)：每个对话房间的唯一标识，创建后保持不变。
 *   同一房间内的所有消息共享历史上下文。
 * - parent_message_id (消息接续点)：指明本次请求要接在哪条消息后面。
 *   DeepSeek 网页版会为房间内每条消息分配一个递增的数字 ID。
 *   第一轮 AI 回复通常是 message 2，之后每轮递增 2（user + assistant 各占一个 ID）。
 *   脚本会自动从 SSE 流中捕获最新的消息 ID 并保存，下次请求默认续写。
 *
 * 用法：
 *   ./chat.ts "你好"                              # 新房间，首轮对话
 *   ./chat.ts --session <room-id> "继续"          # 进入已有房间，自动续写
 *   ./chat.ts --parent-id 2 "重新接在这里"         # 手动指定从哪个消息继续
 *   ./chat.ts --raw "原始数据"                     # 查看原始 SSE 流（会保存 parentMessageId 及原始数据）
 *   ./chat.ts --think "思考问题"                   # 开启深度思考模式
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { SHA3_WASM_B64 } from "./wasm-embedded.js";

const CRED_FILE = path.join(__dirname, "credentials.json");
const SESSIONS_DIR = path.join(__dirname, ".sessions");

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

interface Credentials {
  cookie: string;
  bearer: string;
  userAgent: string;
}

interface MessageRecord {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** 本条消息发出时基于的父消息 ID（来自会话记录或手动指定） */
  parentMessageId: number | null;
}

interface SessionState {
  title: string;
  messages: MessageRecord[];
  /** 最新一条 assistant 回复的 message ID，作为下一次请求的 parent_message_id */
  parentMessageId: number | null;
}

// ───────────────── 持久化 ─────────────────

function loadCredentials(): Credentials | null {
  try {
    if (!fs.existsSync(CRED_FILE)) return null;
    return JSON.parse(fs.readFileSync(CRED_FILE, "utf-8")) as Credentials;
  } catch {
    return null;
  }
}

function sessionFile(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

function loadSessionState(sessionId: string): SessionState {
  try {
    if (!fs.existsSync(sessionFile(sessionId))) {
      return { title: "", messages: [], parentMessageId: null };
    }
    const raw = JSON.parse(fs.readFileSync(sessionFile(sessionId), "utf-8"));
    // 兼容旧版 lastMessageId 字段
    if (typeof raw.lastMessageId === "number" && !raw.messages) {
      return {
        title: raw.title || "",
        messages: [],
        parentMessageId: raw.lastMessageId,
      };
    }
    // 处理旧版消息记录中没有 parentMessageId 字段的情况
    const messages = (raw.messages || []).map((m: any) => ({
      ...m,
      parentMessageId: m.parentMessageId ?? null,
    }));
    return {
      title: raw.title || "",
      messages,
      parentMessageId: raw.parentMessageId ?? raw.lastMessageId ?? null,
    };
  } catch {
    return { title: "", messages: [], parentMessageId: null };
  }
}

function saveSessionState(sessionId: string, state: SessionState): void {
  const ordered = {
    parentMessageId: state.parentMessageId,
    title: state.title,
    messages: state.messages,
  };
  fs.writeFileSync(sessionFile(sessionId), JSON.stringify(ordered, null, 2));
}

// ───────────────── 显示最近 2 轮对话 ─────────────────

function printRecentMessages(messages: MessageRecord[]): void {
  if (messages.length === 0) return;

  const recent = messages.slice(-4);
  const rounds: { user: string; assistant: string | null; parentId: number | null }[] = [];
  let currentUser: string | null = null;
  let currentUserParentId: number | null = null;

  for (const msg of recent) {
    if (msg.role === "user") {
      currentUser = msg.content;
      currentUserParentId = msg.parentMessageId;
    } else if (msg.role === "assistant" && currentUser !== null) {
      rounds.push({ user: currentUser, assistant: msg.content, parentId: currentUserParentId });
      currentUser = null;
      currentUserParentId = null;
    }
  }

  const displayRounds = rounds.slice(-2);
  if (displayRounds.length === 0) return;

  console.log(`\n📋 最近 ${displayRounds.length} 轮对话记录：\n`);
  displayRounds.forEach((round, index) => {
    const idStr = round.parentId !== null ? ` [parent: ${round.parentId}]` : "";
    const userPreview =
      round.user.replace(/\n/g, " ").slice(0, 100) +
      (round.user.length > 100 ? "…" : "");
    console.log(`   User${idStr}: ${userPreview}`);
    const aiPreview =
      round.assistant!.replace(/\n/g, " ").slice(0, 100) +
      (round.assistant!.length > 100 ? "…" : "");
    console.log(`   AI:   ${aiPreview}`);
    if (index < displayRounds.length - 1) console.log("");
  });
  console.log("");
}

// ───────────────── 网络与加密 ─────────────────

function extractChallenge(obj: any): any {
  if (!obj || typeof obj !== "object") return null;
  if (obj.challenge && typeof obj.challenge === "object") return obj.challenge;
  for (const key of Object.keys(obj)) {
    const found = extractChallenge(obj[key]);
    if (found) return found;
  }
  return null;
}

function getHeaders(cookie: string, bearer: string, ua: string) {
  return {
    Cookie: cookie,
    Authorization: `Bearer ${bearer}`,
    "User-Agent": ua,
    Accept: "*/*",
    "Content-Type": "application/json",
    Origin: "https://chat.deepseek.com",
    Referer: "https://chat.deepseek.com/",
    "x-client-platform": "web",
    "x-client-version": "1.7.0",
    "x-app-version": "20241129.1",
    "x-client-locale": "zh_CN",
    "x-client-timezone-offset": "28800",
  };
}

async function getPowChallenge(cookie: string, bearer: string, ua: string) {
  const res = await fetch(
    "https://chat.deepseek.com/api/v0/chat/create_pow_challenge",
    {
      method: "POST",
      headers: getHeaders(cookie, bearer, ua),
      body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
    }
  );
  const rawText = await res.text();
  if (!res.ok) {
    console.error(`❌ PoW 请求失败 (${res.status}):`, rawText.slice(0, 500));
    process.exit(1);
  }
  const data = JSON.parse(rawText);
  const challenge =
    data?.data?.biz_data?.challenge ||
    data?.data?.challenge ||
    data?.challenge ||
    extractChallenge(data);
  if (!challenge) {
    console.error(
      "❌ 未找到 challenge。完整响应：",
      JSON.stringify(data, null, 2)
    );
    process.exit(1);
  }
  return challenge;
}

function solveSha256(challenge: any): number {
  const targetDiff =
    challenge.difficulty > 1000
      ? Math.floor(Math.log2(challenge.difficulty))
      : challenge.difficulty;
  let nonce = 0;
  while (true) {
    const hash = crypto
      .createHash("sha256")
      .update(challenge.salt + challenge.challenge + nonce)
      .digest("hex");
    let bits = 0;
    for (const ch of hash) {
      const val = parseInt(ch, 16);
      if (val === 0) bits += 4;
      else {
        bits += Math.clz32(val) - 28;
        break;
      }
    }
    if (bits >= targetDiff) return nonce;
    if (++nonce > 1_000_000) throw new Error("SHA256 PoW timeout");
  }
}

async function solveDeepSeekHash(challenge: any): Promise<number> {
  const wasmBuf = Buffer.from(SHA3_WASM_B64, "base64");
  const { instance } = await WebAssembly.instantiate(wasmBuf, { wbg: {} });
  const mem = instance.exports.memory;
  const alloc = instance.exports.__wbindgen_export_0;
  const addStack = instance.exports.__wbindgen_add_to_stack_pointer;
  const wasmSolve = instance.exports.wasm_solve;

  const encode = (str: string): [number, number] => {
    const buf = Buffer.from(str, "utf8");
    const ptr = alloc(buf.length, 1);
    new Uint8Array(mem.buffer).set(buf, ptr);
    return [ptr, buf.length];
  };

  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const [ptrC, lenC] = encode(challenge.challenge);
  const [ptrP, lenP] = encode(prefix);
  const retptr = addStack(-16);
  wasmSolve(retptr, ptrC, lenC, ptrP, lenP, challenge.difficulty);
  addStack(16);

  const view = new DataView(mem.buffer);
  const status = view.getInt32(retptr, true);
  if (status === 0) throw new Error("DeepSeekHashV1 solve failed");
  return view.getFloat64(retptr + 8, true);
}

async function solvePow(challenge: any): Promise<number> {
  if (challenge.algorithm === "sha256") return solveSha256(challenge);
  if (challenge.algorithm === "DeepSeekHashV1")
    return solveDeepSeekHash(challenge);
  throw new Error(`Unsupported algorithm: ${challenge.algorithm}`);
}

/** 创建新的“房间”，获得 chat_session_id */
async function createChatSession(
  cookie: string,
  bearer: string,
  ua: string
): Promise<string> {
  const res = await fetch(
    "https://chat.deepseek.com/api/v0/chat_session/create",
    {
      method: "POST",
      headers: getHeaders(cookie, bearer, ua),
      body: JSON.stringify({}),
    }
  );
  if (!res.ok)
    throw new Error(`创建会话失败 (${res.status}): ${await res.text()}`);
  const data: any = await res.json();
  const sessionId =
    data?.data?.biz_data?.id ||
    data?.data?.biz_data?.chat_session_id ||
    data?.biz_data?.id ||
    data?.biz_data?.chat_session_id;
  if (!sessionId) throw new Error(`会话 ID 无效: ${JSON.stringify(data)}`);
  return sessionId;
}

// ───────────────── 流解析 ─────────────────

function parseLine(
  data: string,
  state: {
    mode: "idle" | "thinking" | "response";
    thinkingTime: number | null;
  }
): { styled: string | null; clean: string | null; messageId?: number } {
  try {
    const json = JSON.parse(data);
    let styled = "";
    let clean = "";
    let messageId: number | undefined;

    // 捕获最新的消息 ID，用于下一轮续写
    if (json.response_message_id) messageId = json.response_message_id;
    if (json.v?.response?.message_id) messageId = json.v.response.message_id;

    // 初始 fragments
    if (json.v?.response?.fragments) {
      for (const frag of json.v.response.fragments) {
        if (frag.type === "THINK") {
          if (state.mode !== "thinking") {
            styled += "\n🧠 [思考开始]\n";
            clean += "\n🧠 [思考开始]\n";
            state.mode = "thinking";
          }
          if (frag.content) {
            styled += `\x1b[36m${frag.content}\x1b[0m`;
            clean += frag.content;
          }
        } else if (frag.type === "RESPONSE") {
          if (state.mode === "thinking") {
            const timeStr = state.thinkingTime
              ? ` (耗时 ${state.thinkingTime.toFixed(1)}s)`
              : "";
            styled += `\x1b[0m\n🧠 [思考结束${timeStr}]\n\n📝 [正文]\n`;
            clean += `\n🧠 [思考结束${timeStr}]\n\n📝 [正文]\n`;
            state.mode = "response";
          } else if (state.mode === "idle") {
            styled += "\n📝 [正文]\n";
            clean += "\n📝 [正文]\n";
            state.mode = "response";
          }
          if (frag.content) {
            styled += frag.content;
            clean += frag.content;
          }
        }
      }
      return { styled: styled || null, clean: clean || null, messageId };
    }

    // 追加 fragments 数组
    if (
      json.p === "response/fragments" &&
      json.o === "APPEND" &&
      Array.isArray(json.v)
    ) {
      for (const frag of json.v) {
        if (frag.type === "THINK") {
          if (state.mode !== "thinking") {
            styled += "\n🧠 [思考开始]\n";
            clean += "\n🧠 [思考开始]\n";
            state.mode = "thinking";
          }
          if (frag.content) {
            styled += `\x1b[36m${frag.content}\x1b[0m`;
            clean += frag.content;
          }
        } else if (frag.type === "RESPONSE") {
          if (state.mode === "thinking") {
            const timeStr = state.thinkingTime
              ? ` (耗时 ${state.thinkingTime.toFixed(1)}s)`
              : "";
            styled += `\x1b[0m\n🧠 [思考结束${timeStr}]\n\n📝 [正文]\n`;
            clean += `\n🧠 [思考结束${timeStr}]\n\n📝 [正文]\n`;
            state.mode = "response";
          } else if (state.mode === "idle") {
            styled += "\n📝 [正文]\n";
            clean += "\n📝 [正文]\n";
            state.mode = "response";
          }
          if (frag.content) {
            styled += frag.content;
            clean += frag.content;
          }
        }
      }
      return { styled: styled || null, clean: clean || null, messageId };
    }

    // 思考耗时
    if (json.p === "response/fragments/-1/elapsed_secs" && json.o === "SET") {
      state.thinkingTime =
        typeof json.v === "number" ? json.v : parseFloat(json.v);
      return { styled: null, clean: null, messageId };
    }

    // 增量文本
    let rawContent = "";
    if (typeof json.v === "string" && !json.p) {
      rawContent = json.v;
    } else if (json.o === "APPEND" && typeof json.v === "string") {
      rawContent = json.v;
    }

    if (rawContent) {
      if (state.mode === "thinking") {
        styled = `\x1b[36m${rawContent}\x1b[0m`;
        clean = rawContent;
      } else {
        styled = rawContent;
        clean = rawContent;
      }
    }

    return { styled: styled || null, clean: clean || null, messageId };
  } catch {
    return { styled: null, clean: null };
  }
}

// ───────────────── CLI ─────────────────

function printUsage() {
  console.log("用法:");
  console.log(
    "  ./chat.ts [--session <id>] [--parent-id <id>] [--new] [--raw] [--think] <你的消息>"
  );
  console.log("");
  console.log("选项:");
  console.log(
    "  --session <id>   使用指定的会话 ID (房间号) 继续对话，显示最近 2 轮历史"
  );
  console.log(
    "  --parent-id <id>  指定本轮对话的 parent_message_id（覆盖会话记录）"
  );
  console.log("  --new            强制创建新会话");
  console.log("  --think          开启思考模式（默认关闭）");
  console.log("  --raw            完全透传原始数据，不做任何解析");
  console.log("");
  console.log("示例:");
  console.log('  ./chat.ts "你好"');
  console.log('  ./chat.ts --think "解释量子纠缠"');
  console.log('  ./chat.ts --session <id> "继续上次对话"');
  console.log('  ./chat.ts --session <id> --parent-id 3 "接在id=3之后回复"');
}

async function main() {
  const args = process.argv.slice(2);
  let sessionId: string | undefined;   // 房间号
  let prompt: string | undefined;
  let forceNew = false;
  let rawMode = false;
  let forceThink = false;
  let parentIdOverride: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session" && i + 1 < args.length) {
      sessionId = args[i + 1];
      i++;
    } else if (args[i] === "--parent-id" && i + 1 < args.length) {
      const val = parseInt(args[i + 1], 10);
      if (!isNaN(val) && val >= 0) {
        parentIdOverride = val;
      } else {
        console.error("❌ --parent-id 必须是一个非负整数");
        process.exit(1);
      }
      i++;
    } else if (args[i] === "--new") {
      forceNew = true;
    } else if (args[i] === "--raw") {
      rawMode = true;
    } else if (args[i] === "--think") {
      forceThink = true;
    } else if (!prompt) {
      prompt = args.slice(i).join(" ");
      break;
    }
  }

  if (!prompt) {
    printUsage();
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.bearer) {
    console.error("❌ 凭证或 Bearer 缺失，请重新登录: npx tsx login.ts");
    process.exit(1);
  }

  const { cookie, bearer, userAgent } = creds;
  console.log("\n⏳ 正在连接 DeepSeek...");

  try {
    // ── 会话初始化：确定房间号 ──
    if (forceNew || !sessionId) {
      // 创建新房间 (chat_session_id)
      sessionId = await createChatSession(cookie, bearer, userAgent);
      console.log(`✅ 新会话已创建，ID: ${sessionId}`);
    } else {
      // 使用已有房间，加载历史
      const existingState = loadSessionState(sessionId);
      if (existingState.title) {
        console.log(`\n🔍 会话标题: ${existingState.title}`);
      } else {
        console.log(`📎 使用已有会话: ${sessionId}`);
      }
      printRecentMessages(existingState.messages);
    }

    const sessionState = loadSessionState(sessionId);
    // 决定本轮请求的 parent_message_id：手动指定优先，否则使用会话记录的最新值
    const parentMessageId = parentIdOverride ?? sessionState.parentMessageId ?? null;

    // ── PoW & 请求 ──
    const challenge = await getPowChallenge(cookie, bearer, userAgent);
    const answer = await solvePow(challenge);
    const powResponse = Buffer.from(
      JSON.stringify({
        ...challenge,
        answer,
        target_path: "/api/v0/chat/completion",
      })
    ).toString("base64");

    const res = await fetch(
      "https://chat.deepseek.com/api/v0/chat/completion",
      {
        method: "POST",
        headers: {
          ...getHeaders(cookie, bearer, userAgent),
          "x-ds-pow-response": powResponse,
        },
        body: JSON.stringify({
          chat_session_id: sessionId,        // 房间号
          parent_message_id: parentMessageId, // 接续点
          prompt,
          ref_file_ids: [],
          thinking_enabled: forceThink,
          search_enabled: false,
          preempt: false,
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `聊天请求失败 (${res.status}): ${errText.slice(0, 200)}`
      );
    }

    // ── RAW 模式：输出原始 SSE 并保存（含原始数据） ──
    if (rawMode) {
      console.log("========== DeepSeek 原始流 (RAW STREAM) ==========");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let rawText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        process.stdout.write(chunk);
        rawText += chunk;
      }
      console.log();
      console.log("========== 流结束 ==========");

      // 从原始 SSE 流中提取 parentMessageId 和标题（保证后续能正常续写）
      let extractedMessageId: number | undefined;
      let sessionTitle = sessionState.title;
      const lines = rawText.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // 解析标题事件
        if (line.startsWith("event: title")) {
          const maybeDataLine = lines[i + 1];
          if (maybeDataLine && maybeDataLine.startsWith("data: ")) {
            try {
              const json = JSON.parse(maybeDataLine.slice(6).trim());
              if (json.content) sessionTitle = json.content;
            } catch {}
          }
        }
        // 解析 data 行
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            if (json.response_message_id) extractedMessageId = json.response_message_id;
            if (json.v?.response?.message_id) extractedMessageId = json.v.response.message_id;
          } catch {}
        }
      }

      // 构建带标注的原始数据消息，与其他正常对话区分
      const rawAssistantMessage: MessageRecord = {
        role: "assistant",
        content: `[RAW 原始数据流]\n\n${rawText}\n\n[RAW 结束]`,
        timestamp: Date.now(),
        parentMessageId: parentMessageId,
      };

      const updatedState: SessionState = {
        parentMessageId: extractedMessageId ?? sessionState.parentMessageId,
        title: sessionTitle,
        messages: [
          ...sessionState.messages,
          { role: "user", content: prompt, timestamp: Date.now(), parentMessageId },
          rawAssistantMessage,
        ],
      };
      saveSessionState(sessionId, updatedState);

      // 结尾信息
      console.log(
        `\n📌 会话 ID: ${sessionId}  |  本轮 parent_message_id: ${parentMessageId ?? "(无)"}`
      );
      if (extractedMessageId) {
        console.log(`💾 raw 模式已保存上下文 (message ${extractedMessageId})，原始数据已存入会话记录`);
      }
      return;
    }

    // ── 正常解析 SSE 流 ──
    const parseState: {
      mode: "idle" | "thinking" | "response";
      thinkingTime: number | null;
    } = { mode: "idle", thinkingTime: null };

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let latestMessageId: number | undefined;
    let fullResponseClean = "";
    let sessionTitle = sessionState.title;
    let currentEventType = "";

    console.log("\n🤖 AI 回复：");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith("event:")) {
          currentEventType = trimmedLine.slice(6).trim();
          continue;
        }
        let data = line;
        if (data.startsWith("data: ")) data = data.slice(6);
        else if (!data.startsWith("{")) continue;

        data = data.trim();
        if (!data) continue;

        // 标题事件
        if (currentEventType === "title") {
          try {
            const json = JSON.parse(data);
            if (json.content) {
              sessionTitle = json.content;
              console.log(`\n`);
              console.log(`🔍 会话标题更新: ${sessionTitle}`);
            }
          } catch {}
          currentEventType = "";
          continue;
        }

        const { styled, clean, messageId } = parseLine(data, parseState);
        if (messageId) latestMessageId = messageId;
        if (styled) process.stdout.write(styled);
        if (clean) fullResponseClean += clean;
      }
    }

    console.log("");

    // ── 保存完整状态 ──
    const now = Date.now();
    const updatedState: SessionState = {
      parentMessageId: latestMessageId ?? null,   // 下一轮请求将用到这个 ID
      title: sessionTitle,
      messages: [
        ...sessionState.messages,
        {
          role: "user",
          content: prompt,
          timestamp: now,
          parentMessageId: parentMessageId,
        },
        ...(fullResponseClean.trim()
          ? [
              {
                role: "assistant" as const,
                content: fullResponseClean.trim(),
                timestamp: now,
                parentMessageId: parentMessageId,
              },
            ]
          : []),
      ],
    };

    saveSessionState(sessionId, updatedState);

    // ── 结尾信息（统一在此显示本轮 parent_message_id）──
    console.log(
      `\n📌 会话 ID: ${sessionId}\n   本轮消息的父消息（续写点关系） parent_message_id: ${parentMessageId ?? "(无)"}\n`
    );
    if (latestMessageId) {
      console.log(`💾 上下文已保存（message ${latestMessageId}）`);
    }
    console.log("\n📜 下次继续会话：");
    console.log(
      `   ./chat.ts --session ${sessionId}${forceThink ? " --think" : ""} "你的新消息"`
    );
    console.log("\n   可用选项：");
    console.log(
      "   --session <id>   使用指定会话 ID (房间号) 继续对话"
    );
    console.log(
      "   --parent-id <id>  指定本轮对话的 parent_message_id（覆盖会话记录）"
    );
    console.log("   --new            强制创建新会话");
    console.log("   --think          开启思考模式");
    console.log("   --raw            显示原始数据流，不做任何解析");
    console.log("   --help           显示完整帮助");
  } catch (err: any) {
    console.error("\n❌ 错误:", err.message);
    process.exit(1);
  }
}

main();