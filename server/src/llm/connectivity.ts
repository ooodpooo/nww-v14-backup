import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type { LLMProvider, ProviderAuthMode } from "@ai-novel/shared/types/llm";
import type {
  ModelRouteRequestProtocol,
  ModelRouteStructuredResponseFormat,
  ModelRouteTaskType,
} from "@ai-novel/shared/types/novel";
import { getLLM, resolveLLMClientOptions } from "./factory";
import {
  MODEL_ROUTE_TASK_TYPES,
  resolveModel,
  toStructuredOutputStrategy,
  upsertModelRouteConfig,
} from "./modelRouter";
import { invokeStructuredLlmDetailed, summarizeStructuredOutputFailure } from "./structuredInvoke";
import {
  resolveStructuredOutputProfile,
  selectStructuredOutputStrategy,
  type StructuredOutputStrategy,
} from "./structuredOutput";

export type ConnectivityProbeMode = "plain" | "structured" | "both";

const STRUCTURED_PROBE_SCHEMA = z.object({
  status: z.literal("ok"),
});

export interface ConnectivityProbeStatus {
  ok: boolean;
  latency: number | null;
  error: string | null;
  requestProtocol: ModelRouteRequestProtocol | null;
}

export interface StructuredConnectivityProbeStatus extends ConnectivityProbeStatus {
  strategy: string | null;
  reasoningForcedOff: boolean;
  fallbackAvailable: boolean;
  fallbackUsed: boolean;
  errorCategory: string | null;
  nativeJsonObject: boolean;
  nativeJsonSchema: boolean;
  profileFamily: string | null;
}

export interface LLMConnectivityStatus extends ConnectivityProbeStatus {
  provider: LLMProvider;
  model: string;
  plain: ConnectivityProbeStatus | null;
  structured: StructuredConnectivityProbeStatus | null;
}

export interface ModelRouteConnectivityStatus extends LLMConnectivityStatus {
  taskType: ModelRouteTaskType;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "连接测试失败。";
}

/** 单次连通性探针超时；NWW_CONNECTIVITY_TIMEOUT_MS=0 表示关闭（回滚到旧行为）。 */
function resolveProbeTimeoutMs(): number | undefined {
  const raw = process.env.NWW_CONNECTIVITY_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 15_000;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 15_000;
  if (value <= 0) return undefined;
  return Math.floor(value);
}

function getProtocolCandidates(preferred?: ModelRouteRequestProtocol): ModelRouteRequestProtocol[] {
  if (preferred === "openai_compatible") {
    // 显式选择 OpenAI 兼容时，不再回退到 anthropic：
    // 本地网关（WorkBuddy/Trae）只暴露 OpenAI 兼容端点，回退会向 /v1/messages 发起请求而返回 404。
    return ["openai_compatible"];
  }
  if (preferred === "anthropic") {
    return ["anthropic", "openai_compatible"];
  }
  return ["openai_compatible", "anthropic"];
}

/** 从 LangChain 消息 content（string | array）中抽取纯文本。 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const value = (part as { text?: unknown }).text;
          return typeof value === "string" ? value : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * 从单个流式 chunk 中抽取文本：普通 content，或推理模型的 reasoning_content。
 * 部分本地网关（如 WorkBuddy/Trae）对推理模型会把思考内容放在 reasoning_content，
 * 而 content 为空，若不聚合会导致"模型未返回任何内容"的误判。
 */
function extractChunkText(chunk: unknown): string {
  const c = chunk as { content?: unknown; additional_kwargs?: { reasoning_content?: unknown } };
  let text = extractTextContent(c?.content);
  const reasoning = c?.additional_kwargs?.reasoning_content;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    text += reasoning;
  }
  return text;
}

/**
 * 以流式方式发起一次普通对话并聚合文本。
 * 兼容"即使不带 stream 字段也强制返回 SSE"的网关（如 Trae 本地网关）：
 * LangChain 的 ChatOpenAI 流式解析器能正确消费 SSE 帧，
 * 而普通 invoke（聚合 JSON）在此类网关上会因无法解析 SSE 而失败。
 */
async function streamPlainText(llm: ChatOpenAI, messages: BaseMessage[], timeoutMs?: number): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(new Error(`连接测试超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
  }
  try {
    const stream = await llm.stream(messages, { signal: controller.signal });
    let content = "";
    for await (const chunk of stream) {
      content += extractChunkText(chunk);
    }
    return content;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getStructuredFormatCandidates(input: {
  provider: LLMProvider;
  model?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  requestProtocol: ModelRouteRequestProtocol;
  preferred?: ModelRouteStructuredResponseFormat;
}): ModelRouteStructuredResponseFormat[] {
  if (input.requestProtocol === "anthropic") {
    return ["prompt_json"];
  }
  const profile = resolveStructuredOutputProfile({
    provider: input.provider,
    model: input.model,
    baseURL: input.baseURL,
    requestProtocol: input.requestProtocol,
    executionMode: "structured",
  });
  const profileFirst = selectStructuredOutputStrategy(profile, STRUCTURED_PROBE_SCHEMA);
  const fallbackOrder: StructuredOutputStrategy[] = profileFirst === "json_schema"
    ? ["json_schema", "json_object", "prompt_json"]
    : profileFirst === "json_object"
      ? ["json_object", "prompt_json", "json_schema"]
      : ["prompt_json", "json_object", "json_schema"];
  const preferred = input.preferred;
  if (preferred === "json_schema" || preferred === "json_object" || preferred === "prompt_json") {
    return [preferred, ...fallbackOrder].filter((value, index, array) => array.indexOf(value) === index);
  }
  return fallbackOrder;
}

async function testPlainConnection(input: {
  provider: LLMProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  requestProtocol?: ModelRouteRequestProtocol;
  timeoutMs?: number;
}): Promise<LLMConnectivityStatus> {
  try {
    const resolved = await resolveLLMClientOptions(input.provider, {
      apiKey: input.apiKey,
      baseURL: input.baseURL,
      authMode: input.authMode,
      model: input.model,
      temperature: 0.1,
      maxTokens: 16,
      requestProtocol: input.requestProtocol,
      timeoutMs: input.timeoutMs,
    });
    const llm = await getLLM(input.provider, {
      apiKey: input.apiKey,
      baseURL: input.baseURL,
      authMode: input.authMode,
      model: resolved.model,
      temperature: 0.1,
      maxTokens: 16,
      requestProtocol: resolved.requestProtocol,
      timeoutMs: input.timeoutMs,
    });
    const start = Date.now();
    const content = await streamPlainText(llm, [new HumanMessage("请只回复 ok")], input.timeoutMs);
    if (!content.trim()) {
      throw new Error("模型未返回任何内容。");
    }
    const plain = {
      ok: true,
      latency: Date.now() - start,
      error: null,
      requestProtocol: resolved.requestProtocol,
    };
    return {
      provider: resolved.provider,
      model: resolved.model,
      ok: plain.ok,
      latency: plain.latency,
      error: plain.error,
      requestProtocol: plain.requestProtocol,
      plain,
      structured: null,
    };
  } catch (error) {
    const plain = {
      ok: false,
      latency: null,
      error: toErrorMessage(error),
      requestProtocol: input.requestProtocol ?? null,
    };
    return {
      provider: input.provider,
      model: input.model?.trim() || "",
      ok: plain.ok,
      latency: plain.latency,
      error: plain.error,
      requestProtocol: plain.requestProtocol,
      plain,
      structured: null,
    };
  }
}

async function testStructuredConnection(input: {
  provider: LLMProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  requestProtocol?: ModelRouteRequestProtocol;
  structuredResponseFormat?: ModelRouteStructuredResponseFormat;
  timeoutMs?: number;
}): Promise<LLMConnectivityStatus> {
  const resolved = await resolveLLMClientOptions(input.provider, {
    apiKey: input.apiKey,
    baseURL: input.baseURL,
    authMode: input.authMode,
    model: input.model,
    temperature: 0.2,
    maxTokens: 256,
    requestProtocol: input.requestProtocol,
    structuredStrategy: toStructuredOutputStrategy(input.structuredResponseFormat ?? "auto") ?? undefined,
    executionMode: "plain",
    timeoutMs: input.timeoutMs,
  });
  try {
    const startedAt = Date.now();
    const result = await invokeStructuredLlmDetailed({
      provider: resolved.provider,
      model: resolved.model,
      apiKey: input.apiKey,
      baseURL: input.baseURL ?? resolved.baseURL,
      authMode: input.authMode ?? resolved.authMode,
      temperature: 0.2,
      maxTokens: 256,
      taskType: "planner",
      requestProtocol: resolved.requestProtocol,
      structuredStrategy: toStructuredOutputStrategy(input.structuredResponseFormat ?? "auto") ?? undefined,
      label: "llm.connectivity.structured_probe",
      schema: STRUCTURED_PROBE_SCHEMA,
      messages: [
        new SystemMessage("你正在执行结构化输出兼容性探针。必须只输出合法 JSON。"),
        new HumanMessage("请输出一个 JSON 对象，字段 status 的值必须是 ok。"),
      ],
      maxRepairAttempts: 1,
      disableFallbackModel: true,
      timeoutMs: input.timeoutMs,
    });
    const structured: StructuredConnectivityProbeStatus = {
      ok: true,
      latency: Date.now() - startedAt,
      error: null,
      requestProtocol: resolved.requestProtocol,
      strategy: result.diagnostics.strategy,
      reasoningForcedOff: result.diagnostics.reasoningForcedOff,
      fallbackAvailable: result.diagnostics.fallbackAvailable,
      fallbackUsed: result.diagnostics.fallbackUsed,
      errorCategory: null,
      nativeJsonObject: result.diagnostics.profile.nativeJsonObject,
      nativeJsonSchema: result.diagnostics.profile.nativeJsonSchema,
      profileFamily: result.diagnostics.profile.family,
    };
    return {
      provider: resolved.provider,
      model: resolved.model,
      ok: structured.ok,
      latency: structured.latency,
      error: structured.error,
      requestProtocol: structured.requestProtocol,
      plain: null,
      structured,
    };
  } catch (error) {
    const summary = summarizeStructuredOutputFailure({
      error,
      fallbackAvailable: false,
    });
    const structured: StructuredConnectivityProbeStatus = {
      ok: false,
      latency: null,
      error: toErrorMessage(error),
      requestProtocol: input.requestProtocol ?? resolved.requestProtocol,
      strategy: null,
      reasoningForcedOff: false,
      fallbackAvailable: false,
      fallbackUsed: false,
      errorCategory: summary.category,
      nativeJsonObject: false,
      nativeJsonSchema: false,
      profileFamily: null,
    };
    return {
      provider: resolved.provider,
      model: resolved.model,
      ok: structured.ok,
      latency: structured.latency,
      error: structured.error,
      requestProtocol: structured.requestProtocol,
      plain: null,
      structured,
    };
  }
}

async function mergeProbeStatuses(input: {
  provider: LLMProvider;
  model?: string;
  plain: LLMConnectivityStatus | null;
  structured: LLMConnectivityStatus | null;
  plainPrimary?: LLMConnectivityStatus | null;
  structuredPrimary?: LLMConnectivityStatus | null;
}): Promise<LLMConnectivityStatus> {
  const provider = input.plain?.provider ?? input.structured?.provider ?? input.provider;
  const model = input.plain?.model ?? input.structured?.model ?? input.model?.trim() ?? "";
  const plainOk = input.plain?.plain?.ok === true;
  const structuredOk = input.structured?.structured?.ok === true;
  // 任一探针成功即整体成功；优先以 plain 成功为准（更接近真实对话）。
  const top: ConnectivityProbeStatus | null = plainOk
    ? input.plain!.plain!
    : structuredOk
      ? input.structured!.structured!
      : null;
  const ok = top?.ok ?? false;
  let error: string | null = top?.error ?? null;
  let requestProtocol = top?.requestProtocol ?? null;
  if (!ok) {
    // 两个探针都失败时，优先报告首选协议（通常是用户显式指定的 openai_compatible）的真实错误，
    // 而不是回退协议（anthropic）的错误，避免误导。
    const primary = input.plainPrimary?.plain
      ?? input.structuredPrimary?.structured
      ?? input.plain?.plain
      ?? input.structured?.structured
      ?? null;
    error = primary?.error ?? error;
    requestProtocol = primary?.requestProtocol ?? requestProtocol;
  }
  return {
    provider,
    model,
    ok,
    latency: top?.latency ?? null,
    error,
    requestProtocol,
    plain: input.plain?.plain ?? null,
    structured: input.structured?.structured ?? null,
  };
}

async function testConnection(input: {
  provider: LLMProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  probeMode?: ConnectivityProbeMode;
  requestProtocol?: ModelRouteRequestProtocol;
  structuredResponseFormat?: ModelRouteStructuredResponseFormat;
  timeoutMs?: number;
}): Promise<LLMConnectivityStatus> {
  const probeMode = input.probeMode ?? "both";
  const protocolCandidates = getProtocolCandidates(input.requestProtocol);
  let plain: LLMConnectivityStatus | null = null;
  let plainPrimary: LLMConnectivityStatus | null = null;
  let structured: LLMConnectivityStatus | null = null;
  let structuredPrimary: LLMConnectivityStatus | null = null;
  if (probeMode === "plain" || probeMode === "both") {
    for (let i = 0; i < protocolCandidates.length; i++) {
      const requestProtocol = protocolCandidates[i];
      const result = await testPlainConnection({ ...input, requestProtocol, timeoutMs: input.timeoutMs });
      if (i === 0) plainPrimary = result;
      plain = result;
      if (plain.ok) {
        break;
      }
    }
  }
  if (probeMode === "structured" || probeMode === "both") {
    for (let i = 0; i < protocolCandidates.length; i++) {
      const requestProtocol = protocolCandidates[i];
      for (const structuredResponseFormat of getStructuredFormatCandidates({
        provider: input.provider,
        model: input.model,
        baseURL: input.baseURL,
        requestProtocol,
        preferred: input.structuredResponseFormat,
      })) {
        const result = await testStructuredConnection({ ...input, requestProtocol, structuredResponseFormat, timeoutMs: input.timeoutMs });
        if (i === 0) structuredPrimary = result;
        structured = result;
        if (structured.ok) {
          break;
        }
      }
      if (structured?.ok) {
        break;
      }
    }
  }
  return mergeProbeStatuses({
    provider: input.provider,
    model: input.model,
    plain,
    structured,
    plainPrimary,
    structuredPrimary,
  });
}

/**
 * 外层 deadline 兜底：即使底层客户端某条调用链没接住 timeoutMs，
 * 也会在预算内返回一个失败的连通性状态，避免请求挂死。
 * 同时吞掉 reject，防止 unhandled rejection。
 */
function withProbeDeadline(
  promise: Promise<LLMConnectivityStatus>,
  timeoutMs: number | undefined,
  meta: { provider: LLMProvider; model: string; requestProtocol?: ModelRouteRequestProtocol },
): Promise<LLMConnectivityStatus> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  const budgetMs = timeoutMs + 5_000; // 给底层客户端超时留出收尾余量
  return new Promise<LLMConnectivityStatus>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        provider: meta.provider,
        model: meta.model,
        ok: false,
        latency: null,
        error: `连接测试超时（${Math.round(budgetMs / 1000)}s）`,
        requestProtocol: meta.requestProtocol ?? null,
        plain: null,
        structured: null,
      });
    }, budgetMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          provider: meta.provider,
          model: meta.model,
          ok: false,
          latency: null,
          error: error instanceof Error && error.message ? error.message : "连接测试失败。",
          requestProtocol: meta.requestProtocol ?? null,
          plain: null,
          structured: null,
        });
      },
    );
  });
}

async function testModelRoutes(taskTypes: readonly ModelRouteTaskType[] = MODEL_ROUTE_TASK_TYPES): Promise<{
  testedAt: string;
  statuses: ModelRouteConnectivityStatus[];
}> {
  const resolvedRoutes = await Promise.all(taskTypes.map(async (taskType) => ({
    taskType,
    ...(await resolveModel(taskType)),
  })));

  const probeTimeoutMs = resolveProbeTimeoutMs();
  const dedupedChecks = new Map<string, Promise<LLMConnectivityStatus>>();
  for (const route of resolvedRoutes) {
    const key = [
      route.provider,
      route.model,
      route.requestProtocol,
      route.structuredResponseFormat,
    ].join("::");
    if (!dedupedChecks.has(key)) {
      dedupedChecks.set(key, withProbeDeadline(
        testConnection({
          provider: route.provider,
          model: route.model,
          requestProtocol: route.requestProtocol,
          structuredResponseFormat: route.structuredResponseFormat,
          probeMode: "both",
          timeoutMs: probeTimeoutMs,
        }),
        probeTimeoutMs,
        { provider: route.provider, model: route.model ?? "", requestProtocol: route.requestProtocol },
      ));
    }
  }

  const statuses = await Promise.all(resolvedRoutes.map(async (route) => {
    const key = [
      route.provider,
      route.model,
      route.requestProtocol,
      route.structuredResponseFormat,
    ].join("::");
    const result = await dedupedChecks.get(key)!;
    const effectiveProtocol = result.structured?.requestProtocol ?? result.plain?.requestProtocol ?? route.requestProtocol;
    const effectiveFormat = (
      result.structured?.strategy === "json_schema"
      || result.structured?.strategy === "json_object"
      || result.structured?.strategy === "prompt_json"
    )
      ? result.structured.strategy
      : route.structuredResponseFormat;
    const shouldPersistProbeResult = result.structured?.ok === true
      && (effectiveProtocol !== route.requestProtocol || effectiveFormat !== route.structuredResponseFormat);
    if (shouldPersistProbeResult) {
      await upsertModelRouteConfig(route.taskType, {
        provider: route.provider,
        model: route.model,
        temperature: route.temperature,
        maxTokens: route.maxTokens,
        requestProtocol: effectiveProtocol,
        structuredResponseFormat: effectiveFormat,
      });
    }
    return {
      taskType: route.taskType,
      provider: route.provider,
      model: route.model,
      ok: result.ok,
      latency: result.latency,
      error: result.error,
      requestProtocol: result.requestProtocol,
      plain: result.plain,
      structured: result.structured,
    };
  }));

  return {
    testedAt: new Date().toISOString(),
    statuses,
  };
}

export const llmConnectivityService = {
  testConnection,
  testModelRoutes,
};
