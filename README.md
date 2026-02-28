# Better-Claw

### Turn your Claude Code into a ClawdBot.

把你本地的 Claude Code 变成一个随时在线的私人 AI 助手 —— 通过 Telegram 对话、语音消息与它交互，它拥有和你桌面 Claude Code 完全相同的能力：MCP 工具、Skills、文件操作、Shell 命令，外加长期记忆和定时任务。

基于 [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk) 构建，支持 Telegram / CLI 多平台接入和多用户管理。

## 前置依赖

- **Node.js** ≥ 20
- **Claude Code CLI** 已安装并完成认证（`claude --version` 可正常输出）— Agent SDK 复用 CLI 认证，无需单独配置 API Key

## 快速开始

```bash
# 1. 克隆仓库并安装依赖。
git clone https://github.com/your-org/better-claw.git
cd better-claw
npm install

# 2. 初始化数据目录（首次运行会自动创建并复制 config.example.yaml）。
npx tsx src/index.ts
# 输出：Initialized new data directory: .../data
# 输出：Please edit .../data/config.yaml and restart.

# 3. 编辑配置文件，填入实际值（至少检查 anthropic 和 telegram 部分）。
$EDITOR data/config.yaml

# 4. 启动服务。
npx tsx src/index.ts
```

## 数据目录 (`--data-dir`)

每个数据目录对应一个独立的 agent 实例，包含配置、用户数据、日志和会话历史。通过 `--data-dir` 参数可以在同一台机器上运行多个 agent 实例：

```bash
# 使用默认 ./data/ 目录。
npx tsx src/index.ts

# 指定自定义数据目录。
npx tsx src/index.ts --data-dir /path/to/my-agent

# start.sh 自动重启模式也支持 --data-dir。
./start.sh --data-dir /path/to/my-agent
```

**首次使用新目录时**，程序会自动创建目录、复制 `config.example.yaml` 作为初始配置，然后退出并提示编辑配置文件。

## 配置文件

配置文件位于 `<data-dir>/config.yaml`，所有字段都有默认值。最小可运行配置为空文件（Agent SDK 使用 CLI 认证）。

完整配置项参考 [config.example.yaml](config.example.yaml)。

关键配置说明：

| 字段 | 说明 |
|------|------|
| `anthropic.authToken` / `baseUrl` | 通过代理服务器认证时使用 |
| `telegram.botToken` | 不配置则不启动 Telegram 适配器 |
| `logging.directory` | 相对路径基于 dataDir 解析，默认 `logs` |
| `session.rotationTimeoutHours` | 超过此小时数自动开新会话 |

## 内置 Skills

仓库自带以下 Claude Code skills，启动时自动通过 symlink 安装到 `~/.claude/skills/`：

| Skill | 说明 | 额外依赖 |
|-------|------|----------|
| `playwright` | 浏览器自动化（导航、截图、表单填写、数据抓取） | 需配置 Playwright MCP server |
| `peekaboo` | macOS 屏幕截图与 GUI 自动化 | 需配置 Peekaboo MCP server |
| `speech-to-text` | 语音/音频文件转录为文字 | 需安装 `openai-whisper` 和 `ffmpeg` |

Playwright 和 Peekaboo 需要在 `~/.claude/settings.json` 中配置对应的 MCP server，参考各 skill 目录下的 `SKILL.md` 说明。

## 对话命令

在 Telegram 或 CLI 对话中可使用以下命令：

| 命令 | 说明 |
|------|------|
| `/bind <token>` | 绑定账号，将当前平台用户关联到系统用户 |
| `/stop` | 中断当前正在执行的 AI 响应，队列中的后续消息不受影响 |
| `/new` | 归档当前会话并开始一个全新会话 |
| `/restart` | 重启整个服务进程（由外层进程管理器重新拉起） |
| `/admin <subcommand>` | 管理员命令，支持用户管理和工作组管理（仅 admin 用户可用，详见 `/admin help`） |

## CLI 工具

所有子命令都支持 `--data-dir`（简写 `-d`）指定数据目录。

### 用户管理

使用前需要先通过 CLI 创建用户，然后在对话中用 `/bind` 绑定平台账号：

```bash
# 创建用户，会输出用户 ID 和 token。
npx tsx src/cli.ts user create -n "Alice"

# 在 Telegram 对话中发送 /bind <token> 完成绑定。
# 也可通过 CLI 直接绑定（支持 telegram / cli / qq / wechat / dingtalk）：
npx tsx src/cli.ts user bind -t <token> -p telegram -u <telegramUserId>

# 查看所有用户。
npx tsx src/cli.ts user list

# 查看用户详情。
npx tsx src/cli.ts user info <userId>

# 修改显示名称。
npx tsx src/cli.ts user rename <userId> "Bob"

# 设置权限组。
npx tsx src/cli.ts user set-group <userId> admin

# 删除用户及其所有数据（交互式确认）。
npx tsx src/cli.ts user delete <userId>
```

### 工作组管理

工作组用于跨用户协作，共享一个 workspace 目录。配置持久化在 `config.yaml` 的 `permissions.workGroups` 中。

```bash
# 创建工作组。
npx tsx src/cli.ts workgroup create team-alpha

# 添加成员（默认 rw 读写权限，可用 -a r 指定只读）。
npx tsx src/cli.ts workgroup add-member team-alpha <userId>
npx tsx src/cli.ts workgroup add-member team-alpha <userId> -a r

# 查看工作组成员。
npx tsx src/cli.ts workgroup members team-alpha

# 修改成员权限（r 或 rw）。
npx tsx src/cli.ts workgroup set-access team-alpha <userId> r

# 查看工作组详情。
npx tsx src/cli.ts workgroup info team-alpha

# 列出所有工作组。
npx tsx src/cli.ts workgroup list

# 移除成员。
npx tsx src/cli.ts workgroup remove-member team-alpha <userId>

# 删除工作组及其 workspace（交互式确认）。
npx tsx src/cli.ts workgroup delete team-alpha
```

### 交互式对话

```bash
# CLI 对话模式（开发调试用）。
npx tsx src/cli.ts chat
```

## 开发

```bash
# 开发模式运行。
npm run dev

# CLI 对话模式。
npm run dev:chat

# 编译 TypeScript。
npm run build

# 运行测试（在 Claude Code 会话内需去掉 CLAUDECODE 环境变量）。
env -u CLAUDECODE npx vitest run

# 监听模式测试。
env -u CLAUDECODE npx vitest
```

## 目录结构

```
better-claw/
├── src/
│   ├── index.ts              # 服务入口
│   ├── cli.ts                # CLI 管理工具入口
│   ├── config/               # YAML 配置加载 + Zod 校验
│   ├── core/                 # Agent 会话、消息队列、上下文管理
│   ├── adapter/              # 消息平台适配器（CLI、Telegram）
│   ├── memory/               # 两层记忆系统（core + extended）
│   ├── cron/                 # 定时任务调度与管理
│   ├── mcp/                  # MCP 工具服务器
│   ├── user/                 # 用户管理与数据存储
│   └── logger/               # pino 日志（控制台 + 文件轮转）
├── tests/                    # vitest 测试
├── data/                     # 默认数据目录（gitignore）
├── config.example.yaml       # 配置模板
├── start.sh                  # 自动重启启动脚本
└── AGENT.md                  # 架构设计文档
```

## 数据目录内部结构

```
<data-dir>/
├── config.yaml
├── logs/
│   └── app.*.log
└── users/
    └── <userId>/
        ├── profile.json
        ├── session.json
        ├── workspace/
        ├── sessions/
        ├── memory/
        │   ├── core.json
        │   └── extended/
        └── crons.json
```

## License

MIT
