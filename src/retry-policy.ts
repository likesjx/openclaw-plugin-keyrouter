import type { RetryErrorClass, RetryRecommendation, RouteCandidate } from "./types.js";

export function classifyError(input: string): RetryErrorClass {
  const s = input.toLowerCase();
  if (s.includes("quota") || s.includes("insufficient_quota") || s.includes("billing")) {
    return "quota_exhausted";
  }
  if (s.includes("429") || s.includes("rate limit") || s.includes("too many requests")) {
    return "rate_limited";
  }
  if (s.includes("401") || s.includes("403") || s.includes("invalid api key") || s.includes("unauthorized")) {
    return "auth_invalid";
  }
  if (s.includes("timeout") || s.includes("econnreset") || s.includes("network") || s.includes("temporar")) {
    return "transient_network";
  }
  if (s.includes("500") || s.includes("502") || s.includes("503") || s.includes("504") || s.includes("internal error")) {
    return "server_error";
  }
  return "unknown";
}

export function retryRecommendation(
  errorClass: RetryErrorClass,
  attempt: number,
  maxAttempts = 3,
  hasTooling = false
): RetryRecommendation {
  const hasAttemptsLeft = attempt < maxAttempts;

  switch (errorClass) {
    case "quota_exhausted":
      return {
        errorClass,
        shouldRetry: hasAttemptsLeft,
        shouldSwitchModel: true,
        strategy: hasTooling ? "immediate_fallback" : "default",
        reason: hasTooling
          ? "hard quota during tool workflow; rapid fallback to reliable redundant model"
          : "hard quota condition; switch candidate tier/provider",
      };
    case "rate_limited":
      return {
        errorClass,
        shouldRetry: hasAttemptsLeft,
        shouldSwitchModel: true,
        reason: "rate limit encountered; switch to adjacent model or provider",
      };
    case "auth_invalid":
      return {
        errorClass,
        shouldRetry: false,
        shouldSwitchModel: true,
        reason: "credentials invalid; do not retry same provider key",
      };
    case "transient_network":
      return {
        errorClass,
        shouldRetry: hasAttemptsLeft,
        shouldSwitchModel: false,
        reason: "transient transport issue; retry same target first",
      };
    case "server_error":
      return {
        errorClass,
        shouldRetry: hasAttemptsLeft,
        shouldSwitchModel: hasAttemptsLeft,
        reason: "server instability; retry then switch on repeated failures",
      };
    default:
      return {
        errorClass,
        shouldRetry: hasAttemptsLeft,
        shouldSwitchModel: hasAttemptsLeft,
        reason: "unknown error; conservative bounded retry with fallback",
      };
  }
}

export function nextCandidate(candidates: RouteCandidate[], currentIndex: number): RouteCandidate | null {
  if (currentIndex + 1 >= candidates.length) {
    return null;
  }
  return candidates[currentIndex + 1] ?? null;
}
