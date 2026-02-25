项目初衷：openclaw bug太多，安装麻烦，对telegram的支持较差，上下文管理混乱，定时任务不稳定，无法满足我的需求，所以我决定自己写一个新的agent框架，命名为better-claw。

最开始的runtime核心选择claude code。基于claude agent sdk 开发。语言使用typescript，运行环境nodejs。

需要支持的核心功能：
+ 更好的上下文管理，以及长期记忆。实现近乎无限的交互上下文。
+ 更好的定时任务管理。
+ 更好的telegram支持，以及可拓展的消息收发接口。
+ 多用户支持。
+ cli工具。
+ 日志系统。

---

## 技术栈

| 依赖 | 用途 |
|------|------|
| `@anthropic-ai/claude-agent-sdk` | Agent 核心，query() + MCP 工具 |
| `grammy` | Telegram 机器人 |
| `node-cron` | 定时任务调度 |
| `pino` + `pino-roll` + `pino-pretty` | 结构化日志（文件+控制台） |
| `zod` (v4) | 配置校验 + MCP 工具 schema |
| `yaml` | 配置文件解析 |
| `commander` | CLI 参数解析 |
| `nanoid` | 用户 token / 任务 ID 生成 |
| `vitest` | 测试框架 |
| `tsx` | 开发环境直接运行 TS |

---

## 目录结构

```
better-claw/
├── package.json
├── tsconfig.json
├── config.example.yaml
├── src/
│   ├── index.ts                 # 入口：启动服务
│   ├── cli.ts                   # CLI 入口（运维+对话）
│   ├── config/
│   │   ├── index.ts             # 加载 YAML → 类型化对象
│   │   └── schema.ts            # Zod 配置 schema
│   ├── core/
│   │   ├── agent.ts             # Agent 会话管理（query, resume, interrupt）
│   │   ├── agent-context.ts     # AsyncLocalStorage 用户上下文
│   │   ├── queue.ts             # 每用户消息队列 + 顺序处理
│   │   ├── context.ts           # 应用层上下文管理（压缩/卸载）
│   │   └── system-prompt.ts     # System prompt 拼装
│   ├── user/
│   │   ├── manager.ts           # 用户 CRUD、token、平台绑定
│   │   ├── store.ts             # 用户数据文件 I/O
│   │   └── types.ts             # 用户类型定义
│   ├── memory/
│   │   ├── manager.ts           # 记忆读写逻辑（core + extended）
│   │   ├── tools.ts             # MCP 工具：memory_read, memory_write, memory_delete
│   │   └── types.ts             # 记忆类型定义
│   ├── cron/
│   │   ├── scheduler.ts         # node-cron 封装，触发 → agent
│   │   ├── tools.ts             # MCP 工具：cron CRUD
│   │   ├── store.ts             # crons.json 持久化
│   │   └── types.ts             # 定时任务类型定义
│   ├── adapter/
│   │   ├── interface.ts         # 统一 MessageAdapter 接口
│   │   ├── types.ts             # InboundMessage 等
│   │   ├── telegram/
│   │   │   ├── bot.ts           # grammy 初始化 + 消息处理
│   │   │   ├── adapter.ts       # TelegramAdapter implements MessageAdapter
│   │   │   └── formatter.ts     # agent 输出 → Telegram MarkdownV2
│   │   └── cli/
│   │       ├── adapter.ts       # CLIAdapter implements MessageAdapter
│   │       └── formatter.ts     # agent 输出 → 终端文本
│   ├── mcp/
│   │   └── server.ts            # createSdkMcpServer 聚合所有自定义工具
│   ├── logger/
│   │   └── index.ts             # pino 配置
│   └── utils/
│       ├── file.ts              # JSON 读写、目录创建
│       └── token.ts             # nanoid token 生成
├── data/                        # 运行时数据（gitignore）
│   ├── config.yaml
│   ├── users/
│   │   └── {userId}/
│   │       ├── profile.json
│   │       ├── memory/
│   │       │   ├── core.json
│   │       │   └── extended/
│   │       ├── crons.json
│   │       └── history.json
│   └── logs/
└── tests/
    ├── e2e/                     # 端到端测试
    ├── core/
    ├── user/
    ├── memory/
    ├── cron/
    └── adapter/
```

---

## 关键设计决策

### 1. AsyncLocalStorage 传递用户上下文

MCP 工具的 handler 无法传入自定义上下文。使用 `AsyncLocalStorage<{ userId: string }>` 在 `query()` 调用前设置，工具 handler 内通过 `agentContext.getStore()` 读取 userId。

### 2. 权限模式

使用 `bypassPermissions` + `allowDangerouslySkipPermissions: true`，因为这是无人值守的服务端 agent。

### 3. 消息推送粒度

默认推送 assistant 中间文本 + 最终结果。可通过 `messagePush` 配置调整。

### 4. 记忆系统

分两层：core（自动注入 system prompt）和 extended（agent 按需读取）。agent 自行决定存入哪一层。

### 5. Cron 触发的响应广播

定时任务触发时，agent 回复通过用户所有已绑定平台的 adapter 广播。

### 6. 认证

agent-sdk 复用本地 Claude Code CLI 的认证，config.yaml 中 apiKey 为可选。

### 7. MCP 工具命名

SDK 自动命名为 `mcp__{server_name}__{tool_name}`，如 `mcp__better-claw__memory_read`。

---

## 数据流

### 用户消息流

```
[平台] → [Adapter.start handler]
              │
              ├── 是命令？(/bind, /stop)
              │     ├── /bind token → UserManager.bindPlatform()
              │     └── /stop → Queue.interrupt()
              │
              └── 普通消息
                    │
                    ├── UserManager.resolveUser() → 未绑定？回复"请先绑定"
                    │
                    └── Queue.enqueue({userId, text, reply, showTyping})
                          │
                          └── [队列处理器]（每用户顺序执行）
                                │
                                ├── showTyping()
                                ├── agentContext.run({userId}, () =>
                                │     sendToAgent(userId, text, onMessage))
                                │
                                ├── onMessage:
                                │     ├── AssistantMessage → reply(中间文本)
                                │     └── ResultMessage → log
                                │
                                └── 完成 → 处理下一条
```

### 定时任务流

```
[node-cron 触发] → scheduler.onTrigger(userId, task)
                      │
                      ├── agentContext.run({userId}, () =>
                      │     sendToAgent(userId, task.prompt, onMessage))
                      │
                      └── onMessage → 查找用户所有已绑定平台 → 广播回复
```

---

## 实施阶段与进度

### Phase 1：基础 MVP ✅ 已完成

**目标**：单用户通过 CLI 与 agent 对话，支持记忆。

已实现：
- config/ — 配置加载 + Zod 校验（所有字段带默认值）
- logger/ — pino 日志（控制台 + 文件轮转）
- utils/ — 文件 I/O、nanoid token 生成
- user/ — 用户类型、文件存储、管理器（含绑定缓存）
- memory/ — core + extended 两层记忆、MCP 工具
- mcp/server.ts — 聚合 MCP 服务器
- core/ — agent-context, system-prompt, agent (query/resume/interrupt), queue
- adapter/ — 接口 + CLI 适配器
- index.ts — 启动入口（自动创建默认用户 + CLI 绑定）
- e2e 测试通过（SDK basic, MCP server, Full app startup）

### Phase 2：Telegram + 多用户 ✅ 已完成

已实现：
- adapter/telegram/ — TelegramAdapter（grammy long polling）+ formatter（MarkdownV2 转义 + 消息切分）
- cli.ts — CLI 管理工具（user create/list/info/bind, chat）
- core/queue.ts — typing 状态定期刷新（4s 间隔，适配 Telegram 5s 过期）
- index.ts — 条件启动 Telegram 适配器（config.telegram.botToken）
- 多用户绑定、队列打断、session resume 均已就绪
- 测试通过：telegram-formatter（7 tests）, user/manager（8 tests）, e2e（3 tests）

### Phase 3：定时任务 ✅ 已完成

已实现：
- cron/types.ts — CronTask 类型定义
- cron/store.ts — crons.json 持久化读写
- cron/scheduler.ts — node-cron 封装（CRUD + 调度 + 启动加载）
- cron/tools.ts — MCP 工具：cron_create, cron_list, cron_update, cron_delete
- mcp/server.ts — 聚合 memory + cron 工具
- index.ts — initScheduler + handleCronTrigger（广播到用户所有绑定平台）
- agent.ts — allowedTools 加入 cron 工具
- 测试通过：cron/scheduler（9 tests），全部 27 tests

### Phase 4：上下文管理 + 完善（下一步）

1. `src/core/context.ts` — 应用层上下文压缩
2. Session resumption 持久化
3. Compaction beta 启用
4. 优雅关闭完善
5. 错误处理 + 重试
6. Token 用量统计

---

## 运行与测试

### 开发运行

```bash
# 直接运行（独立终端）
npx tsx src/index.ts

# 开发模式（自动重启）
npm run dev
```

### 运行测试

**重要**：在 Claude Code 会话内运行测试时，必须去掉 CLAUDECODE 环境变量，否则 agent-sdk 会检测到嵌套 Claude Code 会话并拒绝启动。

```bash
# e2e 测试（需要已认证的 Claude Code CLI）
env -u CLAUDECODE npx vitest run tests/e2e/

# 全部测试
env -u CLAUDECODE npx vitest run
```

独立终端中（非 Claude Code 会话内）不需要 `env -u CLAUDECODE`。

### 配置

配置文件位于 `data/config.yaml`，所有字段都有默认值。最小配置为空文件（仅注释即可）。agent-sdk 复用本地 Claude Code CLI 的认证。

参考 `config.example.yaml` 查看所有可配置项。

### 注意事项

- pino-roll 的 maxSize 格式为数字+单字母后缀：`10m`、`1g`、`500k`（不是 `10MB`）
- Zod v4 的 `.default()` 对 object schema 需要工厂函数提供完整默认值
- TypeScript 无法追踪闭包回调内的变量赋值，需从回调内 return 结果

### 踩坑记录

开发过程中遇到的问题和解决方案，避免重复犯错：

1. **SDKResultMessage 是联合类型**：`SDKResultMessage` 是 success | error 的联合体，必须先检查 `result.subtype === 'success'` 才能访问 `.result` 属性，否则 TypeScript 报错。

2. **ESM 模块中不能用 `require()`**：项目是 ESM（`"type": "module"`），构造函数中不能使用 `require()`。需要异步导入时使用 `await import()`，但构造函数不能是 async 的，所以需要改用静态工厂方法 `static async create()`。

3. **grammy 使用 node-fetch 而非原生 fetch**：grammy 底层依赖 `node-fetch`，不是 Node.js 原生 `fetch`。因此 `undici` 的 `ProxyAgent`（通过 `dispatcher` 选项）不生效。必须使用 `https-proxy-agent`，通过 `baseFetchConfig: { agent }` 传给 grammy。

4. **Telegram API 需要代理**：中国大陆网络环境无法直接访问 `api.telegram.org`。TelegramAdapter 支持代理配置，优先级：config.yaml 中的 `telegram.proxy` > 环境变量 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`。

5. **grammy `bot.start()` 需要错误处理**：`bot.start()` 返回 Promise 但不会被 await（long polling 持续运行），如果不加 `.catch()`，启动失败（如 409 Conflict、网络超时）会成为 unhandled rejection 且没有任何日志。

6. **Telegram webhook 残留导致 long polling 静默失败**：如果之前设置过 webhook，启动 long polling 前必须调用 `bot.api.deleteWebhook()` 清除，否则 bot 不会收到任何消息且没有错误提示。

7. **遇到的错误都要记录到此文件的踩坑记录中**，帮助后续开发避免重复踩坑。
