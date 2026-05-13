# Hashline 集成到 chat.ts — 设计文档

## 概述

把 opencode-hashline 的行级哈希标注 + 引用编辑 + 哈希校验能力内联到 chat.ts 的工具系统中。

改动范围：**仅在 chat.ts 单文件内**，不新增文件，不修改其他模块。

## 核心决策

| 决策 | 选择 | 理由 |
|------|------|------|
| write 带 #HL 前缀 | 自动清洗 | 与插件一致，模型不需要手动清理 |
| edit 操作粒度 | 批量 operations[] | 一次往返改完，防止往返超限 |
| fileRev 存储 | 内存 Map + 现场重算 | 与插件一致，读时缓存 rev，编辑时现场校验 |
| safeReapply | 做，默认 false | 实现成本极低（~15行），配合修改时不增加复杂度 |
| read 标注格式 | 完整 `<hashline-file>` XML 包裹 | 与插件格式一致，元信息有用 |
| edit 参数说明 | description 文本 + tool.md 示例 | chat.ts 类型系统简陋，模型看文本就够了 |

## 实现结构

```
chat.ts 新增段落：
  【第4B部分：Hashline 核心】(~200 行)
    ├── 哈希工具函数 (hashText, hashlineLineHash, hashlineAnchorHash, computeFileRev, getAdaptiveHashLength)
    ├── 标注函数 (formatAnnotatedLine, annotateReadOutput)
    ├── Ref 解析 (parseLineRef, resolveLineRef, findRefCandidates)
    ├── 编辑操作 (resolveChanges, validateChangeConflicts, applyChanges, applyHashlineEdit)
    ├── 清洗函数 (stripHashlineAnnotations)
    └── fileRevCache (Map<string, string>)

chat.ts 修改段落：
  【第9部分：ToolExecutor】
    - askConfirm: 加入 edit 到确认列表
    - runTool: read 走标注输出, write 走清洗, 新增 edit case

  【第10部分：registerBuiltinTools】
    - 新增 edit 工具注册
```

## 数据流

```
模型调用 read → runTool("read")
  → fs.readFileSync() 读原始内容
  → annotateReadOutput() 标注 + 算 rev + 写缓存
  → 返回 <hashline-file>...</hashline-file>

模型调用 edit → runTool("edit")
  → fs.readFileSync() 读当前文件
  → 如果有 fileRev，现场 computeFileRev() 对比
  → resolveChanges() 解析 refs 为 splice 操作
  → validateChangeConflicts() 检测重叠
  → applyChanges() 从后往前 splice
  → fs.writeFileSync() 写入
  → fileRevCache 清除

模型调用 write → runTool("write")
  → stripHashlineAnnotations() 清洗 content
  → fs.writeFileSync() 写入
  → fileRevCache 清除
```

## 与 opencode-hashline 的差异

| 项 | opencode-hashline | chat.ts | 原因 |
|----|------------------|---------|------|
| 缓存 key | (path, offset, limit) | path | chat.ts 总是读全文件 |
| 缓存淘汰 | maxSize 100 限制 | 不限制 | 文件数量有限，无泄漏风险 |
| 编辑输出 | oldString/newString 给调用方 | 直接写盘 | chat.ts 没有外部调用方 |
| dryRun | 支持 | 不支持 | chat.ts 不需要干跑模式 |
| expectedFileHash | 支持 | 不支持 | fileRev 已足够 |
| 工具注册 | 追加描述到原生工具 | 独立 edit 工具 + description 文本 | chat.ts 无法劫持工具 |
