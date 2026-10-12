/**
 * agent-browser CLI 封装
 * 
 * 封装 agent-browser CLI 的子进程调用，实现参数校验、超时控制、取消机制、
 * 输出限制和资源清理。
 */

import { spawn } from 'node:child_process';
import type {
  BrowserTask,
  BrowserResult,
  BrowserExecutor,
  BrowserStats,
} from './types.js';
import { createBrowserError } from './types.js';

/**
 * agent-browser CLI 配置
 */
export interface AgentBrowserConfig {
  /** CLI 可执行文件路径 */
  cliPath: string;
  /** 输出大小上限（字节），默认 1MB */
  maxOutputSize?: number;
  /** 默认超时（毫秒），默认 60 秒 */
  defaultTimeoutMs?: number;
  /** 会话 ID 前缀 */
  sessionPrefix?: string;
}

/**
 * agent-browser CLI 执行器
 */
export class AgentBrowserExecutor implements BrowserExecutor {
  private readonly config: Required<AgentBrowserConfig>;
  private readonly stats: BrowserStats = {
    totalCalls: 0,
    successCount: 0,
    failureCount: 0,
    timeoutCount: 0,
    cancelledCount: 0,
    totalDurationMs: 0,
    totalOutputSize: 0,
  };
  private readonly activeSessions = new Set<string>();

  constructor(config: AgentBrowserConfig) {
    this.config = {
      cliPath: config.cliPath,
      maxOutputSize: config.maxOutputSize ?? 1024 * 1024, // 1MB
      defaultTimeoutMs: config.defaultTimeoutMs ?? 60000, // 60s
      sessionPrefix: config.sessionPrefix ?? 'video-discovery',
    };
  }

  /**
   * 执行浏览器任务
   */
  async execute(task: BrowserTask): Promise<BrowserResult> {
    const startTime = Date.now();
    this.stats.totalCalls++;

    try {
      // 参数校验
      this.validateTask(task);

      // 准备命令
      const args = this.buildCommandArgs(task);
      const env = this.buildEnvironment(task);

      // 执行命令
      const runOptions: {
        timeoutMs: number;
        signal?: AbortSignal;
        maxOutputSize: number;
        env?: Record<string, string>;
      } = {
        timeoutMs: task.timeoutMs,
        maxOutputSize: this.config.maxOutputSize,
      };
      if (task.signal) runOptions.signal = task.signal;
      if (Object.keys(env).length > 0) runOptions.env = env;
      
      const result = await this.runCommand(args, runOptions);

      const durationMs = Date.now() - startTime;
      this.stats.successCount++;
      this.stats.totalDurationMs += durationMs;
      this.stats.totalOutputSize += result.outputSize;

      if (task.sessionId) {
        this.activeSessions.add(task.sessionId);
      }

      const browserResult: BrowserResult = {
        success: true,
        durationMs,
        outputSize: result.outputSize,
      };
      if (result.data !== undefined) browserResult.data = result.data;
      if (result.text !== undefined) browserResult.text = result.text;
      
      return browserResult;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this.stats.failureCount++;
      this.stats.totalDurationMs += durationMs;

      if (error && typeof error === 'object' && 'type' in error) {
        const browserError = error as ReturnType<typeof createBrowserError>;
        if (browserError.type === 'timeout') {
          this.stats.timeoutCount++;
        } else if (browserError.type === 'cancelled') {
          this.stats.cancelledCount++;
        }
        throw error;
      }

      const options: { cause?: Error; retryable: boolean } = { retryable: false };
      if (error instanceof Error) {
        options.cause = error;
      }
      throw createBrowserError('execution_failed', 'Task execution failed', options);
    }
  }

  /**
   * 清理资源
   */
  async cleanup(sessionId?: string): Promise<void> {
    const sessionsToClean = sessionId
      ? this.activeSessions.has(sessionId)
        ? [sessionId]
        : []
      : Array.from(this.activeSessions);

    for (const sid of sessionsToClean) {
      try {
        await this.runCommand(['close', '--all'], {
          timeoutMs: 5000,
          maxOutputSize: this.config.maxOutputSize,
          env: { AGENT_BROWSER_SESSION: sid },
        });
        this.activeSessions.delete(sid);
      } catch (error) {
        // 记录但不抛出清理错误
        console.error(`Failed to cleanup session ${sid}:`, error);
      }
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): Readonly<BrowserStats> {
    return { ...this.stats };
  }

  /**
   * 校验任务参数
   */
  private validateTask(task: BrowserTask): void {
    if (!task.type) {
      throw createBrowserError(
        'invalid_params',
        'Task type is required',
        { retryable: false }
      );
    }

    if (!task.target || typeof task.target !== 'string') {
      throw createBrowserError(
        'invalid_params',
        'Task target must be a non-empty string',
        { retryable: false }
      );
    }

    if (task.timeoutMs <= 0) {
      throw createBrowserError(
        'invalid_params',
        'Task timeout must be positive',
        { retryable: false }
      );
    }

    // 校验 URL（navigate 任务）
    if (task.type === 'navigate') {
      try {
        const url = new URL(task.target);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error('Only HTTP(S) URLs are allowed');
        }
      } catch (error) {
        const options: { cause?: Error; retryable: boolean } = { retryable: false };
        if (error instanceof Error) {
          options.cause = error;
        }
        throw createBrowserError(
          'invalid_params',
          `Invalid URL: ${task.target}`,
          options
        );
      }
    }
  }

  /**
   * 构建命令参数
   */
  private buildCommandArgs(task: BrowserTask): string[] {
    const args: string[] = [];

    switch (task.type) {
      case 'navigate':
        args.push('open', task.target);
        break;
      case 'snapshot':
        args.push('snapshot', '-i', '--json');
        if (task.params?.selector) {
          args.push('-s', String(task.params.selector));
        }
        break;
      case 'click':
        args.push('click', task.target);
        break;
      case 'fill':
        if (!task.params?.text) {
          throw createBrowserError(
            'invalid_params',
            'Fill task requires text parameter',
            { retryable: false }
          );
        }
        args.push('fill', task.target, String(task.params.text));
        break;
      case 'extract':
        args.push('eval', task.target);
        break;
      case 'screenshot':
        args.push('screenshot', task.target);
        break;
      default:
        throw createBrowserError(
          'invalid_params',
          `Unsupported task type: ${task.type}`,
          { retryable: false }
        );
    }

    return args;
  }

  /**
   * 构建环境变量
   */
  private buildEnvironment(task: BrowserTask): Record<string, string> {
    const env: Record<string, string> = {};

    if (task.sessionId) {
      env.AGENT_BROWSER_SESSION = task.sessionId;
    }

    return env;
  }

  /**
   * 运行命令
   */
  private async runCommand(
    args: string[],
    options: {
      timeoutMs: number;
      signal?: AbortSignal;
      maxOutputSize: number;
      env?: Record<string, string>;
    }
  ): Promise<{ data?: unknown; text?: string; outputSize: number }> {
    // 检查是否已取消
    if (options.signal?.aborted) {
      throw createBrowserError('cancelled', 'Task was cancelled', {
        retryable: false,
      });
    }

    return new Promise((resolve, reject) => {
      const child = spawn(this.config.cliPath, args, {
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let outputSize = 0;
      let timedOut = false;
      let cancelled = false;

      // 超时控制
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000);
      }, options.timeoutMs);

      // 取消控制
      const onAbort = () => {
        cancelled = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000);
      };
      options.signal?.addEventListener('abort', onAbort);

      // 收集输出
      child.stdout?.on('data', (chunk: Buffer) => {
        const data = chunk.toString('utf-8');
        outputSize += Buffer.byteLength(data, 'utf-8');

        if (outputSize > options.maxOutputSize) {
          child.kill('SIGTERM');
          reject(
            createBrowserError('output_overflow', 'Output size exceeded limit', {
              retryable: false,
            })
          );
          return;
        }

        stdout += data;
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });

      // 处理退出
      child.on('exit', (code, signal) => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);

        if (cancelled) {
          reject(
            createBrowserError('cancelled', 'Task was cancelled', {
              retryable: false,
            })
          );
          return;
        }

        if (timedOut) {
          reject(
            createBrowserError('timeout', 'Task timed out', {
              retryable: true,
            })
          );
          return;
        }

        if (code !== 0) {
          reject(
            createBrowserError(
              'execution_failed',
              `Command exited with code ${code}: ${stderr.trim()}`,
              { retryable: false }
            )
          );
          return;
        }

        // 尝试解析 JSON 输出
        let data: unknown;
        const trimmed = stdout.trim();
        if (trimmed && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
          try {
            data = JSON.parse(trimmed);
          } catch {
            // 如果解析失败，将其作为文本返回
            data = undefined;
          }
        }

        resolve({
          data,
          text: stdout,
          outputSize,
        });
      });

      // 处理错误
      child.on('error', (error) => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
        reject(
          createBrowserError('process_error', 'Failed to spawn process', {
            cause: error,
            retryable: false,
          })
        );
      });
    });
  }
}
