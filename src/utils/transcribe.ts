import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logger/index.js';

const execFileAsync = promisify(execFile);

/** transcribeAudio 的返回结果。 */
export interface TranscribeResult {
  /** 转录文本，不可用时为 null。 */
  text: string | null;
  /** 转录不可用的原因（供 agent 决策参考）。仅当 text 为 null 时有值。 */
  unavailableReason?: string;
}

// ---------------------------------------------------------------------------
// 依赖可用性检查（带缓存，进程生命周期内只检查一次）
// ---------------------------------------------------------------------------

let cachedDepCheck: { available: boolean; reason?: string } | null = null;

/**
 * 检查 whisper 和 ffmpeg 是否可用。
 * 结果会被缓存，后续调用直接返回缓存值。
 */
async function checkDependencies(whisperPath: string): Promise<{ available: boolean; reason?: string }> {
  if (cachedDepCheck) return cachedDepCheck;

  const log = getLogger();

  // 检查 whisper。
  try {
    await execFileAsync(whisperPath, ['--help'], { timeout: 15_000 });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const reason = whisperPath === 'whisper'
        ? 'whisper 命令未找到，请安装: pip install openai-whisper'
        : `whisper 未找到（配置路径: ${whisperPath}），请确认路径正确或安装: pip install openai-whisper`;
      log.warn(reason);
      cachedDepCheck = { available: false, reason };
      return cachedDepCheck;
    }
    if (code === 'EACCES') {
      const reason = `whisper 无执行权限（路径: ${whisperPath}）`;
      log.warn(reason);
      cachedDepCheck = { available: false, reason };
      return cachedDepCheck;
    }
    // --help 返回非零退出码但命令本身存在，视为可用。
  }

  // 检查 ffmpeg（whisper 内部依赖）。
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 10_000 });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const reason = 'ffmpeg 未安装，whisper 依赖 ffmpeg 处理音频格式，请安装: brew install ffmpeg 或 apt install ffmpeg';
      log.warn(reason);
      cachedDepCheck = { available: false, reason };
      return cachedDepCheck;
    }
    if (code === 'EACCES') {
      const reason = 'ffmpeg 无执行权限';
      log.warn(reason);
      cachedDepCheck = { available: false, reason };
      return cachedDepCheck;
    }
  }

  log.info('speechToText dependencies (whisper, ffmpeg) verified');
  cachedDepCheck = { available: true };
  return cachedDepCheck;
}

/**
 * 使用 OpenAI Whisper CLI 将音频文件转录为文本。
 *
 * 流程：输入音频 → whisper 转录 → 返回文本。
 * 需要系统安装 openai-whisper（brew install openai-whisper 或 pip install openai-whisper）。
 * Whisper 内部使用 ffmpeg 处理音频格式，支持 .oga, .ogg, .mp3 等常见格式。
 *
 * @param audioPath - 输入音频文件路径（支持 .oga, .ogg, .mp3 等 ffmpeg 可处理的格式）。
 * @returns 转录结果，包含文本和失败原因。
 */
export async function transcribeAudio(audioPath: string): Promise<TranscribeResult> {
  const log = getLogger();
  const config = getConfig();
  const sttConfig = config.speechToText;

  if (!sttConfig) {
    log.warn('speechToText not configured, skipping transcription');
    return { text: null };
  }

  // 先检查依赖是否可用。
  const deps = await checkDependencies(sttConfig.whisperPath);
  if (!deps.available) {
    return { text: null, unavailableReason: deps.reason };
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
      return { text: null, unavailableReason: 'whisper 执行完成但未生成输出文件' };
    }

    const text = readFileSync(txtPath, 'utf-8').trim();

    if (!text) {
      log.warn({ audioPath }, 'Whisper returned empty transcription');
      return { text: null, unavailableReason: 'whisper 转录结果为空' };
    }

    log.info({ audioPath, textLength: text.length }, 'Audio transcribed');
    return { text };
  } catch (err) {
    log.error({ err, audioPath }, 'Audio transcription failed');
    const errMsg = err instanceof Error ? err.message : String(err);
    return { text: null, unavailableReason: `whisper 转录过程出错: ${errMsg}` };
  } finally {
    // 清理临时目录。
    try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
  }
}
