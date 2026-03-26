import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv } from '../helpers/setup.js';
import { getConfig, setConfig } from '../../src/config/index.js';
import { renderBindWelcomeMessage, renderUnboundNoticeMessage } from '../../src/user/messages.js';

/**
 * 用户消息模板单元测试。
 */
describe('user messages', () => {
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    const env = createTestEnv();
    cleanup = env.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('should render default bind welcome message with user name', () => {
    expect(renderBindWelcomeMessage('Alice')).toBe('Bound successfully! Welcome, Alice.');
  });

  it('should render configured bind welcome message with user name variable', () => {
    const config = getConfig();
    setConfig({
      ...config,
      messages: {
        ...config.messages,
        bindWelcome: 'Hi, ${userName}. Your account is now linked.',
      },
    });

    expect(renderBindWelcomeMessage('Bob')).toBe('Hi, Bob. Your account is now linked.');
  });

  it('should leave configured bind welcome message unchanged when no variable is present', () => {
    const config = getConfig();
    setConfig({
      ...config,
      messages: {
        ...config.messages,
        bindWelcome: 'Account linked successfully.',
      },
    });

    expect(renderBindWelcomeMessage('Carol')).toBe('Account linked successfully.');
  });

  it('should render default unbound notice message with command prefix', () => {
    expect(renderUnboundNoticeMessage('/')).toBe(
      "I don't recognize you yet. Use /bind <your-token> to link your account.",
    );
  });

  it('should render configured unbound notice message with command prefix variable', () => {
    const config = getConfig();
    setConfig({
      ...config,
      messages: {
        ...config.messages,
        unboundNotice: 'Please link your account first: ${commandPrefix}bind <your-token>',
      },
    });

    expect(renderUnboundNoticeMessage('.')).toBe(
      'Please link your account first: .bind <your-token>',
    );
  });
});
