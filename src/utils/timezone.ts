/**
 * 时区工具函数。
 *
 * @module
 */

/**
 * 获取系统默认时区（IANA 格式）。
 *
 * @returns 系统时区字符串，如 "Asia/Shanghai"。
 */
export function getSystemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * 解析用户有效时区：优先使用用户设置，否则回退到系统时区。
 *
 * @param userTimezone - 用户在 profile 中设置的时区。
 * @returns 有效的 IANA 时区字符串。
 */
export function resolveTimezone(userTimezone?: string): string {
  return userTimezone?.trim() || getSystemTimezone();
}

/**
 * 验证 IANA 时区字符串是否有效。
 *
 * @param tz - 待验证的时区字符串。
 * @returns 有效则返回 true。
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取时区的 UTC 偏移量字符串（如 "UTC+8"、"UTC-5"、"UTC+5:30"）。
 *
 * @param tz - IANA 时区字符串。
 * @param date - 参考日期（默认当前时间，因为偏移量可能因夏令时而变化）。
 * @returns UTC 偏移量字符串。
 */
export function getUtcOffset(tz: string, date: Date = new Date()): string {
  // 用 Intl 获取时区的格式化偏移量。
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'longOffset',
  });
  const parts = formatter.formatToParts(date);
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  // 格式为 "GMT+8:00" 或 "GMT-05:00" 或 "GMT"。
  const gmt = tzPart?.value ?? 'GMT';

  if (gmt === 'GMT') {
    return 'UTC+0';
  }

  // "GMT+8:00" → "UTC+8", "GMT-05:30" → "UTC-5:30"
  const match = gmt.match(/^GMT([+-])(\d{1,2}):?(\d{2})?$/);
  if (!match) {
    return gmt.replace('GMT', 'UTC');
  }

  const sign = match[1];
  const hours = parseInt(match[2], 10);
  const minutes = match[3] ? parseInt(match[3], 10) : 0;

  if (minutes === 0) {
    return `UTC${sign}${hours}`;
  }
  return `UTC${sign}${hours}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * 将日期格式化为用户时区的本地时间字符串。
 *
 * @param date - 日期对象。
 * @param tz - IANA 时区字符串。
 * @returns 格式化的本地时间字符串，如 "2026-03-10 09:43"。
 */
export function formatLocalTime(date: Date, tz: string): string {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  // sv-SE locale 产生 "2026-03-10 09:43" 格式。
  return formatter.format(date);
}

/**
 * 将日期格式化为用户时区的 ISO 8601 格式（含时区偏移）。
 *
 * @param date - 日期对象。
 * @param tz - IANA 时区字符串。
 * @returns ISO 8601 格式字符串，如 "2026-03-10T09:43:31+08:00"。
 */
export function formatISOWithTimezone(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    fractionalSecondDigits: 3,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour') === '24' ? '00' : get('hour');
  const minute = get('minute');
  const second = get('second');

  // 获取 offset。
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'longOffset',
  });
  const tzPart = formatter.formatToParts(date).find((p) => p.type === 'timeZoneName');
  const gmt = tzPart?.value ?? 'GMT';
  const offset = gmt === 'GMT' ? '+00:00' : gmt.replace('GMT', '');

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}
