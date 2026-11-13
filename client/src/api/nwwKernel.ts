/**
 * nwwKernel — NWW-V12 内核 API 客户端（V14 正确整合版）
 *
 * 通过 Node 网关的 /api/nww/* 桥接路由访问 Python FastAPI 内核。
 * 注意: apiClient 已配置 baseURL="/api", 所以这里的路径不要再加 /api 前缀!
 * 正确: apiClient.get("/nww/health") → 实际请求 /api/nww/health
 * 错误: apiClient.get("/api/nww/health") → 实际请求 /api/api/nww/health (404!)
 */
import { apiClient } from "./client";

export interface NWWHealth {
  ok: boolean;
  service?: string;
  version?: string;
}

export interface NWWBook {
  id: string;
  title: string;
  path: string;
}

export interface NWWChapter {
  no: number;
  title?: string;
  path?: string;
  words?: number;
}

export interface NWWWriteResult {
  ok: boolean;
  stages?: Array<{
    name: string;
    ok: boolean;
    detail?: string;
  }>;
  error?: string;
}

/** 获取内核健康状态 */
export async function getNWWHealth(): Promise<NWWHealth> {
  const res = await apiClient.get<NWWHealth>("/nww/health");
  return res.data;
}

/** 获取内核书架列表 */
export async function getNWWShelf(): Promise<{ books: NWWBook[]; projects_root?: string }> {
  const res = await apiClient.get<{ books: NWWBook[]; projects_root?: string }>("/nww/books");
  return res.data;
}

/** 创建新书 */
export async function createNWWBook(payload: {
  title: string;
  genre?: string;
  synopsis?: string;
}): Promise<NWWBook> {
  const res = await apiClient.post<NWWBook>("/nww/books", payload);
  return res.data;
}

/** 建书 bootstrap：LLM 生成 卷纲/世界观/主角 */
export async function bootstrapNWWBook(bookId: string): Promise<{
  ok: boolean;
  written?: string[];
  skipped?: string[];
  missing?: string[];
  error?: string;
}> {
  const res = await apiClient.post(`/nww/books/${bookId}/bootstrap`);
  return res.data;
}

/** 获取章节列表 */
export async function getNWWChapters(bookId: string): Promise<{ chapters: NWWChapter[] }> {
  const res = await apiClient.get(`/nww/books/${bookId}/chapters`);
  return res.data;
}

/** 获取文件树 */
export async function getNWWTree(bookId: string): Promise<{ tree: unknown }> {
  const res = await apiClient.get(`/nww/books/${bookId}/tree`);
  return res.data;
}

/** 获取 tracking（四大账本） */
export async function getNWWTracking(bookId: string): Promise<unknown> {
  const res = await apiClient.get(`/nww/books/${bookId}/tracking`);
  return res.data;
}

/** 构建 Writing Packet */
export async function buildNWVPacket(bookId: string, chapter: number): Promise<unknown> {
  const res = await apiClient.post(`/nww/books/${bookId}/mvp/packet`, { chapter });
  return res.data;
}

/** 写章流水线（agents/write）
 *  注意: 后端期望字段名是 chapter (整数), 不是 chapter_id!
 */
export async function runNWWWrite(
  bookId: string,
  chapter: number,
  payload: Record<string, unknown> = {},
): Promise<NWWWriteResult> {
  const res = await apiClient.post<NWWWriteResult>(
    `/nww/books/${bookId}/mvp/agents/write`,
    { chapter, ...payload },
  );
  return res.data;
}

/** 运行无状态脚本 */
export async function runNWWScript(payload: {
  script: string;
  book_zip_base64: string;
}): Promise<unknown> {
  const res = await apiClient.post("/nww/skill/run", payload);
  return res.data;
}

/** 获取模型配置 */
export async function getNWWModelConfig(): Promise<unknown> {
  const res = await apiClient.get("/nww/models/config");
  return res.data;
}

/** 测试模型连通性 */
export async function testNWWModel(payload: {
  base_url: string;
  api_key: string;
  model: string;
}): Promise<unknown> {
  const res = await apiClient.post("/nww/models/test", payload);
  return res.data;
}
