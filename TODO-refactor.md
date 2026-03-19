# refactor/clean-restart 分支重构 TODO

基于阶段四末尾 (`1c23d2a`) 创建，从阶段五/六中提取有价值的改动。

---

## 一、Cherry-pick（独立修复/功能，可直接移植）

- [x] **P0** `c3ee471` resolveUserId fallback — AsyncLocalStorage 断裂时 MCP tool 全链路 userId fallback
- [x] **P1** `78cd291` Groq Whisper + provider fallback chain — 新 STT 引擎 + 多 provider 架构
- [x] **P1** `309d7d4` .oga → .ogg remap — Groq API 文件扩展名兼容
- [x] **P1** `bbd175e` carryoverIncludeToolCalls — session 轮转时携带 tool call 上下文
- [x] **P2** `58d5028` sdkEnv 配置 + rotation 阈值调低 — 防止 SDK compact 挂起
- [x] **P2** `b929df6` fsync restart marker — restart 前确保标记落盘
- [x] **P2** `c12dfe9` 移除手动 ack() — 根治 Telegram 409 冲突
- [x] **P3** `42ec896` fatal 错误写 pino + tsx watch 禁令文档

## 二、Extract（需从 EventBus 版本中提取重实现）

- [ ] **P0** AgentProcess 持久化子进程 — 消除每条消息 16-18s 冷启动；ConfigWatcher 配置热更新
  - 来源: `2162a3e`, `d7c365b`
  - 核心文件: agent-process.ts (InputChannel, 三态重启标志), config-watcher.ts
  - 需适配: agent.ts 中的集成代码（当前版本用 per-query spawn，需改为复用 AgentProcess）
  - 附带: transport exit hook, zombie 检测 (`d7c365b`)

- [ ] **P1** per-user callback fallback map
  - 来源: `57127c3`
  - 核心: agent-context.ts 的 setActiveCallbacks/clearActiveCallbacks
  - 解决: sendFile/notifyUser 在 AsyncLocalStorage 断裂时丢失

- [ ] **P1** mid-query context rotation
  - 来源: `0467885`
  - 核心: agent.ts 中 mid-query 检测 soft/hard 阈值，触发后台轮转或中断+轮转
  - 附带: MidQueryRotationNeeded 异常类, notifyUser 通道
  - 附带: commands.ts 命令注册表 + buildHelpText()

- [ ] **P1** Telegram pre-ack + replyTo 上下文
  - 来源: `b3a6062`
  - 核心: middleware pre-ack（推进 server-side offset，防 /restart 死循环）
  - 核心: 提取 reply_to_message 的发送者/时间/文本
  - 附带: InboundMessage.replyTo / externalUserId 字段, bindPlatformByUserId()

- [ ] **P2** summaryModel 环境变量 + truncateMiddle + zombie 自动重试
  - 来源: `ceb8d6d`
  - 核心: summaryModel 默认值读 ANTHROPIC_DEFAULT_HAIKU_MODEL 环境变量
  - 核心: truncateMiddle() Unicode 安全截断 (utils/string.ts)
  - 核心: zombie result 检测 + 自动重试（避免用户丢失首条消息）

- [ ] **P2** envelope 增强：sender 信息 + reply context + isGroup
  - 来源: `a82ac2a`, `4268413`
  - 核心: envelope 中添加 sender (platformId, name, username), reply context
  - 核心: isGroup 字段，私聊时不显示 sender（避免 agent 用第三人称）
  - 需适配: 当前 wrapMessageEnvelope() 在 index.ts

- [ ] **P3** supportsStreaming 接口
  - 来源: `575f9e8`
  - 核心: 适配器声明是否支持流式，非流式平台不发中间消息避免重复

## 三、跳过

- ~~`68144e6` post-restart notification~~ — 完全依赖 EventBus emit，main 分支有自己的实现
