/**
 * 浏览器执行层类型定义
 * 
 * 封装 agent-browser CLI 的类型契约，不依赖具体实现或宿主接口。
 */

/**
 * 浏览器任务配置
 */
export interface BrowserTask {
  /** 任务类型 */
  type: 'navigate' | 'snapshot' | 'click' | 'fill' | 'extract' | 'screenshot';
  /** 目标 URL（navigate）或选择器/引用（其他操作） */
  target: string;
  /** 任务超时（毫秒），不超过整轮剩余时间 */
  timeoutMs: number;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 会话标识，用于隔离不同任务的浏览器状态 */
  sessionId?: string;
  /** 额外参数（如 fill 的文本内容、snapshot 的选项等） */
  params?: Record<string, unknown>;
}

/**
 * 浏览器执行结果
 */
export interface BrowserResult {
  /** 是否成功 */
  success: boolean;
  /** 结构化输出（快照、提取的数据等） */
  data?: unknown;
  /** 输出文本（截图路径、错误信息等） */
  text?: string;
  /** 实际耗时（毫秒） */
  durationMs: number;
  /** 输出大小（字节），用于检查是否超限 */
  outputSize: number;
}

/**
 * 浏览器错误类型
 */
export type BrowserErrorType =
  | 'timeout'          // 超时
  | 'cancelled'        // 已取消
  | 'invalid_params'   // 参数无效
  | 'navigation_failed' // 导航失败
  | 'element_not_found' // 元素未找到
  | 'execution_failed'  // 执行失败
  | 'output_overflow'   // 输出超限
  | 'process_error';    // 进程错误

/**
 * 浏览器执行错误
 */
export interface BrowserError extends Error {
  type: BrowserErrorType;
  /** 原始错误（如果有） */
  cause?: Error | undefined;
  /** 是否可重试 */
  retryable: boolean;
}

/**
 * 浏览器执行器接口
 * 
 * 实现此接口的可以是真实的 agent-browser CLI 封装，也可以是测试用的假执行器。
 */
export interface BrowserExecutor {
  /**
   * 执行浏览器任务
   * 
   * @param task 任务配置
   * @returns 执行结果
   * @throws {BrowserError} 执行失败时抛出
   */
  execute(task: BrowserTask): Promise<BrowserResult>;

  /**
   * 清理资源
   * 
   * 关闭本任务拥有的会话、页面和子进程，不清理外部资源。
   * 
   * @param sessionId 会话标识，undefined 表示清理所有
   */
  cleanup(sessionId?: string): Promise<void>;
}

/**
 * 浏览器执行统计
 */
export interface BrowserStats {
  /** 总调用次数 */
  totalCalls: number;
  /** 成功次数 */
  successCount: number;
  /** 失败次数 */
  failureCount: number;
  /** 超时次数 */
  timeoutCount: number;
  /** 取消次数 */
  cancelledCount: number;
  /** 总耗时（毫秒） */
  totalDurationMs: number;
  /** 总输出大小（字节） */
  totalOutputSize: number;
}

/**
 * 创建浏览器错误
 */
export function createBrowserError(
  type: BrowserErrorType,
  message: string,
  options?: { cause?: Error; retryable?: boolean }
): BrowserError {
  const error = new Error(message) as BrowserError;
  error.name = 'BrowserError';
  error.type = type;
  if (options?.cause !== undefined) {
    error.cause = options.cause;
  }
  error.retryable = options?.retryable ?? false;
  return error;
}
