# Better-Claw Roadmap & TODO

> 灵感来源：Context Mode (mksglu/claude-context-mode) + Everything Claude Code (affaan-m/everything-claude-code)
> 创建时间：2026-03-01

---

## P0 - 会话摘要可靠性

**问题**：当前 session 摘要完全依赖 Haiku 生成自然语言，失败率较高（多个 session 显示 "Summary generation failed"），一旦失败就丢失全部上下文。

**改进方案**：在 AI 摘要之外，增加程序化结构化提取作为兜底。

- [ ] 在 `session-manager.ts` 的摘要生成逻辑中增加 fallback 机制
- [ ] 程序化提取以下结构化信息（不依赖 AI）：
  - 用户消息关键词 / 最后 N 条消息摘录
  - 本次会话调用了哪些 MCP 工具（及调用次数）
  - 哪些 memory key 被读写过
  - 消息数、时长、token 消耗等元数据
- [ ] AI 摘要作为增强，结构化信息作为保底，两者合并存入 metadata
- [ ] 确保即使 AI 摘要失败，session 历史仍有可用的上下文骨架

**参考**：ECC 的 session-end.js — 解析 JSONL transcript 提取用户消息、工具使用、修改文件等结构化数据。

---

## P1 - Extended Memory 全文搜索

**问题**：extended memory 是简单的 key-value 文件存储，agent 必须知道确切的 key 才能读取。随着记忆积累，检索效率越来越低。

**改进方案**：引入 SQLite FTS5 全文搜索索引。

- [ ] 引入 `better-sqlite3` 依赖
- [ ] 创建 FTS5 虚拟表，对所有 extended memory 内容建索引
  - 使用 `tokenize='porter unicode61'` 支持英文词干提取
  - 考虑中文分词支持（trigram 或 jieba）
  - BM25 排名，key/title 权重高于 content
- [ ] 新增 `memory_search` MCP 工具，支持语义化搜索记忆
- [ ] 在 `memory_write` 时自动更新索引，`memory_delete` 时自动清理
- [ ] 保持现有 key-value 文件存储不变（FTS 作为索引层，不替代存储层）

**参考**：Context Mode 的 `store.ts` — SQLite FTS5 + BM25 + Porter stemming + trigram fallback + Levenshtein 模糊纠错。

---

## P2 - 后台自动学习用户模式

**问题**：用户偏好完全靠 agent 被动记录（用户明确说"记住X"才写入 core memory），没有主动学习机制。

**改进方案**：在会话结束时自动分析对话，提取隐含的用户模式。

- [ ] 在 SessionEnd 流程中增加"模式分析"步骤
- [ ] 用 AI（Haiku 级别即可）分析本次对话，提取：
  - 用户反复纠正的回答方式 → 写入 preferences
  - 新发现的兴趣领域 / 关注话题
  - 沟通风格偏好（简洁 vs 详细、语气等）
  - 活跃时间模式
- [ ] 提取结果与现有 core memory 对比，只写入新发现的信息
- [ ] 设置置信度阈值，避免单次对话的偶然行为被当作长期偏好
- [ ] 定期回顾机制：每 N 个会话做一次跨会话的综合分析
- [ ] 所有自动写入的偏好标记来源（auto-learned），与用户明确指定的区分

**参考**：ECC 的 continuous-learning + /learn-eval 的五维度质量门控思路。但不做命令式的，做成后台自动的。

---

## P3 - 智能会话管理

**问题**：当前会话轮转只看两个硬指标（4小时超时 / 80% 上下文占用），不够智能。

**改进方案**：增加逻辑断点检测和关键信息保护。

- [ ] **话题结束检测**：识别用户的结束语（"好的谢谢"、"OK"、"先这样"等），标记会话为"话题已结束"。下次来消息时倾向于开新会话。
- [ ] **主动提醒**：当上下文占比较高（如 60-70%）时，在回复末尾温和提示用户可以开新会话
- [ ] **关键信息保护**：轮转前自动检测本次会话中是否有重要的新信息（新的用户偏好、重要决定等），如果有则自动写入 extended memory 作为保险
- [ ] **会话标签**：给每个会话自动打标签（如"投资讨论"、"技术研究"、"闲聊"），方便后续回溯

**参考**：ECC 的 strategic compaction 理念 — 在逻辑断点而非任意阈值进行压缩。

---

## P4 - 工具输出压缩（长期储备）

**问题**：目前 11 个工具输出都较精简，暂无瓶颈。但如果未来增加更多功能（Web 搜索、文件分析、大数据处理等），工具输出可能成为上下文消耗大户。

**改进方案**：借鉴 Context Mode 的沙箱 + 知识库架构。

- [ ] 对大输出工具（如未来的 web_fetch、file_analyze 等）增加输出压缩层
- [ ] 超过阈值的输出自动索引到 FTS5 知识库（复用 P1 的基础设施）
- [ ] 只返回摘要到上下文，agent 需要细节时再搜索
- [ ] 设计通用的 "大输出处理" 中间件，新工具可以直接复用

**参考**：Context Mode 的 intent-driven search — 输出超 5KB 自动索引，只返回匹配 intent 的摘要。

---

## 设计原则备忘

来自两个项目的通用经验：

1. **MCP 工具数量控制**：保持工具精简（<20个），每个工具的 schema 描述都消耗上下文 token
2. **用便宜模型做辅助工作**：摘要生成、模式分析等用 Haiku，核心对话用 Opus/Sonnet
3. **程序化 > 纯 AI**：能用代码确定性提取的信息，不要依赖 AI 生成（可靠性更高）
4. **渐进式采用**：每个改进独立可用，不要搞大重构
