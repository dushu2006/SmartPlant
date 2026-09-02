# SmartPlant AI — Connecting a Provider

The AI copilot is **provider-agnostic**. The backend ships with three engines behind one
API (`POST /api/ai/chat`): Anthropic Claude, any OpenAI-compatible endpoint, and a
deterministic fallback that works offline. All three share the **same permission-checked
tool registry** and the **same confirmation/audit pipeline** (PRD §47–48), so switching
engines never changes safety behavior.

## 1. Configuration (`.env` at repo root)

The server auto-loads `.env` from the repository root (`cp .env.example .env`).

| Variable | Default | Meaning |
|---|---|---|
| `AI_MODE` | `auto` | `auto` → use a provider if a key is present, else fallback. `anthropic` / `openai` → force a provider. `fallback` → never call an LLM. |
| `ANTHROPIC_API_KEY` | — | Claude key. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5` | Claude model name. |
| `OPENAI_API_KEY` | — | OpenAI key. |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model name. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint (OpenAI, NVIDIA NIM, Ollama, vLLM…). |
| `OPENAI_EXTRA_BODY` | — | JSON merged into every chat request (e.g. NIM `{"chat_template_kwargs":{"thinking":false}}`). |
| `AI_MAX_TOOL_ITERATIONS` | `8` | Tool-calling loop cap. |
| `AI_MAX_TOKENS` | `16384` | Max completion tokens (NIM DeepSeek supports up to 16k). |
| `AI_ACTION_CONFIRM_TTL_MIN` | `10` | Action confirm-token lifetime. |

## 2. Examples

### Anthropic (Claude)

```bash
AI_MODE=auto
ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_MODEL=claude-sonnet-4-5   (default)
```

### OpenAI

```bash
AI_MODE=auto
OPENAI_API_KEY=sk-...
# OPENAI_MODEL=gpt-4o-mini            (default)
```

### Local model via Ollama (no cloud, no cost)

```bash
ollama pull qwen3:14b
AI_MODE=openai
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=qwen3:14b
```

> Local models must support OpenAI-style tool/function calling for the tool loop to work.

### NVIDIA NIM (build.nvidia.com) — recommended

The backend accepts **`NVIDIA_API_KEY`** directly (the same variable the official
NVIDIA SDK example uses), plus `NVIDIA_BASE_URL` / `NVIDIA_MODEL` aliases. You only
need to fill in one key:

```bash
AI_MODE=auto                            # uses NIM automatically when the key is present
NVIDIA_API_KEY=nvapi-...                # NVIDIA API key (NVIDIA Developer → build.nvidia.com)
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL=deepseek-ai/deepseek-v4-pro-0813

# Equivalent explicit form (optional if you prefer OPENAI_* variables):
# OPENAI_API_KEY=nvapi-...
# OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1
# OPENAI_MODEL=deepseek-ai/deepseek-v4-pro-0813
```

NIM-specific defaults shipped in `.env.example`:

| Variable | Default | Meaning |
|---|---|---|
| `NVIDIA_API_KEY` | — | NVIDIA NIM API key (alias of `OPENAI_API_KEY`) |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | NIM OpenAI-compatible base URL |
| `NVIDIA_MODEL` | `deepseek-ai/deepseek-v4-pro-0813` | NIM model id |
| `OPENAI_EXTRA_BODY` | `{"chat_template_kwargs":{"thinking":false}}` | auto-set for NIM endpoints (disables thinking so tool calling works) |
| `AI_TEMPERATURE` / `AI_TOP_P` / `AI_SEED` | `1` / `0.95` / `42` | sampling knobs — same as the SDK example |
| `AI_MAX_TOKENS` | `16384` | NIM DeepSeek supports up to 16k |

The OpenAI adapter sends `tools` + `tool_choice:auto` + `max_tokens` + sampling
parameters, and merges any `OPENAI_EXTRA_BODY` JSON into the request — so the NIM
integration behaves like the official SDK example, just server-side with the
SmartPlant tool registry.

## 3. Restart & verify

```bash
cd backend
npm start
```

Then call the API and inspect the `model` field of the response:

```bash
curl -s http://localhost:4000/api/ai/chat \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <token>' \
  -d '{"message":"Is the Primary Extruder okay?"}'
```

`"model": "fallback-deterministic-v1"` → no LLM connected.
`"model": "anthropic:claude-sonnet-4-5"` or `"openai:gpt-4o-mini"` → connected.

## 3b. Questions the copilot answers

The copilot (full page `#/ai` **and** the floating chatbot on every page) answers
from live tool results — never from memory:

| Question | Tool(s) used |
|---|---|
| "What is the temperature of Extruder 1?" | `get_machine_status` (value + timestamp + quality) |
| "When will Extruder 1 turn off?" | `predict_machine` (shift schedule / run-pattern estimate, basis + confidence) |
| "Does Extruder 1 have any errors?" | `get_active_alerts` (+ `get_machine_status`) |
| "Will Extruder 1 go wrong after some weeks?" | `predict_machine` (failure outlook window + deterioration index + caveat) |
| "Which machines are running?" | `list_machines` |
| "Set up my plant: 2 extruders and 1 conveyor" | `generate_machines_from_description` (preview → confirm → created) |

`predict_machine` is a grounded heuristic (schedule, telemetry trends, health,
alerts, maintenance history) — always presented with an honest caveat, never as
a validated failure probability (PRD §39).

## 4. Grounding evaluation

The eval suite (`backend/test/eval.mjs`, `npm run eval`) runs the same 10 grounding cases
(status, alerts, inventory exactness, refusal, history, energy, documents, actions,
offline staleness, health ranking) against **whatever engine is configured**. Run it once
with a provider connected and once without — both must pass; a connected LLM may use more
tools per question, but the assertions on evidence/numbers/refusals are identical.

## 5. Safety invariants (do not disable)

- The LLM only receives tool **schemas**; it never receives raw SQL or file access.
- Every tool call is re-authorized server-side against the caller's RBAC role.
- Mutating tools (`create_task`, `create_assistance_request`, `acknowledge_alert`) return a
  **preview**; execution happens only via `POST /api/ai/actions/confirm` with a signed,
  single-use, time-boxed token. Confirmed executions are audited (`AI.ACTION_EXECUTE`) and
  trigger notifications.
- Every chat/tool call is recorded in `ai_usage` (provider, model, tokens, latency) and
  surfaced in `/api/admin/ai/usage`.
