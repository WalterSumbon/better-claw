import { createInterface, type Interface as ReadlineInterface } from 'readline';
import type { MessageAdapter, SendFileOptions } from '../interface.js';
import type { InboundMessage } from '../types.js';
import { formatForTerminal } from './formatter.js';

/** CLI 适配器：通过终端 stdin/stdout 与 agent 交互。 */
export class CLIAdapter implements MessageAdapter {
  readonly platform = 'cli' as const;
  readonly commandPrefix = '/';
  private rl: ReadlineInterface | null = null;
  private running = false;

  /**
   * 启动 CLI 适配器，监听终端输入。
   *
   * @param handler - 收到消息时的回调。
   */
  async start(handler: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.running = true;

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });

    console.log('Better-Claw CLI ready. Type your message (Ctrl+C to exit).\n');
    this.rl.prompt();

    this.rl.on('line', async (line: string) => {
      const text = line.trim();
      if (!text) {
        this.rl?.prompt();
        return;
      }

      const isCommand = text.startsWith('/');
      let commandName: string | undefined;
      let commandArgs: string | undefined;

      if (isCommand) {
        const spaceIdx = text.indexOf(' ');
        if (spaceIdx === -1) {
          commandName = text.slice(1);
          commandArgs = '';
        } else {
          commandName = text.slice(1, spaceIdx);
          commandArgs = text.slice(spaceIdx + 1).trim();
        }
      }

      const msg: InboundMessage = {
        platform: 'cli',
        platformUserId: 'cli_user',
        text,
        raw: line,
        isCommand,
        commandName,
        commandArgs,
      };

      await handler(msg);
      if (this.running) {
        this.rl?.prompt();
      }
    });

    this.rl.on('close', () => {
      this.running = false;
      console.log('\nGoodbye!');
      process.exit(0);
    });
  }

  /** 停止 CLI 适配器。 */
  async stop(): Promise<void> {
    this.running = false;
    this.rl?.close();
  }

  /**
   * 在终端输出文本。
   *
   * @param _platformUserId - 忽略（CLI 只有一个用户）。
   * @param text - 要输出的文本。
   */
  async sendText(_platformUserId: string, text: string): Promise<void> {
    const formatted = formatForTerminal(text);
    console.log(`\n${formatted}\n`);
  }

  /**
   * 在终端输出文件信息（CLI 无法发送真正的文件）。
   *
   * @param _platformUserId - 忽略。
   * @param filePath - 文件路径。
   * @param options - 发送选项。
   */
  async sendFile(_platformUserId: string, filePath: string, options?: SendFileOptions): Promise<void> {
    const typeInfo = options?.type ? ` (${options.type})` : '';
    const captionInfo = options?.caption ? `\n  Caption: ${options.caption}` : '';
    console.log(`\n[File${typeInfo}: ${filePath}]${captionInfo}\n`);
  }

  /**
   * 在终端显示 thinking 状态。
   *
   * @param _platformUserId - 忽略。
   */
  async showTyping(_platformUserId: string): Promise<void> {
    process.stdout.write('Thinking...\r');
  }
}
