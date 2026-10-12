/**
 * Bilibili 视频来源实现
 * 
 * 实现 Bilibili 搜索和视频信息提取。
 */

import type { VideoCandidate, PlatformId } from '../core/types.js';
import type {
  VideoSource,
  SearchQuery,
  SourceResult,
  PlatformConfig,
  SourceStatus,
} from './types.js';

/**
 * Bilibili 平台配置
 */
const BILIBILI_CONFIG: PlatformConfig = {
  id: 'bilibili' as PlatformId,
  name: 'Bilibili',
  allowedDomains: [
    'bilibili.com',
    'www.bilibili.com',
    'search.bilibili.com',
  ],
  searchUrlTemplate: 'https://search.bilibili.com/all?keyword={keyword}&page=1',
  videoUrlPattern: /^https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/,
};

/**
 * Bilibili 视频来源
 */
export class BilibiliSource implements VideoSource {
  getConfig(): PlatformConfig {
    return BILIBILI_CONFIG;
  }

  async search(
    query: SearchQuery,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<SourceResult> {
    const startTime = Date.now();
    const limit = query.limit ?? 10;
    
    try {
      // 1. 构建搜索 URL
      const searchUrl = this.buildSearchUrl(query.keyword);
      
      // 2. TODO: 使用浏览器执行器访问页面
      // const executor = ...
      // const browserResult = await executor.execute({
      //   type: 'navigate',
      //   target: searchUrl,
      //   timeoutMs: options?.timeoutMs ?? 60000,
      //   signal: options?.signal,
      // });
      
      // 3. TODO: 获取页面快照
      // const snapshotResult = await executor.execute({
      //   type: 'snapshot',
      //   target: 'body',
      //   timeoutMs: 10000,
      //   signal: options?.signal,
      // });
      
      // 4. 检测是否需要人工处理
      // const manualCheck = this.detectManualRequired(snapshotResult.text || '');
      // if (manualCheck.required) {
      //   return this.createPausedResult(
      //     manualCheck.reason!,
      //     Date.now() - startTime
      //   );
      // }
      
      // 5. 提取视频列表
      // const candidates = this.extractVideosFromHtml(
      //   snapshotResult.text || '',
      //   query.platform
      // ).slice(0, limit);
      
      // 临时返回，等待浏览器执行器集成
      throw new Error('Browser executor integration pending');
    } catch (error) {
      const durationMs = Date.now() - startTime;
      
      // 检查取消
      if (options?.signal?.aborted) {
        return {
          candidates: [],
          status: {
            type: 'cancelled',
            message: 'Search was cancelled',
            resultCount: 0,
            expectedCount: limit,
          },
          durationMs,
        };
      }
      
      // 其他错误
      return {
        candidates: [],
        status: {
          type: 'parse_error',
          message: error instanceof Error ? error.message : 'Unknown error',
          resultCount: 0,
          expectedCount: limit,
        },
        durationMs,
      };
    }
  }

  normalizeVideoUrl(url: string): string | null {
    // 先规范化 URL 格式（添加协议）
    let normalizedUrl = url;
    if (url.startsWith('//')) {
      normalizedUrl = 'https:' + url;
    } else if (!url.startsWith('http')) {
      normalizedUrl = 'https://' + url;
    }
    
    const match = normalizedUrl.match(BILIBILI_CONFIG.videoUrlPattern);
    if (!match) {
      return null;
    }
    
    const bvid = match[1];
    return `https://www.bilibili.com/video/${bvid}`;
  }

  detectManualRequired(pageContent: string): {
    required: boolean;
    reason?: 'login' | 'captcha' | 'verification';
  } {
    // 检测登录要求
    if (
      pageContent.includes('登录') ||
      pageContent.includes('login-panel') ||
      pageContent.includes('请先登录')
    ) {
      return { required: true, reason: 'login' };
    }

    // 检测验证码
    if (
      pageContent.includes('验证码') ||
      pageContent.includes('captcha') ||
      pageContent.includes('geetest')
    ) {
      return { required: true, reason: 'captcha' };
    }

    return { required: false };
  }

  /**
   * 从快照或 HTML 中提取视频列表
   * 
   * @param content 页面内容
   * @param platform 平台标识
   * @returns 候选视频列表
   */
  private extractVideosFromHtml(
    content: string,
    platform: PlatformId
  ): VideoCandidate[] {
    const candidates: VideoCandidate[] = [];
    
    // Bilibili 搜索结果的常见模式
    // 视频项通常包含：
    // - 标题：在 title 属性或文本内容中
    // - 链接：href="//www.bilibili.com/video/BV..."
    // - UP主：在作者相关的元素中
    // - 时长：通常在角标或 data 属性中
    
    // 使用正则表达式提取视频链接
    // 注意：需要匹配 href="..." 和 url="..." 两种格式
    const videoLinkPattern = /(?:href|url)="(?:https?:)?\/\/(?:www\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/gi;
    const matches = content.matchAll(videoLinkPattern);
    
    const seen = new Set<string>();
    
    for (const match of matches) {
      const bvid = match[1];
      
      // 跳过无效匹配
      if (!bvid) {
        continue;
      }
      
      // 去重
      if (seen.has(bvid)) {
        continue;
      }
      seen.add(bvid);
      
      // 构建候选对象
      const url = `https://www.bilibili.com/video/${bvid}`;
      
      // 尝试在附近提取标题（简化版，实际需要更精确的解析）
      const titleMatch = this.extractNearbyTitle(content, match.index || 0);
      
      const candidate: VideoCandidate = {
        platform,
        url,
        title: titleMatch || `视频 ${bvid}`,
        channel: 'page',
        verification: 'page-observed',
      };
      if (bvid) {
        candidate.platformId = bvid;
      }
      
      candidates.push(candidate);
    }
    
    return candidates;
  }
  
  /**
   * 尝试提取链接附近的标题
   * 
   * @param content 完整内容
   * @param linkIndex 链接在内容中的位置
   * @returns 提取到的标题或 null
   */
  private extractNearbyTitle(content: string, linkIndex: number): string | null {
    // 简化实现：在链接前后 500 字符范围内搜索 title 属性或标题标签
    const start = Math.max(0, linkIndex - 500);
    const end = Math.min(content.length, linkIndex + 500);
    const context = content.slice(start, end);
    
    // 匹配 title="..." 或 <h3>...</h3> 等
    const titlePatterns = [
      /title=["']([^"']+)["']/i,
      /<h\d[^>]*>([^<]+)<\/h\d>/i,
      /data-title=["']([^"']+)["']/i,
    ];
    
    for (const pattern of titlePatterns) {
      const match = context.match(pattern);
      if (match?.[1]) {
        return this.cleanTitle(match[1]);
      }
    }
    
    return null;
  }
  
  /**
   * 清理标题文本
   * 
   * @param title 原始标题
   * @returns 清理后的标题
   */
  private cleanTitle(title: string): string {
    return title
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  /**
   * 创建暂停状态的结果
   * 
   * @param reason 暂停原因
   * @param durationMs 耗时
   * @returns 来源结果
   */
  private createPausedResult(
    reason: 'login' | 'captcha' | 'verification',
    durationMs: number
  ): SourceResult {
    const messages: Record<typeof reason, string> = {
      login: '需要登录才能继续搜索',
      captcha: '遇到验证码，需要人工处理',
      verification: '需要完成安全验证',
    };
    
    return {
      candidates: [],
      status: {
        type: reason === 'login' ? 'login_required' : 'captcha_required',
        message: messages[reason],
        resultCount: 0,
      },
      durationMs,
    };
  }

  /**
   * 构建搜索 URL
   * 
   * @param keyword 搜索关键词
   * @returns 搜索 URL
   */
  private buildSearchUrl(keyword: string): string {
    const encodedKeyword = encodeURIComponent(keyword);
    return BILIBILI_CONFIG.searchUrlTemplate.replace('{keyword}', encodedKeyword);
  }
}
