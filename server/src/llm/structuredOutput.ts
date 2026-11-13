import type { StructuredResponseEvidence } from "@ai-novel/shared/types/structuredDiagnostics";
import { toJSONSchema, type ZodType } from "zod";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { ModelRouteRequestProtocol } from "@ai-novel/shared/types/novel";
import { isBuiltInProvider } from "./providers";
import { isDeepSeekThinkingModeProvider, isGlmThinkingModeProvider } from "./reasoning";

export type StructuredExecutionMode = "plain" | "structured";
export type StructuredOutputStrategy = "json_schema" | "json_object" | "prompt_json";
export type StructuredOutputErrorCategory =
  | "unsupported_native_json"
  | "thinking_pollution"
  | "incomplete_json"
  | "malformed_json"
  | "schema_mismatch"
  | "transport_error";

export interface StructuredOutputProfile {
  nativeJsonSchema: boolean;
  nativeJsonObject: boolean;
  requiresNonThinkingForStructured: boolean;
  supportsReasoningToggle: boolean;
  omitMaxTokensForNativeStructured: boolean;
  preferredStructuredStrategy: StructuredOutputStrategy;
  safeStructuredMaxTokens?: number;
  family: string;
}

export interface StructuredOutputDiagnostics {
  response?: StructuredResponseEvidence;
  attemptId?: string | null;
  strategy: StructuredOutputStrategy;
  profile: StructuredOutputProfile;
  reasoningForcedOff: boolean;
  fallbackAvailable: boolean;
  fallbackUsed: boolean;
  errorCategory: StructuredOutputErrorCategory | null;
}

const QWEN_FAMILY_PATTERN = /(?:^|[/:_-])qwen(?:\d+(?:\.\d+)?)?/i;
const DASHSCOPE_HOST_PATTERN = /(?:^|\.)dashscope\.aliyuncs\.com$/i;
const MODELSCOPE_HOST_PATTERN = /(?:^|\.)modelscope\.cn$/i;
const OPENAI_HOST_PATTERN = /(?:^|\.)api\.openai\.com$/i;
const GEMINI_HOST_PATTERN = /(?:^|\.)generativelanguage\.googleapis\.com$/i;
const MOONSHOT_HOST_PATTERN = /(?:^|\.)api\.moonshot\.cn$/i;
const DEEPSEEK_HOST_PATTERN = /(?:^|\.)api\.deepseek\.com$/i;
const GLM_HOST_PATTERN = /(?:^|\.)open\.bigmodel\.cn$/i;
const GROK_HOST_PATTERN = /(?:^|\.)api\.x\.ai$/i;
const MINIMAX_HOST_PATTERN = /(?:^|\.)api\.minimax(?:i)?\.(?:io|com)$/i;
// OpenAI WebUI API 桥接自己发布的模型 id 形态：webui-chrome-{chatgpt|gemini|qwen|deepseek}。
const AGNES_HOST_PATTERN = /(?:^|\.)agnes-ai\.cn$/i;
const WEBUI_BRIDGE_MODEL_PATTERN = /webui[-_]chrome|webui[-_]via[-_]chrome/i;
const WEBUI_BRIDGE_PROVIDER_PATTERN = /webui|chrome/i;
const LOOPBACK_HOST_PATTERN = /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|::1|\[::1\])$/i;

function normalizeText(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function extractHost(baseURL?: string): string {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isQwenFamily(model: string): boolean {
  return QWEN_FAMILY_PATTERN.test(model);
}

/**
 * 端点是否为本地 OpenAI WebUI API 桥接（openai-webui-api 的 /v1）。
 *
 * 这条通道的 response_format 不是可选装饰：不传时桥接会走工具回路，
 * 在正文前后追加 `[tool N]` 状态行和「════ 结果分区」，结构化解析必然失败；
 * 传了才切到桥接的 A 协议（严格 JSON 提示 + 本地抽取 + 抽取失败返回 502
 * `bridge_json_invalid`），并且不再进入工具回路。
 */
function isWebuiBridgeEndpoint(provider: string, model: string, baseURL?: string): boolean {
  if (WEBUI_BRIDGE_MODEL_PATTERN.test(model)) {
    return true;
  }
  const host = extractHost(baseURL);
  return Boolean(host)
    && LOOPBACK_HOST_PATTERN.test(host)
    && WEBUI_BRIDGE_PROVIDER_PATTERN.test(provider);
}

function normalizeModelId(model: string): string {
  const normalized = normalizeText(model);
  if (!normalized) {
    return "";
  }
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] ?? normalized : normalized;
}

function isQwenThinkingOnlyModel(model: string): boolean {
  const normalizedModel = normalizeModelId(model);
  if (!normalizedModel) {
    return false;
  }
  return normalizedModel.startsWith("qwq") || normalizedModel.includes("thinking");
}

function supportsDashScopeQwenNativeStructuredOutput(model: string): boolean {
  const normalizedModel = normalizeModelId(model);
  if (!normalizedModel || isQwenThinkingOnlyModel(normalizedModel)) {
    return false;
  }
  if (normalizedModel.startsWith("qwen3")) {
    return true;
  }
  if (normalizedModel.startsWith("qwen-plus")) {
    return true;
  }
  if (normalizedModel.startsWith("qwen-flash")) {
    return true;
  }
  if (normalizedModel.startsWith("qwen-turbo")) {
    return true;
  }
  if (normalizedModel.startsWith("qwen-max")) {
    return true;
  }
  if (normalizedModel.startsWith("qwen-long")) {
    return true;
  }
  return normalizedModel.startsWith("qwen2.5")
    && !normalizedModel.includes("math")
    && !normalizedModel.includes("coder");
}

function isQwenMixedThinkingModel(model: string): boolean {
  const normalizedModel = normalizeModelId(model);
  if (!normalizedModel || isQwenThinkingOnlyModel(normalizedModel)) {
    return false;
  }
  return normalizedModel.startsWith("qwen3")
    || normalizedModel.startsWith("qwen-plus")
    || normalizedModel.startsWith("qwen-flash")
    || normalizedModel.startsWith("qwen-turbo");
}

function supportsNativeJson(profile: StructuredOutputProfile): boolean {
  return profile.nativeJsonSchema || profile.nativeJsonObject;
}

function buildProfile(input: Partial<StructuredOutputProfile> & { family: string }): StructuredOutputProfile {
  return {
    nativeJsonSchema: input.nativeJsonSchema ?? false,
    nativeJsonObject: input.nativeJsonObject ?? false,
    requiresNonThinkingForStructured: input.requiresNonThinkingForStructured ?? false,
    supportsReasoningToggle: input.supportsReasoningToggle ?? false,
    omitMaxTokensForNativeStructured: input.omitMaxTokensForNativeStructured ?? false,
    preferredStructuredStrategy: input.preferredStructuredStrategy ?? "prompt_json",
    safeStructuredMaxTokens: input.safeStructuredMaxTokens,
    family: input.family,
  };
}

export function resolveStructuredOutputProfile(input: {
  provider: LLMProvider;
  model?: string;
  baseURL?: string;
  executionMode?: StructuredExecutionMode;
  requestProtocol?: ModelRouteRequestProtocol;
}): StructuredOutputProfile {
  const provider = normalizeText(input.provider);
  const model = normalizeText(input.model);
  const host = extractHost(input.baseURL);
  const customProvider = !isBuiltInProvider(input.provider);
  // A provider label or model name does not prove that a custom gateway supports
  // its upstream vendor's response_format extensions. Trust only the vendor's
  // direct endpoint (or its default endpoint when no override is supplied).
  const usesOfficialEndpoint = (providerName: LLMProvider, hostPattern: RegExp) => (
    hostPattern.test(host) || (input.provider === providerName && !host)
  );
  const qwenFamily = isQwenFamily(model);
  const qwenMixedThinkingModel = isQwenMixedThinkingModel(model);
  const qwenThinkingOnlyModel = isQwenThinkingOnlyModel(model);
  const qwenNativeStructuredModel = supportsDashScopeQwenNativeStructuredOutput(model);
  const isDashScopeQwen = usesOfficialEndpoint("qwen", DASHSCOPE_HOST_PATTERN);
  const isModelScopeQwen = MODELSCOPE_HOST_PATTERN.test(host) || provider.includes("modelscope");

  if (input.requestProtocol === "anthropic") {
    return buildProfile({
      family: "anthropic",
      preferredStructuredStrategy: "prompt_json",
      safeStructuredMaxTokens: 8192,
    });
  }
  // 桥接模型名（webui-chrome-qwen 之类）会命中下面的 qwen 家族判断，必须先分流。
  if (isWebuiBridgeEndpoint(provider, model, input.baseURL)) {
    return buildProfile({
      family: "webui_bridge",
      nativeJsonObject: true,
      preferredStructuredStrategy: "json_object",
      safeStructuredMaxTokens: 8192,
    });
  }
  // agnes 网关实测接受 18k max_tokens；45 章卷拆章 JSON 约 12k+ 字符，
  // 沿用通用自定义网关的 8192 上限会让 chapters 数组在中途被截断。
  if (AGNES_HOST_PATTERN.test(host)) {
    return buildProfile({
      family: "custom_openai_compatible",
      preferredStructuredStrategy: "prompt_json",
      safeStructuredMaxTokens: 20_000,
    });
  }
  if (usesOfficialEndpoint("gemini", GEMINI_HOST_PATTERN)) {
    return buildProfile({
      family: "gemini",
      nativeJsonSchema: true,
      nativeJsonObject: true,
      preferredStructuredStrategy: "json_schema",
    });
  }
  if (usesOfficialEndpoint("glm", GLM_HOST_PATTERN)) {
    const supportsReasoningToggle = isGlmThinkingModeProvider(
      input.provider,
      input.baseURL,
      input.model,
    );
    return buildProfile({
      family: "glm",
      nativeJsonObject: true,
      preferredStructuredStrategy: "json_object",
      requiresNonThinkingForStructured: supportsReasoningToggle,
      supportsReasoningToggle,
    });
  }
  if (usesOfficialEndpoint("kimi", MOONSHOT_HOST_PATTERN)) {
    const supportsJsonObject = !model.includes("thinking");
    return buildProfile({
      family: "kimi",
      nativeJsonObject: supportsJsonObject,
      preferredStructuredStrategy: supportsJsonObject ? "json_object" : "prompt_json",
    });
  }
  if (usesOfficialEndpoint("deepseek", DEEPSEEK_HOST_PATTERN)) {
    const supportsReasoningToggle = isDeepSeekThinkingModeProvider(
      input.provider,
      input.baseURL,
      input.model,
    );
    return buildProfile({
      family: "deepseek",
      nativeJsonObject: true,
      preferredStructuredStrategy: "json_object",
      requiresNonThinkingForStructured: supportsReasoningToggle,
      supportsReasoningToggle,
    });
  }
  if (usesOfficialEndpoint("grok", GROK_HOST_PATTERN)) {
    return buildProfile({
      family: "grok",
      nativeJsonObject: true,
      preferredStructuredStrategy: "json_object",
    });
  }
  if (usesOfficialEndpoint("minimax", MINIMAX_HOST_PATTERN)) {
    return buildProfile({
      family: "minimax",
      preferredStructuredStrategy: "prompt_json",
      safeStructuredMaxTokens: 8192,
    });
  }
  if (isDashScopeQwen) {
    return buildProfile({
      family: "dashscope_qwen",
      nativeJsonObject: qwenNativeStructuredModel,
      preferredStructuredStrategy: qwenNativeStructuredModel ? "json_object" : "prompt_json",
      requiresNonThinkingForStructured: qwenMixedThinkingModel,
      supportsReasoningToggle: qwenMixedThinkingModel,
      omitMaxTokensForNativeStructured: qwenNativeStructuredModel,
      safeStructuredMaxTokens: qwenNativeStructuredModel ? undefined : 8192,
    });
  }
  if (isModelScopeQwen && qwenFamily) {
    return buildProfile({
      family: "modelscope_qwen",
      preferredStructuredStrategy: "prompt_json",
      requiresNonThinkingForStructured: qwenMixedThinkingModel && !qwenThinkingOnlyModel,
      supportsReasoningToggle: qwenMixedThinkingModel && !qwenThinkingOnlyModel,
      safeStructuredMaxTokens: 8192,
    });
  }
  if (qwenFamily) {
    return buildProfile({
      family: "custom_openai_compatible_qwen",
      preferredStructuredStrategy: "prompt_json",
      safeStructuredMaxTokens: 8192,
    });
  }
  if (usesOfficialEndpoint("openai", OPENAI_HOST_PATTERN)) {
    return buildProfile({
      family: "openai",
      nativeJsonSchema: true,
      nativeJsonObject: true,
      preferredStructuredStrategy: "json_schema",
    });
  }
  if (input.provider === "anthropic") {
    return buildProfile({
      family: "anthropic",
      preferredStructuredStrategy: "prompt_json",
      safeStructuredMaxTokens: 8192,
    });
  }
  if (input.provider === "siliconflow") {
    return buildProfile({
      family: "siliconflow",
      preferredStructuredStrategy: "prompt_json",
      safeStructuredMaxTokens: 8192,
    });
  }
  if (input.provider === "ollama") {
    return buildProfile({
      family: "ollama",
      preferredStructuredStrategy: "prompt_json",
      safeStructuredMaxTokens: 8192,
    });
  }
  if (isWebuiBridgeEndpoint(provider, model, input.baseURL)) {
    return buildProfile({
      family: "webui_bridge",
      nativeJsonObject: true,
      preferredStructuredStrategy: "json_object",
      safeStructuredMaxTokens: 8192,
    });
  }
  if (customProvider) {
    return buildProfile({
      family: qwenFamily ? "custom_openai_compatible_qwen" : "custom_openai_compatible",
      preferredStructuredStrategy: "prompt_json",
      safeStructuredMaxTokens: 8192,
    });
  }
  return buildProfile({
    family: "default",
    preferredStructuredStrategy: "prompt_json",
    safeStructuredMaxTokens: 8192,
  });
}


export function schemaAllowsTopLevelArray<T>(schema: ZodType<T>): boolean {
  const probe = schema.safeParse([]);
  if (probe.success) {
    return true;
  }
  return probe.error.issues.some((issue) => issue.path.length === 0 && issue.code !== "invalid_type");
}

export function selectStructuredOutputStrategy<T>(
  profile: StructuredOutputProfile,
  schema: ZodType<T>,
): StructuredOutputStrategy {
  if (schemaAllowsTopLevelArray(schema)) {
    return "prompt_json";
  }
  if (profile.preferredStructuredStrategy === "json_schema" && profile.nativeJsonSchema) {
    return "json_schema";
  }
  if (
    (profile.preferredStructuredStrategy === "json_object" || profile.preferredStructuredStrategy === "json_schema")
    && profile.nativeJsonObject
  ) {
    return "json_object";
  }
  return "prompt_json";
}

function sanitizeSchemaName(label: string): string {
  const normalized = label.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 48) || "structured_output";
}

export function buildStructuredResponseFormat<T>(input: {
  strategy: StructuredOutputStrategy;
  schema: ZodType<T>;
  label: string;
}): Record<string, unknown> | undefined {
  if (input.strategy === "json_object") {
    return { type: "json_object" };
  }
  if (input.strategy === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: sanitizeSchemaName(input.label),
        strict: true,
        schema: toJSONSchema(input.schema),
      },
    };
  }
  return undefined;
}

export function classifyStructuredOutputFailure(input: {
  error?: unknown;
  rawContent?: string;
}): StructuredOutputErrorCategory {
  const message = input.error instanceof Error
    ? input.error.message
    : typeof input.error === "string"
      ? input.error
      : String(input.error ?? "");
  const rawContent = input.rawContent ?? "";
  const lowerMessage = message.toLowerCase();
  const trimmedRawContent = rawContent.trim().toLowerCase();
  const haystack = `${message}\n${rawContent}`.toLowerCase();

  if (
    haystack.includes("response_format")
    || haystack.includes("json_schema")
    || haystack.includes("json_object")
    || haystack.includes("unsupported response format")
  ) {
    return "unsupported_native_json";
  }
  if (rawContent.includes("<think>") || rawContent.includes("</think>")) {
    return "thinking_pollution";
  }
  const rawLooksLikeHtmlPage = trimmedRawContent.startsWith("<!doctype")
    || trimmedRawContent.startsWith("<html")
    || trimmedRawContent.startsWith("<body")
    || trimmedRawContent.startsWith("<head")
    || trimmedRawContent.startsWith("<title");
  const messageLooksLikeHtmlTransport = lowerMessage.includes("text/html")
    || lowerMessage.includes("content-type: text/html")
    || lowerMessage.includes("<!doctype")
    || lowerMessage.includes("<html")
    || lowerMessage.includes("<body")
    || lowerMessage.includes("</div>")
    || lowerMessage.includes("</script>")
    || lowerMessage.includes("<title>403")
    || lowerMessage.includes("<title>404")
    || lowerMessage.includes("<title>429")
    || lowerMessage.includes("<title>502")
    || lowerMessage.includes("<title>503");
  if (
    rawLooksLikeHtmlPage
    || messageLooksLikeHtmlTransport
    || (
      trimmedRawContent.startsWith("<")
      && (
        lowerMessage.includes("unexpected token '<'")
        || lowerMessage.includes("is not valid json")
      )
    )
  ) {
    return "transport_error";
  }
  if (
    haystack.includes("未检测到完整 json 值")
    || haystack.includes("unexpected end of json input")
    || haystack.includes("unterminated")
    || haystack.includes("end of json")
  ) {
    return "incomplete_json";
  }
  if (
    haystack.includes("expected ',' or '}'")
    || haystack.includes("unexpected token")
    || haystack.includes("json 解析失败")
    || haystack.includes("malformed")
  ) {
    return "malformed_json";
  }
  if (haystack.includes("zod") || haystack.includes("schema") || haystack.includes("校验错误")) {
    return "schema_mismatch";
  }
  return "transport_error";
}

export function extractStructuredOutputErrorCategory(message?: string | null): StructuredOutputErrorCategory | null {
  const match = message?.match(/\[STRUCTURED_OUTPUT:([a-z_]+)\]/i);
  if (!match) {
    return null;
  }
  const category = match[1].toLowerCase() as StructuredOutputErrorCategory;
  return [
    "unsupported_native_json",
    "thinking_pollution",
    "incomplete_json",
    "malformed_json",
    "schema_mismatch",
    "transport_error",
  ].includes(category) ? category : null;
}

export class StructuredOutputError extends Error {
  readonly category: StructuredOutputErrorCategory;

  readonly diagnostics: StructuredOutputDiagnostics;

  readonly retryWithNextStrategy: boolean;

  constructor(input: {
    message: string;
    category: StructuredOutputErrorCategory;
    diagnostics: StructuredOutputDiagnostics;
    retryWithNextStrategy?: boolean;
    cause?: unknown;
  }) {
    super(`[STRUCTURED_OUTPUT:${input.category}] ${input.message}`, { cause: input.cause });
    this.name = "StructuredOutputError";
    this.category = input.category;
    this.diagnostics = input.diagnostics;
    this.retryWithNextStrategy = input.retryWithNextStrategy ?? false;
  }
}

export function canUseForcedJsonOutput(profile: StructuredOutputProfile): boolean {
  return supportsNativeJson(profile);
}
