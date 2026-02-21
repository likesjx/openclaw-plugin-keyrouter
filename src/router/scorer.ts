import type {
  OpenClawConfig,
  OpenClawProviderModel,
  KeyRouterProviderPolicy,
  RouteCandidate,
  RouteDecision,
  RouteDimensionScores,
  NormalizedRequest,
} from "../types.js";

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function inferDimensions(input: NormalizedRequest): RouteDimensionScores {
  const text = input.plainText.toLowerCase();
  const tokens = text.split(/\s+/).filter(Boolean).length;

  const reasoningHints = ["why", "prove", "reason", "analyze", "tradeoff", "formal"];
  const codingHints = ["code", "refactor", "debug", "typescript", "python", "api", "plugin"];
  const latencyHints = ["quick", "fast", "brief", "short"];
  const costHints = ["cheap", "low cost", "budget", "save", "free"];

  const hasAny = (hints: string[]): boolean => hints.some((h) => text.includes(h));

  const complexity = clamp01(tokens / 240);
  const reasoning = hasAny(reasoningHints) ? 0.85 : clamp01(complexity * 0.6);
  const coding = hasAny(codingHints) ? 0.9 : clamp01(complexity * 0.4);
  const multimodal = input.hasImage ? 1 : 0;
  const tooling = input.hasToolCall || input.hasToolResult ? 0.9 : 0.2;
  const contextPressure = clamp01(tokens / 1000);
  const latencySensitivity = hasAny(latencyHints) ? 0.85 : 0.35;
  const costSensitivity = hasAny(costHints) ? 0.9 : 0.4;

  return {
    complexity,
    reasoning,
    coding,
    multimodal,
    tooling,
    contextPressure,
    latencySensitivity,
    costSensitivity,
  };
}

function selectPolicy(dim: RouteDimensionScores): "cheap" | "balanced" | "reasoning" {
  if (dim.reasoning > 0.72 || dim.complexity > 0.82) {
    return "reasoning";
  }
  if (dim.costSensitivity > 0.75 && dim.latencySensitivity > 0.6) {
    return "cheap";
  }
  return "balanced";
}

type CandidateSeed = {
  providerId: string;
  model: OpenClawProviderModel;
  hasApiKey: boolean;
};

function flattenCandidates(config: OpenClawConfig): CandidateSeed[] {
  const providers = config.models?.providers ?? {};
  const out: CandidateSeed[] = [];

  for (const [providerId, provider] of Object.entries(providers)) {
    const models = Array.isArray(provider.models) ? provider.models : [];
    const hasApiKey = typeof provider.apiKey === "string" && provider.apiKey.length > 0;

    for (const model of models) {
      out.push({ providerId, model, hasApiKey });
    }
  }

  return out;
}

function applyProviderPolicy(
  seeds: CandidateSeed[],
  policy?: KeyRouterProviderPolicy,
): CandidateSeed[] {
  if (!policy) return seeds;
  const deny = new Set((policy.deny ?? []).map((v) => v.trim()).filter(Boolean));
  const allow = new Set((policy.allow ?? []).map((v) => v.trim()).filter(Boolean));
  let out = seeds.filter((s) => !deny.has(s.providerId));
  if (allow.size > 0) {
    out = out.filter((s) => allow.has(s.providerId));
  }
  return out;
}

function modelName(seed: CandidateSeed): string {
  return `${seed.providerId}/${seed.model.id}`.toLowerCase();
}

function matchesMultimodal(seed: CandidateSeed, requiresImage: boolean): boolean {
  if (!requiresImage) {
    return true;
  }
  return Array.isArray(seed.model.input) && seed.model.input.includes("image");
}

function modelScore(
  seed: CandidateSeed,
  dim: RouteDimensionScores,
  policy: "cheap" | "balanced" | "reasoning",
  providerPolicy?: KeyRouterProviderPolicy,
): number {
  const id = modelName(seed);
  const inputCost = seed.model.cost?.input;
  const outputCost = seed.model.cost?.output;
  const cost = (typeof inputCost === "number" ? inputCost : 999) + (typeof outputCost === "number" ? outputCost : 999);

  let score = 0;

  if (policy === "cheap") {
    score += 1 / (1 + cost);
    score += dim.latencySensitivity * (id.includes("flash") || id.includes("mini") ? 0.5 : 0.1);
  } else if (policy === "reasoning") {
    score += dim.reasoning * (id.includes("reason") || id.includes("o3") || id.includes("thinking") ? 1.2 : 0.2);
    score += dim.coding * (id.includes("code") || id.includes("codex") ? 0.8 : 0.1);
  } else {
    score += dim.complexity * 0.4;
    score += dim.reasoning * (id.includes("pro") || id.includes("sonnet") ? 0.6 : 0.2);
    score += 1 / (1 + cost * 0.6);
  }

  if (id.includes("gemini-3-flash") || id.includes("gpt-4o-mini")) {
    score += dim.latencySensitivity * 0.2;
  }

  if (seed.hasApiKey) {
    score += 0.05;
  }

  const prefer = new Set((providerPolicy?.prefer ?? []).map((v) => v.trim()).filter(Boolean));
  if (prefer.has(seed.providerId)) {
    score += 0.15;
  }

  return score;
}

export function routeRequest(
  input: NormalizedRequest,
  config: OpenClawConfig,
  opts?: { providerPolicy?: KeyRouterProviderPolicy },
): RouteDecision {
  const dimensions = inferDimensions(input);
  const policy = selectPolicy(dimensions);

  const candidates = applyProviderPolicy(flattenCandidates(config), opts?.providerPolicy)
    .filter((seed) => matchesMultimodal(seed, input.hasImage))
    .map((seed): RouteCandidate => {
      const score = modelScore(seed, dimensions, policy, opts?.providerPolicy);
      return {
        providerId: seed.providerId,
        modelId: seed.model.id,
        score,
        inputCost: seed.model.cost?.input,
        outputCost: seed.model.cost?.output,
        rationale: `policy=${policy}, apiKey=${seed.hasApiKey ? "yes" : "no"}`,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  return {
    policy,
    dimensions,
    topCandidates: candidates,
  };
}

export function formatDecision(decision: RouteDecision): string {
  const lines = [
    "KeyRouter Route Decision",
    `- Policy: ${decision.policy}`,
    `- Dimensions: ${JSON.stringify(decision.dimensions)}`,
    "- Top candidates:",
  ];

  if (!decision.topCandidates.length) {
    lines.push("  - (none)");
  } else {
    for (const c of decision.topCandidates) {
      lines.push(
        `  - ${c.providerId}/${c.modelId}: score=${c.score.toFixed(4)}, cost=${c.inputCost ?? "?"}/${c.outputCost ?? "?"}, ${c.rationale}`,
      );
    }
  }

  return lines.join("\n");
}
