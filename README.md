# DeepSeek Web CLI

基于 DeepSeek 网页版私有 API 的交互式命令行聊天工具。无需 API Key，零 Token 消耗，通过模拟浏览器请求直接对话。

> ⚠️ 仅供体验和学习：本项目基于网页私有接口逆向实现，随时可能被封禁或变更，请勿用于生产环境。
>
> 📌 注：网页版 API 支持多种模型，可通过 `/model` 命令在 flash / pro / vision 之间切换。

---

## 当前状态

**chat.ts 是项目唯一活跃代码**，一个独立的单文件交互式 REPL（约 2800 行），包含全部功能——登录、CLI、REPL、SSE 解析、API 客户端、PoW 求解、工具执行、Hashline 编辑引擎、会话持久化、提示词体系。无其他模块依赖。

**OpenCode 插件部分已暂停开发**（`opencode/` 目录下文件为历史遗留，不要修改或依赖）。

---

## chat.ts — 单文件交互式 REPL

**所有功能内聚在单文件中。登录也内置其中。**

### 前置条件

- **Node.js >= 18**
- **Chrome 浏览器**（仅首次登录时需要，启动时带 `--remote-debugging-port=9222`）
- **tsx**（TypeScript 执行器，全局安装）
- **playwright-core**（CDP 连接 Chrome 获取凭证，仅首次登录时需要）
- Android Termux 额外需要 `android-tools` + `adb forward tcp:9222 localabstract:chrome_devtools_remote`

### 快速开始

```bash
# 1. 安装依赖（仅首次）
npm install -g tsx
npm install playwright-core

# 2. 启动 REPL（首次运行会自动触发登录流程）
./chat.ts

# 3. 或使用 bun 效率更高（自动安装 playwright-core 相关依赖）
npm install -g bun
bun run ./chat.ts
```

如果凭证缺失或过期，chat.ts 会在启动时自动通过 Chrome DevTools Protocol 捕获 cookie 和 bearer token，保存到 `credentials.json`。已登录状态下直接进入 REPL。

### Android Termux 额外步骤

```bash
pkg install android-tools
# 开启无线调试后，使用 adb pair 配对，然后 adb connect IP:端口
# 转发 Chrome 调试端口
adb forward tcp:9222 localabstract:chrome_devtools_remote
# 验证转发可用
curl -s http://127.0.0.1:9222/json/version
```

### 首次登录流程

1. 启动带远程调试端口的 Chrome：
   - 桌面端：以 `--remote-debugging-port=9222` 参数启动 Chrome
   - Android：确保已通过 `adb forward tcp:9222 localabstract:chrome_devtools_remote` 转发端口
2. 运行 `./chat.ts`，脚本自动检测登录态：
   - 已有有效登录态 → 自动捕获凭证
   - 无有效登录态 → 打开 DeepSeek 页面提示手动登录，完成后自动捕获
3. 凭证保存至 `credentials.json`（gitignored）

> 凭证可能在一段时间后过期，届时运行 `./chat.ts` 会自动重新登录，或在 REPL 中执行 `/reauth`。

### 命令速查

**会话管理**

| 命令 | 说明 |
|------|------|
| `/new [标题]` | 创建新会话 |
| `/load [id]` | 切换会话（无参数时交互式选择） |
| `/ls, /list` | 列出所有会话 |
| `/del [id\|--all]` | 交互式删除 / 指定删除 / 全删 |
| `/parent, /p <id>` | 手动覆盖续接点 |
| `/fork, /f [id] [标题]` | 分叉新会话 |
| `/save, /s` | 手动保存 |
| `/history [-r N] [-a] [-id <id>]` | 查看历史（详见 help） |

**提示词管理**

| 命令 | 说明 |
|------|------|
| `/system, /sys` | 查看提示词状态 |
| `  -c` | 清除局部（回退到全局） |
| `  -f <path> [-l]` | 加载提示词（-l 为局部） |
| `/reinject, /rj [-new\|-keep]` | 重新注入提示词 |

**模式切换**

| 命令 | 说明 |
|------|------|
| `/think [on\|off]` | 切换深度思考模式（提示符 💭） |
| `/search [on\|off]` | 切换联网搜索（提示符 🔍） |
| `/model, /m [flash\|pro\|vision]` | 切换模型 |
| `/upload, /up <path>` | 上传文件 |
| `/tool, /t [on\|off\|-l]` | 工具模式开关 / 列表 |
| `/raw` | 切换原始 SSE（调试用） |

**系统**

| 命令 | 说明 |
|------|------|
| `/?, /h` | 帮助 |
| `/quit, /q` | 退出（需确认） |
| `/clear` | 清屏 |
| `/cd <path>` | 切换工作目录 |
| `/pwd` | 当前工作目录 |
| `/auth` | 查看凭证状态 |
| `  -s` | 验证凭证有效性 |
| `/reauth` | 重新登录 |
| `!<cmd>` | Shell 透传 |

### 提示词体系

在工作目录下创建 `.deepseek/` 目录（gitignored），支持五类提示词文件：

```
.deepseek/
├── system.md          # 局部（优先级最高）
├── system-all.md      # 全局（局部不存在时生效）
├── tool.md            # 工具补充提示词
├── skill.md           # skill 提示词
├── think.md           # 深度思考提示词（覆盖默认推理提示）
└── sessions/          # 会话存档目录
```

使用 `/cd <path>` 切换目录后，自动重新发现该目录的提示词和会话。

### 会话持久化

- 自动保存：每轮对话结束后自动保存到 `.deepseek/sessions/<id>.json`
- 退出恢复：退出重启后自动恢复最近会话
- `/s` 手动保存、`/load` 切换、`/del` 删除
- `/f` 基于任意历史点分叉新会话（首轮注入原会话历史）

### 工作目录感知

- 启动时以 `process.cwd()` 为工作目录
- `/cd <path>` 切换目录，自动重新扫描 `.deepseek/` 并恢复会话
- 不同目录可以有独立的提示词和会话

---

## 工作原理

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

- **ChatSession**：会话管理、消息发送、工具调用循环（最大 10 次）、模型/搜索/思考开关
- **StreamParser**：SSE 流解析器，处理文本/思考/工具调用/标题/引用链接，支持 DSML 标签格式
- **DeepSeekClient**：无状态 API 客户端，封装 PoW、HTTP 请求、文件上传
- **SessionStore**：会话 JSON 文件持久化
- **ToolRegistry/ToolExecutor**：工具注册与执行（含用户确认机制）
- **Hashline 核心**：行级 SHA1 哈希标注、ref 解析、编辑冲突检测、fileRev 版本校验、safeReapply 自动重定位

---

## 文件结构

```
deepseek-web-cli/
├── chat.ts              # ★ 唯一活跃代码（约 2800 行，单文件打包）
├── tool.md              # 工具使用说明书（供 .deepseek/tool.md 按需复制）
├── credentials.json     # 登录凭证 (gitignored)
├── .gitignore
├── AGENTS.md            # Agent 指引
├── Test/
│   ├── test.test.ts     # 78 项自动化单元测试
│   ├── TEST_PLAN.md     # 手动 + 自动完整测试方案
│   └── test*/           # 测试用 .deepseek/ fixture 目录
├── opencode/            # OpenCode 插件（已暂停，保留作参考）
│   ├── deepseek-web/
│   │   ├── server.ts, client.ts, auth.ts, login.ts ...
│   │   └── package.json
│   └── deepseek-web.ts  # 旧版插件入口
└── .deepseek/           # 局部提示词和会话（gitignored）
```

---

## 技术实现

- **PoW 反爬**：通过嵌入的 WASM 模块（base64 内联）计算 DeepSeekHashV1 / SHA256
- **CDP 登录**：Chrome DevTools Protocol 自动捕获 cookie 和 bearer token
- **SSE 解析**：从 OpenClaw Zero Token 移植 tagBuffer 状态机
- **单文件打包**：chat.ts 完整内联了 Client/PoW/Parser/Session/Tools/REPL/Credentials，可脱离其他文件独立运行
- **工具调用**：`<tool_call>` / `<|DSML|invoke>` 标签格式，StreamParser 实时检测，支持 CDATA 参数包装
- **Hashline 安全编辑**：read 输出每行自动标注 `#HL 行号#行哈希#锚点|` 标签，edit 时引用标签精确定位。文件在读写之间被外部修改时，哈希校验失败直接拒绝编辑。write 自动清洗标注前缀。支持 safeReapply 自动重定位（详见 `tool.md`）

---

## Hashline 文件编辑安全机制

chat.ts 内联了 [opencode-hashline](https://github.com/AngDrew/opencode-hashline) 的核心能力，为 `read` / `write` / `edit` 工具提供行级哈希校验。

### 工作流程

```
模型调用 read foo.ts
  → 返回 <hashline-file> 包裹的标注内容，每行带 #HL N#hash#anchor|
  → #HL REV:A1B2C3D4 为文件版本指纹

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

### 六种操作

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
| 行哈希校验 | 每个 ref 携带行内容 SHA1 哈希（3-4 字符），不匹配时拒绝编辑 |
| 锚点哈希校验 | ref 带 anchor 时还校验前后邻行内容，防同内容行误定位 |
| fileRev 版本锁 | 8 位 SHA1 文件版本指纹，读写之间文件被修改则拒绝编辑 |
| 重叠检测 | 批量操作中，删除/替换范围有重叠时拒绝执行 |
| safeReapply | 开启后 hash 匹配但行号移动时自动重新定位（仅当恰好一个候选时） |

---

## 测试

```bash
# 安装 tsx（仅首次）
npm install -g tsx

# 78 项自动化单元测试（Node 原生 test runner + tsx）
node node_modules/tsx/dist/cli.mjs --test Test/test.test.ts
```

覆盖哈希函数、标注输出、ref 解析、编辑操作、冲突检测、fileRev 校验、标注清洗、会话持久化、环境发现、边界情况等 14 个维度。测试无需凭证或网络连接。

详细手动验收方案见 [Test/TEST_PLAN.md](Test/TEST_PLAN.md)。

---

## OpenCode 插件（已暂停开发）

<details>
<summary>展开查看原始插件文档（仅供参考，不保证与最新代码一致）</summary>

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

### 安装

```bash
cd opencode/deepseek-web
npm install
```

插件启动后在 `http://127.0.0.1:8899/v1` 启动本地代理服务器，注册名为 `deepseek-web` 的 Provider。

### 已知问题和限制

1. 由于网页版 API 并非公开接口，可能会受到反爬机制、频率限制或接口变动的影响
2. 会话绑定偶尔可能出现映射丢失，导致多轮对话断开
3. 不支持文件上传、联网搜索等高级功能（通过本插件）
4. 仅供体验和学习，不建议用于生产环境

</details>

---

## 参考与致谢

- OpenClaw Zero Token — 核心技术参考 https://github.com/linuxhsj/openclaw-zero-token/
- ds2api — 核心技术参考 https://github.com/CJackHwang/ds2api
- opencode-hashline — 核心技术参考 https://github.com/AngDrew/opencode-hashline
- DeepSeek — 免费网页对话服务
