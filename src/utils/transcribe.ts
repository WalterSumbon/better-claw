import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename, extname } from 'path';
import { getConfig } from '../config/index.js';
import type { AppConfig } from '../config/schema.js';
import { getLogger } from '../logger/index.js';

/** providers 数组中单个条目的类型。 */
type ProviderEntry = NonNullable<AppConfig['speechToText']>['providers'][number];

const execFileAsync = promisify(execFile);

/** transcribeAudio 的返回结果。 */
export interface TranscribeResult {
  /** 转录文本，不可用时为 null。 */
  text: string | null;
  /** 转录不可用的原因（供 agent 决策参考）。仅当 text 为 null 时有值。 */
  unavailableReason?: string;
}

// ---------------------------------------------------------------------------
// 清理 Whisper 输出中的孤立 UTF-16 代理字符
// ---------------------------------------------------------------------------

/**
 * 清理文本中未配对的 UTF-16 代理字符，用 U+FFFD 替代。
 * Whisper 偶尔输出此类字符，JSON 解析器会拒绝（400 invalid surrogate）。
 */
function sanitizeSurrogates(raw: string): string {
  return raw.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
}

// ---------------------------------------------------------------------------
// whisper-cli provider
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
 * 使用本地 OpenAI Whisper CLI 转录音频。
 */
async function transcribeWithWhisperCli(
  audioPath: string,
  providerConfig: { whisperPath: string; model: string },
  language?: string,
): Promise<TranscribeResult> {
  const log = getLogger();

  const deps = await checkDependencies(providerConfig.whisperPath);
  if (!deps.available) {
    return { text: null, unavailableReason: deps.reason };
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'whisper-'));

  try {
    const args = [
      audioPath,
      '--model', providerConfig.model,
      '--output_format', 'txt',
      '--output_dir', tempDir,
    ];
    if (language) {
      args.push('--language', language);
    }

    await execFileAsync(providerConfig.whisperPath, args, { timeout: 120_000 });

    const baseName = basename(audioPath).replace(/\.[^.]+$/, '');
    const txtPath = join(tempDir, `${baseName}.txt`);
    if (!existsSync(txtPath)) {
      log.error({ txtPath }, 'Whisper output file not found');
      return { text: null, unavailableReason: 'whisper 执行完成但未生成输出文件' };
    }

    const rawText = readFileSync(txtPath, 'utf-8').trim();
    const text = sanitizeSurrogates(rawText);

    if (!text) {
      log.warn({ audioPath }, 'Whisper returned empty transcription');
      return { text: null, unavailableReason: 'whisper 转录结果为空' };
    }

    log.info({ audioPath, textLength: text.length }, 'Audio transcribed (whisper-cli)');
    return { text };
  } catch (err) {
    log.error({ err, audioPath }, 'Audio transcription failed (whisper-cli)');
    const errMsg = err instanceof Error ? err.message : String(err);
    return { text: null, unavailableReason: `whisper 转录过程出错: ${errMsg}` };
  } finally {
    try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Groq provider
// ---------------------------------------------------------------------------

/** 扩展名 → MIME 类型映射。 */
const AUDIO_MIME: Record<string, string> = {
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
};

/**
 * Groq API 根据文件扩展名判断格式，不认 .oga（Telegram 语音消息的默认扩展名）。
 * .oga 实际就是 OGG Opus，映射为 .ogg 即可。
 */
const GROQ_EXT_REMAP: Record<string, string> = {
  '.oga': '.ogg',
};

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * 使用 Groq Cloud Whisper API 转录音频。
 *
 * API 兼容 OpenAI /audio/transcriptions 格式：
 *   POST multipart/form-data { file, model, language? }
 *   Authorization: Bearer <apiKey>
 */
async function transcribeWithGroq(
  audioPath: string,
  providerConfig: { apiKey: string; model: string },
  language?: string,
): Promise<TranscribeResult> {
  const log = getLogger();

  const ext = extname(audioPath).toLowerCase();
  const mimeType = AUDIO_MIME[ext] ?? 'application/octet-stream';
  // Groq 按扩展名识别格式，.oga 需映射为 .ogg。
  const remappedExt = GROQ_EXT_REMAP[ext];
  const fileName = remappedExt
    ? basename(audioPath, ext) + remappedExt
    : basename(audioPath);

  try {
    const fileBuffer = readFileSync(audioPath);
    const blob = new Blob([fileBuffer], { type: mimeType });

    const form = new FormData();
    form.append('file', blob, fileName);
    form.append('model', providerConfig.model);
    form.append('response_format', 'text');
    if (language) {
      form.append('language', language);
    }

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${providerConfig.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log.error({ status: response.status, body, audioPath }, 'Groq API error');
      return { text: null, unavailableReason: `Groq API 返回 ${response.status}: ${body}` };
    }

    const rawText = (await response.text()).trim();
    const text = sanitizeSurrogates(rawText);

    if (!text) {
      log.warn({ audioPath }, 'Groq returned empty transcription');
      return { text: null, unavailableReason: 'Groq 转录结果为空' };
    }

    log.info({ audioPath, textLength: text.length, model: providerConfig.model }, 'Audio transcribed (groq)');
    return { text };
  } catch (err) {
    log.error({ err, audioPath }, 'Audio transcription failed (groq)');
    const errMsg = err instanceof Error ? err.message : String(err);
    return { text: null, unavailableReason: `Groq 转录过程出错: ${errMsg}` };
  }
}

// ---------------------------------------------------------------------------
// Provider 路由
// ---------------------------------------------------------------------------

/** 根据 provider 配置调用对应的转录实现。 */
function runProvider(
  provider: ProviderEntry,
  audioPath: string,
  language?: string,
): Promise<TranscribeResult> {
  switch (provider.type) {
    case 'groq':
      return transcribeWithGroq(audioPath, provider, language);
    case 'whisper-cli':
      return transcribeWithWhisperCli(audioPath, provider, language);
  }
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/**
 * 将音频文件转录为文本。
 *
 * providers 数组构成 fallback 链：按顺序依次尝试，
 * 前一个失败自动降级到下一个，全部失败才最终报错。
 *
 * @param audioPath - 输入音频文件路径。
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

  const { providers, language } = sttConfig;
  const failures: string[] = [];

  for (const provider of providers) {
    const result = await runProvider(provider, audioPath, language);
    if (result.text) {
      return result;
    }
    // 记录失败原因，继续尝试下一个 provider。
    const reason = result.unavailableReason ?? '未知错误';
    log.warn({ provider: provider.type, reason, audioPath }, 'Provider failed, trying next');
    failures.push(`[${provider.type}] ${reason}`);
  }

  // 所有 provider 都失败了。
  return {
    text: null,
    unavailableReason: `所有转录引擎均失败:\n${failures.join('\n')}`,
  };
}
