/**
 * Bilibili 来源测试
 * 
 * 使用离线夹具测试视频提取、链接规范化和人工处理检测逻辑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BilibiliSource } from '../dist/platforms/bilibili.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('normalizes Bilibili video URLs correctly', () => {
  const source = new BilibiliSource();
  
  // 标准格式
  assert.equal(
    source.normalizeVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD'),
    'https://www.bilibili.com/video/BV1xx411c7mD'
  );
  
  // 无协议
  assert.equal(
    source.normalizeVideoUrl('//www.bilibili.com/video/BV1yy4y1z7zz'),
    'https://www.bilibili.com/video/BV1yy4y1z7zz'
  );
  
  // 带参数
  assert.equal(
    source.normalizeVideoUrl('https://www.bilibili.com/video/BV1ab4y1c7sS?p=1'),
    'https://www.bilibili.com/video/BV1ab4y1c7sS'
  );
  
  // 无效链接
  assert.equal(
    source.normalizeVideoUrl('https://www.youtube.com/watch?v=abc123'),
    null
  );
  
  assert.equal(
    source.normalizeVideoUrl('not-a-url'),
    null
  );
});

test('detects login requirement', () => {
  const source = new BilibiliSource();
  
  const loginPage = '<div class="login-panel">请先登录</div>';
  const result = source.detectManualRequired(loginPage);
  
  assert.equal(result.required, true);
  assert.equal(result.reason, 'login');
});

test('detects captcha requirement', () => {
  const source = new BilibiliSource();
  
  const captchaPage = '<div class="geetest-wrap">请完成验证码验证</div>';
  const result = source.detectManualRequired(captchaPage);
  
  assert.equal(result.required, true);
  assert.equal(result.reason, 'captcha');
});

test('detects normal page with no manual intervention', () => {
  const source = new BilibiliSource();
  
  const normalPage = '<div class="video-list"><a href="/video/BV123">视频</a></div>';
  const result = source.detectManualRequired(normalPage);
  
  assert.equal(result.required, false);
  assert.equal(result.reason, undefined);
});

test('extracts videos from search result fixture', async () => {
  const source = new BilibiliSource();
  const fixturePath = join(__dirname, 'fixtures', 'bilibili-search-result.html');
  const html = await readFile(fixturePath, 'utf-8');
  
  // 使用私有方法进行测试（通过类型断言）
  const extractMethod = source['extractVideosFromHtml'].bind(source);
  const candidates = extractMethod(html, 'bilibili');
  
  // 应该提取到 3 个不同的视频（第 4 个是重复的）
  assert.equal(candidates.length, 3);
  
  // 验证第一个视频
  const first = candidates[0];
  assert.equal(first.platform, 'bilibili');
  assert.equal(first.platformId, 'BV1xx411c7mD');
  assert.equal(first.url, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.match(first.title, /TypeScript/);
  assert.equal(first.channel, 'page');
  assert.equal(first.verification, 'page-observed');
  
  // 验证第二个视频
  const second = candidates[1];
  assert.equal(second.platformId, 'BV1yy4y1z7zz');
  assert.equal(second.url, 'https://www.bilibili.com/video/BV1yy4y1z7zz');
  
  // 验证第三个视频
  const third = candidates[2];
  assert.equal(third.platformId, 'BV1ab4y1c7sS');
  assert.equal(third.url, 'https://www.bilibili.com/video/BV1ab4y1c7sS');
});

test('builds correct search URL', () => {
  const source = new BilibiliSource();
  const buildMethod = source['buildSearchUrl'].bind(source);
  
  const url1 = buildMethod('TypeScript');
  assert.match(url1, /search\.bilibili\.com\/all\?keyword=TypeScript/);
  
  const url2 = buildMethod('前端 开发');
  assert.match(url2, /keyword=%E5%89%8D%E7%AB%AF/); // URL 编码
});

test('returns config with correct properties', () => {
  const source = new BilibiliSource();
  const config = source.getConfig();
  
  assert.equal(config.id, 'bilibili');
  assert.equal(config.name, 'Bilibili');
  assert.ok(Array.isArray(config.allowedDomains));
  assert.ok(config.allowedDomains.includes('bilibili.com'));
  assert.ok(config.searchUrlTemplate.includes('{keyword}'));
  assert.ok(config.videoUrlPattern instanceof RegExp);
});
