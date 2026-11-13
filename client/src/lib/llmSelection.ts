import type { APIKeyStatus, LLMSelectionSettings } from "@/api/settings";
import type { LLMProvider } from "@ai-novel/shared/types/llm";

export interface LLMSelectionValue {
  provider: LLMProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export function sanitizeModelList(models: unknown): string[] {
  if (!Array.isArray(models)) {
    return [];
  }
  return Array.from(
    new Set(
      models
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

export function resolveModel(currentModel: string, models: string[]): string {
  const normalizedCurrent = currentModel.trim();
  if (normalizedCurrent) {
    return normalizedCurrent;
  }
  return models[0] ?? "";
}

export function getProviderSelectionModels(config: APIKeyStatus): string[] {
  return sanitizeModelList([config.currentModel, ...(config.models ?? [])]);
}

export function isRunnableProviderConfig(config: APIKeyStatus): boolean {
  return config.isConfigured && config.isActive && getProviderSelectionModels(config).length > 0;
}

export function resolvePreferredLLMSelection(
  preferred: LLMSelectionSettings | LLMSelectionValue | null | undefined,
  providerConfigs: APIKeyStatus[],
  fallback?: Pick<LLMSelectionValue, "temperature" | "maxTokens">,
): LLMSelectionSettings | null {
  const runnableProviders = providerConfigs.filter(isRunnableProviderConfig);

  // Honor the user's explicit choice first. Never silently substitute another
  // provider (e.g. workbuddy) just because the chosen provider is temporarily
  // not runnable — keep the user's provider/model so the UI can surface it
  // instead of forcing a fallback behind their back.
  if (preferred?.provider) {
    const matchedConfig =
      runnableProviders.find((item) => item.provider === preferred.provider)
      ?? providerConfigs.find((item) => item.provider === preferred.provider);
    const modelList = matchedConfig
      ? getProviderSelectionModels(matchedConfig)
      : preferred.model
        ? [preferred.model]
        : [];
    const model = preferred.model && modelList.includes(preferred.model)
      ? preferred.model
      : (modelList[0] ?? preferred.model ?? "");
    return {
      provider: preferred.provider,
      model,
      temperature: preferred.temperature ?? fallback?.temperature ?? 0.7,
      ...(preferred.maxTokens !== undefined
        ? { maxTokens: preferred.maxTokens }
        : fallback?.maxTokens !== undefined
          ? { maxTokens: fallback.maxTokens }
          : {}),
    };
  }

  // No explicit choice yet → use the first runnable provider as a default.
  // This default only seeds the in-memory store and must NOT be persisted back
  // to the server (see LLMSelectionBootstrap) so it cannot clobber a real choice.
  if (runnableProviders.length === 0) {
    return null;
  }
  const selectedConfig = runnableProviders[0];
  const model = resolveModel("", getProviderSelectionModels(selectedConfig));
  if (!model) {
    return null;
  }

  return {
    provider: selectedConfig.provider,
    model,
    temperature: fallback?.temperature ?? 0.7,
    ...(fallback?.maxTokens !== undefined ? { maxTokens: fallback.maxTokens } : {}),
  };
}
