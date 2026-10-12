/**
 * 平台来源类型定义
 * 
 * 定义视频平台来源的通用接口，不依赖具体平台实现。
 */

import type { VideoCandidate, PlatformId } from '../core/types.js';

/**
 * 搜索查询
 */
export interface SearchQuery {
  /** 平台标识 */
  platform: PlatformId;
  /** 搜索关键词 */
  keyword: string;
  /** 期望结果数量 */
  limit?: number;
}

/**
 * 来源执行结果
 */
export interface SourceResult {
  /** 候选视频列表 */
  candidates: VideoCandidate[];
  /** 来源状态 */
  status: SourceStatus;
  /** 执行耗时（毫秒） */
  durationMs: number;
}

/**
 * 来源状态类型
 */
export type SourceStatusType =
  | 'success'           // 成功
  | 'partial'           // 部分成功
  | 'login_required'    // 需要登录
  | 'captcha_required'  // 需要验证码
  | 'rate_limited'      // 被限流
  | 'network_error'     // 网络错误
  | 'parse_error'       // 解析错误
  | 'cancelled'         // 已取消
  | 'timeout';          // 超时

/**
 * 来源状态
 */
export interface SourceStatus {
  /** 状态类型 */
  type: SourceStatusType;
  /** 说明信息 */
  message?: string;
  /** 获得的结果数 */
  resultCount: number;
  /** 期望的结果数 */
  expectedCount?: number;
}

/**
 * 平台配置
 */
export interface PlatformConfig {
  /** 平台标识 */
  id: PlatformId;
  /** 平台名称 */
  name: string;
  /** 允许的域名列表 */
  allowedDomains: string[];
  /** 搜索 URL 模板 */
  searchUrlTemplate: string;
  /** 视频 URL 模式（用于链接规范化） */
  videoUrlPattern: RegExp;
}

/**
 * 视频来源接口
 * 
 * 实现此接口的类负责从特定平台搜索和提取视频信息。
 */
export interface VideoSource {
  /**
   * 获取平台配置
   */
  getConfig(): PlatformConfig;

  /**
   * 搜索视频
   * 
   * @param query 搜索查询
   * @param options 执行选项（超时、取消信号等）
   * @returns 搜索结果
   */
  search(
    query: SearchQuery,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<SourceResult>;

  /**
   * 规范化视频链接
   * 
   * @param url 原始链接
   * @returns 规范化后的链接，如果无法识别则返回 null
   */
  normalizeVideoUrl(url: string): string | null;

  /**
   * 检测是否需要人工处理
   * 
   * @param pageContent 页面内容或快照
   * @returns 检测结果
   */
  detectManualRequired(pageContent: string): {
    required: boolean;
    reason?: 'login' | 'captcha' | 'verification';
  };
}
