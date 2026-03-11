/** 命令元信息。 */
export interface CommandDef {
  name: string;
  args?: string;
  description: string;
}

/** 所有已注册的用户命令（单一数据源）。 */
export const commands: CommandDef[] = [
  { name: 'bind', args: '<token>', description: 'Link your platform account' },
  { name: 'stop', description: 'Interrupt current response' },
  { name: 'new', description: 'Start a new session' },
  { name: 'restart', description: 'Restart the service' },
  { name: 'context', description: 'Show current context usage' },
  { name: 'admin', args: '<...>', description: 'Admin commands (admin only)' },
  { name: 'help', description: 'Show available commands' },
];

/**
 * 根据命令注册表生成帮助文本。
 *
 * @param prefix - 命令前缀（如 `/` 或 `.`）。
 */
export function buildHelpText(prefix: string): string {
  const entries = commands.map((cmd) => {
    const usage = cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name;
    return { usage: `${prefix}${usage}`, desc: cmd.description };
  });
  const maxLen = Math.max(...entries.map((e) => e.usage.length));
  const lines = entries.map((e) => `  ${e.usage.padEnd(maxLen)}  — ${e.desc}`);
  return ['Available commands:', ...lines].join('\n');
}
