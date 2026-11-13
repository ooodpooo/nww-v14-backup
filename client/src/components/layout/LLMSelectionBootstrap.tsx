import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAPIKeySettings, getLLMSelectionSetting } from "@/api/settings";
import { queryKeys } from "@/api/queryKeys";
import { resolvePreferredLLMSelection } from "@/lib/llmSelection";
import { useLLMStore } from "@/store/llmStore";

export default function LLMSelectionBootstrap() {
  const store = useLLMStore();
  const [apiKeyQueryEnabled, setApiKeyQueryEnabled] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setApiKeyQueryEnabled(true), 700);
    return () => window.clearTimeout(timer);
  }, []);

  const selectionQuery = useQuery({
    queryKey: queryKeys.settings.llmSelection,
    queryFn: getLLMSelectionSetting,
    staleTime: 5 * 60 * 1000,
  });
  const apiKeySettingsQuery = useQuery({
    queryKey: queryKeys.settings.apiKeys,
    queryFn: getAPIKeySettings,
    enabled: apiKeyQueryEnabled,
    staleTime: 5 * 60 * 1000,
  });

  const resolvedSelection = useMemo(() => {
    if (store.hasHydratedSelection) {
      return null;
    }
    if (!selectionQuery.isSuccess && !selectionQuery.isError) {
      return null;
    }
    const savedSelection = selectionQuery.data?.data ?? null;
    if (!apiKeySettingsQuery.isSuccess && !apiKeySettingsQuery.isError) {
      return null;
    }
    if (savedSelection && apiKeySettingsQuery.isError) {
      return savedSelection;
    }
    return resolvePreferredLLMSelection(
      savedSelection,
      apiKeySettingsQuery.data?.data ?? [],
      {
        temperature: store.temperature,
        maxTokens: store.maxTokens,
      },
    );
  }, [
    apiKeySettingsQuery.data?.data,
    apiKeySettingsQuery.isError,
    apiKeySettingsQuery.isSuccess,
    selectionQuery.data?.data,
    selectionQuery.isError,
    selectionQuery.isSuccess,
    store.hasHydratedSelection,
    store.maxTokens,
    store.temperature,
  ]);

  useEffect(() => {
    if (store.hasHydratedSelection || !resolvedSelection) {
      return;
    }
    // Seed the in-memory store only. Do NOT persist the resolved selection back to
    // the server: doing so clobbers the user's explicitly saved provider/model with
    // a fallback (e.g. workbuddy) on every app load. The user's own choice, written
    // via LLMSelector, remains the single source of truth in the DB.
    store.setSelection(resolvedSelection);
  }, [resolvedSelection, store]);

  return null;
}
