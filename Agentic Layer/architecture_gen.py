"""
Architecture JSON generation module.
Adapted from DeplAI_old/architecture_JsonGen.py — RabbitMQ removed.
Provides generate_architecture() callable for FastAPI consumption.
"""

import json
import logging
import os
import httpx
from typing import Optional

logger = logging.getLogger(__name__)

# --- Provider-specific system prompts (carried over from DeplAI_old) -----------

_AWS_SYSTEM_PROMPT = """You are an AWS architecture expert. Generate a detailed AWS architecture in JSON format based on the user's prompt.
The JSON should be structured with a 'title', 'nodes', and 'edges'.
Always include "provider": "aws" and "schema_version": "1.0" at the top level.
Every edge must use "from" and "to" fields that reference valid node ids.
For the `type` field in each node, use specific AWS service names compatible with the Python `diagrams` library AND for cost estimation (e.g., `AmazonEC2`, `AmazonRDS`, `AmazonS3`, `AmazonVPC`, `AmazonSubnet`, `ELB`, `AutoScaling`, `AmazonCloudFront`, `AWSLambda`, `AWSIAM`).
Ensure the attributes for each node contain enough detail for cost estimation. For example, EC2 needs `instanceType`, `operatingSystem`, `tenancy`, `termType`, and `storageGB`. S3 needs `storageGB`, `storageClass`, `numPUTRequests`, etc.
The entire output must be a single valid JSON object.

Example of desired structure:
{
    "title": "Cost_Estimation_Ready_Architecture",
    "nodes": [
        {
            "id": "webAppServer",
            "type": "AmazonEC2",
            "label": "Web Server",
            "region": "Asia Pacific (Mumbai)",
            "attributes": {
                "instanceType": "t3.micro",
                "operatingSystem": "Linux",
                "tenancy": "Shared",
                "capacitystatus": "Used",
                "preInstalledSw": "NA",
                "termType": "OnDemand",
                "storageGB": 15,
                "volumeType": "gp3"
            }
        },
        {
            "id": "database",
            "type": "AmazonRDS",
            "label": "RDS Database",
            "region": "Asia Pacific (Mumbai)",
            "attributes": {
                "instanceType": "db.t3.micro",
                "databaseEngine": "PostgreSQL",
                "termType": "OnDemand",
                "storageGB": 100,
                "storageType": "gp3"
            }
        },
        {
            "id": "storageBucket",
            "type": "AmazonS3",
            "label": "S3 Bucket",
            "region": "Asia Pacific (Mumbai)",
            "attributes": {
                "storageGB": 100,
                "storageClass": "Standard",
                "numPUTRequests": 10000,
                "numGETRequests": 50000
            }
        }
    ],
    "edges": [
        { "from": "webAppServer", "to": "database" },
        { "from": "webAppServer", "to": "storageBucket" }
    ]
}

Provide only the JSON object as the response."""

_AZURE_SYSTEM_PROMPT = """You are an Azure architecture expert. Generate a detailed Azure architecture in JSON format based on the user's prompt.
The JSON should be structured with a 'title', 'nodes', and 'edges'.
Always include "provider": "azure" and "schema_version": "1.0" at the top level.
Every edge must use "from" and "to" fields that reference valid node ids.
For the `type` field in each node, use specific Azure service names that can be mapped for cost estimation.
Ensure the attributes for each node contain enough detail for cost estimation. For example, VMs need `vmSize`, `operatingSystem`, `hoursPerMonth`, and `numberOfInstances`. Storage needs `storageGB`, `accessTier`, `redundancy`, etc.
The entire output must be a single valid JSON object.

Example of desired structure:
{
    "title": "Azure_Architecture_Example",
    "nodes": [
        {
          "id": "webAppServer",
          "type": "VirtualMachines",
          "label": "Web Server",
          "region": "eastus",
          "attributes": {
            "vmSize": "Standard_D2_v3",
            "operatingSystem": "Windows",
            "tier": "Standard",
            "billingOption": "PayAsYouGo",
            "hoursPerMonth": 730,
            "numberOfInstances": 1
          }
        },
        {
          "id": "blobStorage",
          "type": "BlobStorage",
          "label": "Blob Storage",
          "region": "eastus",
          "attributes": {
            "storageGB": 500,
            "accessTier": "Cool",
            "redundancy": "LRS"
          }
        }
    ],
    "edges": [
        { "from": "webAppServer", "to": "blobStorage" }
    ]
}

Provide only the JSON object as the response."""

_GCP_SYSTEM_PROMPT = """You are a Google Cloud Platform (GCP) architecture expert. Generate a detailed GCP architecture in JSON format based on the user's prompt.
The JSON should be structured with a 'title', 'nodes', and 'edges'.
Always include "provider": "gcp" and "schema_version": "1.0" at the top level.
Every edge must use "from" and "to" fields that reference valid node ids.
For the `type` field in each node, use specific GCP service names (e.g., 'GCE', 'GCS', 'CloudSQL', 'CloudFunctions', 'VPC').
Ensure attributes provide details for cost estimation, like `instanceType` for compute and `storageClass` for storage.
The entire output must be a single valid JSON object.

Example of desired structure:
{
    "title": "GCP_Architecture_Example",
    "nodes": [
        {
            "id": "webInstance",
            "type": "GCE",
            "label": "Web Server Instance",
            "region": "us-central1",
            "attributes": {
                "instanceType": "e2-medium",
                "operatingSystem": "Debian",
                "termType": "OnDemand",
                "storageGB": 20,
                "volumeType": "pd-standard"
            }
        },
        {
            "id": "sqlDatabase",
            "type": "CloudSQL",
            "label": "Cloud SQL DB",
            "region": "us-central1",
            "attributes": {
                "instanceType": "db-n1-standard-1",
                "databaseEngine": "PostgreSQL",
                "termType": "OnDemand",
                "storageGB": 100
            }
        }
    ],
    "edges": [
        { "from": "webInstance", "to": "sqlDatabase" }
    ]
}

Provide only the JSON object as the response."""


def _system_prompt_for(provider: str) -> str:
    p = provider.strip().upper()
    if p == "AZURE":
        return _AZURE_SYSTEM_PROMPT
    if p == "GCP":
        return _GCP_SYSTEM_PROMPT
    return _AWS_SYSTEM_PROMPT  # default to AWS


# --- LLM dispatch (Groq → OpenRouter fallback) --------------------------------

_GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
_DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"
_DEFAULT_OPENROUTER_MODEL = "mistralai/mistral-7b-instruct"


async def _call_llm_json(system: str, user: str, provider: str = "", api_key: str = "", model: str = "") -> dict:
    """Route through user-specified provider, then Groq, then OpenRouter."""
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]

    # 1. User-specified provider
    if provider and api_key:
        try:
            result = await _openai_compatible(messages, provider, api_key, model)
            if result:
                return result
        except Exception as exc:
            logger.warning("User-provider %s failed in arch gen: %s", provider, exc)

    # 2. Groq
    groq_key = os.getenv("GROQ_API_KEY", "")
    if groq_key:
        try:
            result = await _openai_compatible(messages, "groq", groq_key, _DEFAULT_GROQ_MODEL)
            if result:
                return result
        except Exception as exc:
            logger.warning("Groq fallback failed in arch gen: %s", exc)

    # 3. OpenRouter
    or_key = os.getenv("OPENROUTER_API_KEY", "")
    if or_key:
        try:
            result = await _openai_compatible(messages, "openrouter", or_key, _DEFAULT_OPENROUTER_MODEL)
            if result:
                return result
        except Exception as exc:
            logger.warning("OpenRouter fallback failed in arch gen: %s", exc)

    raise RuntimeError("All LLM providers failed for architecture generation.")


async def _openai_compatible(messages: list, provider: str, api_key: str, model: str) -> Optional[dict]:
    provider_lower = provider.lower()

    url_map = {
        "groq": (_GROQ_URL, model or _DEFAULT_GROQ_MODEL),
        "openrouter": (_OPENROUTER_URL, model or _DEFAULT_OPENROUTER_MODEL),
        "openai": ("https://api.openai.com/v1/chat/completions", model or "gpt-4o-mini"),
        "claude": ("https://api.anthropic.com/v1/messages", model or "claude-3-5-haiku-20241022"),
    }

    if provider_lower == "claude":
        # Anthropic API format is different
        return await _call_anthropic(messages, api_key, model or "claude-3-5-haiku-20241022")

    base_url, resolved_model = url_map.get(provider_lower, (_OPENROUTER_URL, model or _DEFAULT_OPENROUTER_MODEL))

    payload = {
        "model": resolved_model,
        "messages": messages,
        "response_format": {"type": "json_object"},
        "temperature": 0.3,
        "max_tokens": 4096,
    }

    async with httpx.AsyncClient(timeout=90) as client:
        resp = await client.post(
            base_url,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()

    content = data["choices"][0]["message"]["content"]
    return json.loads(content)


async def _call_anthropic(messages: list, api_key: str, model: str) -> Optional[dict]:
    system_msgs = [m["content"] for m in messages if m["role"] == "system"]
    user_msgs = [m for m in messages if m["role"] != "system"]
    payload = {
        "model": model,
        "max_tokens": 4096,
        "system": "\n\n".join(system_msgs),
        "messages": user_msgs,
    }
    async with httpx.AsyncClient(timeout=90) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
    text = data["content"][0]["text"]
    # Anthropic doesn't have json_object mode — extract JSON via brace-depth
    # matching (the greedy regex r"\{.*\}" could capture garbage if the LLM
    # includes braces in explanation text).
    depth = 0
    obj_start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                obj_start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and obj_start != -1:
                candidate = text[obj_start : i + 1]
                try:
                    return json.loads(candidate)
                except json.JSONDecodeError:
                    obj_start = -1
                    continue
    # Last resort: try parsing the entire text
    return json.loads(text)


# --- Public API ---------------------------------------------------------------

async def generate_architecture(
    prompt: str,
    provider: str = "aws",
    llm_provider: str = "",
    llm_api_key: str = "",
    llm_model: str = "",
) -> dict:
    """
    Generate an architecture JSON from a natural language prompt.

    Returns:
        {"success": True, "architecture_json": {...}}
      or
        {"success": False, "error": "..."}
    """
    # Inject provider context into the prompt if not already present
    augmented_prompt = prompt
    if "provider:" not in prompt.lower():
        augmented_prompt = f"Provider: {provider.upper()}\n\n{prompt}"

    system = _system_prompt_for(provider)
    try:
        arch = await _call_llm_json(system, augmented_prompt, llm_provider, llm_api_key, llm_model)
        return {"success": True, "architecture_json": arch}
    except json.JSONDecodeError as exc:
        logger.error("Architecture gen: JSON parse failed: %s", exc)
        return {"success": False, "error": f"LLM returned invalid JSON: {exc}"}
    except Exception as exc:
        logger.error("Architecture gen failed: %s", exc)
        return {"success": False, "error": str(exc)}
