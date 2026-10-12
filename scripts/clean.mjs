import { rm } from "node:fs/promises";

// 仅清理本项目构建输出，不触碰数据库、浏览器 profile 或宿主配置。
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
