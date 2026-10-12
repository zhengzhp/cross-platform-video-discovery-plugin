/**
 * 可控假执行器（用于测试）
 * 
 * 用于离线测试浏览器执行层逻辑，不依赖真实的 agent-browser CLI。
 * 支持模拟成功、失败、超时、取消、输出超限等场景。
 */

import type {
  BrowserTask,
  BrowserResult,
  BrowserExecutor,
} from './types.js';
import { createBrowserError } from './types.js';

/**
 * 模拟行为配置
 */
export interface MockBehavior {
  /** 延迟（毫秒） */
  delayMs?: number;
  /** 是否失败 */
  shouldFail?: boolean;
  /** 失败类型 */
  failureType?: 'timeout' | 'cancelled' | 'invalid_params' | 'execution_failed' | 'output_overflow';
  /** 模拟输出 */
  output?: {
    data?: unknown;
    text?: string;
    size?: number;
  };
}

/**
 * 假执行器
 */
export class MockBrowserExecutor implements BrowserExecutor {
  private readonly behaviors = new Map<string, MockBehavior>();
  private readonly executionLog: Array<{
    task: BrowserTask;
    timestamp: number;
    result?: BrowserResult;
    error?: Error;
  }> = [];
  private readonly cleanedSessions = new Set<string>();

  /**
   * 设置特定任务类型的行为
   */
  setBehavior(taskType: string, behavior: MockBehavior): void {
    this.behaviors.set(taskType, behavior);
  }

  /**
   * 清除所有行为配置
   */
  clearBehaviors(): void {
    this.behaviors.clear();
  }

  /**
   * 获取执行日志
   */
  getExecutionLog(): ReadonlyArray<{
    task: BrowserTask;
    timestamp: number;
    result?: BrowserResult;
    error?: Error;
  }> {
    return [...this.executionLog];
  }

  /**
   * 获取已清理的会话列表
   */
  getCleanedSessions(): ReadonlyArray<string> {
    return Array.from(this.cleanedSessions);
  }

  /**
   * 清空日志
   */
  clearLog(): void {
    this.executionLog.length = 0;
    this.cleanedSessions.clear();
  }

  /**
   * 执行浏览器任务
   */
  async execute(task: BrowserTask): Promise<BrowserResult> {
    const startTime = Date.now();
    const behavior = this.behaviors.get(task.type) || {};

    try {
      // 基本参数校验
      if (!task.type) {
        throw createBrowserError('invalid_params', 'Task type is required', {
          retryable: false,
        });
      }

      if (!task.target) {
        throw createBrowserError('invalid_params', 'Task target is required', {
          retryable: false,
        });
      }

      if (task.timeoutMs <= 0) {
        throw createBrowserError('invalid_params', 'Task timeout must be positive', {
          retryable: false,
        });
      }

      // 模拟延迟
      if (behavior.delayMs) {
        await this.delay(behavior.delayMs, task.signal);
      }

      // 检查是否已取消
      if (task.signal?.aborted) {
        throw createBrowserError('cancelled', 'Task was cancelled', {
          retryable: false,
        });
      }

      // 模拟失败
      if (behavior.shouldFail) {
        throw this.createMockError(behavior.failureType || 'execution_failed');
      }

      // 生成模拟结果
      const durationMs = Date.now() - startTime;
      const outputSize = behavior.output?.size ?? 100;

      const result: BrowserResult = {
        success: true,
        data: behavior.output?.data,
        text: behavior.output?.text ?? `Mock output for ${task.type}`,
        durationMs,
        outputSize,
      };

      // 记录日志
      this.executionLog.push({
        task,
        timestamp: startTime,
        result,
      });

      return result;
    } catch (error) {
      // 记录错误日志
      this.executionLog.push({
        task,
        timestamp: startTime,
        error: error instanceof Error ? error : new Error(String(error)),
      });

      throw error;
    }
  }

  /**
   * 清理资源
   */
  async cleanup(sessionId?: string): Promise<void> {
    if (sessionId) {
      this.cleanedSessions.add(sessionId);
    } else {
      // 清理所有会话（实际场景中会从 activeSessions 获取）
      this.cleanedSessions.add('*');
    }
  }

  /**
   * 延迟执行（支持取消）
   */
  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createBrowserError('cancelled', 'Task was cancelled', {
          retryable: false,
        }));
        return;
      }

      const timeout = setTimeout(resolve, ms);

      const onAbort = () => {
        clearTimeout(timeout);
        reject(createBrowserError('cancelled', 'Task was cancelled', {
          retryable: false,
        }));
      };

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * 创建模拟错误
   */
  private createMockError(type: string): Error {
    switch (type) {
      case 'timeout':
        return createBrowserError('timeout', 'Mock timeout error', {
          retryable: true,
        });
      case 'cancelled':
        return createBrowserError('cancelled', 'Mock cancellation', {
          retryable: false,
        });
      case 'invalid_params':
        return createBrowserError('invalid_params', 'Mock invalid params', {
          retryable: false,
        });
      case 'output_overflow':
        return createBrowserError('output_overflow', 'Mock output overflow', {
          retryable: false,
        });
      default:
        return createBrowserError('execution_failed', 'Mock execution failure', {
          retryable: false,
        });
    }
  }
}
