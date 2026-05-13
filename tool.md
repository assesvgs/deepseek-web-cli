## 工具调用格式

所有工具通过 `<tool_call>` XML 标签调用：

```
<tool_call name="工具名">
{"参数名": "参数值"}
</tool_call>
```

## edit 工具 — Hashline 行级哈希引用编辑

### 核心流程

**第一步：read 文件，观察标注**

read 返回的内容每行带有 `#HL` 标注：

```
#HL 1#A3F#9BC|import { foo } from "./lib"
#HL 2#B12#4D5|
#HL 3#C78#E90|function main() {
#HL 4#D34#FAB|  foo()
#HL 5#E56#123|}
```

格式：`#HL  <行号>#<行哈希>#<锚点哈希>|<内容>`
- `行哈希`：该行内容的 3-4 字符 SHA1 指纹
- `锚点哈希`：该行+前后邻行的 3-4 字符 SHA1 指纹（防止同内容行误定位）
- `#HL REV:XXXXXXXX`：文件版本指纹，传给 edit 可防止过期编辑

**第二步：edit 引用标注**

```json
{
  "filePath": "src/main.ts",
  "operations": [
    {
      "op": "replace",
      "startRef": "#HL 3#C78#E90",
      "content": "async function main() {"
    },
    {
      "op": "insert_after",
      "startRef": "#HL 3#C78#E90",
      "content": "  console.log(\"starting...\")"
    }
  ],
  "fileRev": "A1B2C3D4"
}
```

**关键规则：**
- ref 必须从 read 输出**原样复制**，不要修改任何字符
- fileRev 从 `#HL REV:XXXXXXXX` 行原样复制
- 多个操作放在同一个 `operations` 数组里，一次 edit 完成
- content 中如果带有 `#HL` 前缀会被自动清洗，所以可以直接复制 read 输出中的内容

### 六种操作

| 操作 | 必需参数 | 说明 | 示例 |
|------|---------|------|------|
| `replace` | startRef 或 ref, content | 替换行范围。无 endRef 则替换单行 | `{"op":"replace","startRef":"#HL 2#xxx#yyy","content":"新内容"}` |
| `delete` | startRef 或 ref | 删除行范围 | `{"op":"delete","startRef":"#HL 3#xxx#yyy","endRef":"#HL 5#xxx#yyy"}` |
| `insert_before` | startRef 或 ref, content | 在目标行**之前**插入 | `{"op":"insert_before","startRef":"#HL 1#xxx#yyy","content":"新行"}` |
| `insert_after` | startRef 或 ref, content | 在目标行**之后**插入 | `{"op":"insert_after","startRef":"#HL 3#xxx#yyy","content":"新行"}` |
| `replace_range` | startRef, endRef, content | 替换整段范围 | `{"op":"replace_range","startRef":"#HL 2#xxx#yyy","endRef":"#HL 4#xxx#yyy","content":"新内容"}` |
| `set_file` | content | 全量覆盖文件，不能与其他操作混用 | `{"op":"set_file","content":"完整文件内容"}` |

### 安全机制（自动执行，无需手动处理）

| 机制 | 行为 |
|------|------|
| 行哈希校验 | ref 中的哈希与当前文件行内容不匹配时，拒绝编辑并返回错误 |
| fileRev 版本锁 | 传入的 fileRev 与文件当前版本不一致时拒绝，提示重新 read |
| 重叠检测 | 多个操作的删除/替换范围有重叠时拒绝 |
| safeReapply | 设为 `true` 时，若哈希匹配但行号移动，自动重新定位（仅当恰好一个候选时） |

### 安全示例

```
# 读取文件时 fileRev 为 A1B2C3D4
# 在 edit 之前，外部程序修改了文件 → fileRev 变为 E5F6G7H8
# 此时 edit 传入 fileRev: "A1B2C3D4" → 被拒绝
# 错误信息：File revision mismatch. Read the file again.
# 
# 解决：重新 read 获取新的 refs 和 fileRev，再 edit
```

### 何时需要重新 read

1. edit 返回 hash mismatch 或 fileRev mismatch 错误时
2. write 覆盖文件之后（文件内容完全变了）
3. 需要查看文件最新内容确认修改结果时
4. safeReapply 虽然有自动重定位，但仍建议重新 read 获取准确的行号

### 批量操作优势

❌ **不要这样（每条操作单独调用 edit）：**
```
edit → replace 第3行
edit → insert 第5行
edit → delete 第7行
```
3 次网络往返，效率低，且中间文件可能被修改。

✅ **应该这样（一次调用全部完成）：**
```json
{
  "filePath": "src/main.ts",
  "operations": [
    {"op": "replace", "startRef": "#HL 3#xxx#yyy", "content": "新第3行"},
    {"op": "insert_after", "startRef": "#HL 5#xxx#yyy", "content": "新行"},
    {"op": "delete", "startRef": "#HL 7#xxx#yyy"}
  ],
  "fileRev": "A1B2C3D4"
}
```
1 次往返，且所有操作的 refs 基于同一份 read 快照，一致性有保证。

## write 工具 — 全量覆盖写入

直接写入文件全部内容。**如果 content 中混入了 `#HL` 前缀，会被自动清洗，无需手动处理。**

```json
{
  "path": "src/newfile.ts",
  "content": "const x = 1\nconst y = 2\n"
}
```

## read 工具 — 读取文件

读取文件全部内容，输出自动带有 hashline 行哈希标注。无需任何额外参数。

```json
{
  "path": "src/main.ts"
}
```

## exec 工具 — 执行系统命令

执行 shell 命令并返回输出。

```json
{
  "command": "ls -la src/"
}
```
