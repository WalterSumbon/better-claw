import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logger/index.js';

const execFileAsync = promisify(execFile);

/**
 * 使用 ffmpeg 将音频文件转换为 16kHz 单声道 WAV 格式。
 *
 * @param inputPath - 输入音频文件路径。
 * @param outputPath - 输出 WAV 文件路径。
 */
async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-i', inputPath,
    '-ar', '16000',
    '-ac', '1',
    '-y',
    outputPath,
  ]);
}

/**
 * 使用 whisper.cpp CLI 将音频文件转录为文本。
 *
 * 流程：输入音频 → ffmpeg 转 WAV → whisper 转录 → 返回文本。
 * 需要系统安装 ffmpeg 和 whisper.cpp。
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

  const wavPath = audioPath.replace(/\.[^.]+$/, '.wav');

  try {
    // 转换为 WAV。
    await convertToWav(audioPath, wavPath);

    // 调用 whisper CLI。
    const args = [
      '-m', sttConfig.modelPath,
      '-f', wavPath,
      '--output-txt',
      '--no-timestamps',
    ];
    if (sttConfig.language) {
      args.push('-l', sttConfig.language);
    }

    await execFileAsync(sttConfig.whisperPath, args, { timeout: 120_000 });

    // whisper 默认输出到 {wavPath}.txt。
    const txtPath = `${wavPath}.txt`;
    if (!existsSync(txtPath)) {
      log.error({ txtPath }, 'Whisper output file not found');
      return null;
    }

    const text = readFileSync(txtPath, 'utf-8').trim();

    // 清理临时文件。
    unlinkSync(txtPath);
    unlinkSync(wavPath);

    if (!text) {
      log.warn({ audioPath }, 'Whisper returned empty transcription');
      return null;
    }

    log.info({ audioPath, textLength: text.length }, 'Audio transcribed');
    return text;
  } catch (err) {
    log.error({ err, audioPath }, 'Audio transcription failed');
    // 清理临时 WAV。
    if (existsSync(wavPath)) {
      try { unlinkSync(wavPath); } catch { /* ignore */ }
    }
    return null;
  }
}
