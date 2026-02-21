export type OpenClawPluginCommandDefinition = {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: { args?: string }) => Promise<{ text: string; isError?: boolean }>;
};

export type OpenClawProviderModel = {
  id: string;
  name?: string;
  input?: string[];
  cost?: {
    input?: number;
    output?: number;
  };
};

export type OpenClawProviderConfig = {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: OpenClawProviderModel[];
};

export type OpenClawConfig = {
  auth?: {
    profiles?: Record<string, { provider?: string; mode?: string }>;
  };
  models?: {
    providers?: Record<string, OpenClawProviderConfig>;
  };
  agents?: {
    defaults?: { model?: string | { primary?: string } };
    list?: Array<{ id?: string; model?: string | { primary?: string } }>;
  };
};

export type KeyRouterProviderPolicy = {
  allow?: string[];
  prefer?: string[];
  deny?: string[];
};

export type KeyRouterHardApplyConfig = {
  enabled?: boolean;
  mode?: "off" | "override" | "pin";
  pinScope?: "agent" | "defaults";
};

export type KeyRouterPluginConfig = {
  enabled?: boolean;
  providers?: KeyRouterProviderPolicy;
  hardApply?: KeyRouterHardApplyConfig;
};

export type OpenClawPluginApi = {
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  registerCommand: (cmd: OpenClawPluginCommandDefinition) => void;
  pluginConfig?: unknown;
  registerCli: (
    registrar: (ctx: {
      program: {
        command: (
          name: string,
        ) => {
          description: (text: string) => unknown;
          command: (
            name: string,
          ) => {
            description: (text: string) => unknown;
            argument: (spec: string, description?: string) => unknown;
            action: (...args: unknown[]) => unknown;
          };
          action: (...args: unknown[]) => unknown;
        };
      };
      logger: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
      };
    }) => void | Promise<void>,
    opts?: { commands?: string[] },
  ) => void;
  registerHook?: (events: string | string[], handler: (...args: unknown[]) => unknown) => void;
  on: (hookName: string, handler: (...args: unknown[]) => unknown) => void;
};

export type OpenClawPluginDefinition = {
  id: string;
  name: string;
  description: string;
  version: string;
  register: (api: OpenClawPluginApi) => void;
};

export type IngestedProvider = {
  id: string;
  modelCount: number;
  hasApiKey: boolean;
};

export type IngestedSnapshot = {
  authProfileCount: number;
  providers: IngestedProvider[];
};

export type NormalizedPartType =
  | "text"
  | "image"
  | "tool_call"
  | "tool_result"
  | "json"
  | "unknown";

export type NormalizedMessagePart = {
  type: NormalizedPartType;
  text?: string;
  imageUrl?: string;
  toolName?: string;
  toolCallId?: string;
  payload?: unknown;
};

export type NormalizedMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool" | "unknown";
  parts: NormalizedMessagePart[];
};

export type NormalizedRequest = {
  messages: NormalizedMessage[];
  plainText: string;
  hasImage: boolean;
  hasToolCall: boolean;
  hasToolResult: boolean;
};

export type RouteDimensionScores = {
  complexity: number;
  reasoning: number;
  coding: number;
  multimodal: number;
  tooling: number;
  contextPressure: number;
  latencySensitivity: number;
  costSensitivity: number;
};

export type RouteCandidate = {
  providerId: string;
  modelId: string;
  score: number;
  inputCost?: number;
  outputCost?: number;
  rationale: string;
};

export type RouteDecision = {
  policy: "cheap" | "balanced" | "reasoning";
  dimensions: RouteDimensionScores;
  topCandidates: RouteCandidate[];
};

export type RetryErrorClass =
  | "quota_exhausted"
  | "rate_limited"
  | "auth_invalid"
  | "transient_network"
  | "server_error"
  | "unknown";

export type RetryRecommendation = {
  errorClass: RetryErrorClass;
  shouldRetry: boolean;
  shouldSwitchModel: boolean;
  strategy?: "default" | "immediate_fallback";
  reason: string;
};

export type UsageEvent = {
  at: string;
  providerId: string;
  modelId: string;
  status: "routed" | "success" | "failed";
  tokensInput?: number;
  tokensOutput?: number;
  errorClass?: RetryErrorClass;
};

export type QuotaEntry = {
  remaining?: number;
  resetAt?: string;
  cooldownUntil?: string;
};

export type KeyRouterState = {
  usage: UsageEvent[];
  quota: Record<string, QuotaEntry>;
};
