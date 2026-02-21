import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KeyRouterState, QuotaEntry, RetryErrorClass, UsageEvent } from "./types.js";

const STATE_DIR = join(homedir(), ".openclaw", "keyrouter");
const STATE_PATH = join(STATE_DIR, "state.json");
const MAX_USAGE_EVENTS = 1000;

function ensureDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

export function loadState(): KeyRouterState {
  ensureDir();
  if (!existsSync(STATE_PATH)) {
    return { usage: [], quota: {} };
  }

  try {
    const raw = readFileSync(STATE_PATH, "utf-8").trim();
    if (!raw) return { usage: [], quota: {} };
    const parsed = JSON.parse(raw) as KeyRouterState;
    return {
      usage: Array.isArray(parsed.usage) ? parsed.usage : [],
      quota: parsed.quota && typeof parsed.quota === "object" ? parsed.quota : {},
    };
  } catch {
    return { usage: [], quota: {} };
  }
}

export function saveState(state: KeyRouterState): void {
  ensureDir();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function recordUsage(event: Omit<UsageEvent, "at">): KeyRouterState {
  const state = loadState();
  state.usage.push({ ...event, at: new Date().toISOString() });
  if (state.usage.length > MAX_USAGE_EVENTS) {
    state.usage = state.usage.slice(state.usage.length - MAX_USAGE_EVENTS);
  }
  saveState(state);
  return state;
}

export function setQuota(modelKey: string, quota: QuotaEntry): KeyRouterState {
  const state = loadState();
  state.quota[modelKey] = quota;
  saveState(state);
  return state;
}

export function applyCooldown(modelKey: string, minutes: number): KeyRouterState {
  const state = loadState();
  const existing = state.quota[modelKey] ?? {};
  const cooldownUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  state.quota[modelKey] = {
    ...existing,
    cooldownUntil,
  };
  saveState(state);
  return state;
}

export function summarizeUsage(state: KeyRouterState): string {
  const lines = [
    "KeyRouter Usage Summary",
    `- Events: ${state.usage.length}`,
  ];

  const grouped = new Map<string, { total: number; failed: number; routed: number; success: number }>();
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

export function summarizeQuota(state: KeyRouterState): string {
  const lines = [
    "KeyRouter Quota Summary",
    `- Entries: ${Object.keys(state.quota).length}`,
  ];

  if (!Object.keys(state.quota).length) {
    lines.push("- No quota records yet");
    return lines.join("\n");
  }

  for (const [modelKey, q] of Object.entries(state.quota)) {
    lines.push(
      `  - ${modelKey}: remaining=${q.remaining ?? "?"}, resetAt=${q.resetAt ?? "?"}, cooldownUntil=${q.cooldownUntil ?? "-"}`,
    );
  }

  return lines.join("\n");
}

export function markFailureWithError(modelKey: string, errorClass: RetryErrorClass): KeyRouterState {
  const cooldown = errorClass === "rate_limited" ? 2 : errorClass === "quota_exhausted" ? 10 : 1;
  return applyCooldown(modelKey, cooldown);
}
