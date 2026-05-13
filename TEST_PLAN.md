# chat.ts 完整测试方案

## 测试架构

```
测试分为两层：

第1层：单元测试（可自动化，用 Node 原生 test runner）
  └── 测试纯函数：hash、标注、ref解析、编辑、清洗、工具执行、会话持久化

第2层：手动验收（需要 Chrome + DeepSeek 登录态）
  └── 测试 REPL 交互：命令系统、提示词发现、目录切换、多会话管理

第1层在 CI 里跑，第2层在本地跑。
```

---

## 第1层：单元测试（自动化）

### 测试文件：`chat/test/test.mjs`

使用 Node.js 原生 `node:test` + `node:assert/strict`。

### 1.1 Hashline 哈希函数

| # | 测试项 | 输入 | 期望输出 |
|---|--------|------|---------|
| 1 | hlHash 长度 | `hlHash("hello", 3)` | 3 字符大写十六进制 |
| 2 | hlHash 幂等性 | `hlHash("hello", 3)` 两次调用 | 结果相同 |
| 3 | hlHash 不同输入不同输出 | `"hello"` vs `"world"` | 结果不同 |
| 4 | lineHash 正确 | `lineHash("const x = 1", 3)` | 3 字符，与 hlHash 一致 |
| 5 | anchorHash 邻行参与 | `anchorHash("a", "b", "c", 3)` vs `anchorHash("x", "b", "y", 3)` | 结果不同（邻行变了） |
| 6 | anchorHash 幂等 | 相同参数两次 | 结果相同 |
| 7 | getHashLength ≤4096 | `getHashLength(100)` | 3 |
| 8 | getHashLength 4096 边界 | `getHashLength(4096)` | 3 |
| 9 | getHashLength >4096 | `getHashLength(4097)` | 4 |
| 10 | fileRev 新行一致性 | `fileRev("a\nb\n")` / `fileRev("a\r\nb\r\n")` | 结果相同 |
| 11 | fileRev 不同内容 | `"a\n"` vs `"b\n"` | 结果不同 |
| 12 | fileRev 8 字符 | 任意输入 | 8 字符大写十六进制 |

### 1.2 标注输出

| # | 测试项 | 期望 |
|---|--------|------|
| 13 | annotateReadOutput 基本结构 | 包含 `<hashline-file path="..."` 开头和 `</hashline-file>` 结尾 |
| 14 | annotateReadOutput 包含 REV 行 | 包含 `#HL REV:` 后跟 8 字符 |
| 15 | annotateReadOutput 每行有标注 | 第 i 行包含 `#HL i+#hash+#anchor|内容` |
| 16 | annotateReadOutput 3 行文件 | `total_lines="3"`，3 行标注 |
| 17 | annotateReadOutput 空文件 | `total_lines="0"`，无标注行，有 `# file is empty` |
| 18 | annotateReadOutput CRLF 兼容 | `"a\r\nb\r\n"` 正确标注，行哈希与 LF 版一致 |
| 19 | annotateReadOutput 存入 fileRevCache | 缓存中存在该路径的 rev |

### 1.3 Ref 解析

| # | 测试项 | 期望 |
|---|--------|------|
| 20 | parseLineRef 标准格式 | `"#HL 3#A3F#9BC"` → `{ lineNum: 3, hash: "A3F", anchor: "9BC" }` |
| 21 | parseLineRef 无 anchor | `"#HL 5#B12"` → `{ lineNum: 5, hash: "B12", anchor: undefined }` |
| 22 | parseLineRef 带 `;;;` 前缀 | `";;; 1#CCC"` → 正确解析 |
| 23 | parseLineRef 带 `|内容` | `"#HL 2#D34#E56|const x"` → 正确解析（忽略 `|` 后内容） |
| 24 | parseLineRef 非法格式抛异常 | `"#HL abc"` → throw |
| 25 | parseLineRef 空字符串抛异常 | `""` → throw |

### 1.4 Ref 定位

| # | 测试项 | 期望 |
|---|--------|------|
| 26 | resolveLineRef 哈希匹配 | ref 指向已有行 → 返回正确索引 |
| 27 | resolveLineRef 行号正确 | ref `#HL 2#xxx#yyy` → 返回 index 1 |
| 28 | resolveLineRef 哈希不匹配抛异常 | 改了一行内容后 ref 的 hash 对不上 → throw |
| 29 | resolveLineRef 行号超出抛异常 | ref 指向第 999 行但文件只有 5 行 → throw |

### 1.5 safeReapply

| # | 测试项 | 期望 |
|---|--------|------|
| 30 | safeReapply 单候选 | 文件中间插入一行，原行的 hash+anchor 仍匹配 → 自动定位到新行号 |
| 31 | safeReapply 多候选 | 两行内容相同且 hash 相同 → throw 列出候选行号 |
| 32 | safeReapply 零候选 | 行内容完全改变 → throw |
| 33 | safeReapply 关闭 | `safeReapply=false`，哈希不匹配 → 直接 throw |

### 1.6 编辑操作

| # | 测试项 | 期望 |
|---|--------|------|
| 34 | replace 单行 | `{op:"replace", startRef:"#HL 2#xxx#yyy", content:"new"}` → 第2行被替换 |
| 35 | replace 范围 | startRef 第2行 + endRef 第4行 → 第2-4行被替换 |
| 36 | delete 单行 | `{op:"delete", startRef:"#HL 3#xxx#yyy"}` → 第3行删除 |
| 37 | delete 范围 | startRef 第2行 + endRef 第5行 → 第2-5行删除 |
| 38 | insert_before | `{op:"insert_before", startRef:"#HL 1#xxx#yyy", content:"new"}` → 第1行前插入 |
| 39 | insert_after | `{op:"insert_after", startRef:"#HL 2#xxx#yyy", content:"new"}` → 第2行后插入 |
| 40 | replace_range | `{op:"replace_range", startRef, endRef, content}` → 范围替换 |
| 41 | set_file | `{op:"set_file", content:"全量内容"}` → 文件整体覆盖 |
| 42 | set_file 不能混用 | set_file + 其他操作 → throw |

### 1.7 批量操作与冲突检测

| # | 测试项 | 期望 |
|---|--------|------|
| 43 | 批量 3 个操作 | 3 个 replace/insert 同时执行 → 全部生效 |
| 44 | 批量从后往前应用（无索引漂移） | 先改第 5 行再改第 2 行 → 两次都命中 |
| 45 | 重叠删除检测 | 两个操作删除了同一行 → throw "Overlapping" |
| 46 | 重叠替换检测 | 两个操作替换了同一行 → throw "Overlapping" |
| 47 | 操作数冲突 | `insert_before` 引用了被另一个操作删除的行 → throw |
| 48 | 空操作列表 | `resolveChanges([], ...)` → throw |

### 1.8 fileRev 校验

| # | 测试项 | 期望 |
|---|--------|------|
| 49 | fileRev 匹配 | 传正确的 fileRev → 编辑成功 |
| 50 | fileRev 不匹配 | 传过期的 fileRev → throw "File revision mismatch" |
| 51 | fileRev 不传 | 不传 rev → 跳过校验，编辑成功 |
| 52 | fileRev 大小写 | `rev: "abcd1234"` vs 实际 `"ABCD1234"` → 匹配（toUpperCase） |

### 1.9 标注清洗

| # | 测试项 | 期望 |
|---|--------|------|
| 53 | stripHashlineAnnotations 基本 | `"#HL 1#A3F#9BC|hello"` → `"hello"` |
| 54 | stripHashlineAnnotations REV 行 | `"#HL REV:ABCD1234"` → 删除 |
| 55 | stripHashlineAnnotations wrapper | `<hashline-file ...>` 和 `</hashline-file>` → 删除 |
| 56 | stripHashlineAnnotations 注释行 | `"# format: ..."` `"# use refs..."` → 删除 |
| 57 | stripHashlineAnnotations 混合内容 | 完整 read 输出 → 恢复原始文件内容 |
| 58 | stripHashlineAnnotations 无标注内容 | `"hello\nworld"` → `"hello\nworld"` 不变 |
| 59 | stripHashlineAnnotations 空字符串 | `""` → `""` |

### 1.10 文件操作工具

| # | 测试项 | 期望 |
|---|--------|------|
| 60 | read 工具返回标注 | `read /tmp/test.txt` → 返回 `<hashline-file>` 包裹的标注内容 |
| 61 | write 工具清洗内容 | 写入选包含 `#HL` 标注的内容 → 文件里无 `#HL` 前缀 |
| 62 | write 工具清缓存 | write 后 fileRevCache 中该路径已删除 |
| 63 | edit 工具基本编辑 | 读文件 → 用 ref edit → 文件正确修改 |
| 64 | edit 工具批量编辑 | 3 个操作一次完成 → 文件正确修改 |
| 65 | edit 工具 fileRev 校验 | 改外部修改文件后 edit 带旧 rev → throw |
| 66 | edit 工具清缓存 | edit 后 fileRevCache 中该路径已删除 |
| 67 | exec 工具执行 | `exec echo hello` → 返回 `"hello\n"` |
| 68 | exec 工具超时 | 睡眠 60 秒 → throw (timeout 30s) |

### 1.11 会话持久化

| # | 测试项 | 期望 |
|---|--------|------|
| 69 | SessionStore.save 创建文件 | save 一个 session → `.json` 文件存在 |
| 70 | SessionStore.save 更新 updatedAt | save 两次 → updatedAt 不同 |
| 71 | SessionStore.load 正常加载 | load 已保存的 id → 得到相同 SessionState |
| 72 | SessionStore.load 不存在 | load 不存在的 id → null |
| 73 | SessionStore.load 损坏文件 | JSON 损坏 → console.warn + null |
| 74 | SessionStore.delete 删除 | delete 后 load → null |
| 75 | SessionStore.delete 清 current | 删除的是活跃会话 → _current 清空 |
| 76 | SessionStore.list 排序 | 按 updatedAt 降序 |
| 77 | SessionStore.list 空目录 | 无会话 → 返回 [] |
| 78 | SessionStore.list 过滤 _current | 结果不含 _current 文件 |
| 79 | SessionStore.list 跳过损坏 | 目录中有损坏 JSON → warn + 跳过 |
| 80 | SessionStore.getCurrentId 正常 | _current 有内容 → 返回 id |
| 81 | SessionStore.getCurrentId 不存在 | _current 不存在 → null |
| 82 | SessionStore.setCurrentId | setCurrentId("abc") → getCurrentId() → "abc" |

### 1.12 环境发现

| # | 测试项 | 期望 |
|---|--------|------|
| 83 | scanDeepseekDir 局部提示词优先 | system.md 和 system-all.md 都存在 → 返回 system.md 内容，source="local" |
| 84 | scanDeepseekDir 回退全局 | 只有 system-all.md → 返回其内容，source="global" |
| 85 | scanDeepseekDir 无提示词 | 两个都不存在 → systemPrompt=""，source="none" |
| 86 | scanDeepseekDir 读取 tool.md | tool.md 存在 → toolMdContent 有值 |
| 87 | scanDeepseekDir 读取 skill.md | skill.md 存在 → skillMdContent 有值 |
| 88 | scanDeepseekDir 空目录 | 无 .deepseek/ 目录 → 所有内容为空 |

### 1.13 边界情况

| # | 测试项 | 期望 |
|---|--------|------|
| 89 | 空文件 read 标注 | `annotateReadOutput("", "/f")` → total_lines=0, 有 "file is empty" |
| 90 | 单行文件 | 正确标注，anchorHash 只用上下邻行中的一个 |
| 91 | 超大文件行数 | 5000 行文件 → getHashLength 返回 4 |
| 92 | CRLF 文件编辑 | CRLF 文件 → edit → 保持 CRLF 行尾 |
| 93 | LF 文件编辑 | LF 文件 → edit → 保持 LF 行尾 |
| 94 | 换行符结尾文件 vs 无换行符结尾 | 两种文件 edit 后保持各自格式 |
| 95 | ref 带 diff 前缀 | `"+#HL 3#A3F#9BC"` 或 `"-#HL 3#A3F#9BC"` → 正确解析（strip） |
| 96 | content 中的 `#HL` 前缀被清洗 | edit 操作的 content 字段含标注 → 自动清洗 |
| 97 | fileRevCache 不泄漏 | 1000 次 read/edit 后内存不无限增长（有 delete） |

---

## 第2层：手动验收（需要运行 chat.ts）

### 测试环境准备

```
mkdir -p /tmp/chat-test
cd /tmp/chat-test

# 创建两个项目目录
mkdir -p project-a/.deepseek/sessions
mkdir -p project-b/.deepseek/sessions

# 在 project-a 下创建测试文件
echo -e "line one\nline two\nline three" > project-a/test.txt

# 创建提示词文件
echo "你是一个项目A的助手" > project-a/.deepseek/system.md
echo "你是一个全局助手" > project-a/.deepseek/system-all.md
echo "## edit 示例\n..." > project-a/.deepseek/tool.md

# project-b 只有全局提示词
echo "你是项目B的助手" > project-b/.deepseek/system-all.md
```

### 2.1 提示词体系

| # | 操作 | 验证点 |
|---|------|--------|
| M1 | `cd project-a && ../../chat/chat.ts` | 启动后显示 "系统提示词（局部）✅" |
| M2 | 输入 `/sys` | 显示 system.md 内容（截断提示） |
| M3 | 发送消息 | 首轮 prompt 包含 system.md 内容 |
| M4 | 输入 `/sys -c` | 清除局部提示词，回退到 system-all.md |
| M5 | 再次输入 `/sys` | 显示 "全局" 提示词 |
| M6 | 输入 `/sys -c` 再 `/sys -c` | 显示 "ℹ️ 局部提示词不存在，无需清除" |
| M7 | 输入 `/sys -f /path/to/file -l` | 加载为局部提示词 |
| M8 | 输入 `/sys -f /path/to/file` | 加载为全局提示词 |
| M9 | `echo "tool内容" > .deepseek/tool.md` 后输入 `/sys` | 显示 tool.md 状态 |
| M10 | 输入 `/rj -new` | 显示 "下次消息将重新注入提示词（模式：-new）" |
| M11 | 输入 `/rj -keep` | 显示 "下次消息将重新注入提示词（模式：-keep）" |
| M12 | 连续两次 `/rj -new` | 第二次显示 "⚠️ 已有待注入提示词，确认覆盖？(y/n)" |

### 2.2 目录切换

| # | 操作 | 验证点 |
|---|------|--------|
| M13 | 在 project-a 启动 | 工作目录显示 project-a |
| M14 | 输入 `/cd ../project-b` | 提示词切换为 project-b 的全局提示词 |
| M15 | 输入 `/cd ../project-a` | 恢复 project-a 的局部提示词和会话 |
| M16 | 输入 `!cd ../project-b` | Shell 透传切换，同样触发环境发现 |
| M17 | 输入 `/pwd` | 显示当前工作目录 |
| M18 | 切换到无 .deepseek 的目录 | 自动创建 .deepseek/sessions/，提示词为"无" |

### 2.3 会话管理

| # | 操作 | 验证点 |
|---|------|--------|
| M19 | `/new` | 创建新会话，提示 "✅ 已创建新会话" |
| M20 | `/new 测试标题` | 创建带标题的会话 |
| M21 | `/ls` | 列出所有会话（ID、标题、轮数、时间） |
| M22 | `/save` 或 `/s` | 手动保存，显示会话路径 |
| M23 | `/load`（无参） | 交互式选择列表 |
| M24 | `/load` → 输入序号 | 切换到对应会话 |
| M25 | `/load` → 输入 `q` | 退出交互模式 |
| M26 | `/load <id>` | 直接切换 |
| M27 | `/load <不存在的id>` | 显示 "❌ 未找到" + 列出可用会话 |
| M28 | `/del`（无参） | 进入删除子模式 |
| M29 | 删除子模式 → 输入序号 | 删除对应会话 |
| M30 | 删除子模式 → 输入 `all` | 二次确认后全删 |
| M31 | 删除子模式 → 输入 `q` | 退出 |
| M32 | `/del <id>` | 直接删除确认 |
| M33 | `/del --all` | 进入删除子模式显示全部 |
| M34 | 删除当前活跃会话后发消息 | 自动创建新会话 |
| M35 | `/q` → `y` | 退出，保存会话 |
| M36 | `/q` → `n` | 取消退出 |
| M37 | 重新启动 | 自动恢复上次会话 |

### 2.4 Fork 分叉

| # | 操作 | 验证点 |
|---|------|--------|
| M38 | 对话 3 轮后 `/f` | 分叉新会话，首轮注入历史 |
| M39 | 两个 fork 分别对话 | 两个会话独立，互不影响 |
| M40 | 新会话立即 `/f` | "⚠️ 当前会话无历史消息，无法 fork" |
| M41 | `/f 测试标题` | fork 带自定义标题 |
| M42 | `/ls` | fork 会话显示 "(fork)" 标记 |

### 2.5 续接点控制

| # | 操作 | 验证点 |
|---|------|--------|
| M43 | `/p 2` | 确认后 parentMessageId 更新为 2 |
| M44 | `/p abc` | 显示 "❌ id 必须是数字" |

### 2.6 历史查看

| # | 操作 | 验证点 |
|---|------|--------|
| M45 | `/history` | 显示最近 2 轮 |
| M46 | `/history 5` | 显示最近 5 轮 |
| M47 | `/history -r 3` | 显示最近 3 轮 |
| M48 | `/history -a` | 显示全部 |
| M49 | `/history -id <id>` | 显示指定会话最近 2 轮 |
| M50 | `/history off` | 静默切换，不显示历史 |
| M51 | `/history on` | 开启自动打印 |

### 2.7 模式切换

| # | 操作 | 验证点 |
|---|------|--------|
| M52 | `/think on` | 提示符显示 🧠 |
| M53 | `/think off` | 提示符不显示 🧠 |
| M54 | `/search on` | 提示符显示 🔍 |
| M55 | `/search off` | 提示符不显示 🔍 |
| M56 | `/raw` | 显示 "📶 原始 SSE 数据流：开" |
| M57 | 再按一次 `/raw` | 显示 "📶 原始 SSE 数据流：关" |
| M58 | `/tool on` | 下次消息包含工具提示词 |
| M59 | `/tool off` | 下次消息不包含工具提示词 |

### 2.8 工具执行

| # | 操作 | 验证点 |
|---|------|--------|
| M60 | 模型调用 `read test.txt` | 返回 `<hashline-file>` 标注内容 |
| M61 | 模型用 ref 调用 `edit` | 文件正确修改 |
| M62 | 外部修改 test.txt 后模型用旧 ref edit | 返回 hash mismatch 错误 |
| M63 | 模型用旧 fileRev edit | 返回 "File revision mismatch" |
| M64 | 模型调用 `write` 写入带 `#HL` 的内容 | 文件内容干净 |
| M65 | 模型调用 `exec ls` | 返回目录列表 |
| M66 | 模型批量 edit（3 个操作） | 一次 tool_call 完成 3 处修改 |
| M67 | 模型 insert_before | 在指定行前正确插入 |
| M68 | 模型 insert_after | 在指定行后正确插入 |
| M69 | 模型 delete 范围 | 删除多行 |

### 2.9 凭证管理

| # | 操作 | 验证点 |
|---|------|--------|
| M70 | `/auth` | 显示 cookie 数量、bearer 前缀、userAgent |
| M71 | `/auth -s` | 验证凭证有效性 |

### 2.10 系统命令

| # | 操作 | 验证点 |
|---|------|--------|
| M72 | `/?` 或 `/h` 或 `/help` | 显示完整帮助 |
| M73 | 未知命令 `/foo` | 显示 "❌ 未知命令" + 列出可用命令 |
| M74 | `/clear` | 清屏 |
| M75 | `!echo hello` | 输出 hello |
| M76 | 空行输入 | 忽略，重新显示提示符 |

### 2.11 边界行为

| # | 操作 | 验证点 |
|---|------|--------|
| M77 | 无凭证启动 | 自动触发登录流程 |
| M78 | 无 .deepseek 目录启动 | 自动创建目录，提示词状态为"无" |
| M79 | 启动后立即 `/q` | 退出，_current 保存（空 id） |
| M80 | 长消息 | 正常处理 |
| M81 | Ctrl+C | 保存会话 → 退出 |
| M82 | `/tool on` 后 read + edit 完整流程 | 模型正确使用 hashline refs |
| M83 | write 后立即 read | write 清缓存 → read 返回新标注 |
| M84 | 消息队列 | 发消息时 AI 正在回复 → "⏳ AI 回复中，消息已排队" |
| M85 | `/sys -f 不存在的文件` | "❌ 源文件不存在" |

---

## 运行方式

```bash
# 第1层：自动化单元测试
cd chat
node --test test/test.mjs

# 第2层：手动验收（逐项对照执行）
./chat.ts
```

---

## 未覆盖项

| 项 | 原因 |
|----|------|
| `/reauth` 重新登录 | 需要 Chrome + 手动登录 DeepSeek，太复杂 |
| API 返回 401 自动重登 | 需要模拟过期 token，需要 Chrome |
| StreamParser SSE 解析 | 需要 DeepSeek 真实 SSE 流 |
| PoW 求解 | 需要 DeepSeek 返回的 challenge |
| 房间恢复 | 需要 DeepSeek 返回空响应 |
