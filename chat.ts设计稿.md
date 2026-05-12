# DeepSeek Web CLI 重构施工蓝图 (v11.0 — 实现终稿)

## 一、设计原则

| 原则 | 说明 |
|------|------|
| 复用优先 | 最大化复用现有 DeepSeekWebClient、SSE 解析、PoW 算法、loginDeepseek。`server.ts`、`client.ts`、`auth.ts`、`wasm-embedded.ts` 等文件不动 |
| 最小改动 | 改造范围严格控制在 `chat.ts` 单文件内（目标 ~1400 行） |
| REPL 为核心 | 入口固定为 `./chat.ts`，直接进入交互式 REPL，废除命令行参数单次执行模式 |
| 状态机模型 | ChatSession 作为状态机管理会话生命周期 |
| 工作目录感知 | 会话和提示词跟随 `process.cwd()`，`!cd` 或任何 Shell 命令导致目录变化时重新发现环境 |
| 惰性创建 | 会话 ID 仅在首次 API 请求时创建 |
| 单一职责 | 每个类只做一件事：Client 负责 API，Parser 负责解析，Session 负责协调 |

---

## 二、宏观架构

### 2.1 单文件内部分层

```
chat.ts (~2200 行)
├── 导入 & 常量 (node内置, WASM_B64, CRED_FILE, JUNK_TOKENS)
├── 类型定义 (Credentials, SessionState, MessageRecord, ToolDefinition, ParseEvent)
│
├── 领域层 (无状态)
│   ├── class PowSolver        # PoW 求解器 (SHA256 + DeepSeekHashV1)
│   ├── class DeepSeekClient   # 无状态 API 客户端
│   └── class StreamParser     # SSE → ParseEvent 流
│
├── 应用层 (有状态，协调)
│   ├── class SessionStore     # 会话 JSON 持久化
│   ├── class ToolRegistry     # 工具注册表
│   ├── class ToolExecutor     # 工具执行 + 确认
│   ├── class PromptBuilder    # 拼接提示词/工具/用户消息
│   ├── class ChatSession      # 核心状态机，send() 异步生成器
│   └── scanDeepseekDir()      # 环境发现函数
│
├── 交互层
│   ├── loginDeepseek()        # 内联 auth.ts
│   ├── ensureCredentials()    # 凭证管理与自动登录
│   ├── handleCommand()        # 命令分发
│   ├── displayEvent() / getPrompt() / printHelp()
│   └── startRepl()            # readline 循环
│
└── main() 入口
```

### 2.2 核心数据流（用户发送消息）

```
用户输入 "你好"
  → REPL 识别为非命令
  → session.send("你好")
       ├─ 确定 isFirstTurn (parentMessageId == null 或 reinjectMode 激活)
       ├─ PromptBuilder.build(systemPrompt, toolsPrompt, userMsg, isFirstTurn)
       ├─ 若 sessionId 仍为本地 UUID → client.createChatSession()
       ├─ while (深度 < 10):
       │    ├─ client.chat(sessionId, parentId, prompt, thinkEnabled)
       │    ├─ StreamParser.feedLine() 逐行解析
       │    ├─ 事件分派:
       │    │    ├─ text_delta → 终端输出
       │    │    ├─ thinking_delta → 终端输出(蓝色)
       │    │    ├─ message_id → 更新 parentMessageId
       │    │    ├─ title → 更新 session.title
       │    │    └─ tool_call_end:
       │    │         ├─ 🔧 执行工具: xxx ✅
       │    │         ├─ ToolExecutor.execute(name, args)
       │    │         ├─ 构造 tool_response
       │    │         └─ continue (再次调用 chat)
       │    └─ 无工具调用则跳出循环
       ├─ pushUserAndAssistantMessages()
       └─ store.save()
```

---

## 三、目录结构规范

### 工作目录下的 `.deepseek/`

```
{当前工作目录}/
  └── .deepseek/
      ├── system.md             # 局部系统提示词（优先级最高）
      ├── system-all.md         # 全局系统提示词（局部不存在时生效）
      ├── tool.md               # 工具提示词（存在即注入）
      ├── skill.md              # skill 提示词（预留，当前版本不自动注入）
      └── sessions/
          ├── _current          # 最后活跃会话 ID（文本文件）
          ├── <sessionId>.json  # 会话存档
          └── <forkId>.json     # fork 分支存档
```

### 凭证文件

```
脚本所在目录/
  └── credentials.json          # 凭证 (cookie + bearer + userAgent)
```

### 提示词优先级

| 文件 | 作用域 | 优先级 | 自动注入 |
|------|--------|--------|----------|
| `.deepseek/system.md` | 局部 | 最高 | 是 |
| `.deepseek/system-all.md` | 全局 | 低 | 是（局部不存在时） |
| `.deepseek/tool.md` | 局部 | 补充 | 是 |
| `.deepseek/skill.md` | 局部 | 预留 | 否 |

---

## 四、命令系统完整规范

### 4.1 语法规则

| 特征 | 规则 | 例子 |
|------|------|------|
| 命令前缀 | `/` 开头 | `/help` |
| Shell 透传 | `!` 开头 | `!git status` |
| 简写 | 首字母；冲突则取前两个字母 | `/list` → `/ls`；`/history` 无简写（`/h` 给 `/help`） |
| 选项 | `-` 短选项 | `/history -r 5` |
| 开关 | 使用 `on` / `off` 子命令 | `/think on` |
| 位置参数 | 按定义顺序 | `/fork <id> [标题]` |

### 4.2 会话管理

| 命令 | 简写 | 参数 | 说明 |
|------|------|------|------|
| `/new` | 无 | `[标题]` | 创建新会话（惰性，不调用 API） |
| `/load` | 无 | `<sessionId>` | 切换会话；未找到时列出可用会话 |
| `/list` | `/ls` | 无 | 列出当前目录所有会话（编号、ID、标题、轮数、时间、fork 标记） |
| `/del` | 无 | `[id\|--all]` | 无参数→交互式；`<id>`→直接删除；`--all`→全部删除 |
| `/parent` | `/p` | `<id>` | 手动覆盖 parentMessageId，需确认 |
| `/fork` | `/f` | `[id] [标题]` | 从指定消息 ID 分叉新会话 |
| `/save` | `/s` | 无 | 手动保存当前会话 |
| `/history` | 无 | `[-r N] [-a] [-id <id>] [on\|off]` | 查看历史或控制自动打印 |

### 4.3 提示词管理

| 命令 | 简写 | 参数 | 说明 |
|------|------|------|------|
| `/system` | `/sys` | `[-c] [-f <path>] [-f <path> -l]` | 查看/管理/清除/加载提示词 |
| `/reinject` | `/rj` | `[-new \| -keep]` | 设置下次消息的提示词注入策略 |

### 4.4 凭证管理

| 命令 | 简写 | 参数 | 说明 |
|------|------|------|------|
| `/auth` | 无 | `[-s]` | 查看凭证状态；`-s` 验证有效性 |
| `/reauth` | 无 | 无 | 覆盖式重新登录，强制刷新凭证 |

### 4.5 工具与模式

| 命令 | 简写 | 参数 | 说明 |
|------|------|------|------|
| `/tools` | `/t` | 无 | 列出所有可用工具 |
| `/think` | 无 | `[on\|off]` | 切换思考模式；默认关；提示符同步更新 |
| `/raw` | 无 | 无 | 切换原始 SSE 输出（调试用） |

### 4.6 系统命令

| 命令 | 简写 | 说明 |
|------|------|------|
| `/help` | `/?` `/h` | 显示帮助；`/help <cmd>` 显示详细帮助 |
| `/quit` | `/q` | 退出（需确认 y/n） |
| `/clear` | 无 | 清屏 |
| `/cd` | 无 | `<path>` 切换工作目录，自动重新发现提示词和会话 |
| `/pwd` | 无 | 显示当前工作目录 |
| `!<cmd>` | — | Shell 透传；切换目录后触发环境发现 |

### 4.7 各命令详细行为

#### `/new [标题]`
- **id 为空字符串 `""`** 占位，不生成 UUID。首次 `send()` 时判空则调用 `client.createChatSession()` 获取真实 ID 并替换
- 初始化 SessionState：id=`""`, parentMessageId=null, thinkEnabled=false, title=标题或"新会话"
- 写入 _current
- 不调用 createChatSession() API
- 提示符切换为 `💬 标题 >`
- 输出：`✅ 已创建新会话 [标题]`

#### `/load [<sessionId>]`
- **无参数：交互式选择**，显示编号列表，输序号切换，输 `q` 退出
- 有参数：加载指定会话
- 先保存当前会话，加载目标会话
- 若不存在：打印 `❌ 未找到会话 xxx` + 列出可用会话
- 更新 _current
- 成功：`📎 已切换到：ID - 标题 (n 轮)`

#### `/list` (`/ls`)
- 扫描 sessions/ 下所有 .json 文件（跳过 _current）
- 按 updatedAt 降序排列
- 时间：<1h→"n 分钟前"；1-24h→"n 小时前"；>24h→"MM-DD HH:mm"
- Fork 标记：`(fork 自 abcd)`
- 无会话时：`暂无保存的会话`

#### `/del` 交互式（子模式标志方案）
- 进入删除子模式：设置 `let deleteSubMode = true`，在 REPL 的 `on('line')` 回调最前面检查此标志
- 输入路由到删除处理，直至用户输入 `q` 退出子模式
```
🗑️ 删除会话管理
   输入序号删除 | all 全部 | q 退出

   [1] xxx - 标题A (12 轮)
   [2] yyy - 标题B (3 轮, fork)
删除> 2
   ✅ 已删除 yyy - 标题B
```
- 删除当前活跃会话后回退到无会话状态
- **`/del <id>` 直接删除仍需 y/n 确认**，防止误删
- `--all`：进入删除子模式，输入 "all" 后二次确认 `⚠️ 将删除全部 n 个会话，确认？(y/n)`

#### `/parent <id>` (`/p`)
- 显示 `⚠️ 续接点将被修改 (原: 6 → 新: 2)，确认？(y/n)`
- 确认后直接更新 session.parentMessageId，不创建新分支

#### `/fork [id] [标题]` (`/f`)
- 调用 `client.createChatSession()` 创建新 chat_session_id
- 复制原会话消息直到分叉点，**将分叉点之前全部历史文本注入新房间首轮 prompt**
- forkedFrom 记录原会话 ID
- 标题优先级：[可选标题] > "原标题 - 分支" > "未命名分支"
- 自动切换到新会话
- **当前会话无消息（0 轮）时：`⚠️` 警告并拒绝，不创建空会话**

#### `/save` (`/s`)
```
✅ 已保存会话
   标题：xxx
   会话 ID：a1b2c3d4
   路径：.deepseek/sessions/a1b2c3d4.json
```

#### `/history`
- `/history` → 当前会话最近 2 轮
- `/history 5` 或 `-r 5` → 最近 5 轮
- `/history -a` → 全部
- `/history -id <id>` → 指定会话最近 2 轮
- `/history off` → 关闭自动打印（静默切换）
- `/history on` → 开启自动打印（默认开启）
- 输出格式：`👤` 绿色用户消息 + `🤖` 白色 AI 回复 + 蓝色思考内容
- 静默切换时只显示 `📎 已切换到：ID - 标题 (n 轮)`

#### `/system` (`/sys`)
- 无参数：**从磁盘实时读取** system.md/system-all.md，显示当前生效提示词路径和内容（过长截断提示）
- `-c`：删除 system.md，若 system-all.md 存在则自动回退到全局；若 system.md 不存在则打印 `ℹ️ 局部提示词不存在，无需清除`
- `-f <path>`：复制文件为 system-all.md（全局）；**源不存在则 `❌` 错误，不修改任何文件**
- `-f <path> -l`：复制文件为 system.md（局部）；同上校验
- **`-c` / `-f` 操作后自动重新 scanDeepseekDir() 更新 session.systemPrompt**

#### `/reinject` (`/rj`)
- `-new`：parentMessageId 置为 null，下次消息作为首轮处理
- `-keep`：保持 parentMessageId，下次消息前拼接提示词
- 提示：`🔄 下次消息将重新注入提示词（共 xxx 字，模式：-new/-keep）`
- 仅对下一条消息生效
- **重复调用时提示 `⚠️` 已有待注入提示词（模式：xxx），确认覆盖？(y/n)**

#### `/auth` & `/auth -s`
```
🔑 凭证状态
   Cookie:  ✅ 已设置 (d_id=xxx, ds_session_id=xxx, 5 个 cookies)
   Bearer:  ✅ 已设置 (gnX1...)
   UA:      ✅ Mozilla/5.0 ...
```
- `-s`：发起 GET `/api/v0/users/current` 验证，输出 `✅ 凭证有效` 或 `❌ 凭证已过期`

#### `/reauth`
- 调用 loginDeepseek() 重新捕获，覆盖 credentials.json
- 打印进度，成功后不退出 REPL

#### `/think [on/off]`
- 持久存储于 session.thinkEnabled
- 提示符同步：关 `💬 标题 >`；开 `💬 标题 🧠 >`

#### `/raw`
- 开关原始 SSE 输出（调试用）
- 开启后：send() 内直接用 `process.stdout.write` 输出原始字节，不经过 StreamParser/displayEvent
- 原始输出不含提示符（rl.prompt/rl.setPrompt/console.log 均跳过）
- 原始数据自动保存到 messages[] 中
- 显示 `📶 原始 SSE 数据流：开（调试用）`

#### `/cd <path>`
- 使用 `process.chdir()` 切换工作目录，不通过子进程
- 切换后自动触发 `switchWorkspace()`：保存当前会话 → 重新扫描 .deepseek/ → 打印提示词状态 → 恢复新目录最后活跃会话 → 更新提示符

#### `/quit` (`/q`)
- `⚠️ 确认退出？(y/n)`，仅 y/yes 退出
- 退出前自动保存并更新 _current

#### `!<cmd>`
- execSync(cmd, { stdio: 'inherit' })
- 执行后比较 process.cwd()，变化则触发 switchWorkspace()
- 若新目录无 `.deepseek/` 结构 → **自动创建** `.deepseek/sessions/` 目录
- 流程：保存当前会话 → 重新扫描提示词 → 打印状态 → 恢复新目录会话 → 更新提示符

#### 未知命令
- 打印 `❌ 未知命令: /foo` + 列出所有可用命令，提示用户输入 `/?` 查看帮助

---

## 五、核心数据结构

```typescript
interface Credentials {
  cookie: string;
  bearer: string;
  userAgent: string;
}

interface MessageRecord {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  messageId?: number;
  parentMessageId: number | null;
}

interface SessionState {
  id: string;                    // chat_session_id (UUID)
  title: string;
  parentMessageId: number | null;
  messages: MessageRecord[];
  forkedFrom?: string;
  thinkEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string }>;
}

type ParseEvent =
  | { type: "text_delta"; content: string }
  | { type: "thinking_delta"; content: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; name: string; argsDelta: string }
  | { type: "tool_call_end"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "message_id"; id: number }
  | { type: "title"; title: string }
  | { type: "error"; message: string }
  | { type: "end" };
```

---

## 六、核心模块接口设计

### 6.1 PowSolver
```typescript
class PowSolver {
  solve(challenge: any): Promise<number>; // 根据 algorithm 自动派发
  private solveSha256(challenge): number;
  private async solveDeepSeekHash(challenge): Promise<number>;
}
```
从 client.ts 提取，依赖 crypto, Buffer, WASM_B64。

### 6.2 DeepSeekClient（无状态）
```typescript
class DeepSeekClient {
  constructor(private creds: Credentials);
  async createChatSession(): Promise<string>;
  async chat(
    sessionId: string,
    parentMessageId: number | null,
    message: string,
    thinkingEnabled: boolean,
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>>;
}
```
关键改变：不再持有 chatSessionId，构造函数只接受 Credentials。

### 6.3 StreamParser
```typescript
class StreamParser {
  feedLine(line: string): ParseEvent[];
  flush(): ParseEvent[];
}
```
从 deepseek-web-stream.ts 提取 pushDelta 状态机，去除外部依赖。
- 过滤 JUNK_TOKENS
- 识别 `<think>`, `</think>`, `<tool_call>`, `</tool_call>` 标签
- 提取 message_id、title

### 6.4 SessionStore
```typescript
class SessionStore {
  constructor(private workDir: string);
  save(state: SessionState): void;
  load(id: string): SessionState | null;  // 兼容旧版 lastMessageId
  delete(id: string): void;
  list(): { id: string; title: string; rounds: number; updatedAt: number; forkedFrom?: string }[];
  getCurrentId(): string | null;
  setCurrentId(id: string): void;
}
```

### 6.5 ToolRegistry & ToolExecutor
```typescript
class ToolRegistry {
  register(tool: ToolDefinition): void;
  find(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  buildToolPrompt(): string;  // 生成 JSON 数组字符串
}

class ToolExecutor {
  constructor(private registry: ToolRegistry);
  async execute(name: string, args: Record<string, unknown>): Promise<string>;
  // 读操作（read/web_search/web_fetch）自动执行
  // 写/执行操作（write/exec）需确认 y/n
}
```

内置 5 个工具：`read`、`write`、`exec`、`web_search`、`web_fetch`。

### 6.6 PromptBuilder
```typescript
class PromptBuilder {
  constructor(private workDir: string);
  build(systemPrompt: string, toolsPrompt: string, userMessage: string,
        isFirstTurn: boolean, toolMdContent?: string, skillMdContent?: string): string;
}
```
首轮拼接顺序：系统提示词 → 工具定义 → tool.md → skill.md → `User: {用户消息}`。后续轮次仅发送用户消息。

### 6.7 ChatSession（核心协调器）
```typescript
class ChatSession {
  private state: SessionState;
  private reinjectMode: "new" | "keep" | null;

  constructor(state, client, store, promptBuilder, toolExecutor);

  // 核心：发送消息，返回事件生成器。内部 new StreamParser() 解析流，
  // 累积 text_delta 拼接完整回复，流结束后自动存入 messages[]
  async *send(userMessage: string, rawMode: boolean): AsyncGenerator<ParseEvent>;

  // 状态访问器
  get sessionId(): string;
  get title(): string;
  get thinkEnabled(): boolean;
  get parentMessageId(): number | null;

  // 状态修改器
  setThinkEnabled(v: boolean): void;
  setParentMessageId(id: number | null): void;
  setReinjectMode(m: "new" | "keep" | null): void;
  setSystemPrompt(p: string): void;
  setClient(creds: Credentials): void;  // 内部 new DeepSeekClient(creds)
  setTitle(t: string): void;
  addMessage(m: MessageRecord): void;

  // 静态工厂（不含 parser，send() 内部自建）
  static create(client, store, promptBuilder, executor, title?): ChatSession;
  static load(id, client, store, promptBuilder, executor): ChatSession | null;
}
```

send 方法内部流程（伪代码）：
```typescript
async *send(message: string, rawMode: boolean) {
  // 0. 创建 AbortController（可被 session.abort() 中断）
  this._ac = new AbortController();

  // 1. 处理 reinject
  let isFirstTurn = this.state.parentMessageId === null;
  if (reinjectMode === 'new') { this.state.parentMessageId = null; isFirstTurn = true; }
  else if (reinjectMode === 'keep') { isFirstTurn = true; }
  this.reinjectMode = null;

  // 1. 构建 prompt
  const prompt = promptBuilder.build(systemPrompt, toolsPrompt, message, isFirstTurn, toolMd);

  // 2. 惰性创建 sessionId
  if (!isRealSessionId(this.state.id)) {
    this.state.id = await client.createChatSession();
    store.setCurrentId(this.state.id);
  }

  // 3. 工具调用循环（最大 10 次）
  let currentPrompt = prompt;
  let currentParentId = this.state.parentMessageId;
  let depth = 0;
  const MAX_TOOL_CALLS = 10;

  while (depth <= MAX_TOOL_CALLS) {
    const stream = await client.chat(this.state.id, currentParentId,
      currentPrompt, this.state.thinkEnabled, this._ac.signal);

    let foundToolCall = false;
    const parser = new StreamParser();
    for await (const event of parser.parse(stream)) {
      switch (event.type) {
        case 'message_id':
          this.state.parentMessageId = event.id;
          currentParentId = event.id;
          break;
        case 'title':
          this.state.title = event.title;
          break;
        case 'tool_call_end':
          foundToolCall = true;
          yield event;
          const result = await toolExecutor.execute(event.name, event.arguments);
          currentPrompt = `<tool_response name="${event.name}">\n${result}\n</tool_response>`;
          break;  // 跳出当前流
        default:
          yield event;
      }
    }
    if (!foundToolCall) break;
    depth++;
  }

  if (depth > MAX_TOOL_CALLS) {
    yield { type: 'error', message: '工具调用超过最大次数限制' };
  }

  // 4. 保存
  this.state.updatedAt = Date.now();
  this.save();
}
```

---

## 七、代码组织（单文件结构，严格按此顺序）

| 段落 | 内容 | 预估行数 |
|------|------|----------|
| 1 | Shebang & 导入声明 | 5 |
| 2 | 类型定义 (Credentials, SessionState, MessageRecord, ToolDefinition, ParseEvent) | 30 |
| 3 | 常量 (CRED_FILE, WASM_B64, JUNK_TOKENS) | ~110 |
| 4 | 工具函数 (getHeaders, extractChallenge, formatTime, readFileIfExists, isRealSessionId) | 30 |
| 5 | class PowSolver | 40 |
| 6 | class DeepSeekClient | 80 |
| 7 | class StreamParser | 150 |
| 8 | class SessionStore | 80 |
| 9 | class ToolRegistry + class ToolExecutor | 60 |
| 10 | registerBuiltinTools() | 40 |
| 11 | class PromptBuilder | 30 |
| 12 | class ChatSession | 200 |
| 13 | scanDeepseekDir() 环境发现 | 30 |
| 14 | loginDeepseek() + 凭证管理函数 | 200 |
| 15 | handleCommand() 命令分发 | 250 |
| 16 | displayEvent(), getPrompt(), printHelp() | 60 |
| 17 | startRepl() REPL 循环 | 150 |
| 18 | main() 入口 | 20 |
| 19 | main() 调用 | 2 |
| **总计** | | **~1400** |

---

## 八、分阶段实施路线图

### 阶段 1：基础骨架与无状态通信（目标：能发一条消息）

| 步骤 | 内容 | 验证 |
|------|------|------|
| 1.1 | 创建 chat.ts，搭建所有类和函数的空骨架 | 编译通过 |
| 1.2 | 实现 PowSolver（从 client.ts 拷贝） | 编译通过 |
| 1.3 | 实现 DeepSeekClient（无状态，chat 返回原始流） | 硬编码发消息，收到流 |
| 1.4 | 实现 StreamParser（从 deepseek-web-stream.ts 提取状态机） | 解析流输出 text_delta |

### 阶段 2：应用层 - 会话与提示词（目标：多轮对话）

| 步骤 | 内容 | 验证 |
|------|------|------|
| 2.1 | 实现 SessionStore（save/load/list/delete，含 formatTime） | 读写文件 |
| 2.2 | 实现 scanDeepseekDir 和 PromptBuilder | 扫描目录写入内容 |
| 2.3 | 实现 ChatSession v1（无工具循环）| 发送两条消息验证上下文接续 |
| 2.4 | 编写简化 REPL | 连续对话 |

### 阶段 3：工具系统（目标：AI 能执行工具）

| 步骤 | 内容 | 验证 |
|------|------|------|
| 3.1 | 实现 ToolRegistry 和 ToolExecutor，注册 5 个内置工具 | 列出工具 |
| 3.2 | 升级 ChatSession.send，加入工具调用循环 | 发消息触发工具执行 |

### 阶段 4：交互层与完整 REPL（目标：完整产品）

| 步骤 | 内容 | 验证 |
|------|------|------|
| 4.1 | 内联 loginDeepseek，实现 ensureCredentials | 删除凭证，自动登录 |
| 4.2 | 实现 handleCommand（所有命令）和 startRepl 循环 | 命令可用 |
| 4.3 | 实现 Shell 透传、目录切换检测 | `!cd ../dir` 触发环境发现 |
| 4.4 | 实现 displayEvent 彩色输出、/help、错误处理 | 思考蓝色显示 |
| 4.5 | 完善 /history、/fork、边界条件处理 | 对照验收标准 |

---

## 九、验收标准

| # | 验收项 | 验证方法 |
|---|--------|----------|
| 1 | `./chat.ts` 启动后进入 REPL，可连续对话 | 启动，输入消息，观察回复 |
| 2 | 凭证缺失时自动触发登录 | 删除 credentials.json，启动 |
| 3 | 凭证过期 (401) 提示并自动登录，不崩溃 | 模拟 401 |
| 4 | `/think on` 后思考内容蓝色显示，提示符含 🧠 | 发送需思考的问题 |
| 5 | 设置系统提示词后，首轮回答受约束 | 创建 system.md，验证回答风格 |
| 6 | AI 请求工具 → 自动执行 → 结果返回最终回复 | 触发读文件或执行命令 |
| 7 | 写操作需用户 y/n 确认 | 触发写文件，观察确认提示 |
| 8 | `/new`、`/ls`、`/load`、`/del` 全流程工作 | 增删查切换 |
| 9 | 退出后重启恢复上次会话 | `/q` 退出，重新启动验证上下文 |
| 10 | `/fork` 分叉后两个会话独立 | fork 后分别在两个会话发消息 |
| 11 | `!cd` 切换目录后重新发现提示词并恢复会话 | 准备两个目录，执行 `!cd ../other` |
| 12 | `/reauth` 覆盖刷新凭证 | 执行后检查 credentials.json |
| 13 | `/raw` 输出原始 SSE 流 | 开启后发送消息，观察格式 |
| 14 | `/history` 参数组合正确 | 测试 `-r`、`-a`、`-id`、on/off |
| 15 | `/auth` 查看状态，`-s` 验证有效性 | 执行命令检查输出 |
| 16 | REPL 内 401 不退出，自动重新登录 | 运行时让 token 失效，发消息 |
| 17 | `/q` 退出需确认 | 输入 `/q`，观察确认提示 |

---

## 十、扩展预留

- **新模型接入**：抽象 BaseAIClient 接口（chat, createSession），DeepSeekClient 为实现之一
- **用户自定义工具**：扫描 `~/.config/ds-chat/tools/` 动态加载
- **数据库持久化**：实现 SessionStore 接口的 SQLite 版本
- **多用户支持**：ChatSession 关联 userId

---

---

## 十一、已确认的实现决策（2026-05-11 逐项核对）

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 惰性会话 ID 判断 | 初始 id 为空字符串 `""`，`send()` 时判空则调用 `createChatSession()` |
| 2 | 旧版会话文件兼容 | **不兼容**。全新格式，`SessionState` 直接用 `parentMessageId`，`SessionStore.load()` 不处理旧字段 |
| 3 | 提示词文件复制 | 原样复制，`readFileSync` + `writeFileSync`，不做任何预处理 |
| 4 | `/del` 交互式删除 | B 方案：子模式标志 `deleteSubMode`，后续 line 事件路由到删除处理 |
| 5 | `/fork` 新房间历史 | A 方案：将分叉点之前全部对话历史文本注入新房间首轮 prompt |
| 6 | 目录切换时 `.deepseek/` 初始化 | A 方案：自动 `mkdir -p .deepseek/sessions/` |
| 7 | AI 回复文本累积与存储 | A 方案：`ChatSession.send()` 内部累积 `text_delta`，流结束自动存入 `messages[]` |
| 8 | SessionStore.save 并发策略 | 直接覆盖写入（单进程 REPL，无并发场景） |
| 9 | SessionStore.load 损坏文件 | 打印 `⚠️` 警告并返回 null；文件不存在则静默返回 null |
| 10 | 删除活跃会话后 _current | 清空 `_current`，回退到无会话状态 |
| 11 | `/fork` 历史注入拼装格式 | 纯对话文本 `User: xxx\nAssistant: yyy\n...`，和正常首轮格式一致 |
| 12 | ChatSession.create 工厂 | 传入 client, store, builder, executor，startRepl 里创建一次后共享 |
| 13 | 401 自动重登流程 | send() 返回 error 事件给 REPL；REPL 层调用 ensureCredentials()→重新 new DeepSeekClient→重试 send() |
| 14 | handleCommand 返回值 | 返回 `ChatSession | null`，startRepl 用返回值更新当前 session 变量 |
| 15 | reinject 实现 | handleCommand 调用 `session.setReinjectMode('new'|'keep')`；send() 开头检查标志→执行注入→清除 |
| 16 | quit 清理步骤 | save → setCurrentId → process.exit(0) |
| 17 | 401 重登后 client 替换 | `ChatSession.setClient(creds)` 内部 `new DeepSeekClient(creds)` 替换 |
| 18 | displayEvent 颜色 | text_delta 白色；thinking_delta `\x1b[36m` 青色；tool_call_end 黄色；error 红色 |
| 19 | displayEvent 职责 | 纯输出函数，不返回数据（ChatSession 已内部累积并存 messages[]） |
| 20 | /raw 模式行为 | 打印原始 SSE 行文本（`data: {...}`），不做解析和颜色处理 |
| 21 | SIGINT 处理 | 优雅退出：保存当前会话 → setCurrentId → process.exit |
| 22 | startRepl 初始化顺序 | 凭证就绪 → 建所有依赖 → scan 环境发现 → 恢复/创建会话 → 注入提示词 → 打印状态 → REPL |
| 23 | /fork 无历史消息 | 打印 `⚠️` 警告并拒绝，不创建空会话 |
| 24 | /del `<id>` 直接删除 | 仍需 y/n 确认，防止误删 |
| 25 | /system -f 源不存在 | 打印 `❌` 错误，不修改任何文件 |
| 26 | /reinject 重复调用 | 提示 `⚠️` 已有待注入提示词（模式：xxx），确认覆盖？(y/n) |
| 27 | /del --all | 进入删除子模式，显示列表，输入 "all" 后二次确认 `⚠️` |
| 28 | 未知命令提示 | 显示 `❌ 未知命令: /foo，输入 /? 查看帮助` + 列出所有可用命令 |
| 29 | /load 无参数 | 打印 `❌ 用法: /load <sessionId>` |
| 30 | /system -c 无文件 | 打印 `ℹ️ 局部提示词不存在，无需清除` |
| 31 | ChatSession.send 异常 | 全部 yield `{ type: 'error' }` 事件，永不 throw |
| 32 | ToolExecutor 确认阻塞 | `rl.pause()` → raw stdin 读一行 → 确认 → `rl.resume()`，解决 readline 嵌套冲突 |
| 33 | SessionStore 自动创目录 | save()/list()/delete() 前自动 `mkdir -p .deepseek/sessions/` |
| 34 | credentials.json 损坏 | 打印 `❌ 凭证文件损坏`，视为无凭证，触发自动登录 |
| 35 | 工具循环中 parentMessageId | 跟随更新：每次 chat() 返回的 message_id 即时更新，递归时用最新值 |
| 36 | tool_response 引导语 | 英文 `Please proceed based on this tool result.` |
| 37 | SessionStore.list 损坏文件 | 跳过损坏文件 + 打印 `⚠️ 跳过损坏文件: xxx.json` |
| 38 | send() 并发控制 | 排队等待：用 `isSending` 标志，新消息排队，提示 `⏳ AI 回复中，消息已排队` |
| 39 | 用户消息存入 messages 时机 | send() 开始时立即 push（防止失败丢失），AI 回复流结束后 push |
| 40 | /raw 模式下非文本事件 | 混合显示：tool_call_end 显示 `🔧`，message_id/title 显示标签，error 显示 `❌` |
| 41 | /load 切换时 abort 进行中流 | 先 abort 再 save 再 switch。send() 接受 AbortSignal 透传给 client.chat() |
| 42 | /reinject -new 时 messages[] | 保持历史不删除，只重置 parentMessageId。可插入一条 system 消息标记重新注入点 |
| 43 | send() 消息队列 | 数组队列 `queue: string[]`，push 排队 + shift 消费 |
| 44 | JUNK_TOKENS | 从 deepseek-web-stream.ts 拷贝现有已验证列表 |
| 45 | 流→行转换 | StreamParser 提供 `async *parse(stream): AsyncGenerator<ParseEvent>`，内部完成字节读取+行分割+feedLine+flush |
| 46 | 空输入行 | 忽略，重新显示提示符 |
| 47 | 工具执行失败 | 返回错误文本给 AI（如 "Error: file not found: /path"），不中止循环 |
| 48 | /system 显示内容 | 重新从磁盘读取 system.md/系统-all.md（实时），非 session 快照 |
| 49 | createChatSession 失败 | yield `{ type: 'error', message: '创建会话失败: ...' }`，send() 结束 |
| 50 | /system -c/-f 后快照 | 自动重新 scanDeepseekDir() 更新 session.systemPrompt |
| 51 | 局部清除后全局回退 | /system -c 删除 system.md 后，若 system-all.md 存在，自动回退到全局 |
| 52 | StreamParser 生命周期 | 每次 send() 内部 `new StreamParser()`，不注入到 ChatSession 构造函数 |
| 53 | handleCommand 上下文 | ctx 对象：`{ client, store, promptBuilder, toolRegistry, creds, workDir, rl }` |
| 54 | 目录切换实现 | execShell 返回标志 → REPL 调 `switchWorkspace()`（初始化复用同一函数） |
| 55 | loginDeepseek 内联 | 完整内联 226 行（含 openInChrome），chat.ts 可脱离 deepseek-web/ 其他文件独立运行 |
| 56 | `/load` 无参数 | 交互式：显示编号列表，输序号切换，输 `q` 退出 |
| 57 | `/cd <path>` | 专属命令，直接 `process.chdir()`，自动触发环境发现 |
| 58 | 搜索默认值 | `searchEnabled` 默认 `true`（匹配参考项目） |
| 59 | `/tool on/off` | 显式控制工具提示词注入，和搜索独立 |
| 60 | 房间恢复确认 | `roomRecoveryMsg` 标志 + y/n 确认子模式（不自动重建） |

---

## 附录 A：内置工具定义

```json
[
  { "name": "read",  "description": "Read file content from a given path.",           "parameters": { "path":    { "type": "string", "description": "File path" } } },
  { "name": "write", "description": "Write content to a file.",                       "parameters": { "path":    { "type": "string", "description": "File path" }, "content": { "type": "string", "description": "Content to write" } } },
  { "name": "exec",  "description": "Execute a system command and return the output.", "parameters": { "command": { "type": "string", "description": "Command to run" } } }
]
```
> 注：`web_search` 和 `web_fetch` 已移除。DeepSeek 网页版自带 `search_enabled` 参数处理联网搜索，不需要客户端工具。通过 `/search on/off` 切换。

## 附录 B：提示词文件体系

| 文件 | 作用域 | 优先级 | 自动注入 |
|------|--------|--------|----------|
| `.deepseek/system.md` | 局部 | 最高（覆盖全局） | 是 |
| `.deepseek/system-all.md` | 全局 | 低 | 是（局部不存在时） |
| `.deepseek/tool.md` | 局部 | 补充 | 是 |
| `.deepseek/skill.md` | 局部 | 预留 | 否 |

## 附录 C：现有资产复用清单

| 现有代码 | 在新 chat.ts 中的角色 | 修改程度 |
|----------|----------------------|----------|
| DeepSeekWebClient | 完全复用，模板提取为 DeepSeekClient + PowSolver | 重构封装 |
| parseLine() | 融入 StreamParser | 重构嵌入 |
| solveSha256() / solveDeepSeekHash() | 封装为 PowSolver | 不修改 |
| loginDeepseek() | 内联到 chat.ts | 不修改 |
| getHeaders() / extractChallenge() | 内联为工具函数 | 内联 |
| loadSessionState() / saveSessionState() | 重构为 SessionStore | 重构 |
| WASM_B64 常量 | 不变 | 不修改 |
| server.ts / client.ts / auth.ts / types.ts / constants.ts | 不动 | 不修改 |

---

文档结束。此蓝图融合了 plan.md 的分层架构、plan2 的交互细节、plan3 的单文件决策、plan4 的入口简化、plan5 的完整代码骨架、plan6 的方案对比分析、plan7 的阶段路线、plan8 的完整命令行为定义、plan9 的像素级施工指导。开发者拿到此文档可直接开始编码。

---

## 十二、代码审查修复记录（2026-05-12）

| 级别 | 修复 | 说明 |
|------|------|------|
| **CRITICAL** | `tool_call_end` 属性键 | `parsedArgs` → `arguments`，工具调用参数不再丢失 |
| HIGH | StreamParser reader 释放 | `parse()` 加 `finally { reader.releaseLock() }` |
| HIGH | rawMode reader 释放 | 加 try/finally 释放 + AbortError 处理 |
| HIGH | `currentEventType` 字段 | 类体中显式声明 |
| HIGH | `/q` 退出挂起 | `rl.close()` 后加 `process.exit(0)` |

## 附录 D：当前实现概要

| 属性 | 值 |
|------|-----|
| 文件 | `deepseek-web/chat.ts` |
| 行数 | ~2212 |
| 工具数 | 3（read/write/exec） |
| 命令数 | 22（/new /load /ls /del /p /f /s /history /sys /rj /t /think /search /raw /tool /auth /reauth /cd /?,/h /q /clear /pwd + !<cmd>） |
| 提示词层级 | 3（局部 > 全局 > 无） |
| 搜索 | 默认开，`/search on/off` |
| 工具模式 | 默认关，`/tool on/off` 注入 `<tool_call>` XML 格式 |
| 原始模式 | `/raw` 开关，直接 `process.stdout.write` 原始 SSE |
| 目录切换 | `/cd <path>` 专属命令，自动环境发现 |
| `/load` | 交互式（无参数时显示编号列表） |
| 房间恢复 | 检测空响应 → y/n 确认 → 含历史首轮注入 |
