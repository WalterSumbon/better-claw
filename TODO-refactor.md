# refactor/clean-restart 分支重构 TODO

基于阶段四末尾 (`1c23d2a`) 创建，从阶段五/六中提取有价值的改动。

---

## 一、Cherry-pick（独立修复/功能，可直接移植）

- [ ] **P0** `c3ee471` resolveUserId fallback — AsyncLocalStorage 断裂时 MCP tool 全链路 userId fallback
- [ ] **P1** `78cd291` Groq Whisper + provider fallback chain — 新 STT 引擎 + 多 provider 架构
- [ ] **P1** `309d7d4` .oga → .ogg remap — Groq API 文件扩展名兼容
- [ ] **P1** `bbd175e` carryoverIncludeToolCalls — session 轮转时携带 tool call 上下文
- [ ] **P2** `58d5028` sdkEnv 配置 + rotation 阈值调低 — 防止 SDK compact 挂起
- [ ] **P2** `b929df6` fsync restart marker — restart 前确保标记落盘
- [ ] **P2** `c12dfe9` 移除手动 ack() — 根治 Telegram 409 冲突
- [ ] **P3** `42ec896` fatal 错误写 pino + tsx watch 禁令文档

## 二、Extract（需从 EventBus 版本中提取重实现）

- [ ] **P0** `2162a3e` AgentProcess 持久化子进程 — 消除每条消息 16-18s 冷启动；ConfigWatcher 配置热更新
- [ ] **P1** `57127c3` per-user callback fallback map — setActiveCallbacks/clearActiveCallbacks
- [ ] **P1** `0467885` mid-query context rotation — 对话中途检测阈值触发轮转；commands.ts 命令注册表
- [ ] **P1** `b3a6062` Telegram pre-ack + replyTo 上下文 + bindPlatformByUserId
- [ ] **P2** `d7c365b` transport exit hook + zombie 检测（依赖 AgentProcess）
- [ ] **P2** `ceb8d6d` summaryModel 环境变量、truncateMiddle、zombie 自动重试
- [ ] **P2** `a82ac2a` envelope 增强：sender 信息 + reply context 格式化
- [ ] **P2** `4268413` isGroup 字段，私聊不显示 sender
- [ ] **P3** `575f9e8` supportsStreaming 接口区分流式/非流式适配器

## 三、跳过

- ~~`68144e6` post-restart notification~~ — 完全依赖 EventBus emit，main 分支有自己的实现
