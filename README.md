# 跨平台视频发现插件

面向 Pi 和 DeepSeek Harness 的个人视频发现插件，两个宿主计划共用业务核心与 `agent-browser` 执行层。

> **当前状态：项目骨架，尚不可用于查找视频。** 没有工具注册、抓取、SQLite、排序或反馈实现；未安装到任何宿主。

## 开发准备

- Node.js **22.13+**，推荐 Node.js 24。后续拟采用内置 `node:sqlite`，仍需验证两个宿主的实际运行环境。
- npm；浏览器业务开发时再准备 `agent-browser` 和浏览器运行环境，骨架构建不需要它们。

在项目根目录执行（需要安装开发依赖）：

```sh
npm install
npm run typecheck
npm run build
npm run clean
```

`build` 仅将空入口编译到 `dist/`；`clean` 仅删除该目录。依赖安装可能访问 npm registry，不会安装浏览器或修改宿主设置。当前没有测试脚本，测试规划见 [tests/README.md](tests/README.md)。

## 目录

```text
src/
  core/              共享业务核心（占位）
  browser/           agent-browser 执行层（占位）
  platforms/         按视频网站分开的搜索与提取（占位）
  adapters/
    pi/              Pi 扩展空入口
    dsh/             DSH 插件空入口
scripts/             开发辅助脚本
tests/               测试目录与后续规划
docs/
  architecture.md    模块边界和实现顺序
  development-plan.md 权威开发计划
  status.md          实际进度与交接
  verification.md    验证规范
```

## Agent 协作

接手前阅读 [AGENTS.md](AGENTS.md)、[项目状态](docs/status.md) 和 [验证规范](docs/verification.md)。计划以仓库内 [development-plan.md](docs/development-plan.md) 为准，仓库外副本不自动同步。

当前尚未安装项目依赖，无锁文件、业务测试或 CI；首次安装依赖后应保留生成的锁文件。

## 计划边界

后续按 [开发计划](docs/development-plan.md) 实现：兴趣 → 有限页面查找与外部搜索 → 去重排序 → 会话展示 → 反馈与撤销。

抖音、TikTok、Bilibili、YouTube 仅为首批候选预设，不是固定白名单；后续支持用户通过受校验的声明式配置自定义平台，不默认执行任意脚本。平台定义、提取规则和注册机制尚未实现。

首版统一使用 `agent-browser`，批量提取元数据、复用专用会话，一轮最多两个来源并发。同一用户整轮查找跨宿主串行，共用数据库时通过跨进程锁协调。以上均为设计目标，不是当前能力。

## 宿主集成状态

两个入口目前不执行任何操作。尚未加入 Pi 自动加载 manifest、DSH bundle patch 或宿主依赖；待业务实现时核对宿主版本后补充。不要把入口可编译理解为宿主兼容性已验证。

不会默认附着日常浏览器、执行平台写操作或向模型发送 Cookie/令牌。源码中的占位入口不启动数据库、浏览器或模型调用。
