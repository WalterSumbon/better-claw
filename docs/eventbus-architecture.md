# EventBus 架构设计

> 状态：设计中（未实现）
> 最后更新：2026-03-12

## 背景

现有架构中消息队列存在几个核心问题：

1. `/stop` 指令无法打断正在运行的 SDK 循环（grammy 串行处理导致控制命令被阻塞）
2. 硬轮转阈值不能及时中断（for-await 循环内部检查依赖 SDK yield）
3. 各队列之间相互阻塞

决定推翻现有队列架构，改用 **单一 EventBus** 模式。

## 核心原则

- **Bus 只做一件事**：收事件、发事件、不等任何人
- **无阻塞**：emit 是 fire-and-forget，listener 异常不影响其他 listener
- **零业务逻辑**：Bus 不理解事件内容，不做路由判断
- **listener 自治**：每个 listener 内部自行管理状态和队列

## 三个核心部件

### 1. EventBus

纯分发，不含业务逻辑。大约 50 行代码。

### 2. Adapter

平台接入层。每个平台（Telegram / CLI / DingTalk / AgentBox / Agentelegram）一个 adapter。

- 收到平台消息 → `bus.emit('msg:in', payload)`
- 监听 `msg:out` → 发送到对应平台
- 监听 `agent:busy/idle` → 映射为平台特定的状态展示（如 Telegram typing）

**Cron 和 Webhook 也是特殊的 Adapter：**

- Cron adapter：定时触发 `emit('msg:in', { userId, source: 'cron', text: prompt })`
- Webhook adapter：
  - 需要 agent 响应的请求 → `emit('msg:in')`
  - 纯通知类消息（不唤起 agent） → 直接 `emit('msg:out')`

### 3. Agent

每个用户一个 Agent 实例，内部管理 SDK 调用、session、排队。

- 监听 `msg:in`（过滤属于自己 userId 的事件）
- 根据消息内容自行决定处理方式（普通 query、命令、abort 等）
- 流式输出过程中逐片段 `emit('msg:out')`
- 状态切换时 `emit('agent:busy')` / `emit('agent:idle')`

#### Agent 内部架构

Agent 内部维护**两个独立队列**，各自串行执行，互不阻塞：

```
msg:in listener
  → Agent 判断内容（指令前缀可配置）
    ├─ 指令（/stop /new /context ...）→ 指令队列 → 指令执行器
    └─ 普通消息 → 普通消息队列 → query 执行器
```

**指令队列**：
- 独立于普通消息队列，不会被长时间运行的 SDK query 阻塞
- 指令执行器有权干预普通队列（如 abort 当前 query），反过来不行
- 指令可能包含多个步骤（如 `/new`：先 abort 当前 query → 等 abort 完成 → rotate session）
- 是否是指令由 Agent 模块决定，指令前缀可配置

**普通消息队列 — 三种策略（可配置）**：
- **sequential**（默认）：排队依次执行
- **merge**：当前 query 正在执行时，后续消息累积；当前执行完后将累积消息用 envelope 换行拼接合并为一条发给 SDK
- **interrupt**：新消息到来时 abort 当前 query，新消息顶上去执行

**abort 语义**：
- 只中断当前正在执行的 query，不清空队列
- 已完成的 tool loop 结果保留在 conversation history，只是不再继续循环
- 通过 `AbortController.abort()` 通知 SDK 退出 `for await` 循环

**query 执行流程**：

```typescript
async processQueue() {
  while (queue.length > 0) {
    const msg = queue.shift()  // 或 merge 多条
    this.abortController = new AbortController()
    bus.emit('agent:busy', { userId })

    try {
      for await (const chunk of sdk.query(msg.text, {
        signal: this.abortController.signal
      })) {
        bus.emit('msg:out', { streaming: true, text: chunk })
      }
      bus.emit('msg:out', { text: fullText })  // 完整消息
    } catch (e) {
      if (e.name === 'AbortError') { /* 正常中断，已完成的 tool loop 已保留 */ }
    }

    bus.emit('agent:idle', { userId })
  }
}
```

## 事件定义

### 事件类型

| 事件 | 方向 | 说明 |
|------|------|------|
| `msg:in` | Adapter → Agent | 所有入站消息，不区分命令/普通消息/cron |
| `msg:out` | Agent → Adapter | 所有出站消息，包含文本和文件 |
| `agent:busy` | Agent → Adapter | Agent 开始处理，adapter 可映射为 typing 等 |
| `agent:idle` | Agent → Adapter | Agent 处理完毕 |

### Payload 类型定义

```typescript
// ---- 事件映射（用于泛型约束） ----

interface EventMap {
  'msg:in': MsgInPayload
  'msg:out': MsgOutPayload
  'agent:busy': AgentStatePayload
  'agent:idle': AgentStatePayload
}

// ---- msg:in ----

interface MsgInPayload {
  userId: string          // 哪个用户
  source: string          // 来源 adapter: 'telegram' | 'cli' | 'cron' | 'webhook' | 'agentelegram' | ...
  text?: string           // 文本内容
  files?: FileAttachment[] // 附件（图片/语音/文档）
}

// ---- msg:out ----

interface MsgOutPayload {
  userId: string
  target: string          // 目标 adapter，从 msg:in.source 透传；'*' = 广播到所有 adapter
  text?: string
  files?: FileAttachment[]
  streaming?: boolean     // true = 流式增量片段
  final?: boolean         // true = 流的最后一块（streaming 也为 true）
  // 没有 streaming 字段 = 完整消息
}

// ---- agent 状态 ----

interface AgentStatePayload {
  userId: string
  target?: string         // 触发源 adapter（可选）
}

// ---- 文件附件 ----

interface FileAttachment {
  type: 'image' | 'audio' | 'document' | 'video'
  path?: string           // 本地文件路径
  url?: string            // 远程 URL
  mimeType?: string       // MIME 类型，如 'image/png', 'audio/ogg'
  filename?: string
}
```

### 流式输出协议

Agent 调用 SDK 时，每次 yield 产生增量文本：

1. **流式片段**：`emit('msg:out', { streaming: true, text: "增量内容" })`
2. **流式结束**：`emit('msg:out', { streaming: true, final: true, text: "最后一段" })`
3. **完整消息**：`emit('msg:out', { text: "完整回复全文" })`（无 streaming 字段）

Adapter 按需选择监听：

- **支持流式的 adapter**（如 Telegram 通过 editMessage 模拟、agentelegram 原生流式）：监听 `streaming: true` 的事件
- **不支持流式的 adapter**：只监听无 streaming 字段的完整消息

这样每个 adapter 不需要自己实现累积逻辑。

## EventBus 实现

### API

```typescript
class EventBus {
  on<K extends keyof EventMap>(event: K, fn: (payload: EventMap[K]) => void): () => void
  once<K extends keyof EventMap>(event: K, fn: (payload: EventMap[K]) => void): () => void
  onAny(fn: (event: string, payload: unknown) => void): () => void
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void
}
```

- `on()` — 注册监听，返回 unsubscribe 函数
- `once()` — 监听一次后自动取消
- `onAny()` — 监听所有事件（用于 log listener）
- `emit()` — 触发事件，fire-and-forget

不暴露 `off()`，通过 `on()` 返回的 unsubscribe 函数取消监听。

### 实现要点

- listener 异常用 try-catch 吞掉，但必须 log 出来（不能静默丢失）
- emit 先通知 anyListeners，再通知具体 listeners
- 全部同步执行，不引入异步调度
- 泛型约束事件名和 payload 类型

### Log Listener

通过 `onAny()` 实现，监听所有事件并输出结构化日志：

```typescript
bus.onAny((event, payload) => {
  logger.debug({ event, payload }, '[EventBus]')
})
```

## 管理通道

Agent 状态管理操作（MCP 激活/停用、Skill 安装/激活、Memory CRUD、Cron CRUD）**不走 EventBus**，通过直接方法调用实现。

原因：

1. **语义不匹配** — 管理操作是 request-response，需要同步返回结果；Bus 是 fire-and-forget
2. **现有模式已验证** — agentelegram 的 MgmtHandler 就是直接方法调用，工作良好
3. **对话中的管理请求** — 用户在聊天中说"关掉某个 MCP"，这走 `msg:in`，Agent（SDK）自己有工具能力直接执行

管理操作产生的副作用如果需要广播（如配置变更通知），可以在操作完成后 emit 通知事件。但这是可选的，不是核心流程。

## TODO

- [ ] 群聊支持：可能需要在 payload 中增加 `channelId` 字段来区分同一用户的不同会话
- [ ] 实现 EventBus
- [ ] 改造 Adapter 层
- [ ] 改造 Agent / Session
- [ ] Cron adapter 化
- [ ] Webhook adapter 化
