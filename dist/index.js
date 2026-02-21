// src/openclaw-config.ts
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");
function loadOpenClawConfig() {
  if (!existsSync(OPENCLAW_CONFIG_PATH)) {
    return {};
  }
  const raw = readFileSync(OPENCLAW_CONFIG_PATH, "utf-8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}
function saveOpenClawConfig(config) {
  writeFileSync(OPENCLAW_CONFIG_PATH, `${JSON.stringify(config, null, 2)}
`, "utf-8");
}
function setPrimaryModelSelection(args) {
  const config = loadOpenClawConfig();
  if (!config.agents) config.agents = {};
  if (args.scope === "agent" && args.agentId) {
    if (!Array.isArray(config.agents.list)) {
      config.agents.list = [];
    }
    const entry = config.agents.list.find(
      (item) => typeof item === "object" && item !== null && "id" in item && item.id === args.agentId
    );
    if (!entry) return false;
    const current = typeof entry.model === "string" ? entry.model : entry.model?.primary ?? void 0;
    if (current === args.modelRef) return false;
    entry.model = args.modelRef;
    saveOpenClawConfig(config);
    return true;
  }
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.model) config.agents.defaults.model = {};
  const currentDefault = typeof config.agents.defaults.model === "string" ? config.agents.defaults.model : config.agents.defaults.model?.primary;
  if (currentDefault === args.modelRef) return false;
  config.agents.defaults.model = args.modelRef;
  saveOpenClawConfig(config);
  return true;
}
function setSessionModelSelection(args) {
  const sessionsPath = join(
    homedir(),
    ".openclaw",
    "agents",
    args.agentId,
    "sessions",
    "sessions.json"
  );
  if (!existsSync(sessionsPath)) return false;
  const raw = readFileSync(sessionsPath, "utf-8").trim();
  if (!raw) return false;
  const store = JSON.parse(raw);
  const sessionKey = `agent:${args.agentId}:main`;
  const entry = store[sessionKey];
  if (!entry || typeof entry !== "object") return false;
  const changed = entry.model !== args.modelId || entry.modelOverride !== args.modelId || entry.modelProvider !== args.providerId || entry.providerOverride !== args.providerId;
  if (!changed) return false;
  entry.model = args.modelId;
  entry.modelOverride = args.modelId;
  entry.modelProvider = args.providerId;
  entry.providerOverride = args.providerId;
  writeFileSync(sessionsPath, `${JSON.stringify(store, null, 2)}
`, "utf-8");
  return true;
}
function ingestSnapshot(config) {
  const profiles = config.auth?.profiles ?? {};
  const providers = config.models?.providers ?? {};
  const providerList = Object.entries(providers).map(([id, value]) => {
    const hasApiKey = typeof value.apiKey === "string" && value.apiKey.length > 0;
    const modelCount = Array.isArray(value.models) ? value.models.length : 0;
    return { id, modelCount, hasApiKey };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return {
    authProfileCount: Object.keys(profiles).length,
    providers: providerList
  };
}
function formatSnapshot(snapshot) {
  const lines = [
    "KeyRouter Ingest Report",
    `- Auth profiles: ${snapshot.authProfileCount}`,
    `- Providers: ${snapshot.providers.length}`
  ];
  for (const provider of snapshot.providers) {
    lines.push(
      `  - ${provider.id}: models=${provider.modelCount}, apiKey=${provider.hasApiKey ? "yes" : "no"}`
    );
  }
  return lines.join("\n");
}

// src/normalizer.ts
function safeString(value) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}
function normalizeRole(value) {
  if (value === "system" || value === "developer" || value === "user" || value === "assistant" || value === "tool") {
    return value;
  }
  return "unknown";
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function parsePart(part) {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }
  if (!part || typeof part !== "object") {
    return { type: "unknown", payload: part };
  }
  const record = part;
  const type = safeString(record.type).toLowerCase();
  if (type === "text") {
    return { type: "text", text: safeString(record.text) };
  }
  if (type === "image" || type === "image_url") {
    return {
      type: "image",
      imageUrl: safeString(record.imageUrl || record.url || record.image_url?.url)
    };
  }
  if (type === "tool_call") {
    return {
      type: "tool_call",
      toolName: safeString(record.name || record.function?.name),
      toolCallId: safeString(record.id || record.tool_call_id),
      payload: record
    };
  }
  if (type === "tool_result") {
    return {
      type: "tool_result",
      toolCallId: safeString(record.tool_call_id || record.id),
      payload: record
    };
  }
  if (type === "json") {
    return { type: "json", payload: record };
  }
  if (record.tool_calls) {
    return { type: "tool_call", payload: record, toolName: "unknown" };
  }
  if (record.content && typeof record.content !== "string") {
    return { type: "json", payload: record.content };
  }
  return { type: "unknown", payload: record };
}
function normalizeMessage(message) {
  if (typeof message === "string") {
    return {
      role: "user",
      parts: [{ type: "text", text: message }]
    };
  }
  if (!message || typeof message !== "object") {
    return {
      role: "unknown",
      parts: [{ type: "unknown", payload: message }]
    };
  }
  const record = message;
  const role = normalizeRole(record.role);
  const content = record.content;
  let parts = [];
  if (typeof content === "string") {
    parts = [{ type: "text", text: content }];
  } else if (Array.isArray(content)) {
    parts = content.map(parsePart);
  } else if (content && typeof content === "object") {
    parts = [parsePart(content)];
  }
  if (record.tool_calls && Array.isArray(record.tool_calls) || role === "tool") {
    const toolParts = asArray(record.tool_calls).map(parsePart);
    parts = parts.concat(toolParts.length ? toolParts : [{ type: role === "tool" ? "tool_result" : "tool_call", payload: record }]);
  }
  if (!parts.length) {
    parts = [{ type: "unknown", payload: record }];
  }
  return { role, parts };
}
function collectPlainText(messages) {
  const chunks = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.text) {
        chunks.push(part.text);
      }
      if (!part.text && part.type === "tool_call" && part.toolName) {
        chunks.push(`tool:${part.toolName}`);
      }
    }
  }
  return chunks.join("\n").trim();
}
function normalizeRequest(input) {
  const messages = Array.isArray(input) ? input.map(normalizeMessage) : [normalizeMessage(input)];
  const plainText = collectPlainText(messages);
  let hasImage = false;
  let hasToolCall = false;
  let hasToolResult = false;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "image") hasImage = true;
      if (part.type === "tool_call") hasToolCall = true;
      if (part.type === "tool_result") hasToolResult = true;
    }
  }
  return {
    messages,
    plainText,
    hasImage,
    hasToolCall,
    hasToolResult
  };
}
function parseCommandInput(args) {
  const raw = (args || "").trim();
  if (!raw) {
    return [{ role: "user", content: "" }];
  }
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      return [{ role: "user", content: raw }];
    }
  }
  return [{ role: "user", content: raw }];
}

// src/retry-policy.ts
function classifyError(input) {
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
function retryRecommendation(errorClass, attempt, maxAttempts = 3, hasTooling = false) {
  const hasAttemptsLeft = attempt < maxAttempts;
  switch (errorClass) {
    case "quota_exhausted":
      return {
        errorClass,
        shouldRetry: hasAttemptsLeft,
        shouldSwitchModel: true,
        strategy: hasTooling ? "immediate_fallback" : "default",
        reason: hasTooling ? "hard quota during tool workflow; rapid fallback to reliable redundant model" : "hard quota condition; switch candidate tier/provider"
      };
    case "rate_limited":
      return {
        errorClass,
        shouldRetry: hasAttemptsLeft,
        shouldSwitchModel: true,
        reason: "rate limit encountered; switch to adjacent model or provider"
      };
    case "auth_invalid":
      return {
        errorClass,
        shouldRetry: false,
        shouldSwitchModel: true,
        reason: "credentials invalid; do not retry same provider key"
      };
    case "transient_network":
      return {
        errorClass,
        shouldRetry: hasAttemptsLeft,
        shouldSwitchModel: false,
        reason: "transient transport issue; retry same target first"
      };
    case "server_error":
      return {
        errorClass,
        shouldRetry: hasAttemptsLeft,
        shouldSwitchModel: hasAttemptsLeft,
        reason: "server instability; retry then switch on repeated failures"
      };
    default:
      return {
        errorClass,
        shouldRetry: hasAttemptsLeft,
        shouldSwitchModel: hasAttemptsLeft,
        reason: "unknown error; conservative bounded retry with fallback"
      };
  }
}
function nextCandidate(candidates, currentIndex) {
  if (currentIndex + 1 >= candidates.length) {
    return null;
  }
  return candidates[currentIndex + 1] ?? null;
}

// src/router/scorer.ts
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
function inferDimensions(input) {
  const text = input.plainText.toLowerCase();
  const tokens = text.split(/\s+/).filter(Boolean).length;
  const reasoningHints = ["why", "prove", "reason", "analyze", "tradeoff", "formal"];
  const codingHints = ["code", "refactor", "debug", "typescript", "python", "api", "plugin"];
  const latencyHints = ["quick", "fast", "brief", "short"];
  const costHints = ["cheap", "low cost", "budget", "save", "free"];
  const hasAny = (hints) => hints.some((h) => text.includes(h));
  const complexity = clamp01(tokens / 240);
  const reasoning = hasAny(reasoningHints) ? 0.85 : clamp01(complexity * 0.6);
  const coding = hasAny(codingHints) ? 0.9 : clamp01(complexity * 0.4);
  const multimodal = input.hasImage ? 1 : 0;
  const tooling = input.hasToolCall || input.hasToolResult ? 0.9 : 0.2;
  const contextPressure = clamp01(tokens / 1e3);
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
    costSensitivity
  };
}
function selectPolicy(dim) {
  if (dim.reasoning > 0.72 || dim.complexity > 0.82) {
    return "reasoning";
  }
  if (dim.costSensitivity > 0.75 && dim.latencySensitivity > 0.6) {
    return "cheap";
  }
  return "balanced";
}
function flattenCandidates(config) {
  const providers = config.models?.providers ?? {};
  const out = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    const models = Array.isArray(provider.models) ? provider.models : [];
    const hasApiKey = typeof provider.apiKey === "string" && provider.apiKey.length > 0;
    for (const model of models) {
      out.push({ providerId, model, hasApiKey });
    }
  }
  return out;
}
function applyProviderPolicy(seeds, policy) {
  if (!policy) return seeds;
  const deny = new Set((policy.deny ?? []).map((v) => v.trim()).filter(Boolean));
  const allow = new Set((policy.allow ?? []).map((v) => v.trim()).filter(Boolean));
  let out = seeds.filter((s) => !deny.has(s.providerId));
  if (allow.size > 0) {
    out = out.filter((s) => allow.has(s.providerId));
  }
  return out;
}
function modelName(seed) {
  return `${seed.providerId}/${seed.model.id}`.toLowerCase();
}
function matchesMultimodal(seed, requiresImage) {
  if (!requiresImage) {
    return true;
  }
  return Array.isArray(seed.model.input) && seed.model.input.includes("image");
}
function modelScore(seed, dim, policy, providerPolicy) {
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
function routeRequest(input, config, opts) {
  const dimensions = inferDimensions(input);
  const policy = selectPolicy(dimensions);
  const candidates = applyProviderPolicy(flattenCandidates(config), opts?.providerPolicy).filter((seed) => matchesMultimodal(seed, input.hasImage)).map((seed) => {
    const score = modelScore(seed, dimensions, policy, opts?.providerPolicy);
    return {
      providerId: seed.providerId,
      modelId: seed.model.id,
      score,
      inputCost: seed.model.cost?.input,
      outputCost: seed.model.cost?.output,
      rationale: `policy=${policy}, apiKey=${seed.hasApiKey ? "yes" : "no"}`
    };
  }).sort((a, b) => b.score - a.score).slice(0, 8);
  return {
    policy,
    dimensions,
    topCandidates: candidates
  };
}
function formatDecision(decision) {
  const lines = [
    "KeyRouter Route Decision",
    `- Policy: ${decision.policy}`,
    `- Dimensions: ${JSON.stringify(decision.dimensions)}`,
    "- Top candidates:"
  ];
  if (!decision.topCandidates.length) {
    lines.push("  - (none)");
  } else {
    for (const c of decision.topCandidates) {
      lines.push(
        `  - ${c.providerId}/${c.modelId}: score=${c.score.toFixed(4)}, cost=${c.inputCost ?? "?"}/${c.outputCost ?? "?"}, ${c.rationale}`
      );
    }
  }
  return lines.join("\n");
}

// src/state-store.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";
var STATE_DIR = join2(homedir2(), ".openclaw", "keyrouter");
var STATE_PATH = join2(STATE_DIR, "state.json");
var MAX_USAGE_EVENTS = 1e3;
function ensureDir() {
  if (!existsSync2(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}
function loadState() {
  ensureDir();
  if (!existsSync2(STATE_PATH)) {
    return { usage: [], quota: {} };
  }
  try {
    const raw = readFileSync2(STATE_PATH, "utf-8").trim();
    if (!raw) return { usage: [], quota: {} };
    const parsed = JSON.parse(raw);
    return {
      usage: Array.isArray(parsed.usage) ? parsed.usage : [],
      quota: parsed.quota && typeof parsed.quota === "object" ? parsed.quota : {}
    };
  } catch {
    return { usage: [], quota: {} };
  }
}
function saveState(state) {
  ensureDir();
  writeFileSync2(STATE_PATH, JSON.stringify(state, null, 2));
}
function recordUsage(event) {
  const state = loadState();
  state.usage.push({ ...event, at: (/* @__PURE__ */ new Date()).toISOString() });
  if (state.usage.length > MAX_USAGE_EVENTS) {
    state.usage = state.usage.slice(state.usage.length - MAX_USAGE_EVENTS);
  }
  saveState(state);
  return state;
}
function setQuota(modelKey, quota) {
  const state = loadState();
  state.quota[modelKey] = quota;
  saveState(state);
  return state;
}
function applyCooldown(modelKey, minutes) {
  const state = loadState();
  const existing = state.quota[modelKey] ?? {};
  const cooldownUntil = new Date(Date.now() + minutes * 60 * 1e3).toISOString();
  state.quota[modelKey] = {
    ...existing,
    cooldownUntil
  };
  saveState(state);
  return state;
}
function summarizeUsage(state) {
  const lines = [
    "KeyRouter Usage Summary",
    `- Events: ${state.usage.length}`
  ];
  const grouped = /* @__PURE__ */ new Map();
  for (const event of state.usage) {
    const key = `${event.providerId}/${event.modelId}`;
    const entry = grouped.get(key) ?? { total: 0, failed: 0, routed: 0, success: 0 };
    entry.total += 1;
    if (event.status === "failed") entry.failed += 1;
    if (event.status === "routed") entry.routed += 1;
    if (event.status === "success") entry.success += 1;
    grouped.set(key, entry);
  }
  if (!grouped.size) {
    lines.push("- No usage yet");
  } else {
    lines.push("- By model:");
    for (const [key, g] of grouped.entries()) {
      lines.push(`  - ${key}: total=${g.total}, routed=${g.routed}, success=${g.success}, failed=${g.failed}`);
    }
  }
  return lines.join("\n");
}
function summarizeQuota(state) {
  const lines = [
    "KeyRouter Quota Summary",
    `- Entries: ${Object.keys(state.quota).length}`
  ];
  if (!Object.keys(state.quota).length) {
    lines.push("- No quota records yet");
    return lines.join("\n");
  }
  for (const [modelKey, q] of Object.entries(state.quota)) {
    lines.push(
      `  - ${modelKey}: remaining=${q.remaining ?? "?"}, resetAt=${q.resetAt ?? "?"}, cooldownUntil=${q.cooldownUntil ?? "-"}`
    );
  }
  return lines.join("\n");
}
function markFailureWithError(modelKey, errorClass) {
  const cooldown = errorClass === "rate_limited" ? 2 : errorClass === "quota_exhausted" ? 10 : 1;
  return applyCooldown(modelKey, cooldown);
}

// src/index.ts
var VERSION = "0.1.0";
function runAudit() {
  const config = loadOpenClawConfig();
  const snapshot = ingestSnapshot(config);
  return formatSnapshot(snapshot);
}
function runRoute(rawArgs, providerPolicy) {
  const config = loadOpenClawConfig();
  const normalized = normalizeRequest(parseCommandInput(rawArgs));
  const decision = routeRequest(normalized, config, { providerPolicy });
  if (decision.topCandidates[0]) {
    const top = decision.topCandidates[0];
    recordUsage({
      providerId: top.providerId,
      modelId: top.modelId,
      status: "routed"
    });
  }
  return formatDecision(decision);
}
function runRetry(errorText, providerPolicy) {
  const errorClass = classifyError(errorText);
  const recommendation = retryRecommendation(errorClass, 1, 3, true);
  const config = loadOpenClawConfig();
  const normalized = normalizeRequest([{ role: "user", content: "fallback probe" }]);
  const decision = routeRequest(normalized, config, { providerPolicy });
  const alternate = nextCandidate(decision.topCandidates, 0);
  if (decision.topCandidates[0]) {
    const top = decision.topCandidates[0];
    const modelKey = `${top.providerId}/${top.modelId}`;
    markFailureWithError(modelKey, errorClass);
    recordUsage({
      providerId: top.providerId,
      modelId: top.modelId,
      status: "failed",
      errorClass
    });
  }
  const lines = [
    "KeyRouter Retry Recommendation",
    `- errorClass: ${recommendation.errorClass}`,
    `- shouldRetry: ${recommendation.shouldRetry}`,
    `- shouldSwitchModel: ${recommendation.shouldSwitchModel}`,
    `- strategy: ${recommendation.strategy || "default"}`,
    `- reason: ${recommendation.reason}`,
    `- alternateCandidate: ${alternate ? `${alternate.providerId}/${alternate.modelId}` : "(none)"}`
  ];
  return lines.join("\n");
}
function autoRouteModel(input, providerPolicy) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) return void 0;
  if (prompt.startsWith("/keyrouter_")) return void 0;
  const config = loadOpenClawConfig();
  const payload = Array.isArray(input.messages) && input.messages.length > 0 ? input.messages : [{ role: "user", content: prompt }];
  const normalized = normalizeRequest(payload);
  const decision = routeRequest(normalized, config, { providerPolicy });
  const top = decision.topCandidates[0];
  if (!top) return void 0;
  const providerOverride = top.providerId;
  const modelOverride = top.modelId;
  recordUsage({
    providerId: top.providerId,
    modelId: top.modelId,
    status: "routed"
  });
  return { providerOverride, modelOverride, decision };
}
function resolvePluginConfig(raw) {
  const src = raw || {};
  return {
    enabled: src.enabled !== false,
    providers: {
      allow: src.providers?.allow ?? [],
      prefer: src.providers?.prefer ?? [],
      deny: src.providers?.deny ?? []
    },
    hardApply: {
      enabled: src.hardApply?.enabled ?? false,
      mode: src.hardApply?.mode ?? "override",
      pinScope: src.hardApply?.pinScope ?? "agent"
    }
  };
}
var plugin = {
  id: "openclaw-plugin-keyrouter",
  name: "KeyRouter",
  description: "BYOK router scaffold that ingests OpenClaw auth/model configuration",
  version: VERSION,
  register(api) {
    api.logger.info("KeyRouter scaffold loaded");
    const pluginConfig = resolvePluginConfig(api.pluginConfig);
    const providerPolicy = pluginConfig.providers;
    const hardApply = pluginConfig.hardApply;
    const pendingPinBySessionKey = /* @__PURE__ */ new Map();
    if (!pluginConfig.enabled) {
      api.logger.info("KeyRouter disabled via plugin config");
      return;
    }
    api.on("before_model_resolve", async (event) => {
      try {
        const payload = event || {};
        const routed = autoRouteModel({
          prompt: payload.prompt || "",
          messages: payload.messages
        }, providerPolicy);
        if (!routed) return;
        const modelRef = `${routed.providerOverride}/${routed.modelOverride}`;
        api.logger.info(`KeyRouter auto-route(model_resolve) -> ${modelRef}`);
        if (hardApply.enabled && hardApply.mode === "override") {
          return {
            providerOverride: routed.providerOverride,
            modelOverride: routed.modelOverride
          };
        }
        return;
      } catch (err) {
        api.logger.warn(
          `KeyRouter auto-route(model_resolve) skipped: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
    });
    api.on("before_agent_start", async (event, hookCtx) => {
      try {
        const payload = event || {};
        const context = hookCtx || {};
        const agentId = context.agentId || payload.agentId;
        const routed = autoRouteModel({
          prompt: payload.prompt || "",
          messages: payload.messages
        }, providerPolicy);
        if (!routed) return;
        const modelRef = `${routed.providerOverride}/${routed.modelOverride}`;
        api.logger.info(`KeyRouter auto-route(agent_start) -> ${modelRef}`);
        if (hardApply.enabled && hardApply.mode === "pin") {
          const changed = setPrimaryModelSelection({
            agentId,
            modelRef,
            scope: hardApply.pinScope ?? "agent"
          });
          const sessionPinned = !!agentId && setSessionModelSelection({
            agentId,
            providerId: routed.providerOverride,
            modelId: routed.modelOverride
          });
          if (agentId && context.sessionKey) {
            pendingPinBySessionKey.set(context.sessionKey, {
              agentId,
              providerId: routed.providerOverride,
              modelId: routed.modelOverride,
              modelRef
            });
          }
          if (changed) {
            api.logger.info(
              `KeyRouter hard-apply(pin) -> ${modelRef} (${hardApply.pinScope}${agentId ? `:${agentId}` : ""})`
            );
          }
          if (sessionPinned) {
            api.logger.info(`KeyRouter hard-apply(session) -> ${modelRef} (agent:${agentId}:main)`);
          }
          return;
        }
        if (hardApply.enabled && hardApply.mode === "override") {
          return {
            providerOverride: routed.providerOverride,
            modelOverride: routed.modelOverride
          };
        }
      } catch {
        return;
      }
    });
    api.on("agent_end", async (_event, hookCtx) => {
      if (!(hardApply.enabled && hardApply.mode === "pin")) return;
      const context = hookCtx || {};
      const sessionKey = context.sessionKey;
      if (!sessionKey) return;
      const pending = pendingPinBySessionKey.get(sessionKey);
      if (!pending) return;
      pendingPinBySessionKey.delete(sessionKey);
      const applied = setSessionModelSelection({
        agentId: pending.agentId,
        providerId: pending.providerId,
        modelId: pending.modelId
      });
      if (applied) {
        api.logger.info(`KeyRouter hard-apply(agent_end) -> ${pending.modelRef} (${sessionKey})`);
      }
    });
    api.registerCommand({
      name: "keyrouter_audit",
      description: "Inspect auth profiles and model providers from ~/.openclaw/openclaw.json",
      acceptsArgs: false,
      requireAuth: false,
      handler: async () => {
        try {
          return { text: runAudit() };
        } catch (err) {
          return {
            text: `KeyRouter audit failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true
          };
        }
      }
    });
    api.registerCommand({
      name: "keyrouter_route",
      description: "Run multi-dimension routing over an input prompt or JSON message envelope",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        try {
          const args = (ctx.args || "").trim();
          return { text: runRoute(args, providerPolicy) };
        } catch (err) {
          return {
            text: `KeyRouter route failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true
          };
        }
      }
    });
    api.registerCommand({
      name: "keyrouter_retry",
      description: "Classify an error and show retry/fallback recommendation. Usage: /keyrouter_retry <error text>",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const errorText = (ctx.args || "").trim();
        if (!errorText) {
          return {
            text: "Usage: /keyrouter_retry <error text>",
            isError: true
          };
        }
        return { text: runRetry(errorText, providerPolicy) };
      }
    });
    api.registerCommand({
      name: "keyrouter_usage",
      description: "Show usage summary from KeyRouter local state",
      acceptsArgs: false,
      requireAuth: false,
      handler: async () => {
        const state = loadState();
        return { text: summarizeUsage(state) };
      }
    });
    api.registerCommand({
      name: "keyrouter_quota",
      description: "Show quota/cooldown summary from KeyRouter local state",
      acceptsArgs: false,
      requireAuth: false,
      handler: async () => {
        const state = loadState();
        return { text: summarizeQuota(state) };
      }
    });
    api.registerCommand({
      name: "keyrouter_quota_set",
      description: "Set quota state for a model key. Usage: /keyrouter_quota_set <provider/model> <remaining> [reset-iso]",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const raw = (ctx.args || "").trim();
        const [modelKey, remainingRaw, resetAt] = raw.split(/\s+/);
        if (!modelKey || !remainingRaw) {
          return {
            text: "Usage: /keyrouter_quota_set <provider/model> <remaining> [reset-iso]",
            isError: true
          };
        }
        const remaining = Number(remainingRaw);
        if (!Number.isFinite(remaining)) {
          return { text: `Invalid remaining value: ${remainingRaw}`, isError: true };
        }
        setQuota(modelKey, { remaining, resetAt });
        return { text: `Quota updated for ${modelKey}` };
      }
    });
    api.registerCli(
      ({ program }) => {
        const keyrouter = program.command("keyrouter");
        keyrouter.description("KeyRouter BYOK router utilities");
        keyrouter.command("audit").description("Inspect auth profiles and model providers from ~/.openclaw/openclaw.json").action(() => {
          console.log(runAudit());
        });
        keyrouter.command("route").description("Run multi-dimension routing for a prompt or JSON envelope").argument("<input>", "Prompt text or JSON message envelope").action((input) => {
          console.log(runRoute(String(input || ""), providerPolicy));
        });
        keyrouter.command("retry").description("Classify an error and print retry/fallback recommendation").argument("<error>", "Error text to classify").action((errorText) => {
          console.log(runRetry(String(errorText || ""), providerPolicy));
        });
        keyrouter.command("usage").description("Show KeyRouter usage summary").action(() => {
          console.log(summarizeUsage(loadState()));
        });
        keyrouter.command("quota").description("Show KeyRouter quota/cooldown summary").action(() => {
          console.log(summarizeQuota(loadState()));
        });
        keyrouter.command("quota-set").description("Set quota for a model key").argument("<modelKey>", "Provider/model key").argument("<remaining>", "Remaining quota count").argument("[resetAt]", "Optional reset ISO timestamp").action((modelKey, remainingRaw, resetAt) => {
          const remaining = Number(remainingRaw);
          if (!Number.isFinite(remaining)) {
            throw new Error(`Invalid remaining value: ${remainingRaw}`);
          }
          setQuota(String(modelKey), { remaining, resetAt });
          console.log(`Quota updated for ${modelKey}`);
        });
      },
      { commands: ["keyrouter"] }
    );
  }
};
var index_default = plugin;
export {
  index_default as default
};
//# sourceMappingURL=index.js.map