import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IngestedSnapshot, OpenClawConfig } from "./types.js";

const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

export function loadOpenClawConfig(): OpenClawConfig {
  if (!existsSync(OPENCLAW_CONFIG_PATH)) {
    return {};
  }

  const raw = readFileSync(OPENCLAW_CONFIG_PATH, "utf-8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw) as OpenClawConfig;
}

export function saveOpenClawConfig(config: OpenClawConfig): void {
  writeFileSync(OPENCLAW_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export function setPrimaryModelSelection(args: {
  agentId?: string;
  modelRef: string;
  scope: "agent" | "defaults";
}): boolean {
  const config = loadOpenClawConfig();
  if (!config.agents) config.agents = {};

  if (args.scope === "agent" && args.agentId) {
    if (!Array.isArray(config.agents.list)) {
      config.agents.list = [];
    }
    const entry = config.agents.list.find(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "id" in (item as Record<string, unknown>) &&
        (item as { id?: string }).id === args.agentId,
    ) as { model?: unknown } | undefined;
    if (!entry) return false;

    const current =
      typeof entry.model === "string"
        ? entry.model
        : ((entry.model as { primary?: string } | undefined)?.primary ?? undefined);
    if (current === args.modelRef) return false;

    entry.model = args.modelRef;
    saveOpenClawConfig(config);
    return true;
  }

  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.model) config.agents.defaults.model = {};
  const currentDefault =
    typeof config.agents.defaults.model === "string"
      ? config.agents.defaults.model
      : config.agents.defaults.model?.primary;
  if (currentDefault === args.modelRef) return false;
  config.agents.defaults.model = args.modelRef;
  saveOpenClawConfig(config);
  return true;
}

export function setSessionModelSelection(args: {
  agentId: string;
  providerId: string;
  modelId: string;
}): boolean {
  const sessionsPath = join(
    homedir(),
    ".openclaw",
    "agents",
    args.agentId,
    "sessions",
    "sessions.json",
  );
  if (!existsSync(sessionsPath)) return false;

  const raw = readFileSync(sessionsPath, "utf-8").trim();
  if (!raw) return false;
  const store = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  const sessionKey = `agent:${args.agentId}:main`;
  const entry = store[sessionKey];
  if (!entry || typeof entry !== "object") return false;

  const changed =
    entry.model !== args.modelId ||
    entry.modelOverride !== args.modelId ||
    entry.modelProvider !== args.providerId ||
    entry.providerOverride !== args.providerId;
  if (!changed) return false;

  entry.model = args.modelId;
  entry.modelOverride = args.modelId;
  entry.modelProvider = args.providerId;
  entry.providerOverride = args.providerId;

  writeFileSync(sessionsPath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  return true;
}

export function ingestSnapshot(config: OpenClawConfig): IngestedSnapshot {
  const profiles = config.auth?.profiles ?? {};
  const providers = config.models?.providers ?? {};

  const providerList = Object.entries(providers)
    .map(([id, value]) => {
      const hasApiKey = typeof value.apiKey === "string" && value.apiKey.length > 0;
      const modelCount = Array.isArray(value.models) ? value.models.length : 0;
      return { id, modelCount, hasApiKey };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    authProfileCount: Object.keys(profiles).length,
    providers: providerList,
  };
}

export function formatSnapshot(snapshot: IngestedSnapshot): string {
  const lines = [
    "KeyRouter Ingest Report",
    `- Auth profiles: ${snapshot.authProfileCount}`,
    `- Providers: ${snapshot.providers.length}`,
  ];

  for (const provider of snapshot.providers) {
    lines.push(
      `  - ${provider.id}: models=${provider.modelCount}, apiKey=${provider.hasApiKey ? "yes" : "no"}`,
    );
  }

  return lines.join("\n");
}
