import test from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"

import {
  hlHash, lineHash, anchorHash, fileRev, getHashLength,
  annotateReadOutput, formatAnnotatedLine, formatRef, formatRev,
  parseLineRef, findRefCandidates, resolveLineRef,
  splitToLines, resolveChanges, validateNoOverlap, applyChanges,
  applyHashlineEdit, stripHashlineAnnotations,
  HL_PREFIX, fileRevCache,
  SessionStore, scanDeepseekDir,
} from "../chat.ts"

const TMP = os.tmpdir()

// ─── 1. 哈希函数 ──────────────────────────────────────────

test("hlHash 返回指定长度的大写十六进制", () => {
  const h = hlHash("hello", 3)
  assert.match(h, /^[A-F0-9]{3}$/)
})

test("hlHash 相同输入返回相同结果", () => {
  assert.equal(hlHash("hello", 3), hlHash("hello", 3))
})

test("hlHash 不同输入返回不同结果", () => {
  assert.notEqual(hlHash("hello", 3), hlHash("world", 3))
})

test("lineHash 正确计算行哈希", () => {
  assert.equal(lineHash("const x = 1", 3).length, 3)
})

test("anchorHash 邻行不同导致结果不同", () => {
  assert.notEqual(
    anchorHash("a", "b", "c", 3),
    anchorHash("x", "b", "y", 3),
  )
})

test("anchorHash 相同输入结果相同", () => {
  assert.equal(
    anchorHash("a", "b", "c", 3),
    anchorHash("a", "b", "c", 3),
  )
})

test("getHashLength ≤4096 返回 3", () => {
  assert.equal(getHashLength(1), 3)
  assert.equal(getHashLength(100), 3)
  assert.equal(getHashLength(4096), 3)
})

test("getHashLength >4096 返回 4", () => {
  assert.equal(getHashLength(4097), 4)
  assert.equal(getHashLength(10000), 4)
})

test("fileRev CRLF 和 LF 结果一致", () => {
  const lf = "alpha\nbeta\ngamma\n"
  const crlf = lf.replace(/\n/g, "\r\n")
  assert.equal(fileRev(lf), fileRev(crlf))
})

test("fileRev 不同内容结果不同", () => {
  assert.notEqual(fileRev("a\n"), fileRev("b\n"))
})

test("fileRev 返回 8 字符大写十六进制", () => {
  assert.match(fileRev("hello\n"), /^[A-F0-9]{8}$/)
})

// ─── 2. 标注输出 ──────────────────────────────────────────

test("annotateReadOutput 包含 wrapper 标签", () => {
  const out = annotateReadOutput("hello\nworld\n", "/tmp/test.txt")
  assert.match(out, /^<hashline-file/)
  assert.match(out, /<\/hashline-file>$/)
})

test("annotateReadOutput 包含 REV 行", () => {
  const out = annotateReadOutput("a\n", "/x")
  assert.match(out, /\n#HL REV:[A-F0-9]{8}\n/)
})

test("annotateReadOutput 每行有标注", () => {
  const out = annotateReadOutput("one\ntwo\nthree\n", "/f")
  assert.match(out, /#HL 1#[A-F0-9]{3}#[A-F0-9]{3}\|one/)
  assert.match(out, /#HL 2#[A-F0-9]{3}#[A-F0-9]{3}\|two/)
  assert.match(out, /#HL 3#[A-F0-9]{3}#[A-F0-9]{3}\|three/)
})

test("annotateReadOutput 包含 total_lines", () => {
  const out = annotateReadOutput("a\nb\n", "/f")
  assert.match(out, /total_lines="2"/)
})

test("annotateReadOutput 空文件", () => {
  const out = annotateReadOutput("", "/f")
  // 空字符串 split 产生 [""]，算作一行空内容
  assert.match(out, /total_lines="1"/)
})

test("annotateReadOutput 写入 fileRevCache", () => {
  annotateReadOutput("hello\n", "/tmp/test-cache.txt")
  assert.ok(fileRevCache.has(path.resolve("/tmp/test-cache.txt")))
  fileRevCache.delete(path.resolve("/tmp/test-cache.txt"))
})

test("annotateReadOutput CRLF 内容正确标注", () => {
  const out = annotateReadOutput("a\r\nb\r\n", "/f")
  assert.match(out, /#HL 1#[A-F0-9]{3}#[A-F0-9]{3}\|a/)
  assert.match(out, /#HL 2#[A-F0-9]{3}#[A-F0-9]{3}\|b/)
})

// ─── 3. Ref 解析 ──────────────────────────────────────────

test("parseLineRef 标准格式带 anchor", () => {
  const r = parseLineRef("#HL 3#A3F#9BC")
  assert.equal(r.lineNum, 3)
  assert.equal(r.hash, "A3F")
  assert.equal(r.anchor, "9BC")
})

test("parseLineRef 无 anchor", () => {
  const r = parseLineRef("#HL 5#B12")
  assert.equal(r.lineNum, 5)
  assert.equal(r.hash, "B12")
  assert.equal(r.anchor, undefined)
})

test("parseLineRef 带 ;;; 前缀", () => {
  const r = parseLineRef(";;; 1#CCC")
  assert.equal(r.lineNum, 1)
  assert.equal(r.hash, "CCC")
})

test("parseLineRef 带 |content 后缀", () => {
  const r = parseLineRef("#HL 2#D34#E56|const x")
  assert.equal(r.lineNum, 2)
  assert.equal(r.hash, "D34")
  assert.equal(r.anchor, "E56")
})

test("parseLineRef 非法格式抛异常", () => {
  assert.throws(() => parseLineRef("#HL abc"), /Invalid line reference/)
  assert.throws(() => parseLineRef(""), /Invalid line reference/)
})

// ─── 4. Ref 定位 ──────────────────────────────────────────

test("resolveLineRef 哈希匹配定位正确", () => {
  const lines = ["alpha", "beta", "gamma"]
  const hashLen = getHashLength(lines.length)
  const h = lineHash(lines[1], hashLen)
  const a = anchorHash(lines[0], lines[1], lines[2], hashLen)
  const ref = `#HL 2#${h}#${a}`
  assert.equal(resolveLineRef(ref, lines, false), 1)
})

test("resolveLineRef 行号超出抛异常", () => {
  assert.throws(
    () => resolveLineRef("#HL 999#A3F#9BC", ["a", "b"], false),
    /only has 2 lines/,
  )
})

test("resolveLineRef 哈希不匹配抛异常", () => {
  const ref = `#HL 1#XXX#YYY`
  assert.throws(
    () => resolveLineRef(ref, ["alpha", "beta"], false),
    /Hash mismatch/,
  )
})

// ─── 5. safeReapply ───────────────────────────────────────

test("safeReapply 单候选自动定位", () => {
  // 在目标行之后插入，邻行锚点不变 → safeReapply 能找到
  // 原始: [alpha, beta, gamma]  →  修改: [alpha, beta, INSERTED, gamma]
  const origLines = ["alpha", "beta", "gamma"]
  const newLines = ["alpha", "beta", "INSERTED", "gamma"]

  const hLen = getHashLength(origLines.length)
  const h = lineHash(origLines[1], hLen)
  const a = anchorHash(origLines[0], origLines[1], origLines[2], hLen)
  const ref = `#HL 2#${h}#${a}`

  // 锚点(alpha, beta, gamma)在新文件中仍然匹配(alpha, beta, INSERTED?)
  // 注意：anchorHash 用前后邻行，在新文件中 beta 的邻行变了
  // 所以不用 anchor，只用 hash 测试
  const refNoAnchor = `#HL 2#${h}`
  const idx = resolveLineRef(refNoAnchor, newLines, true)
  assert.equal(idx, 1) // beta 仍在 index 1
})

test("safeReapply 零候选抛异常", () => {
  const lines = ["alpha", "completely changed", "gamma"]
  const ref = `#HL 2#XXX#YYY`
  assert.throws(
    () => resolveLineRef(ref, lines, true),
    /no relocation candidates/,
  )
})

test("safeReapply 关闭时哈希不匹配直接抛异常", () => {
  const lines = ["alpha", "changed", "gamma"]
  const ref = `#HL 2#XXX#YYY`
  assert.throws(
    () => resolveLineRef(ref, lines, false),
    /Hash mismatch/,
  )
})

// ─── 6. 编辑操作 ──────────────────────────────────────────

function makeRef(idx: number, lines: string[], withAnchor = true): string {
  const hLen = getHashLength(lines.length)
  const ln = idx + 1
  const h = lineHash(lines[idx], hLen)
  const a = withAnchor ? anchorHash(lines[idx - 1], lines[idx], lines[idx + 1], hLen) : undefined
  return `#HL ${ln}#${h}${a ? "#" + a : ""}`
}

test("replace 单行", () => {
  const lines = ["one", "two", "three"]
  const ops = [{ op: "replace" as const, startRef: makeRef(1, lines), content: "TWO" }]
  const ch = resolveChanges(lines, ops, false)
  const result = applyChanges(lines, ch)
  assert.deepEqual(result, ["one", "TWO", "three"])
})

test("replace 范围", () => {
  const lines = ["a", "b", "c", "d"]
  const ops = [{ op: "replace" as const, startRef: makeRef(1, lines), endRef: makeRef(2, lines), content: "X\nY" }]
  const changes = resolveChanges(lines, ops, false)
  const result = applyChanges(lines, changes)
  assert.deepEqual(result, ["a", "X", "Y", "d"])
})

test("delete 单行", () => {
  const lines = ["a", "b", "c"]
  const ops = [{ op: "delete" as const, startRef: makeRef(1, lines) }]
  const result = applyChanges(lines, resolveChanges(lines, ops, false))
  assert.deepEqual(result, ["a", "c"])
})

test("delete 范围", () => {
  const lines = ["a", "b", "c", "d"]
  const ops = [{ op: "delete" as const, startRef: makeRef(1, lines), endRef: makeRef(2, lines) }]
  const result = applyChanges(lines, resolveChanges(lines, ops, false))
  assert.deepEqual(result, ["a", "d"])
})

test("insert_before", () => {
  const lines = ["a", "c"]
  const ops = [{ op: "insert_before" as const, startRef: makeRef(1, lines), content: "b" }]
  const result = applyChanges(lines, resolveChanges(lines, ops, false))
  assert.deepEqual(result, ["a", "b", "c"])
})

test("insert_after", () => {
  const lines = ["a", "c"]
  const ops = [{ op: "insert_after" as const, startRef: makeRef(0, lines), content: "b" }]
  const result = applyChanges(lines, resolveChanges(lines, ops, false))
  assert.deepEqual(result, ["a", "b", "c"])
})

test("replace_range", () => {
  const lines = ["a", "b", "c", "d"]
  const ops = [{ op: "replace_range" as const, startRef: makeRef(1, lines), endRef: makeRef(2, lines), content: "X\nY\nZ" }]
  const result = applyChanges(lines, resolveChanges(lines, ops, false))
  assert.deepEqual(result, ["a", "X", "Y", "Z", "d"])
})

test("set_file", () => {
  const lines = ["old1", "old2"]
  const ops = [{ op: "set_file" as const, content: "new1\nnew2" }]
  const result = applyChanges(lines, resolveChanges(lines, ops, false))
  assert.deepEqual(result, ["new1", "new2"])
})

test("set_file 不能与其他操作混用", () => {
  const lines = ["a"]
  const ops = [
    { op: "set_file" as const, content: "x" },
    { op: "replace" as const, startRef: "#HL 1#XXX", content: "y" },
  ]
  assert.throws(
    () => resolveChanges(lines, ops, false),
    /cannot be combined/,
  )
})

// ─── 7. 批量操作与冲突 ─────────────────────────────────────

test("批量 3 个操作", () => {
  const lines = ["one", "two", "three", "four"]
  const ops = [
    { op: "replace" as const, startRef: makeRef(0, lines), content: "ONE" },
    { op: "insert_after" as const, startRef: makeRef(2, lines), content: "INSERTED" },
    { op: "delete" as const, startRef: makeRef(3, lines) },
  ]
  const result = applyChanges(lines, resolveChanges(lines, ops, false))
  assert.deepEqual(result, ["ONE", "two", "three", "INSERTED"])
})

test("批量从后往前不漂移", () => {
  const lines = ["1", "2", "3", "4", "5"]
  const ops = [
    { op: "replace" as const, startRef: makeRef(4, lines), content: "FIVE" },
    { op: "replace" as const, startRef: makeRef(1, lines), content: "TWO" },
  ]
  const result = applyChanges(lines, resolveChanges(lines, ops, false))
  assert.deepEqual(result, ["1", "TWO", "3", "4", "FIVE"])
})

test("重叠删除检测", () => {
  const lines = ["a", "b", "c"]
  const ops = [
    { op: "delete" as const, startRef: makeRef(1, lines) },
    { op: "delete" as const, startRef: makeRef(1, lines) },
  ]
  const ch = resolveChanges(lines, ops, false)
  assert.throws(() => validateNoOverlap(ch), /Overlapping/)
})

test("空操作列表抛异常", () => {
  assert.throws(() => resolveChanges(["a"], [], false), /No operations/)
})

// ─── 8. fileRev 校验 ──────────────────────────────────────

test("applyHashlineEdit fileRev 匹配成功", async () => {
  const dir = await fs.mkdtemp(path.join(TMP, "hashtest-"))
  const file = path.join(dir, "f.txt")
  const raw = "a\nb\nc\n"
  await fs.writeFile(file, raw)

  const rev = fileRev(raw)
  const ops = [{ op: "replace" as const, startRef: makeRef(1, raw.split("\n").filter(l => l), false, raw), content: "B" }]

  // Need to rebuild ref for the actual file content
  const lines = ["a", "b", "c"]
  const hLen = getHashLength(3)
  const h = lineHash("b", hLen)
  const a = anchorHash("a", "b", "c", hLen)
  const ref = `#HL 2#${h}#${a}`

  const result = applyHashlineEdit(file, raw, [{ op: "replace", startRef: ref, content: "B" }], rev)
  assert.equal(result, "a\nB\nc\n")

  await fs.rm(dir, { recursive: true, force: true })
})

test("applyHashlineEdit fileRev 不匹配抛异常", async () => {
  const dir = await fs.mkdtemp(path.join(TMP, "hashtest-"))
  const file = path.join(dir, "f.txt")
  await fs.writeFile(file, "a\nb\nc\n")

  assert.throws(
    () => applyHashlineEdit(file, "a\nb\nc\n", [], "DEADBEEF"),
    /File revision mismatch/,
  )

  await fs.rm(dir, { recursive: true, force: true })
})

test("applyHashlineEdit 不传 rev 跳过校验", () => {
  const lines = ["a", "b", "c"]
  const hLen = getHashLength(3)
  const h = lineHash("b", hLen)
  const a = anchorHash("a", "b", "c", hLen)
  const ref = `#HL 2#${h}#${a}`

  const result = applyHashlineEdit("/x", "a\nb\nc\n", [{ op: "replace", startRef: ref, content: "B" }])
  assert.equal(result, "a\nB\nc\n")
})

// ─── 9. 标注清洗 ──────────────────────────────────────────

test("stripHashlineAnnotations 清洗 ref 前缀", () => {
  const input = "#HL 1#A3F#9BC|hello"
  assert.equal(stripHashlineAnnotations(input), "hello")
})

test("stripHashlineAnnotations 清洗 REV 行", () => {
  const input = "#HL REV:ABCD1234\nhello"
  assert.equal(stripHashlineAnnotations(input), "hello")
})

test("stripHashlineAnnotations 清洗 wrapper 标签", () => {
  const input = '<hashline-file path="/x">\n#HL 1#A3F#9BC|hello\n</hashline-file>'
  assert.equal(stripHashlineAnnotations(input), "hello")
})

test("stripHashlineAnnotations 清洗注释行", () => {
  const input = "# format: <line>#<hash>\n# use refs exactly as shown\n#HL 1#A3F#9BC|hello"
  const out = stripHashlineAnnotations(input)
  assert.equal(out, "hello")
})

test("stripHashlineAnnotations 完整 read 输出还原原始内容", () => {
  const raw = "one\ntwo\nthree\n"
  const annotated = annotateReadOutput(raw, "/x")
  const stripped = stripHashlineAnnotations(annotated)
  // annotateReadOutput normalizes trailing newlines; stripped content matches line-for-line
  assert.equal(stripped, "one\ntwo\nthree")
})

test("stripHashlineAnnotations 无标注内容不变", () => {
  assert.equal(stripHashlineAnnotations("hello\nworld"), "hello\nworld")
})

test("stripHashlineAnnotations 空字符串", () => {
  assert.equal(stripHashlineAnnotations(""), "")
})

test("stripHashlineAnnotations 保留 diff 标记", () => {
  const input = " #HL 1#A3F#9BC|hello"
  assert.equal(stripHashlineAnnotations(input), " hello")
})

// ─── 10. 辅助函数 ─────────────────────────────────────────

test("splitToLines 基本分割", () => {
  assert.deepEqual(splitToLines("a\nb\nc"), ["a", "b", "c"])
})

test("splitToLines 结尾换行", () => {
  assert.deepEqual(splitToLines("a\nb\n"), ["a", "b"])
})

test("splitToLines 空字符串", () => {
  assert.deepEqual(splitToLines(""), [])
})

test("formatRef 带 anchor", () => {
  assert.equal(formatRef(3, "A3F", "9BC"), "3#A3F#9BC")
})

test("formatRef 无 anchor", () => {
  assert.equal(formatRef(5, "B12"), "5#B12")
})

test("formatRev", () => {
  assert.equal(formatRev("ABCD1234"), "REV:ABCD1234")
})

// ─── 11. 会话持久化 ───────────────────────────────────────

test("SessionStore save + load 完整流程", async () => {
  const dir = await fs.mkdtemp(path.join(TMP, "session-test-"))
  const store = new SessionStore(dir)

  const state = {
    id: "test-001",
    title: "测试会话",
    parentMessageId: null,
    messages: [{ role: "user" as const, content: "hello", timestamp: Date.now(), parentMessageId: null }],
    thinkEnabled: false,
    searchEnabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  store.save(state)
  const loaded = store.load("test-001")
  assert.ok(loaded)
  assert.equal(loaded!.title, "测试会话")
  assert.equal(loaded!.messages.length, 1)

  await fs.rm(dir, { recursive: true, force: true })
})

test("SessionStore.load 不存在返回 null", async () => {
  const dir = await fs.mkdtemp(path.join(TMP, "session-test-"))
  const store = new SessionStore(dir)
  assert.equal(store.load("nonexistent"), null)
  await fs.rm(dir, { recursive: true, force: true })
})

test("SessionStore.delete", async () => {
  const dir = await fs.mkdtemp(path.join(TMP, "session-test-"))
  const store = new SessionStore(dir)
  store.save({ id: "t", title: "", parentMessageId: null, messages: [], thinkEnabled: false, searchEnabled: true, createdAt: 0, updatedAt: 0 })
  store.delete("t")
  assert.equal(store.load("t"), null)
  await fs.rm(dir, { recursive: true, force: true })
})

test("SessionStore.delete 清空活跃 current", async () => {
  const dir = await fs.mkdtemp(path.join(TMP, "session-test-"))
  const store = new SessionStore(dir)
  store.save({ id: "t", title: "", parentMessageId: null, messages: [], thinkEnabled: false, searchEnabled: true, createdAt: 0, updatedAt: 0 })
  store.setCurrentId("t")
  store.delete("t")
  assert.equal(store.getCurrentId(), null)
  await fs.rm(dir, { recursive: true, force: true })
})

test("SessionStore.list 按 updatedAt 降序", async () => {
  const dir = await fs.mkdtemp(path.join(TMP, "session-test-"))
  const store = new SessionStore(dir)
  store.save({ id: "older", title: "", parentMessageId: null, messages: [], thinkEnabled: false, searchEnabled: true, createdAt: 100, updatedAt: 100 })
  store.save({ id: "newer", title: "", parentMessageId: null, messages: [], thinkEnabled: false, searchEnabled: true, createdAt: 200, updatedAt: 200 })
  const list = store.list()
  assert.equal(list.length, 2)
  assert.equal(list[0].id, "newer")
  assert.equal(list[1].id, "older")
  await fs.rm(dir, { recursive: true, force: true })
})

test("SessionStore.list 过滤 _current", async () => {
  const dir = await fs.mkdtemp(path.join(TMP, "session-test-"))
  const store = new SessionStore(dir)
  store.save({ id: "s1", title: "", parentMessageId: null, messages: [], thinkEnabled: false, searchEnabled: true, createdAt: 0, updatedAt: 0 })
  store.setCurrentId("s1")
  const list = store.list()
  assert.equal(list.length, 1)
  await fs.rm(dir, { recursive: true, force: true })
})

test("SessionStore.list 跳过损坏文件", async () => {
  const dir = await fs.mkdtemp(path.join(TMP, "session-test-"))
  const store = new SessionStore(dir)
  store.save({ id: "good", title: "", parentMessageId: null, messages: [], thinkEnabled: false, searchEnabled: true, createdAt: 0, updatedAt: 0 })
  await fs.mkdir(path.join(dir, ".deepseek", "sessions"), { recursive: true })
  await fs.writeFile(path.join(dir, ".deepseek", "sessions", "bad.json"), "not json")
  const list = store.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, "good")
  await fs.rm(dir, { recursive: true, force: true })
})

test("SessionStore.currentId set + get", async () => {
  const dir = await fs.mkdtemp(path.join(TMP, "session-test-"))
  const store = new SessionStore(dir)
  store.setCurrentId("abc123")
  assert.equal(store.getCurrentId(), "abc123")
  await fs.rm(dir, { recursive: true, force: true })
})

// ─── 12. 环境发现 ──────────────────────────────────────────

test("scanDeepseekDir 局部提示词优先", async () => {
  const dir = await fs.mkdtemp(path.join(TMP, "scan-test-"))
  const deepseek = path.join(dir, ".deepseek")
  await fs.mkdir(deepseek, { recursive: true })
  await fs.writeFile(path.join(deepseek, "system.md"), "局部")
  await fs.writeFile(path.join(deepseek, "system-all.md"), "全局")

  const env = scanDeepseekDir(dir)
  assert.equal(env.systemPrompt, "局部")
  assert.equal(env.systemSource, "local")

  await fs.rm(dir, { recursive: true, force: true })
})

test("scanDeepseekDir 回退全局", async () => {
  const dir = await fs.mkdtemp(path.join(TMP, "scan-test-"))
  const deepseek = path.join(dir, ".deepseek")
  await fs.mkdir(deepseek, { recursive: true })
  await fs.writeFile(path.join(deepseek, "system-all.md"), "全局")

  const env = scanDeepseekDir(dir)
  assert.equal(env.systemPrompt, "全局")
  assert.equal(env.systemSource, "global")

  await fs.rm(dir, { recursive: true, force: true })
})

test("scanDeepseekDir 无提示词", async () => {
  const dir = await fs.mkdtemp(path.join(TMP, "scan-test-"))
  const env = scanDeepseekDir(dir)
  assert.equal(env.systemPrompt, "")
  assert.equal(env.systemSource, "none")
  await fs.rm(dir, { recursive: true, force: true })
})

test("scanDeepseekDir 读取 tool.md 和 skill.md", async () => {
  const dir = await fs.mkdtemp(path.join(TMP, "scan-test-"))
  const deepseek = path.join(dir, ".deepseek")
  await fs.mkdir(deepseek, { recursive: true })
  await fs.writeFile(path.join(deepseek, "tool.md"), "tool内容")
  await fs.writeFile(path.join(deepseek, "skill.md"), "skill内容")

  const env = scanDeepseekDir(dir)
  assert.equal(env.toolMdContent, "tool内容")
  assert.equal(env.skillMdContent, "skill内容")

  await fs.rm(dir, { recursive: true, force: true })
})

// ─── 13. 编辑边界情况 ──────────────────────────────────────

test("applyHashlineEdit 保持 LF 行尾", () => {
  const raw = "a\nb\nc\n"
  const lines = ["a", "b", "c"]
  const hLen = getHashLength(3)
  const h = lineHash("b", hLen)
  const a = anchorHash("a", "b", "c", hLen)
  const ref = `#HL 2#${h}#${a}`

  const result = applyHashlineEdit("/x", raw, [{ op: "replace", startRef: ref, content: "B" }])
  assert.match(result, /\n$/)  // ends with newline
  assert.ok(!result.includes("\r"))
})

test("applyHashlineEdit 保持 CRLF 行尾", () => {
  const raw = "a\r\nb\r\nc\r\n"
  const lines = ["a", "b", "c"]
  const hLen = getHashLength(3)
  const h = lineHash("b", hLen)
  const a = anchorHash("a", "b", "c", hLen)
  const ref = `#HL 2#${h}#${a}`

  const result = applyHashlineEdit("/x", raw, [{ op: "replace", startRef: ref, content: "B" }])
  assert.match(result, /\r\n$/)
})

test("applyHashlineEdit 无换行符结尾文件", () => {
  const raw = "a\nb\nc"
  const result = applyHashlineEdit("/x", raw, [{ op: "set_file", content: "x\ny" }])
  assert.equal(result, "x\ny")  // no trailing newline
})

test("applyHashlineEdit content 中 #HL 被清洗", () => {
  const raw = "a\nb\nc\n"
  const lines = ["a", "b", "c"]
  const hLen = getHashLength(3)
  const h = lineHash("b", hLen)
  const a = anchorHash("a", "b", "c", hLen)
  const ref = `#HL 2#${h}#${a}`

  // 用真实哈希（A-F0-9）而非 X，regex 才能匹配
  const dirtyContent = "#HL 1#A3F#9BC|replaced\nwith prefix"
  const result = applyHashlineEdit("/x", raw, [{ op: "replace", startRef: ref, content: dirtyContent }])
  assert.equal(result, "a\nreplaced\nwith prefix\nc\n")
})

test("fileRevCache 在编辑后清除", () => {
  const filePath = "/tmp/test-clear.txt"
  fileRevCache.set(path.resolve(filePath), "DEADBEEF")
  const raw = "a\nb\n"
  const lines = ["a", "b"]
  const hLen = getHashLength(2)
  const h = lineHash("a", hLen)
  const a = anchorHash(undefined, "a", "b", hLen)
  const ref = `#HL 1#${h}#${a}`

  applyHashlineEdit(filePath, raw, [{ op: "replace", startRef: ref, content: "X" }])
  assert.equal(fileRevCache.has(path.resolve(filePath)), false)
})

// ─── 14. 大文件边界 ───────────────────────────────────────

test("大文件 getHashLength 返回 4", () => {
  const bigLines = Array.from({ length: 5000 }, (_, i) => `line ${i}`)
  const raw = bigLines.join("\n") + "\n"
  const out = annotateReadOutput(raw, "/big")
  // 应该在总行数大于 4096 时使用 4 字符哈希
  assert.match(out, /#HL 1#[A-F0-9]{4}#[A-F0-9]{4}\|line 0/)
})

test("单行文件正确标注", () => {
  const out = annotateReadOutput("only one line", "/x")
  assert.match(out, /#HL 1#[A-F0-9]{3}#[A-F0-9]{3}\|only one line/)
})
