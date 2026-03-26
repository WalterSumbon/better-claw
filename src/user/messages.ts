import { getConfig } from '../config/index.js';

/** 绑定欢迎词模板中的用户名变量。 */
const USER_NAME_VARIABLE = '${userName}';
/** 未绑定提示模板中的命令前缀变量。 */
const COMMAND_PREFIX_VARIABLE = '${commandPrefix}';

/**
 * 渲染用户绑定成功后的欢迎词。
 *
 * @param userName - 用户显示名称。
 * @returns 渲染后的欢迎词文本。
 */
export function renderBindWelcomeMessage(userName: string): string {
  const template = getConfig().messages.bindWelcome;
  return template.split(USER_NAME_VARIABLE).join(userName);
}

/**
 * 渲染用户未绑定时的提示文案。
 *
 * @param commandPrefix - 当前平台命令前缀。
 * @returns 渲染后的未绑定提示文本。
 */
export function renderUnboundNoticeMessage(commandPrefix: string): string {
  const template = getConfig().messages.unboundNotice;
  return template.split(COMMAND_PREFIX_VARIABLE).join(commandPrefix);
}
