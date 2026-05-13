# DeepSeek Web CLI

基于 DeepSeek 网页版私有 API 的交互式命令行聊天工具。无需 API Key，零 Token 消耗，通过模拟浏览器请求直接对话。

> ⚠️ 仅供体验和学习：本项目基于网页私有接口逆向实现，随时可能被封禁或变更，请勿用于生产环境。
>
> 📌 注：网页版 API 使用的是 **DeepSeek V3 Flash（v4-flash）** 模型，非 DeepSeek Pro 模型。这与官方 API 的 deepseek-chat 模型不同，能力和回复风格有差异。

---

## 当前状态

**chat.ts 是项目当前最完善的组件**，一个独立的单文件交互式 REPL（~2500 行），包含全部功能。

**OpenCode 插件部分已暂停开发**（`index.ts` / `server.ts` / `client.ts`），下列文档中关于插件的说明仅保留作历史参考，不保证与最新代码一致。

---

## chat.ts — 单文件交互式 REPL

**所有功能内聚在单文件中，无需其他模块。（包含登录）**

### 前置条件

- **Node.js >= 18**
- **Chrome 浏览器**（仅登录时需要，启动时带 `--remote-debugging-port=9222`）
- **tsx**（TypeScript 执行器）
- **playwright-core**（CDP 连接 Chrome 获取凭证，仅登录时需要）
- Android Termux 额外需要 `android-tools` + `adb forward tcp:9222 localabstract:chrome_devtools_remote`

### 快速开始

```bash
cd deepseek-web

# 1. 安装依赖
npm install -g tsx
npm install playwright-core

# 2. 登录获取凭证（需要 Chrome 已启动并监听 9222）
npx tsx chat.ts 或 ./chat.ts

# 3. 启动 REPL
./chat.ts
```

### Android Termux 额外步骤

```bash
pkg install android-tools
# 开启无线调试后，使用 adb pair 配对，然后 adb connect IP:端口
# 转发 Chrome 调试端口
adb forward tcp:9222 localabstract:chrome_devtools_remote
# 可查看具体调试消息
curl -s http://127.0.0.1:9222/json/version
```

### 登录获取凭证

1. 启动带远程调试端口的 Chrome：
   - 桌面端：以 `--remote-debugging-port=9222` 参数启动 Chrome
   - Android：确保已通过 `adb forward tcp:9222 localabstract:chrome_devtools_remote` 转发端口
2. 执行登录脚本：
   ```bash
   cd .opencode/plugin/deepseek-web
   npx tsx login.ts 或 npx tsx chat.ts
   ```
3. 如果已有有效登录态，脚本自动捕获凭证；否则打开 DeepSeek 页面提示手动登录
4. 凭证保存至 `credentials.json`

> 注意：凭证可能在一段时间后过期，届时需重新运行 `login.ts`

### 命令速查（22 条）

**会话管理**

| 命令 | 说明 |
|------|------|
| `/new [标题]` | 创建新会话 |
| `/load [id]` | 切换会话（无参数时交互式选择） |
| `/ls` | 列出所有会话 |
| `/del [id\|--all]` | 交互式删除 / 指定删除 / 全删 |
| `/p <id>` | 手动覆盖续接点 |
| `/f [id] [标题]` | 分叉新会话 |
| `/s` | 手动保存 |
| `/history [-r N] [-a] [-id <id>] [on\|off]` | 查看历史 |

**提示词管理**

| 命令 | 说明 |
|------|------|
| `/sys` | 查看当前提示词状态 |
| `/sys -c` | 清除局部提示词（回退到全局） |
| `/sys -f <path> [-l]` | 从文件加载提示词（-l 为局部） |
| `/rj [-new\|-keep]` | 重新注入提示词 |

**模式切换**

| 命令 | 说明 |
|------|------|
| `/think [on\|off]` | 切换深度思考模式（默认关） |
| `/search [on\|off]` | 切换联网搜索（默认开） |
| `/tool [on\|off]` | 切换工具模式（默认关） |
| `/raw` | 切换原始 SSE 数据流（调试用） |

**工具**

| 工具 | 说明 |
|------|------|
| `read` | 读取文件（输出自动标注 hashline 行哈希） |
| `write` | 写入文件（需确认） |
| `edit` | 精确编辑（需确认，支持 hashline 行级哈希引用） |
| `exec` | 执行系统命令（需确认） |

**系统**

| 命令 | 说明 |
|------|------|
| `/?, /h` | 帮助 |
| `/q` | 退出（需确认） |
| `/clear` | 清屏 |
| `/cd <path>` | 切换工作目录（自动发现提示词） |
| `/pwd` | 当前工作目录 |
| `/auth [-s]` | 查看/验证凭证状态 |
| `/reauth` | 重新登录获取凭证 |
| `!<cmd>` | Shell 透传 |

### 提示词体系

在工作目录下创建 `.deepseek/` 目录，支持三层提示词：

```
.deeepseek/
├── system.md          # 局部（优先级最高）
├── system-all.md      # 全局（局部不存在时生效）
├── tool.md            # 工具补充提示词
└── skill.md           # skill 提示词（预留）
```

使用 `/cd <path>` 切换目录后，自动重新发现该目录的提示词和会话。

### 会话持久化

- 自动保存：每轮对话结束后自动保存到 `.deepseek/sessions/<id>.json`
- 退出恢复：退出重启后自动恢复最近会话
- `/s` 手动保存、`/load` 切换、`/del` 删除
- `/fork` 基于任意消息点分叉新会话

### 工作目录感知

- 启动时以 `process.cwd()` 为工作目录
- `/cd <path>` 切换目录，自动重新扫描 `.deepseek/` 并恢复会话
- 不同目录可以有独立的提示词和会话

---

## 工作原理（chat.ts）

```
用户输入 → REPL 解析（/命令 / !透传 / 消息）
                 │
            ChatSession.send()
                 │
            PromptBuilder 组装提示词
                 │
            DeepSeekClient.chat()（PoW + API 请求）
                 │
            SSE 流 ← chat.deepseek.com
                 │
            StreamParser 解析（text/thinking/title/tool_call）
                 │
            终端输出
```

核心模块（均在 chat.ts 单文件内）：
- **ChatSession**：会话管理、消息发送、工具调用循环
- **StreamParser**：SSE 流解析器，处理文本/思考/工具调用/标题
- **DeepSeekClient**：无状态 API 客户端，封装 PoW 和 HTTP 请求
- **SessionStore**：会话 JSON 文件持久化
- **ToolRegistry/ToolExecutor**：工具注册与执行（含确认机制）
- **Hashline 核心**：行级 SHA1 哈希标注、ref 解析、编辑冲突检测、fileRev 版本校验、safeReapply 自动重定位

---

## 文件结构

```
deepseek-web/
├── chat.ts              # ★ 交互式 REPL（核心文件，~2500 行，单文件打包）
├── login.ts             # 独立登录脚本
├── tool.md              # 工具使用说明书（供 .deepseek/ 按需复制）
├── credentials.json     # 登录凭证 (gitignore)
├── test/
│   └── test.test.ts     # 78 项自动化单元测试
├── TEST_PLAN.md         # 完整测试方案
├── docs/
│   └── hashline-integration-design.md
│
│  以下为 OpenCode 插件相关（已暂停开发，保留作参考）：
├── server.ts            # OpenAI 兼容代理
├── client.ts            # 旧版 API 客户端
├── auth.ts              # CDP 登录逻辑
├── wasm-embedded.ts     # PoW WASM 模块 (base64)
├── index.ts             # 插件入口
├── types.ts             # 类型定义
├── constants.ts         # 凭证读写
└── credentials.json     # 登录凭证 (gitignore)
```

---

## 技术实现

- **PoW 反爬**：通过嵌入的 WASM 模块计算 DeepSeekHashV1 / SHA256
- **CDP 登录**：Chrome DevTools Protocol 自动捕获 cookie 和 bearer token
- **SSE 解析**：从 OpenClaw Zero Token 移植 tagBuffer 状态机
- **单文件打包**：chat.ts 完整内联了 Client/PoW/Parser/Session/Tools/REPL，可脱离其他文件独立运行
- **工具调用**：`<tool_call>` XML 标签格式，StreamParser 实时检测
- **Hashline 安全编辑**：read 输出每行自动标注 `#HL 行号#行哈希#锚点|` 标签，edit 时引用标签精确定位。文件在读写之间被外部修改时，哈希校验失败直接拒绝编辑，防止静默写错文件。write 自动清洗标注前缀。支持 safeReapply 自动重定位

---

## Hashline 文件编辑安全机制

`chat.ts` 内联了 [opencode-hashline](https://github.com/AngDrew/opencode-hashline) 的核心能力，为 `read` / `write` / `edit` 工具提供行级哈希校验。

### 工作流程

```
模型调用 read foo.ts
  → 返回 <hashline-file> 包裹的标注内容，每行带 #HL N#hash#anchor|
  → #HL REV:A1B2C3D4 为文件版本指纹
  → rev 存入内存缓存

模型调用 edit { filePath, operations: [{ op: "replace", startRef: "#HL 3#A4F#9BC", content: "..." }], fileRev: "A1B2C3D4" }
  → 读文件现场计算 rev，与 fileRev 对比
  → 解析 refs，校验每行的 hash 和 anchor 是否匹配
  → 检测操作间是否有重叠冲突
  → 从后往前按 splice 顺序应用改动
  → 写入文件，清除 rev 缓存

模型调用 write { content: "..." }
  → 自动清洗 content 中混入的 #HL 前缀和 wrapper 标签
  → 写入文件，清除 rev 缓存
```

### 支持的操作

| 操作 | 说明 |
|------|------|
| `replace` | 替换 startRef 到 endRef 范围（无 endRef 则替换单行） |
| `delete` | 删除 startRef 到 endRef 范围 |
| `insert_before` | 在 startRef 之前插入内容 |
| `insert_after` | 在 endRef 之后插入内容 |
| `replace_range` | 替换 startRef 到 endRef 范围（需同时传两者） |
| `set_file` | 全量覆盖文件（不能与其他操作混用） |

### 安全机制

| 机制 | 说明 |
|------|------|
| 行哈希校验 | 每个 ref 携带行内容 SHA1 哈希（3-4 字符），当前文件行内容不匹配时拒绝编辑 |
| 锚点哈希校验 | 可选，ref 带 anchor 时还校验前后邻行内容，防同内容行误定位 |
| fileRev 版本锁 | 8 位 SHA1 文件版本指纹，读写之间文件被修改则拒绝编辑 |
| 重叠检测 | 批量操作中，删除/替换范围有重叠时拒绝执行 |
| safeReapply | 开启后 hash 匹配但行号移动时全文搜索自动重新定位（仅当恰好一个候选时） |

### 与传统编辑的对比

| | 传统 oldString/newString | hashline ref 编辑 |
|---|---|---|
| 定位方式 | 全文搜索文本 | 行号 + hash + anchor 三重定位 |
| 同内容多匹配 | 直接失败 | 不依赖唯一性，靠 hash 区分 |
| 文件被外部修改 | 静默写错或不匹配 | fileRev 校验拒绝，提示重新 read |
| 所需 token | 需原样复现整段原文 | 只需 10 字符 ref 标签 |
| write 混入标注 | 可能污染文件 | 自动清洗 |

---

## 测试

```bash
npm install tsx          # 仅首次
node node_modules/tsx/dist/cli.mjs --test test/test.test.ts
```

78 项单元测试覆盖哈希函数、标注输出、ref 解析、编辑操作、冲突检测、fileRev 校验、标注清洗、会话持久化、环境发现、边界情况等 14 个维度。

详细手动验收方案见 [TEST_PLAN.md](TEST_PLAN.md)。

---

## OpenCode 插件（已暂停开发）

以下为原始插件文档，保留作历史参考。

<details>
<summary>展开查看</summary>

### 工作原理简图

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

### 安装（OpenCode 插件）

```bash
mkdir -p .opencode/plugin/deepseek-web
cp -r ./deepseek-web/* .opencode/plugin/deepseek-web/
cd .opencode/plugin/deepseek-web
npm install
npx tsx login.ts   # 按提示登录
```

### 在 OpenCode 中使用

启动 OpenCode 后，插件自动在 `http://127.0.0.1:8899/v1` 启动本地代理服务器，注册名为 `deepseek-web` 的 Provider。

- 模型列表：`deepseek-chat`（标准聊天）、`deepseek-reasoner`（深度思考模式）

会话绑定：本地代理服务器为每个 OpenCode 会话维护对应的 DeepSeek 房间 ID 和 parentMessageId，实现多轮对话的上下文延续。

### 已知问题和限制

1. 由于网页版 API 并非公开接口，可能会受到反爬机制、频率限制或接口变动的影响，导致请求失败或回复异常
2. 会话绑定偶尔可能出现映射丢失，导致多轮对话断开
3. 不支持文件上传、联网搜索等高级功能（通过本插件）
4. 仅供体验和学习，不建议用于生产环境

</details>

---

## 参考与致谢

- OpenClaw Zero Token — 核心技术参考
- DeepSeek — 免费网页对话服务
