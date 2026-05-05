DeepSeek Web Plugin for OpenCode (Zero Token)

在 OpenCode 中免费使用 DeepSeek 网页版，无需 API Key，无需付费，零 Token 消耗。

本插件通过模拟浏览器请求，将 DeepSeek 网页版的私有 SSE 流转换为 OpenAI 兼容接口，使 OpenCode 可以直接调用网页版的 DeepSeek 模型（deepseek-chat / deepseek-reasoner）。

仅供体验和学习：本项目基于网页私有接口逆向实现，随时可能被封禁或变更，请勿用于生产环境。

---

工作原理简图

```
OpenCode (AI 编程助手)
    │
    ▼ 请求 /v1/chat/completions
本地代理服务器 (server.ts)    ←── 插件注册的 Provider
    │
    ▼ 组装 prompt，调用 DeepSeek 网页 API (模拟浏览器)
DeepSeek 网页服务器 (chat.deepseek.com)
    │
    ▼ 返回私有格式的 SSE 流
格式转换层 (server.ts)
    │  提取回复文本、思考过程、工具调用
    │  转换为 OpenAI 兼容的 SSE 流
    ▼
OpenCode 收到标准流式响应
```

整个过程完全在本地进行，只需要一个已经登录了 DeepSeek 的浏览器环境（Chrome），之后即可脱离浏览器持续对话。

---

核心概念：房间号与消息续写

chat_session_id（房间号）

· DeepSeek 网页版通过 chat_session_id 维持一段对话的上下文。
· 发起新对话时，脚本向 chat.deepseek.com/api/v0/chat_session/create 发送 POST 请求，得到一个 UUID 作为房间号。
· 后续在同一房间内发送的消息，DeepSeek 服务器会自动记住之前的历史，因此只需要发送当前这一条消息即可延续上下文。

parent_message_id（续写点）

· 房间内的每条消息都有一个递增的数字 ID（如 1, 2, 3...）。
· 其中 偶数 ID 为 AI 的回复，奇数 ID 为用户的提问（由服务器自动分配，客户端无法直接获取奇数 ID）。
· 脚本从 SSE 流中捕获 AI 回复的 response_message_id，并保存为 parent_message_id。
· 在下一次请求时，将 parent_message_id 发送给服务器，表示“请接在这条消息后面继续回答”。

首轮对话：parent_message_id 为空，脚本会把系统提示词、历史消息和工具定义全部拼成一个长文本发送。

后续对话：parent_message_id 不为空，脚本只发送当前用户消息的内容，服务器会自动续写。

---

文件结构

```
.opencode/plugin/deepseek-web/          ← 插件主体
├── index.ts              # 插件入口，注册 Provider 和事件钩子
├── server.ts             # 本地代理服务器 (OpenAI 兼容接口 + 格式转换)
├── client.ts             # DeepSeek 网页 API 客户端 (PoW + 聊天)
├── auth.ts               # CDP 登录 / 凭证捕获逻辑
├── login.ts              # 独立登录脚本（终端运行）
├── chat.ts               # 独立命令行聊天脚本 (不依赖 OpenCode)
├── constants.ts          # 凭证读写路径
├── types.ts              # 类型定义
├── wasm-embedded.ts      # DeepSeek PoW 算法的 WASM 模块 (base64)
├── credentials.json      # 登录后保存的凭证 (自动生成)
└── .sessions/            # chat.ts 的会话存档目录

OpenClaw-Zero-Token/                ← 参考项目核心文件（仅用于学习对比）
├── deepseek-web-client.ts          # DeepSeek 网页客户端（含 PoW、SSE 发送）
├── deepseek-web-stream.ts          # SSE 解析与格式转换核心实现
├── deepseek-web-auth.ts            # CDP 登录与凭证捕获（attach+launch 模式）
├── chrome.ts                       # Chrome 启动管理及 CDP WebSocket 获取
├── cdp.helpers.ts                  # CDP 底层工具（HTTP 请求、WebSocket 创建）
```

---

安装与前置条件

1. Node.js 环境（建议 18+）
2. Chrome 浏览器（用于登录获取凭证）
3. 如果要在 Android Termux 上使用，还需要 android-tools 并正确配置端口转发。

安装插件

将插件文件放入 OpenCode 的插件目录：

```bash
mkdir -p .opencode/plugin/deepseek-web
cp -r ./deepseek-web/* .opencode/plugin/deepseek-web/
cd .opencode/plugin/deepseek-web
npm install
npx tsx login.ts   # 按提示登录
```

Android Termux 额外步骤

```bash
pkg install android-tools
# 开启无线调试后，使用 adb pair 配对，然后 adb connect IP:端口
# 转发 Chrome 调试端口
adb forward tcp:9222 localabstract:chrome_devtools_remote
```

---

登录获取凭证

1. 启动带远程调试端口的 Chrome：
   · 桌面端：以 --remote-debugging-port=9222 参数启动 Chrome（可以写一个启动脚本）。
   · Android：确保已通过 adb forward tcp:9222 localabstract:chrome_devtools_remote 转发端口。
2. 进入插件目录，执行登录脚本：
   ```bash
   cd .opencode/plugin/deepseek-web
   npx tsx login.ts
   ```
3. 如果已有有效登录态，脚本会自动捕获凭证；否则会打开 DeepSeek 页面，提示你手动登录。
4. 成功后，凭证保存在 credentials.json 文件中。

注意：凭证可能在一段时间后过期，届时需重新运行 login.ts。

---

在 OpenCode 中使用

启动 OpenCode 后，插件会自动在 http://127.0.0.1:8899/v1 启动一个本地代理服务器，并向 OpenCode 注册一个名为 deepseek-web 的 Provider。

· 模型列表：
  · deepseek-chat（标准聊天）
  · deepseek-reasoner（深度思考模式）

直接在 OpenCode 中切换到此 Provider 即可开始使用。

会话绑定：插件的本地代理服务器会为每个 OpenCode 会话维护对应的 DeepSeek 房间 ID 和 parentMessageId，实现多轮对话的上下文延续。当 OpenCode 会话删除时，插件也会清理相关状态。

注意：由于网页端 API 并未官方开放，在高频使用或反爬升级时可能会出现暂时失灵，属正常现象。

---

独立脚本 chat.ts 使用指南

chat.ts 是一个不依赖 OpenCode 的命令行聊天脚本，同样实现了多轮对话和上下文管理。

安装依赖

```bash
npm install -g tsx   # 如未安装 tsx
```

用法

```bash
./chat.ts "你好"                              # 新房间，首轮对话
./chat.ts --session <room-id> "继续"          # 进入已有房间，自动续写
./chat.ts --parent-id 2 "重新接在这里"         # 手动指定从哪个消息继续
./chat.ts --raw "原始数据"                     # 查看原始 SSE 流（会保存 parentMessageId 及原始数据）
./chat.ts --think "思考问题"                   # 开启深度思考模式
```

选项

选项 说明
--session <id> 使用指定的会话 ID (房间号) 继续对话，自动显示最近历史
--parent-id <id> 手动指定本轮对话的 parent_message_id（覆盖存档）
--new 强制创建新会话
--think 开启思考模式（deepseek-reasoner）
--raw 输出原始 SSE 流，不进行格式化解析

会话存档

每次对话后，chat.ts 会在 .sessions/ 目录下生成以房间号命名的 JSON 文件，记录对话历史、标题和最新的 parentMessageId，方便随时续写。

---

技术亮点

项目的关键实现参考了 OpenClaw Zero Token 的思路，核心技术模块如下：

1. CDP 附加模式与凭证捕获

· 文件: auth.ts（插件）/ deepseek-web-auth.ts（参考项目）
· 通过 Chrome DevTools Protocol (CDP) 连接已启动的 Chrome，监听网络请求自动捕获 cookie 和 bearer token，无需手动输入密码。

2. 请求伪装与反爬

· 文件: client.ts / deepseek-web-client.ts
· 完整模拟浏览器的请求头（x-client-platform 等），并实现了 DeepSeek 的 PoW 反爬算法（sha256 和 DeepSeekHashV1，后者通过嵌入的 WASM 模块计算）。

3. SSE 流解析与格式转换

· 文件: server.ts / deepseek-web-stream.ts
· 将 DeepSeek 网页版返回的私有 SSE 流实时转换为 OpenAI 兼容的流式格式，支持文本、思考过程、XML 工具调用等复杂输出。

4. 多轮对话与状态管理

· 文件: server.ts / deepseek-web-stream.ts
· 利用 chat_session_id 和 parent_message_id 机制维护对话上下文，本地代理服务器为每个 OpenCode 会话管理独立的 DeepSeek 房间和续写点。

---

参考文件说明

仓库根目录下的 OpenClaw-Zero-Token/ 文件夹存放了上游参考项目的核心源代码，仅供学习对比，不会在插件中实际运行。这些文件展示了更完整的 CDP 启动、SSE 流事件化处理等实现：

· deepseek-web-client.ts – DeepSeek 网页客户端（包含 PoW 挑战、文件上传、模型发现等功能）
· deepseek-web-stream.ts – 将原始字节流转换为 OpenClaw 标准事件流的核心转换层
· deepseek-web-auth.ts – CDP 登录与凭证捕获逻辑（支持 attach + launch 两种模式）
· chrome.ts – Chrome 启动管理及 WebSocket 地址获取
· cdp.helpers.ts – CDP 底层工具（HTTP 请求、WebSocket 创建、认证头处理）

若需深入理解或二次开发，或者对于OpenClaw Zero Token中其他网页模型的支持如豆包等，可参考这些相关文件中的详细注释。

---

已知问题和限制

1. OpenCode 中偶尔失灵
      由于网页版 API 并非公开接口，可能会受到反爬机制、频率限制或接口变动的影响，导致请求失败或回复异常。此时可尝试重新登录获取新凭证。
2. 会话绑定不稳定
      当前版本通过 OpenCode 的 session 事件钩子创建和销毁对应的 DeepSeek 房间，但偶尔可能出现映射丢失，导致多轮对话断开。后续版本会进一步完善绑定逻辑。
3. 不支持文件上传、联网搜索等高级功能（通过本插件）。如需这些功能，请使用官方 API。
4. 仅供体验和学习：本项目基于网页私有接口实现，可能随时被封锁或变更，不建议用于生产环境。

---

参考与致谢

· OpenClaw Zero Token —— 项目的灵感来源和核心技术参考
· OpenCode —— 支持的 AI 编程助手框架
· DeepSeek —— 提供强大的免费网页对话服务

---

贡献

由于本项目属于实验性质，建议在理解代码和风险的前提下进行修改。