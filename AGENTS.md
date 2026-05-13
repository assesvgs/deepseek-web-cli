# AGENTS.md — deepseek-web-cli

## 项目定位

基于 DeepSeek 网页版私有 API 的交互式命令行聊天 REPL。无需 API Key，零 Token 消耗。

## 架构概要

- **核心文件**：`deepseek-web/chat.ts`（~2200 行单文件），所有功能内聚于此，可脱离其他文件独立运行
- **入口**：`./deepseek-web/chat.ts`，shebang `#!/usr/bin/env -S npx tsx`
- **只有 `deepseek-web/` 目录的代码是活跃的**，根目录的 `deepseek-web.ts` 只是 barrel 重导出（`export { default } from "./deepseek-web/index"`）
- `openclaw-zero-token/` 是参考项目，已加入 `.gitignore`，不参与本项目代码

## 运行方式

```bash
cd deepseek-web

# 前置依赖
npm install -g tsx
npm install         # 安装 playwright-core（仅登录时需要）
npx tsx login.ts    # 获取凭证（需 Chrome 监听 9222 端口）

# 启动 REPL
./chat.ts
```

**登录前置条件**：
- 桌面端：Chrome 以 `--remote-debugging-port=9222` 启动
- Android Termux：`pkg install android-tools` + `adb forward tcp:9222 localabstract:chrome_devtools_remote`
- `playwright-core` 仅登录时使用，登录后 Chrome 可关闭

**凭证**：`deepseek-web/credentials.json`（`cookie` + `bearer` + `userAgent`，已 gitignore）

## 文件状态

| 文件 | 状态 |
|------|------|
| `deepseek-web/chat.ts` | **活跃**，核心 REPL |
| `deepseek-web/login.ts` | **活跃**，独立登录脚本 |
| `deepseek-web/auth.ts` | **活跃**，CDP 登录逻辑（被 login.ts 和 chat.ts 内联引用） |
| `deepseek-web/constants.ts` | 凭证读写工具函数 |
| `deepseek-web/types.ts` | Credentials 类型定义 |
| `deepseek-web/wasm-embedded.ts` | PoW WASM base64 常量（chat.ts 已内联，此文件保留作参考） |
| `deepseek-web/server.ts` | **已暂停**，OpenCode 代理服务器 |
| `deepseek-web/client.ts` | **已暂停**，旧版 API 客户端 |
| `deepseek-web/index.ts` | **已暂停**，OpenCode 插件入口 |

**只有 chat.ts 和 login.ts 是活跃开发文件，其余插件相关文件不要修改。**

## 无构建/测试/检查流程

- 无 `npm run build/test/lint/typecheck`
- 直接用 `tsx` 执行 TypeScript，无编译步骤
- 修改后直接 `./chat.ts` 运行验证

## 平台适配

- `chat.ts` 中 `IS_ANDROID = process.platform === "android"`，Android 下自动切换 URL 为 `http://127.0.0.1:9222`
- `login.ts` 会将 `process.platform` 伪装为 `"linux"` 以加载 playwright-core（Android 原生不支持）
- `auth.ts` 中 `openInChrome()` 仅在 Android 下通过 `am start` 自动打开 Chrome

## 核心概念

### 提示词三层体系
工作目录下的 `.deepseek/` 目录（已 gitignore）：
```
.deepeesk/
├── system.md          # 局部提示词（优先级最高）
├── system-all.md      # 全局提示词（局部不存在时生效）
├── tool.md            # 工具补充提示词
└── sessions/          # 会话持久化目录
    ├── _current       # 当前活跃会话 ID
    └── <id>.json      # 会话存档
```

### 工作目录感知
- 启动时 `process.cwd()` 为工作目录
- `/cd <path>` 或 `!cd <path>` 切换目录后自动重新发现 `.deepseek/` 并恢复对应会话
- 不同目录可有独立的提示词和会话

### 惰性会话创建
- `/new` 创建会话时 `id` 为空字符串占位
- 首次 `send()` 发送消息时才调用 `client.createChatSession()` 获取真实 ID

### PoW 反爬
- 内嵌 WASM base64 常量 `SHA3_WASM_B64`
- `PowSolver` 类根据 `algorithm` 字段自动派发：`sha256` 纯 JS，`DeepSeekHashV1` 用 WASM

## 代码风格

- 2 空格缩进
- 单文件内按段落组织：导入 → 类型 → 常量 → 工具函数 → 领域层 → 应用层 → 交互层 → main
- 命令行交互用 `node:readline`，不引入第三方 REPL 库
- 工具确认阻塞：`rl.pause()` → raw stdin 读一行 → 确认 → `rl.resume()`
