/**
 * nwwBridge — NWW-V12 内核桥接路由（V14 正确整合版）
 *
 * 把前端对 /api/nww/* 的请求代理转发到 Python FastAPI 内核服务。
 * 内核默认监听 127.0.0.1:8210，可通过 NWW_KERNEL_URL 环境变量覆盖。
 *
 * 路由映射（关键: 保留 /api 前缀!）：
 *   /api/nww/health          → GET  {KERNEL_URL}/api/health
 *   /api/nww/books           → GET  {KERNEL_URL}/api/books
 *   /api/nww/books/:id/*     → 透传所有书稿操作
 *   /api/nww/mvp/*           → 写作流水线
 *   /api/nww/models/*        → 模型配置中心
 *   /api/nww/skill/run       → 无状态脚本执行
 *   /api/nww/supervisor/*    → 监督器
 *
 * 注意: 本路由必须挂载在 express.json() 之前!
 * 否则 POST/PUT 请求体流会被 express.json() 消费, 导致 http-proxy 永久挂起。
 */
import { Router, Request, Response } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import httpProxy from "http-proxy";

const router = Router();

const KERNEL_URL = process.env.NWW_KERNEL_URL || "http://127.0.0.1:8210";
const proxy = httpProxy.createProxyServer({
  target: KERNEL_URL,
  changeOrigin: true,
  timeout: 120000,
  proxyTimeout: 300000,
});

// http-proxy 的 error 回调第三参在类型上是 ServerResponse | net.Socket（WS 代理场景），
// 这里按 node:http 类型标注以匹配重载，运行时仍是 Express response 实例。
proxy.on("error", (err: Error, _req: IncomingMessage, res: ServerResponse | Socket) => {
  console.error("[nww-bridge] proxy error:", err.message);
  const response = res as Response;
  if (!response.headersSent) {
    response.status(503).json({
      error: "nww_kernel_unavailable",
      message: `NWW 内核服务不可达: ${KERNEL_URL}`,
      detail: err.message,
    });
  }
});

// 所有 /api/nww/* 请求统一代理到内核
// Express 5 path-to-regexp v8 要求通配符必须命名，使用 /*splat
router.all("/*splat", (req: Request, res: Response) => {
  // 关键修复: /api/nww/xxx → /api/xxx (保留 /api 前缀!)
  // 之前的错误写法: replace(/^\/api\/nww/, "") → /xxx (丢了 /api, FastAPI 404)
  const kernelPath = req.originalUrl.replace(/^\/api\/nww/, "/api");
  req.url = kernelPath;
  proxy.web(req, res, { target: KERNEL_URL });
});

export default router;