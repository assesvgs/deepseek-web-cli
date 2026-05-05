import type { Plugin } from "@opencode-ai/plugin";
import { startServer, cleanupSession } from "./server.js";

const DeepSeekPlugin: Plugin = async ({ client }) => {
  // 启动本地代理服务器
  const server = startServer(8899);
  console.log(
    "[DeepSeek Plugin] ✅ 代理已启动 → http://127.0.0.1:8899（独立运行，无需 Chrome）"
  );

  return {
    // ── 事件钩子：监听 OpenCode 会话的创建与删除 ──
    event: async ({ event }) => {
      const sessionId = event.properties?.id || event.properties?.sessionID;

      if (event.type === "session.created") {
        try {
          await fetch("http://127.0.0.1:8899/v1/sessions", {
            method: "POST",
            headers: { "X-Session-Id": sessionId },
          });
        } catch {
          // 预创建失败不影响后续使用，聊天时会自动创建
        }
        console.log(
          `[DeepSeek Plugin] OpenCode 会话 ${sessionId} 已创建，DeepSeek 客户端已就绪`
        );
      }

      if (event.type === "session.deleted") {
        cleanupSession(sessionId);
        console.log(
          `[DeepSeek Plugin] 🗑️ OpenCode 会话 ${sessionId} 已删除，已清理 DeepSeek 客户端`
        );
      }
    },

    // ── chat.params 钩子：将 OpenCode 的 sessionID 注入请求头 ──
    "chat.params": async (input, output) => {
      output.options = output.options || {};
      output.options["X-Session-Id"] = input.sessionID;
    },

    // ── 配置钩子：向 OpenCode 注册自定义 Provider ──
    config: async (config) => {
      config.provider = config.provider ?? {};
      config.provider["deepseek-web"] = {
        name: "DeepSeek Web",
        options: {
          baseURL: "http://127.0.0.1:8899/v1",
          apiKey: "not-needed",
        },
        models: {
          "deepseek-chat": {
            name: "DeepSeek-chat",
            reasoning: false,
            input: ["text"],
            contextWindow: 100000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          "deepseek-reasoner": {
            name: "DeepSeek-reasoner",
            reasoning: true,
            input: ["text"],
            contextWindow: 100000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      };
      if (!config.enabled_providers) {
        config.enabled_providers = ["deepseek-web"];
      } else if (!config.enabled_providers.includes("deepseek-web")) {
        config.enabled_providers.push("deepseek-web");
      }
    },
  };
};

export default DeepSeekPlugin;