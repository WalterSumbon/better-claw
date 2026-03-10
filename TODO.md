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

## P4 - SimpleMem 式记忆代谢系统

**灵感来源**：SimpleMem (UNC-Chapel Hill/UC Berkeley/UCSC, 2026) — 用「结构化语义压缩」在 LoCoMo 基准上登顶记忆 SOTA。核心发现：**记忆结构比模型智力更重要**（GPT-4.1-mini + SimpleMem 打败了 GPT-4o + Mem0）。

**论文/项目**：https://github.com/aiming-lab/SimpleMem

### P4.1 - Memory Write 时自动原子化（优先级最高）

**问题**：当前 extended memory 存储原始文本，包含模糊指代和相对时间，脱离上下文后检索质量下降。

- [ ] 在 `memory_write` 时增加 LLM 预处理步骤（Haiku 级别即可）
- [ ] 指代消解：将代词替换为具体实体（"他" → "寒哥"、"那个项目" → "Better-Claw"）
- [ ] 时间归一化：相对时间转 ISO-8601（"昨天" → "2026-03-04"、"下周" → "2026-03-09~15"）
- [ ] 输出自包含的原子化事实，每条记忆脱离上下文仍可理解
- [ ] SimpleMem 数据：仅此一项将时间推理 F1 从 25.40 提升到 58.62（+130%）

### P4.2 - Session 摘要熵过滤

**问题**：session 摘要全文压缩，低信息量轮次（闲聊、口误、无效语音转录）稀释了高价值信息。

- [ ] 对每轮对话计算信息评分（实体新颖性 + 语义散度）
- [ ] 低于阈值的轮次在摘要生成时跳过
- [ ] 与 P0（摘要可靠性）协同：结构化提取 + 熵过滤 + AI 摘要三层

### P4.3 - 定时递归巩固

**问题**：long-term memory 是 N 个 session 的一坨压缩文本，信息密度随积累递减。extended memory 中相似条目不会自动合并。

- [ ] 用 cron 定时任务触发巩固流程（如每天凌晨）
- [ ] 亲和力评分：内容相似度 × 时间衰减，超过阈值的记忆合并为抽象节点
- [ ] 案例：多次提到"隐变量公司"的不同方面 → 坍缩为一个结构化公司档案
- [ ] 原始细节归档，活跃记忆只保留抽象节点
- [ ] SimpleMem 数据：移除巩固后多跳推理能力下降 31.3%

### P4.4 - 自适应检索深度（远期）

**问题**：当前 extended memory 检索是 agent 手动决策，无自动化。

- [ ] 轻量级查询复杂度估计器，自动决定是否读 memory、读多少
- [ ] 简单问题（"我的时区？"）只查 core memory
- [ ] 复杂问题（"之前讨论的技术架构决策"）自动展开 extended memory 搜索
- [ ] 与 P1（FTS5 全文搜索）协同：先搜索再按相关性截断

**设计约束**：
- 原子化和巩固的 LLM 调用全部异步后台执行，不阻塞用户主交互
- 用 Haiku 做辅助处理，控制成本
- SimpleMem 构建速度 92.6 秒/样本，远快于图数据库方法（A-Mem 5140 秒）

---

## P5 - 工具输出压缩（长期储备）

**问题**：目前 11 个工具输出都较精简，暂无瓶颈。但如果未来增加更多功能（Web 搜索、文件分析、大数据处理等），工具输出可能成为上下文消耗大户。

**改进方案**：借鉴 Context Mode 的沙箱 + 知识库架构。

- [ ] 对大输出工具（如未来的 web_fetch、file_analyze 等）增加输出压缩层
- [ ] 超过阈值的输出自动索引到 FTS5 知识库（复用 P1 的基础设施）
- [ ] 只返回摘要到上下文，agent 需要细节时再搜索
- [ ] 设计通用的 "大输出处理" 中间件，新工具可以直接复用

**参考**：Context Mode 的 intent-driven search — 输出超 5KB 自动索引，只返回匹配 intent 的摘要。

---

## P6 - Agent 原生聊天客户端（本地部署）

**问题**：当前通过 Telegram/钉钉等即时聊天软件适配 agent，但传统聊天软件的交互模型是为人与人沟通设计的，对 agent/multi-agent 场景束手束脚。

**改进方案**：开发一个专为 agent 场景设计的、可本地部署的聊天客户端。

- [ ] 便捷创建 agent 分身（一键创建不同角色/能力的 agent 实例）
- [ ] 支持不同角色的 agent（如：研究员、编码助手、写作助手等，各自有独立的 system prompt 和工具集）
- [ ] 拉群 / multi-agent 协作（多个 agent 在同一对话中协作完成任务）
- [ ] 与 Better-Claw 后端深度集成（不再受第三方聊天平台 API 限制）
- [ ] 本地部署，数据不经过第三方平台

**与现有 TODO 的关系**：
- 继承 P5（自部署 agent 前端）的愿景，但范围更大——不只是单 agent 聊天界面，而是 agent 协作平台
- 可复用 Better-Claw 的 session/memory/skill 基础设施

**待设计**：
- 前端技术选型（Web/Electron/Tauri？）
- Agent 间通信协议设计
- Multi-agent 对话的 context 管理（各 agent 看到什么、共享什么）
- 用户如何编排 agent 协作流程（可视化 vs 声明式配置）

---

## 设计原则备忘

来自两个项目的通用经验：

1. **MCP 工具数量控制**：保持工具精简（<20个），每个工具的 schema 描述都消耗上下文 token
2. **用便宜模型做辅助工作**：摘要生成、模式分析等用 Haiku，核心对话用 Opus/Sonnet
3. **程序化 > 纯 AI**：能用代码确定性提取的信息，不要依赖 AI 生成（可靠性更高）
4. **渐进式采用**：每个改进独立可用，不要搞大重构
