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
| `AI_MAX_TOKENS` | `2048` | Max completion tokens. |
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

### NVIDIA NIM (build.nvidia.com)

```bash
AI_MODE=openai
OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1
OPENAI_API_KEY=nvapi-...                 # NVIDIA API key (NVIDIA Developer → build.nvidia.com)
OPENAI_MODEL=deepseek-ai/deepseek-v4-pro-0813
OPENAI_EXTRA_BODY={"chat_template_kwargs":{"thinking":false}}   # disable thinking for tool calling
AI_MAX_TOKENS=16384                      # NIM DeepSeek supports up to 16k
```

The OpenAI adapter sends `tools` + `tool_choice:auto` + `max_tokens`, and merges any
`OPENAI_EXTRA_BODY` JSON into the request — so the NIM integration is identical to the
official SDK example, just server-side with the SmartPlant tool registry.

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
