/**
 * Minimal stand-ins for the two helpers the short-story module used from the removed
 * TS production kernel tree. Behaviour is kept identical to the former implementations:
 * both are pure (no IO, no persistence) and carry no kernel-specific logic.
 */

class InvalidProductionBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProductionBudgetError";
  }
}

function integer(value: number, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new InvalidProductionBudgetError(`Invalid ${name}`);
  return value;
}

/** Thrown when a saved short-story manuscript changed between reading and writing it. */
export class ProductionVersionConflictError extends Error {
  constructor() {
    super("正文版本已变化，请从作品页重新确认。");
    this.name = "ProductionVersionConflictError";
  }
}

/**
 * Estimates whether one model call fits the configured context window.
 * One token per UTF-8 byte is a deliberately conservative estimate, not provider billing.
 */
export function checkContextBudget(input: {
  input: string;
  contextWindow: number | null;
  outputTokens: number;
  safetyTokens: number;
  inputTokenCount?: number;
}):
  | { ok: boolean; estimatedInputTokens: number; requiredTokens: number; contextWindow: number }
  | { ok: false; reason: "unknown_context_window"; estimatedInputTokens: number } {
  const estimatedInputTokens = integer(input.inputTokenCount ?? new TextEncoder().encode(input.input).length, "input tokens");
  const output = integer(input.outputTokens, "output tokens");
  const safety = integer(input.safetyTokens, "safety tokens");
  if (input.contextWindow === null) return { ok: false, reason: "unknown_context_window", estimatedInputTokens };
  const window = integer(input.contextWindow, "context window", 1);
  const requiredTokens = integer(estimatedInputTokens + output + safety, "required tokens");
  return { ok: requiredTokens <= window, estimatedInputTokens, requiredTokens, contextWindow: window };
}