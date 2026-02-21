import {
  ingestSnapshot,
  formatSnapshot,
  loadOpenClawConfig,
  setPrimaryModelSelection,
  setSessionModelSelection,
} from "./openclaw-config.js";
import { normalizeRequest, parseCommandInput } from "./normalizer.js";
import { classifyError, nextCandidate, retryRecommendation } from "./retry-policy.js";
import { routeRequest, formatDecision } from "./router/scorer.js";
import {
  loadState,
  markFailureWithError,
  recordUsage,
  setQuota,
  summarizeQuota,
  summarizeUsage,
} from "./state-store.js";
import type {
  KeyRouterPluginConfig,
  OpenClawPluginDefinition,
  KeyRouterProviderPolicy,
} from "./types.js";

const VERSION = "0.1.0";

function runAudit() {
  const config = loadOpenClawConfig();
  const snapshot = ingestSnapshot(config);
  return formatSnapshot(snapshot);
}

function runRoute(rawArgs: string, providerPolicy?: KeyRouterProviderPolicy) {
  const config = loadOpenClawConfig();
  const normalized = normalizeRequest(parseCommandInput(rawArgs));
  const decision = routeRequest(normalized, config, { providerPolicy });

  if (decision.topCandidates[0]) {
    const top = decision.topCandidates[0];
    recordUsage({
      providerId: top.providerId,
      modelId: top.modelId,
      status: "routed",
    });
  }

  return formatDecision(decision);
}

function runRetry(errorText: string, providerPolicy?: KeyRouterProviderPolicy) {
  const errorClass = classifyError(errorText);
  const recommendation = retryRecommendation(errorClass, 1, 3, true); // tooling-focused path
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
      errorClass,
    });
  }

  const lines = [
    "KeyRouter Retry Recommendation",
    `- errorClass: ${recommendation.errorClass}`,
    `- shouldRetry: ${recommendation.shouldRetry}`,
    `- shouldSwitchModel: ${recommendation.shouldSwitchModel}`,
    `- strategy: ${recommendation.strategy || "default"}`,
    `- reason: ${recommendation.reason}`,
    `- alternateCandidate: ${alternate ? `${alternate.providerId}/${alternate.modelId}` : "(none)"}`,
  ];
  return lines.join("\n");
}

function autoRouteModel(
  input: { prompt: string; messages?: unknown[] },
  providerPolicy?: KeyRouterProviderPolicy,
) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt) return undefined;
  if (prompt.startsWith("/keyrouter_")) return undefined;

  const config = loadOpenClawConfig();
  const payload = Array.isArray(input.messages) && input.messages.length > 0
    ? input.messages
    : [{ role: "user", content: prompt }];
  const normalized = normalizeRequest(payload);
  const decision = routeRequest(normalized, config, { providerPolicy });
  const top = decision.topCandidates[0];
  if (!top) return undefined;

  const providerOverride = top.providerId;
  const modelOverride = top.modelId;
  recordUsage({
    providerId: top.providerId,
    modelId: top.modelId,
    status: "routed",
  });
  return { providerOverride, modelOverride, decision };
}

function resolvePluginConfig(raw: unknown): Required<KeyRouterPluginConfig> {
  const src = (raw || {}) as KeyRouterPluginConfig;
  return {
    enabled: src.enabled !== false,
    providers: {
      allow: src.providers?.allow ?? [],
      prefer: src.providers?.prefer ?? [],
      deny: src.providers?.deny ?? [],
    },
    hardApply: {
      enabled: src.hardApply?.enabled ?? false,
      mode: src.hardApply?.mode ?? "override",
      pinScope: src.hardApply?.pinScope ?? "agent",
    },
  };
}

const plugin: OpenClawPluginDefinition = {
  id: "openclaw-plugin-keyrouter",
  name: "KeyRouter",
  description: "BYOK router scaffold that ingests OpenClaw auth/model configuration",
  version: VERSION,

  register(api) {
    api.logger.info("KeyRouter scaffold loaded");
    const pluginConfig = resolvePluginConfig(api.pluginConfig);
    const providerPolicy = pluginConfig.providers;
    const hardApply = pluginConfig.hardApply;
    const pendingPinBySessionKey = new Map<
      string,
      { agentId: string; providerId: string; modelId: string; modelRef: string }
    >();

    if (!pluginConfig.enabled) {
      api.logger.info("KeyRouter disabled via plugin config");
      return;
    }

    api.on("before_model_resolve", async (event: unknown) => {
      try {
        const payload = (event || {}) as { prompt?: string; messages?: unknown[] };
        const routed = autoRouteModel({
          prompt: payload.prompt || "",
          messages: payload.messages,
        }, providerPolicy);
        if (!routed) return;
        const modelRef = `${routed.providerOverride}/${routed.modelOverride}`;
        api.logger.info(`KeyRouter auto-route(model_resolve) -> ${modelRef}`);
        if (hardApply.enabled && hardApply.mode === "override") {
          return {
            providerOverride: routed.providerOverride,
            modelOverride: routed.modelOverride,
          };
        }
        return;
      } catch (err) {
        api.logger.warn(
          `KeyRouter auto-route(model_resolve) skipped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
    });

    // Fallback for older runtimes that only apply model overrides here.
    api.on("before_agent_start", async (event: unknown, hookCtx: unknown) => {
      try {
        const payload = (event || {}) as { prompt?: string; messages?: unknown[]; agentId?: string };
        const context = (hookCtx || {}) as { agentId?: string; sessionKey?: string };
        const agentId = context.agentId || payload.agentId;
        const routed = autoRouteModel({
          prompt: payload.prompt || "",
          messages: payload.messages,
        }, providerPolicy);
        if (!routed) return;
        const modelRef = `${routed.providerOverride}/${routed.modelOverride}`;
        api.logger.info(`KeyRouter auto-route(agent_start) -> ${modelRef}`);

        if (hardApply.enabled && hardApply.mode === "pin") {
          const changed = setPrimaryModelSelection({
            agentId,
            modelRef,
            scope: hardApply.pinScope ?? "agent",
          });
          const sessionPinned =
            !!agentId &&
            setSessionModelSelection({
              agentId,
              providerId: routed.providerOverride,
              modelId: routed.modelOverride,
            });
          if (agentId && context.sessionKey) {
            pendingPinBySessionKey.set(context.sessionKey, {
              agentId,
              providerId: routed.providerOverride,
              modelId: routed.modelOverride,
              modelRef,
            });
          }
          if (changed) {
            api.logger.info(
              `KeyRouter hard-apply(pin) -> ${modelRef} (${hardApply.pinScope}${agentId ? `:${agentId}` : ""})`,
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
            modelOverride: routed.modelOverride,
          };
        }
      } catch {
        return;
      }
    });

    api.on("agent_end", async (_event: unknown, hookCtx: unknown) => {
      if (!(hardApply.enabled && hardApply.mode === "pin")) return;
      const context = (hookCtx || {}) as { sessionKey?: string };
      const sessionKey = context.sessionKey;
      if (!sessionKey) return;
      const pending = pendingPinBySessionKey.get(sessionKey);
      if (!pending) return;
      pendingPinBySessionKey.delete(sessionKey);
      const applied = setSessionModelSelection({
        agentId: pending.agentId,
        providerId: pending.providerId,
        modelId: pending.modelId,
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
            isError: true,
          };
        }
      },
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
            isError: true,
          };
        }
      },
    });

    api.registerCommand({
      name: "keyrouter_retry",
      description:
        "Classify an error and show retry/fallback recommendation. Usage: /keyrouter_retry <error text>",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const errorText = (ctx.args || "").trim();
        if (!errorText) {
          return {
            text: "Usage: /keyrouter_retry <error text>",
            isError: true,
          };
        }

        return { text: runRetry(errorText, providerPolicy) };
      },
    });

    api.registerCommand({
      name: "keyrouter_usage",
      description: "Show usage summary from KeyRouter local state",
      acceptsArgs: false,
      requireAuth: false,
      handler: async () => {
        const state = loadState();
        return { text: summarizeUsage(state) };
      },
    });

    api.registerCommand({
      name: "keyrouter_quota",
      description: "Show quota/cooldown summary from KeyRouter local state",
      acceptsArgs: false,
      requireAuth: false,
      handler: async () => {
        const state = loadState();
        return { text: summarizeQuota(state) };
      },
    });

    api.registerCommand({
      name: "keyrouter_quota_set",
      description:
        "Set quota state for a model key. Usage: /keyrouter_quota_set <provider/model> <remaining> [reset-iso]",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const raw = (ctx.args || "").trim();
        const [modelKey, remainingRaw, resetAt] = raw.split(/\s+/);
        if (!modelKey || !remainingRaw) {
          return {
            text: "Usage: /keyrouter_quota_set <provider/model> <remaining> [reset-iso]",
            isError: true,
          };
        }
        const remaining = Number(remainingRaw);
        if (!Number.isFinite(remaining)) {
          return { text: `Invalid remaining value: ${remainingRaw}`, isError: true };
        }
        setQuota(modelKey, { remaining, resetAt });
        return { text: `Quota updated for ${modelKey}` };
      },
    });

    api.registerCli(
      ({ program }) => {
        const keyrouter = program.command("keyrouter") as any;
        keyrouter.description("KeyRouter BYOK router utilities");

        keyrouter
          .command("audit")
          .description("Inspect auth profiles and model providers from ~/.openclaw/openclaw.json")
          .action(() => {
            console.log(runAudit());
          });

        keyrouter
          .command("route")
          .description("Run multi-dimension routing for a prompt or JSON envelope")
          .argument("<input>", "Prompt text or JSON message envelope")
          .action((input: string) => {
            console.log(runRoute(String(input || ""), providerPolicy));
          });

        keyrouter
          .command("retry")
          .description("Classify an error and print retry/fallback recommendation")
          .argument("<error>", "Error text to classify")
          .action((errorText: string) => {
            console.log(runRetry(String(errorText || ""), providerPolicy));
          });

        keyrouter
          .command("usage")
          .description("Show KeyRouter usage summary")
          .action(() => {
            console.log(summarizeUsage(loadState()));
          });

        keyrouter
          .command("quota")
          .description("Show KeyRouter quota/cooldown summary")
          .action(() => {
            console.log(summarizeQuota(loadState()));
          });

        keyrouter
          .command("quota-set")
          .description("Set quota for a model key")
          .argument("<modelKey>", "Provider/model key")
          .argument("<remaining>", "Remaining quota count")
          .argument("[resetAt]", "Optional reset ISO timestamp")
          .action((modelKey: string, remainingRaw: string, resetAt?: string) => {
            const remaining = Number(remainingRaw);
            if (!Number.isFinite(remaining)) {
              throw new Error(`Invalid remaining value: ${remainingRaw}`);
            }
            setQuota(String(modelKey), { remaining, resetAt });
            console.log(`Quota updated for ${modelKey}`);
          });
      },
      { commands: ["keyrouter"] },
    );
  },
};

export default plugin;
