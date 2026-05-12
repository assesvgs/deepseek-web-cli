# DeepSeek Web Plugin

本仓库根目录是 DeepSeek 网页版 OpenCode 插件的开发工作区。`1/` 目录是 OpenClaw 完整源码（参考用），`openclaw-zero-token/` 是上游参考实现。

## 插件结构

插件代码在 `deepseek-web/`，实际使用时安装在 `.opencode/plugin/deepseek-web/`。

```
deepseek-web/
├── index.ts           # 插件入口，注册 Provider 和 session 钩子
├── server.ts          # 本地代理 (8899 端口) — OpenAI 兼容接口 + SSE 格式转换
├── client.ts          # DeepSeek 网页 API 客户端 (PoW + 聊天)
├── auth.ts            # CDP 登录 / 凭证捕获
├── login.ts           # 独立登录脚本
├── chat.ts            # 独立命令行聊天 (不依赖 OpenCode)
├── constants.ts       # 凭证读写
├── types.ts           # 类型定义
├── wasm-embedded.ts   # PoW WASM 模块 (base64)
└── credentials.json   # 登录凭证 (gitignore)
```

## 前置条件

- Node.js >= 18
- Chrome 浏览器（需要以 `--remote-debugging-port=9222` 启动）
- Android Termux 额外需要 `android-tools` + `adb forward tcp:9222 localabstract:chrome_devtools_remote`

## 常用命令

```bash
# 安装依赖
cd deepseek-web && npm install

# 登录获取凭证（需先启动 Chrome 远程调试）
npx tsx login.ts

# 独立命令行聊天
npx tsx chat.ts "你好"
npx tsx chat.ts --think "用思考模式"
npx tsx chat.ts --session <room-id> "继续对话"
npx tsx chat.ts --raw "查看原始 SSE 流"

# 运行插件服务器（由 OpenCode 自动调用，一般无需手动启动）
npx tsx server.ts
```

## 架构要点

- **会话绑定**：每个 OpenCode session 对应一个 DeepSeek 房间 (chat_session_id)，通过 parent_message_id 续写
- **格式转换**：DeepSeek 私有 SSE 流 → OpenAI 兼容流（`server.ts` 实现）
- **PoW 反爬**：通过嵌入的 WASM 模块计算 DeepSeekHashV1
- **凭证生命周期**：凭证可能过期，需重新运行 `login.ts`

## 编码约定

- TypeScript，ESM (`"type": "module"`)
- 2 空格缩进
- 中文注释（因为 README 和代码注释都是中文）
- `deepseek-web/` 内不使用相对路径引用 `1/` 或 `openclaw-zero-token/` 的代码

## 注意事项

- `credentials.json` 包含敏感信息，已 gitignore
- 网页版 API 非公开接口，可能随时变更或封锁
- `deepseek-web/` 插件没有 `package.json`，作为 OpenCode 插件依赖由宿主管理
- `plan*.md` 是重构计划文档，描述 chat.ts 的 REPL 化、工具调用等目标
