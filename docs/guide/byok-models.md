# BYOK model catalog (September 2026)

This page mirrors the **Compare** view at `/dashboard/ai/compare`. Catalog refreshed **2026-09-01**.

## Best performance

For peak DeplAI performance—security analysis, deploy pipelines, and multi-step agents—use:

| Model | Provider id | When to use |
| --- | --- | --- |
| **MiniMax M3** | `MiniMax-M3` | Agentic reasoning, coding, and 1M multimodal context. Set **high** or **extrahigh** thinking effort. |
| **Grok 4.6** | `grok-4.6` | Flagship xAI model for coding and long-running agents. Set **high** or **extrahigh** (`xhigh`) reasoning effort. |

Both models expose a shared effort ladder from `low` through `extrahigh`. Reasoning cannot be disabled on Grok 4.6; MiniMax M3 defaults to adaptive thinking.

## Platform baseline

DeplAI uses **GPT-5.6 Sol** (`gpt-5.6-sol`) as the internal platform baseline for routing and cost accounting. Compare rankings are relative to DeplAI jobs—not a generic chat leaderboard.

## Active flagship models

| Display name | Provider | API id | Context | Input / output (USD per 1M tokens) |
| --- | --- | --- | --- | --- |
| MiniMax M3 | minimax | `MiniMax-M3` | 1M | $0.60 / $2.40 |
| Grok 4.6 | xai | `grok-4.6` | 500k | $2.00 / $6.00 |
| Grok 4.5 | xai | `grok-4.5` | 500k | $2.00 / $6.00 |
| Gemini 3.1 Pro | gemini | `gemini-3.1-pro` | 1M | $2.00 / $12.00 |
| GPT-5.6 Sol | openai | `gpt-5.6-sol` | 1.05M | $4.00 / $20.00 |
| GPT-5.6 Terra | openai | `gpt-5.6-terra` | 1.05M | $2.00 / $12.00 |
| Claude Fable 5 | anthropic | `claude-fable-5` | 1M | $10.00 / $50.00 |
| Claude Opus 5 | anthropic | `claude-opus-5` | 1M | $5.00 / $25.00 |
| Claude Sonnet 5 | anthropic | `claude-sonnet-5` | 1M | $3.00 / $15.00 |

## Other active models

| Display name | Provider | API id | Notes |
| --- | --- | --- | --- |
| Gemini 3.5 Flash-Lite | gemini | `gemini-3.5-flash-lite` | Fast, low-cost Gemini tier |
| MiniMax M2.7 | minimax | `MiniMax-M2.7` | Prior M-series; always-on reasoning |
| Kimi K2.5 | kimi | `kimi-k2.5` | 2M context |
| GLM-5 | glm | `glm-5` | Strong coding and agents |
| GPT-5.6 Luna | openai | `gpt-5.6-luna` | Fast OpenAI tier |
| GPT-5.4 Mini | openai | `gpt-5.4-mini` | Cost-optimized |
| GPT-5.3 Codex | openai | `gpt-5.3-codex` | Coding specialist |
| Claude Haiku 4.5 | anthropic | `claude-haiku-4-5` | Fast Anthropic tier |
| Llama 3.3 70B (Groq) | groq | `llama-3.3-70b-versatile` | Hosted inference |
| GPT OSS 120B (Groq) | groq | `openai/gpt-oss-120b` | Open-weight on Groq |

## Deprecated (still visible, not selectable)

| Model | Replacement |
| --- | --- |
| Gemini 2.5 Pro | Gemini 3.1 Pro |
| Gemini 2.5 Flash | Gemini 3.5 Flash-Lite |
| Claude Opus 4.6 | Claude Opus 5 |
| Claude Sonnet 4.6 | Claude Sonnet 5 |
| Grok 4 | Grok 4.6 |

## Thinking effort by provider

| Provider | Parameter | Shared ladder | Default |
| --- | --- | --- | --- |
| OpenAI | `reasoning.effort` | low · medium · high · extrahigh | medium |
| Anthropic | `output_config.effort` | low · medium · high · extrahigh | high |
| xAI | `reasoning_effort` | low · medium · high · extrahigh | high |
| Gemini | `thinking_level` | low · medium · high | medium |
| MiniMax | `thinking.type` (M3) | low · medium · high · extrahigh | medium |

OpenAI and Anthropic also expose extended API values (`max`, `none`, product-only `ultra`). xAI maps **extrahigh** to API `xhigh`.

## Logical aliases

Agents can request logical names instead of a provider id:

| Alias | Resolves to capability |
| --- | --- |
| `best` / `best_reasoning` | Highest reasoning score among your keyed providers |
| `best_coding` | Strongest coding model |
| `best_agent` | Best agentic / tool-use fit |
| `best_fast` | Fast latency profile |
| `best_cost` | Lowest output price |
| `best_long_context` | Largest context window |
| `best_multimodal` | Vision + audio where supported |

With keys for MiniMax and xAI, `best_reasoning` typically ranks **MiniMax M3** or **Grok 4.6** first—still use **high** or **extrahigh** effort for peak results.

Related: [Core concepts](concepts.md) · [Security and data](security-and-data.md) · [Billing](billing.md)
