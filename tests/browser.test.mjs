/**
 * 浏览器执行层测试
 * 
 * 使用假执行器测试参数校验、超时、取消、输出限制、资源清理等逻辑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockBrowserExecutor } from '../dist/browser/mock-executor.js';

test('validates required task fields', async () => {
  const executor = new MockBrowserExecutor();

  await assert.rejects(
    async () => {
      await executor.execute({ type: '', target: 'test', timeoutMs: 1000 });
    },
    { message: /type is required/i }
  );

  await assert.rejects(
    async () => {
      await executor.execute({ type: 'navigate', target: '', timeoutMs: 1000 });
    },
    { message: /target is required/i }
  );

  await assert.rejects(
    async () => {
      await executor.execute({ type: 'navigate', target: 'test', timeoutMs: 0 });
    },
    { message: /timeout must be positive/i }
  );
});

test('executes successful task and records result', async () => {
  const executor = new MockBrowserExecutor();
  executor.setBehavior('navigate', {
    delayMs: 10,
    output: { text: 'Navigation successful', size: 50 },
  });

  const result = await executor.execute({
    type: 'navigate',
    target: 'https://example.com',
    timeoutMs: 1000,
  });

  assert.equal(result.success, true);
  assert.equal(result.text, 'Navigation successful');
  assert.equal(result.outputSize, 50);
  assert.ok(result.durationMs >= 10);

  const log = executor.getExecutionLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].task.type, 'navigate');
  assert.ok(log[0].result);
});

test('handles timeout error', async () => {
  const executor = new MockBrowserExecutor();
  executor.setBehavior('snapshot', {
    delayMs: 100,
    shouldFail: true,
    failureType: 'timeout',
  });

  await assert.rejects(
    async () => {
      await executor.execute({
        type: 'snapshot',
        target: '.content',
        timeoutMs: 50,
      });
    },
    (err) => {
      assert.equal(err.type, 'timeout');
      assert.equal(err.retryable, true);
      return true;
    }
  );

  const log = executor.getExecutionLog();
  assert.equal(log.length, 1);
  assert.ok(log[0].error);
});

test('handles cancellation via AbortSignal', async () => {
  const executor = new MockBrowserExecutor();
  executor.setBehavior('click', {
    delayMs: 200,
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  await assert.rejects(
    async () => {
      await executor.execute({
        type: 'click',
        target: '@e1',
        timeoutMs: 1000,
        signal: controller.signal,
      });
    },
    (err) => {
      assert.equal(err.type, 'cancelled');
      assert.equal(err.retryable, false);
      return true;
    }
  );
});

test('detects already aborted signal before execution', async () => {
  const executor = new MockBrowserExecutor();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    async () => {
      await executor.execute({
        type: 'fill',
        target: '@e2',
        timeoutMs: 1000,
        signal: controller.signal,
        params: { text: 'test input' },
      });
    },
    { message: /cancelled/i }
  );
});

test('handles output overflow error', async () => {
  const executor = new MockBrowserExecutor();
  executor.setBehavior('extract', {
    shouldFail: true,
    failureType: 'output_overflow',
  });

  await assert.rejects(
    async () => {
      await executor.execute({
        type: 'extract',
        target: 'document.body.innerHTML',
        timeoutMs: 1000,
      });
    },
    (err) => {
      assert.equal(err.type, 'output_overflow');
      assert.equal(err.retryable, false);
      return true;
    }
  );
});

test('cleans up specific session', async () => {
  const executor = new MockBrowserExecutor();

  await executor.execute({
    type: 'navigate',
    target: 'https://example.com',
    timeoutMs: 1000,
    sessionId: 'session-1',
  });

  await executor.cleanup('session-1');

  const cleaned = executor.getCleanedSessions();
  assert.ok(cleaned.includes('session-1'));
});

test('cleans up all sessions when no sessionId provided', async () => {
  const executor = new MockBrowserExecutor();

  await executor.execute({
    type: 'navigate',
    target: 'https://example.com',
    timeoutMs: 1000,
    sessionId: 'session-1',
  });

  await executor.execute({
    type: 'navigate',
    target: 'https://example.org',
    timeoutMs: 1000,
    sessionId: 'session-2',
  });

  await executor.cleanup();

  const cleaned = executor.getCleanedSessions();
  assert.ok(cleaned.includes('*'));
});

test('execution log maintains order and records both success and failure', async () => {
  const executor = new MockBrowserExecutor();
  
  executor.setBehavior('navigate', { output: { text: 'OK' } });
  executor.setBehavior('click', { shouldFail: true });

  await executor.execute({
    type: 'navigate',
    target: 'https://example.com',
    timeoutMs: 1000,
  });

  try {
    await executor.execute({
      type: 'click',
      target: '@e1',
      timeoutMs: 1000,
    });
  } catch {
    // Expected
  }

  await executor.execute({
    type: 'snapshot',
    target: '.main',
    timeoutMs: 1000,
  });

  const log = executor.getExecutionLog();
  assert.equal(log.length, 3);
  assert.equal(log[0].task.type, 'navigate');
  assert.ok(log[0].result);
  assert.equal(log[1].task.type, 'click');
  assert.ok(log[1].error);
  assert.equal(log[2].task.type, 'snapshot');
  assert.ok(log[2].result);
});

test('clearLog removes all execution history', async () => {
  const executor = new MockBrowserExecutor();

  await executor.execute({
    type: 'navigate',
    target: 'https://example.com',
    timeoutMs: 1000,
  });

  await executor.cleanup('test-session');

  executor.clearLog();

  assert.equal(executor.getExecutionLog().length, 0);
  assert.equal(executor.getCleanedSessions().length, 0);
});

test('multiple behaviors can be configured independently', async () => {
  const executor = new MockBrowserExecutor();

  executor.setBehavior('navigate', {
    output: { text: 'Navigate OK' },
  });
  executor.setBehavior('click', {
    delayMs: 50,
    output: { text: 'Click OK' },
  });

  const nav = await executor.execute({
    type: 'navigate',
    target: 'https://example.com',
    timeoutMs: 1000,
  });
  assert.equal(nav.text, 'Navigate OK');

  const click = await executor.execute({
    type: 'click',
    target: '@e1',
    timeoutMs: 1000,
  });
  assert.equal(click.text, 'Click OK');
  assert.ok(click.durationMs >= 50);
});

test('clearBehaviors resets all configured behaviors', async () => {
  const executor = new MockBrowserExecutor();

  executor.setBehavior('navigate', { output: { text: 'Custom' } });
  executor.clearBehaviors();

  const result = await executor.execute({
    type: 'navigate',
    target: 'https://example.com',
    timeoutMs: 1000,
  });

  // Should get default mock output
  assert.match(result.text || '', /Mock output/);
});
