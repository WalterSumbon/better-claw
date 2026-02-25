import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logger/index.js';

const execFileAsync = promisify(execFile);

/**
 * 使用 OpenAI Whisper CLI 将音频文件转录为文本。
 *
 * 流程：输入音频 → whisper 转录 → 返回文本。
 * 需要系统安装 openai-whisper（brew install openai-whisper 或 pip install openai-whisper）。
 * Whisper 内部使用 ffmpeg 处理音频格式，支持 .oga, .ogg, .mp3 等常见格式。
 *
 * @param audioPath - 输入音频文件路径（支持 .oga, .ogg, .mp3 等 ffmpeg 可处理的格式）。
 * @returns 转录文本，转录失败时返回 null。
 */
export async function transcribeAudio(audioPath: string): Promise<string | null> {
  const log = getLogger();
  const config = getConfig();
  const sttConfig = config.speechToText;

  if (!sttConfig) {
    log.warn('speechToText not configured, skipping transcription');
    return null;
  }

  // 创建临时目录存放 whisper 输出文件。
  const tempDir = mkdtempSync(join(tmpdir(), 'whisper-'));

  try {
    // 调用 OpenAI Whisper CLI。
    const args = [
      audioPath,
      '--model', sttConfig.model,
      '--output_format', 'txt',
      '--output_dir', tempDir,
    ];
    if (sttConfig.language) {
      args.push('--language', sttConfig.language);
    }

    await execFileAsync(sttConfig.whisperPath, args, { timeout: 120_000 });

    // OpenAI Whisper 输出文件名为 {原文件名去扩展名}.txt。
    const baseName = basename(audioPath).replace(/\.[^.]+$/, '');
    const txtPath = join(tempDir, `${baseName}.txt`);
    if (!existsSync(txtPath)) {
      log.error({ txtPath }, 'Whisper output file not found');
      return null;
    }

    const text = readFileSync(txtPath, 'utf-8').trim();

    if (!text) {
      log.warn({ audioPath }, 'Whisper returned empty transcription');
      return null;
    }

    log.info({ audioPath, textLength: text.length }, 'Audio transcribed');
    return text;
  } catch (err) {
    log.error({ err, audioPath }, 'Audio transcription failed');
    return null;
  } finally {
    // 清理临时目录。
    try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
  }
}
