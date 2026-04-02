# Local LLM <-> Hugging Face Switchback Guide

This repository now supports a configurable LLM endpoint via environment variables.

## Files Involved

1. `tenant_builder_app/backend/.env`
2. `tenant_builder_app/backend/services/llm_client.py`

## Current Mode (Local LM Studio)

Active values in `.env`:

```env
LLM_PROVIDER=lmstudio
LLM_API_URL=http://127.0.0.1:1234/v1/chat/completions
LLM_MODEL_ID=qwen/qwen3-coder-30b
LLM_API_KEY=lm-studio
LLM_USE_RESPONSE_FORMAT=true
```

## Switch Back to Hugging Face

Edit `tenant_builder_app/backend/.env` and set:

```env
LLM_PROVIDER=huggingface
LLM_API_URL=https://router.huggingface.co/v1/chat/completions
LLM_MODEL_ID=Qwen/Qwen2.5-Coder-32B-Instruct
LLM_API_KEY=<your_hf_api_key>
LLM_USE_RESPONSE_FORMAT=true
```

Notes:

1. `LLM_API_KEY` is preferred by the client for all providers.
2. `HF_API_KEY` and `HF_MODEL_ID` are still supported as fallback values.
3. If your provider rejects `response_format`, set `LLM_USE_RESPONSE_FORMAT=false`.

## Optional Legacy HF Variables

If you prefer the old naming style, these still work as fallbacks:

```env
HF_API_URL=https://router.huggingface.co/v1/chat/completions
HF_MODEL_ID=Qwen/Qwen2.5-Coder-32B-Instruct
HF_API_KEY=<your_hf_api_key>
```

## Verify Connectivity

### Local LM Studio

```bash
curl -s http://127.0.0.1:1234/v1/models
```

### Hugging Face

```bash
curl -s https://router.huggingface.co/v1/models \
  -H "Authorization: Bearer <your_hf_api_key>"
```

## Why This Is Safe

Only the transport/config layer changed in `llm_client.py`; planner/modifier/scanner/validator call sites were not changed.
That keeps ingestion and implementation pipelines stable while allowing provider switching through `.env` only.
