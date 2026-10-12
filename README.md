# 跨平台视频发现插件

面向 Pi 和 DeepSeek Harness 的个人视频发现插件，两个宿主共用业务核心与 `agent-browser` 执行层。

> **当前不可用于查找视频。** 实际进度、已验证能力、工作区状态与遗留项统一见 [项目状态](docs/status.md)；本文提供开发入口，不作为详细完成清单。

## 开发准备

- Node.js **22.13+**，推荐 Node.js 24；共享核心使用内置 `node:sqlite`，真实宿主运行环境仍待验证。
- npm。已有锁文件，可使用干净安装：

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run clean
```

`npm test` 先构建，再用 Node 内置测试框架执行离线断言，不访问视频站或日常浏览器。`clean` 只删除 `dist/`。开发依赖为 TypeScript 和编译 Node API 所需的 `@types/node`，未增加运行时包。

## 共享核心示例

先执行构建，再在项目根目录运行下面的模块示例。这里使用内存数据库与合成候选，**不是实际视频发现**。文件数据库路径应由调用方指定到仓库外的私有数据目录；导入模块不会创建数据库。

```js
import { DiscoveryStore, rankCandidates } from './dist/core/index.js';

const store = new DiscoveryStore(':memory:');
try {
  store.setInterest('local-user', {
    topics: ['摄影'], excludedTerms: ['广告'], depth: 0,
  });
  const batchId = store.createBatch('local-user', [
    { platform: 'example-source', text: '摄影' },
  ]);
  const ranked = rankCandidates([{
    platform: 'example-source', platformId: 'demo',
    url: 'https://video.example/watch/demo', title: '摄影入门（合成测试）',
    channel: 'page', verification: 'page-observed',
  }], store.getPreferences('local-user'));
  store.appendResults('local-user', batchId, ranked.map(row => row.video));
  store.finishBatch('local-user', batchId, 'completed');
  const feedback = store.addFeedback('local-user', {
    batchId, number: 1, reason: 'too-basic', topic: '摄影',
  });
  store.revokeFeedback('local-user', feedback.id);
} finally {
  store.close();
}
```

反馈必须带明确批次与 1-based 编号。质量/广告/无原因负反馈默认只影响视频；作者或主题范围须显式指定，主题须已配置。撤销保留原始记录，偏好从有效反馈重算。未知时长的硬条件返回警告，不伪造元数据。

## 目录与进度

```text
src/
  core/              共享类型、SQLite、排序、反馈、基础跨进程锁
  browser/           agent-browser 执行层（占位）
  platforms/         搜索与提取（占位）
  adapters/
    pi/              Pi 空入口
    dsh/             DSH 空入口
scripts/             开发辅助脚本
tests/               默认离线单元与集成测试
```

当前采用单人／单 Agent 顺序开发，不设多人分工或交接流程。开始前阅读 [操作规范](AGENTS.md)、[项目状态](docs/status.md) 与 [验证规范](docs/verification.md)。仓库内 [开发计划](docs/development-plan.md) 定义产品范围，[开发步骤](docs/development-steps.md) 定义依赖、批次规则与验收，[架构契约](docs/architecture.md) 定义模块及生命周期责任。仓库外副本不自动同步。

每次任务按“明确范围 → 记录计划 → 小范围实施 → 匹配验证 → 状态收口”执行；本批完成不等于整体完成，停止需说明原因和剩余项。规范中的目标契约不代表已经编码。

## 尚未完成的边界

- 抖音、TikTok、Bilibili、YouTube 只是首批候选预设，不是固定白名单；当前无真实来源实现。用户自定义平台配置也是后续目标，不执行任意用户脚本。
- 基础查找锁基于同机 SQLite 事务、PID 与所有者令牌：死 PID 可恢复，活 PID 不按超时强抢。PID 复用可能保守报忙；整轮截止时间、浏览器取消清理及异常批次状态恢复仍需编排接入，完整锁验收尚未完成。不要手动清理仍运行任务的锁。
- `withLock` 等任务退出后才释放锁；调用方必须响应 AbortSignal，并落实有界执行。预算常量不等于已经执行了预算保护。
- 保存推荐结果不等于宿主交付成功，更不等于用户已看；目标契约要求单独交付确认，当前存储/历史过滤仍需调整，见项目状态。上面的示例只演示保存与反馈，不验证交付流程。
- 未接外部搜索、模型调用、有限来源并发、Pi 加载 manifest 或 DSH bundle patch，未进行宿主/真实站点冒烟。不宣称单宿主或双宿主试用版已交付。
- URL 规范化只移除常见跟踪参数；具体视频识别、域名允许列表和别名 URL 需来源实现。核心不把任意 HTTPS URL 自动判为真实视频，候选核验标签由可信来源适配提供。

不会默认附着日常浏览器、执行平台写操作或向模型发送 Cookie/令牌。导入源码入口不启动数据库、浏览器或模型调用。
