// server.ts
import * as http from "node:http";
import { DeepSeekWebClient } from "./client.js";
import { loadCredentials } from "./constants.js";

interface SessionData {
  client: DeepSeekWebClient;
  parentMessageId?: number | null;
}

const sessionMap = new Map<string, SessionData>();

function getOrCreateClient(sessionId: string): SessionData {
  const existing = sessionMap.get(sessionId);
  if (existing) return existing;

  const creds = loadCredentials();
  if (!creds) throw new Error("No credentials found");
  const client = new DeepSeekWebClient(creds);
  const data: SessionData = { client, parentMessageId: null };
  sessionMap.set(sessionId, data);
  console.log(`[DeepSeek Plugin] New client for session ${sessionId}`);
  return data;
}

export function cleanupSession(sessionId: string) {
  if (sessionMap.has(sessionId)) {
    sessionMap.delete(sessionId);
    console.log(`[DeepSeek Plugin] Cleaned up session ${sessionId}`);
  }
}

// ─── 辅助函数 ─────────────────────────
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p.type === "text" && p.text)
      .map((p: any) => p.text)
      .join("");
  }
  return "";
}

// 构建 DeepSeek 网页版可理解的 prompt
function buildPrompt(
  messages: any[],
  parentMessageId: number | null | undefined,
  tools?: any[]
): string {
  // 1. 后续轮次：利用 parentMessageId，只发送最后一条用户消息或工具结果
  if (parentMessageId != null) {
    const last = messages[messages.length - 1];
    if (!last) return "";

    if (last.role === "tool") {
      const resultText = typeof last.content === "string" ? last.content : "";
      return `\n<tool_response id="${last.tool_call_id || ""}" name="${last.name || ""}">\n${resultText}\n</tool_response>\n\nPlease proceed based on this tool result.`;
    }
    return extractText(last.content);
  }

  // 2. 首轮对话：拼接所有历史消息
  const parts: string[] = [];

  // 系统消息 + 工具定义
  const systemMsg = messages.find((m) => m.role === "system");
  if (systemMsg) {
    let systemContent = extractText(systemMsg.content);
    if (tools && tools.length > 0) {
      systemContent += "\n\n## Available Tools\n";
      for (const t of tools) {
        if (t.function) {
          systemContent += `- ${t.function.name}: ${t.function.description}\n`;
        }
      }
    }
    parts.push(`System: ${systemContent}`);
  }

  // 遍历所有非系统消息
  for (const m of messages) {
    if (m.role === "system") continue;

    let content = "";
    if (m.role === "tool") {
      const resultText = typeof m.content === "string" ? m.content : "";
      content = `<tool_response id="${m.tool_call_id || ""}" name="${m.name || ""}">\n${resultText}\n</tool_response>`;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text" && part.text) {
          content += part.text;
        } else if (part.type === "tool_call") {
          const tc = part;
          content += `<tool_call id="${tc.id}" name="${tc.function?.name || tc.name}">${JSON.stringify(tc.function?.arguments || tc.arguments || {})}</tool_call>`;
        } else if (part.type === "thinking" && part.thinking) {
          content += `<think>\n${part.thinking}\n</think>\n`;
        }
      }
    } else {
      content = String(m.content);
    }

    if (!content) continue;

    const role = m.role === "user" ? "User" : "Assistant";
    parts.push(`${role}: ${content}`);
  }

  return parts.join("\n\n");
}

// ─── 并发队列 ──────────────────────────
const pendingQueues = new Map<string, Promise<void>>();
function enqueue(sessionId: string, task: () => Promise<void>): Promise<void> {
  const prev = pendingQueues.get(sessionId) ?? Promise.resolve();
  const next = prev.then(task, task);
  pendingQueues.set(sessionId, next);
  return next;
}

// ─── 空流 ───────────────────────────────
function sendEmptyStream(res: http.ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const finalChunk = {
    id: "chatcmpl-empty",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "deepseek-chat",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

// ─── 流转换工具 ────────────────────────
const JUNK_TOKENS = [
  " response",
  "<|end▁of▁thinking|>",
  "<｜end_of_thinking｜>",
  "<|end_of_thinking|>",
  "<|endoftext|>",
];

function parseToolArgs(rawArgs: string): Record<string, unknown> {
  try {
    return JSON.parse(rawArgs);
  } catch {
    const xmlArgs: Record<string, unknown> = {};
    const tagPattern = /<([a-zA-Z_]\w*)>\s*([\s\S]*?)\s*<\/\1>/g;
    let match;
    while ((match = tagPattern.exec(rawArgs)) !== null) {
      try {
        xmlArgs[match[1]] = JSON.parse(match[2].trim());
      } catch {
        xmlArgs[match[1]] = match[2].trim();
      }
    }
    return Object.keys(xmlArgs).length > 0 ? xmlArgs : { raw: rawArgs };
  }
}

function transformToOpenAISSE(
  deepseekStream: ReadableStream,
  sessionData: SessionData,
  model: string
): ReadableStream {
  const reader = deepseekStream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let streamClosed = false;
  let controller: ReadableStreamDefaultController<any> | null = null;
  let currentMode: "text" | "thinking" | "tool_call" = "text";
  let tagBuffer = "";
  let currentToolName = "";
  let currentToolIndex = 0;
  let currentToolId = "";
  const pendingToolCalls: { id: string; name: string; arguments: string }[] = [];

  function sendChunk(delta: any) {
    if (!controller) return;
    const chunk = {
      id: "chatcmpl-" + Date.now(),
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }

  function finish(reason?: "stop" | "tool_calls") {
    if (streamClosed || !controller) return;
    streamClosed = true;
    const finishReason = reason || (pendingToolCalls.length > 0 ? "tool_calls" : "stop");
    const finalChunk = {
      id: "chatcmpl-" + Date.now(),
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
  }

  function emitText(text: string) {
    if (text) sendChunk({ content: text });
  }

  function emitToolCallDelta(id: string, name: string, args: string) {
    sendChunk({
      tool_calls: [{
        index: currentToolIndex,
        id,
        type: "function",
        function: { name, arguments: args },
      }],
    });
  }

  function pushDelta(delta: string) {
    if (!delta || JUNK_TOKENS.includes(delta)) return;

    tagBuffer += delta;

    const TOOL_START_REGEX =
      /<tool_call\s+(?:id=['"]?([^'"]+)['"]?\s+)?name=['"]?([^'"]+)['"]?(?:\s+id=['"]?([^'"]+)['"]?)?\s*>/i;
    const TOOL_END_REGEX = /<\/tool_call>/i;
    const THINK_START_REGEX = /<(?:think|thinking|thought)>/i;
    const THINK_END_REGEX = /<\/(?:think|thinking|thought)>/i;

    const getMatch = (regex: RegExp) => {
      const match = tagBuffer.match(regex);
      if (!match) return { idx: -1, len: 0, name: "", id: "" };
      return {
        idx: match.index!,
        len: match[0].length,
        name: match[2] || match[1] || "",
        id: match[3] || match[1] || "",
      };
    };

    const candidates = [
      { type: "think_start", ...getMatch(THINK_START_REGEX) },
      { type: "think_end", ...getMatch(THINK_END_REGEX) },
      { type: "tool_start", ...getMatch(TOOL_START_REGEX) },
      { type: "tool_end", ...getMatch(TOOL_END_REGEX) },
    ].filter(c => c.idx !== -1).sort((a, b) => a.idx! - b.idx!);

    if (candidates.length === 0) {
      const lastAngle = tagBuffer.lastIndexOf("<");
      if (lastAngle === -1) {
        if (currentMode === "text") emitText(tagBuffer);
        tagBuffer = "";
      } else {
        const safe = tagBuffer.slice(0, lastAngle);
        if (currentMode === "text") emitText(safe);
        tagBuffer = tagBuffer.slice(lastAngle);
      }
      return;
    }

    const first = candidates[0];
    const before = tagBuffer.slice(0, first.idx);
    if (before && currentMode === "text") emitText(before);

    switch (first.type) {
      case "think_start":
        currentMode = "thinking";
        break;
      case "think_end":
        currentMode = "text";
        break;
      case "tool_start":
        currentMode = "tool_call";
        currentToolName = first.name!;
        currentToolId = first.id || `call_${Date.now()}_${currentToolIndex}`;
        pendingToolCalls.push({ id: currentToolId, name: currentToolName, arguments: "" });
        emitToolCallDelta(currentToolId, currentToolName, "");
        break;
      case "tool_end":
        if (pendingToolCalls[currentToolIndex]) {
          const argStr = pendingToolCalls[currentToolIndex].arguments || "{}";
          pendingToolCalls[currentToolIndex].arguments = JSON.stringify(parseToolArgs(argStr));
          sendChunk({
            tool_calls: [{
              index: currentToolIndex,
              function: {
                name: currentToolName,
                arguments: pendingToolCalls[currentToolIndex].arguments,
              },
            }],
          });
        }
        currentMode = "text";
        currentToolIndex++;
        currentToolName = "";
        currentToolId = "";
        break;
    }

    tagBuffer = tagBuffer.slice(first.idx! + first.len!);
    pushDelta(""); // 递归处理剩余 buffer
  }

  return new ReadableStream({
    start(ctrl) {
      controller = ctrl;
    },
    async pull(ctrl) {
      controller = ctrl;
      if (streamClosed) return;
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (tagBuffer && currentMode === "text") emitText(tagBuffer);
          finish();
          return;
        }

        const text = decoder.decode(value, { stream: true });
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.startsWith("event:")) continue;
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;

          let json: any;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }

          // 更新 parentMessageId
          if (json.response_message_id)
            sessionData.parentMessageId = json.response_message_id;
          if (json.v?.response?.message_id)
            sessionData.parentMessageId = json.v.response.message_id;

          const deltas: string[] = [];
          if (typeof json.v === "string" && (!json.p || json.p.includes("content"))) {
            deltas.push(json.v);
          }
          if (Array.isArray(json.v)) {
            for (const frag of json.v) {
              if (frag.content && (frag.type === "RESPONSE" || frag.type === "THINK")) {
                deltas.push(frag.content);
              }
            }
          }
          const nested = json.v?.response?.fragments;
          if (Array.isArray(nested)) {
            for (const frag of nested) {
              if (frag.content && (frag.type === "RESPONSE" || frag.type === "THINK")) {
                deltas.push(frag.content);
              }
            }
          }
          const choice = json.choices?.[0];
          if (choice?.delta?.content) deltas.push(choice.delta.content);

          for (const d of deltas) pushDelta(d);
        }
      } catch (err: any) {
        controller.error(err);
      }
    },
  });
}

// ─── 聊天处理核心 ──────────────────────
async function handleChatRequest(
  sessionData: SessionData,
  body: any,
  res: http.ServerResponse
) {
  try {
    const messages = body.messages || [];
    const model = body.model || "deepseek-chat";
    const thinkingEnabled = model === "deepseek-reasoner" || model.includes("reasoning");
    const tools = body.tools;

    const parentMessageId = sessionData.parentMessageId;
    const prompt = buildPrompt(messages, parentMessageId, tools);

    if (!prompt) {
      sendEmptyStream(res);
      return;
    }

    const client = sessionData.client;
    const deepseekStream = await client.chat(
      prompt,
      parentMessageId ?? null,
      thinkingEnabled,
      new AbortController().signal
    );

    const sseStream = transformToOpenAISSE(deepseekStream, sessionData, model);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const reader = sseStream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        break;
      }
      res.write(value);
    }
  } catch (err: any) {
    console.error("[DeepSeek Proxy] Error:", err);
    if (!res.headersSent) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: "server_error" } })}\n\n`);
      res.end();
    } else {
      res.end();
    }
  }
}

// ─── HTTP 服务器 ────────────────────────
export function startServer(port = 8899): http.Server {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    if (url.pathname === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [
          { id: "deepseek-chat", object: "model", owned_by: "deepseek-web" },
          { id: "deepseek-reasoner", object: "model", owned_by: "deepseek-web" },
        ],
      }));
      return;
    }

    if (url.pathname === "/v1/sessions") {
      const sid = req.headers["x-session-id"] as string;
      if (req.method === "DELETE") {
        if (sid) cleanupSession(sid);
        res.writeHead(sid ? 200 : 400);
        res.end(JSON.stringify(sid ? { status: "ok" } : { error: { message: "Missing X-Session-Id header" } }));
        return;
      }
      if (req.method === "POST") {
        if (sid) {
          getOrCreateClient(sid);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", sessionId: sid }));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ error: { message: "Missing X-Session-Id header" } }));
        }
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ activeSessions: sessionMap.size }));
      return;
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const sessionId = (req.headers["x-session-id"] as string) || "default";
      const rawBody = await new Promise<string>((resolve, reject) => {
        let buf = "";
        req.on("data", (c) => (buf += c));
        req.on("end", () => resolve(buf));
        req.on("error", reject);
      });
      const body = JSON.parse(rawBody);
      if (!body.messages?.length) {
        sendEmptyStream(res);
        return;
      }

      let sessionData: SessionData;
      try {
        sessionData = getOrCreateClient(sessionId);
      } catch {
        sendEmptyStream(res);
        return;
      }

      enqueue(sessionId, () => handleChatRequest(sessionData, body, res));
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", activeSessions: sessionMap.size }));
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[DeepSeek Plugin] Proxy running → http://127.0.0.1:${port}`);
  });
  return server;
}