# KeyRouter (Scaffold)

A BYOK-first OpenClaw plugin scaffold inspired by ClawRouter architecture.

Current scope:
- Loads as an OpenClaw plugin.
- Adds `/keyrouter_audit` command.
- Ingests auth profile count + provider/model inventory from `~/.openclaw/openclaw.json`.

Not implemented yet:
- Request interception/proxying.
- Runtime routing across provider APIs.
- Secret resolution and per-provider request adapters.

## Next build milestones

1. Add provider adapters (OpenAI/Anthropic/OpenRouter).
2. Normalize model metadata and pricing across providers.
3. Add routing policy (quality/cost/latency tiers).
4. Add fallback/retry policy with provider-aware error handling.
