import { nanoid, customAlphabet } from 'nanoid';

/** 用户 token 字母表：大写字母 + 数字。 */
const userTokenNanoid = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 8);

/**
 * 生成用户 secret token。
 *
 * @returns 8 字符的随机 token（大写字母 + 数字）。
 */
export function generateUserToken(): string {
  return userTokenNanoid();
}

/**
 * 生成短 ID（用于定时任务等）。
 *
 * @returns 12 字符的随机 ID。
 */
export function generateId(): string {
  return nanoid(12);
}
