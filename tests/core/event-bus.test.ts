import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../src/core/event-bus.js';
import type { MsgInPayload, MsgOutPayload, AgentStatePayload } from '../../src/core/event-bus.js';

// Mock logger to prevent file I/O in tests
vi.mock('../../src/logger/index.js', () => ({
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // ---- on / emit 基本功能 ----

  describe('on() + emit()', () => {
    it('should deliver payload to registered listener', () => {
      const handler = vi.fn();
      bus.on('msg:in', handler);

      const payload: MsgInPayload = { userId: 'u1', source: 'telegram', text: 'hello' };
      bus.emit('msg:in', payload);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('should deliver to multiple listeners for the same event', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.on('msg:in', h1);
      bus.on('msg:in', h2);

      bus.emit('msg:in', { userId: 'u1', source: 'cli' });

      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
    });

    it('should not deliver to listeners of other events', () => {
      const handler = vi.fn();
      bus.on('msg:out', handler);

      bus.emit('msg:in', { userId: 'u1', source: 'cli' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle emit with no listeners registered', () => {
      // Should not throw
      expect(() => {
        bus.emit('msg:in', { userId: 'u1', source: 'cli' });
      }).not.toThrow();
    });
  });

  // ---- unsubscribe ----

  describe('unsubscribe', () => {
    it('should stop receiving events after unsubscribe', () => {
      const handler = vi.fn();
      const unsub = bus.on('msg:in', handler);

      bus.emit('msg:in', { userId: 'u1', source: 'cli' });
      expect(handler).toHaveBeenCalledOnce();

      unsub();
      bus.emit('msg:in', { userId: 'u1', source: 'cli' });
      expect(handler).toHaveBeenCalledOnce(); // still 1, not 2
    });

    it('should be safe to call unsubscribe multiple times', () => {
      const handler = vi.fn();
      const unsub = bus.on('msg:in', handler);

      unsub();
      unsub(); // second call should not throw
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ---- once ----

  describe('once()', () => {
    it('should fire listener only once then auto-unsubscribe', () => {
      const handler = vi.fn();
      bus.once('msg:in', handler);

      bus.emit('msg:in', { userId: 'u1', source: 'cli' });
      bus.emit('msg:in', { userId: 'u1', source: 'cli' });

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should allow manual unsubscribe before first emit', () => {
      const handler = vi.fn();
      const unsub = bus.once('msg:in', handler);

      unsub();
      bus.emit('msg:in', { userId: 'u1', source: 'cli' });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ---- onAny ----

  describe('onAny()', () => {
    it('should receive all events with event name', () => {
      const handler = vi.fn();
      bus.onAny(handler);

      const inPayload: MsgInPayload = { userId: 'u1', source: 'telegram' };
      const outPayload: MsgOutPayload = { userId: 'u1', target: 'telegram', text: 'hi' };

      bus.emit('msg:in', inPayload);
      bus.emit('msg:out', outPayload);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, 'msg:in', inPayload);
      expect(handler).toHaveBeenNthCalledWith(2, 'msg:out', outPayload);
    });

    it('should stop receiving after unsubscribe', () => {
      const handler = vi.fn();
      const unsub = bus.onAny(handler);

      bus.emit('msg:in', { userId: 'u1', source: 'cli' });
      expect(handler).toHaveBeenCalledOnce();

      unsub();
      bus.emit('msg:in', { userId: 'u1', source: 'cli' });
      expect(handler).toHaveBeenCalledOnce();
    });

    it('should be called before specific listeners', () => {
      const order: string[] = [];
      bus.onAny(() => order.push('any'));
      bus.on('msg:in', () => order.push('specific'));

      bus.emit('msg:in', { userId: 'u1', source: 'cli' });

      expect(order).toEqual(['any', 'specific']);
    });
  });

  // ---- 错误隔离 ----

  describe('error isolation', () => {
    it('should not block other listeners when one throws', () => {
      const h1 = vi.fn(() => { throw new Error('boom'); });
      const h2 = vi.fn();

      bus.on('msg:in', h1);
      bus.on('msg:in', h2);

      bus.emit('msg:in', { userId: 'u1', source: 'cli' });

      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce(); // h2 still called despite h1 throwing
    });

    it('should not block specific listeners when onAny throws', () => {
      const anyHandler = vi.fn(() => { throw new Error('any boom'); });
      const specificHandler = vi.fn();

      bus.onAny(anyHandler);
      bus.on('msg:in', specificHandler);

      bus.emit('msg:in', { userId: 'u1', source: 'cli' });

      expect(anyHandler).toHaveBeenCalledOnce();
      expect(specificHandler).toHaveBeenCalledOnce();
    });

    it('should not throw even if all listeners throw', () => {
      bus.on('msg:in', () => { throw new Error('e1'); });
      bus.on('msg:in', () => { throw new Error('e2'); });
      bus.onAny(() => { throw new Error('e3'); });

      expect(() => {
        bus.emit('msg:in', { userId: 'u1', source: 'cli' });
      }).not.toThrow();
    });
  });

  // ---- 类型安全 ----

  describe('type safety', () => {
    it('should accept correct payload types for each event', () => {
      const msgInHandler = vi.fn();
      const msgOutHandler = vi.fn();
      const busyHandler = vi.fn();
      const idleHandler = vi.fn();

      bus.on('msg:in', msgInHandler);
      bus.on('msg:out', msgOutHandler);
      bus.on('agent:busy', busyHandler);
      bus.on('agent:idle', idleHandler);

      bus.emit('msg:in', { userId: 'u1', source: 'telegram', text: 'hi', files: [] });
      bus.emit('msg:out', { userId: 'u1', target: 'telegram', text: 'reply', streaming: true, final: false });
      bus.emit('agent:busy', { userId: 'u1', target: 'telegram' });
      bus.emit('agent:idle', { userId: 'u1' });

      expect(msgInHandler).toHaveBeenCalledOnce();
      expect(msgOutHandler).toHaveBeenCalledOnce();
      expect(busyHandler).toHaveBeenCalledOnce();
      expect(idleHandler).toHaveBeenCalledOnce();
    });
  });

  // ---- 边界情况 ----

  describe('edge cases', () => {
    it('should handle listener that unsubscribes itself during emit', () => {
      const handler = vi.fn();
      let unsub: () => void;
      unsub = bus.on('msg:in', (payload) => {
        handler(payload);
        unsub(); // unsubscribe during emit
      });

      const other = vi.fn();
      bus.on('msg:in', other);

      bus.emit('msg:in', { userId: 'u1', source: 'cli' });

      // handler ran once, other also ran
      expect(handler).toHaveBeenCalledOnce();
      expect(other).toHaveBeenCalledOnce();

      // handler is unsubscribed now
      bus.emit('msg:in', { userId: 'u1', source: 'cli' });
      expect(handler).toHaveBeenCalledOnce(); // still 1
      expect(other).toHaveBeenCalledTimes(2);
    });

    it('should handle adding new listener during emit', () => {
      const lateHandler = vi.fn();

      bus.on('msg:in', () => {
        // Add new listener during emit
        bus.on('msg:in', lateHandler);
      });

      bus.emit('msg:in', { userId: 'u1', source: 'cli' });

      // lateHandler may or may not be called during this emit (implementation detail)
      // But it should definitely work on next emit
      bus.emit('msg:in', { userId: 'u1', source: 'cli' });
      expect(lateHandler).toHaveBeenCalled();
    });

    it('should handle streaming msg:out payloads correctly', () => {
      const chunks: MsgOutPayload[] = [];
      bus.on('msg:out', (payload) => chunks.push(payload));

      // Simulate streaming
      bus.emit('msg:out', { userId: 'u1', target: 'telegram', text: 'Hello', streaming: true });
      bus.emit('msg:out', { userId: 'u1', target: 'telegram', text: ' world', streaming: true });
      bus.emit('msg:out', { userId: 'u1', target: 'telegram', text: '!', streaming: true, final: true });
      // Complete message
      bus.emit('msg:out', { userId: 'u1', target: 'telegram', text: 'Hello world!' });

      expect(chunks).toHaveLength(4);
      expect(chunks[0].streaming).toBe(true);
      expect(chunks[2].final).toBe(true);
      expect(chunks[3].streaming).toBeUndefined();
      expect(chunks[3].text).toBe('Hello world!');
    });
  });
});
