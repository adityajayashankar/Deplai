"""
Terraform generation runner.
Wraps the terraform agent AgentOrchestrator for FastAPI consumption.
Uses OpenAI-compatible wiring with Groq defaults.
"""

import json
import importlib
import logging
import os
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Add terraform_rag_agent src to path
_AGENT_SRC = Path(__file__).parent / "terraform_rag_agent" / "src"
_LEGACY_AGENT_SRC = Path(__file__).resolve().parents[1] / "DeplAI_old" / "terraform_rag_agent" / "src"


def _activate_agent_src(agent_src: Path) -> None:
    """Ensure the chosen terraform_rag_agent src path is import-preferred."""
    src = str(agent_src)
    if src in sys.path:
        sys.path.remove(src)
    sys.path.insert(0, src)
    importlib.invalidate_caches()


def _is_available() -> bool:
    """Check whether the RAG agent dependencies are installed."""
    try:
        import openai  # noqa: F401
        return True
    except ImportError:
        return False


def _initialize_agent(provider: str, openai_api_key: str):
    """
    Build an AgentOrchestrator for the given provider.
    Mirrors the logic in DeplAI_old/workers/terraform_generator_worker.py.
    """
    agent_import_error: Optional[Exception] = None
    active_src: Optional[Path] = None
    force_legacy = os.getenv("FORCE_LEGACY_TERRAFORM_RAG", "").strip().lower() in {"1", "true", "yes", "on"}
    candidates = [_LEGACY_AGENT_SRC, _AGENT_SRC] if force_legacy else [_AGENT_SRC, _LEGACY_AGENT_SRC]

    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            _activate_agent_src(candidate)
            from agent.orchestrator import AgentOrchestrator
            from agent.tools.code_generator import TerraformCodeGeneratorTool
            from agent.tools.documentation_generator import DocumentationGeneratorTool
            from agent.tools.terraform_validator import TerraformValidationTool
            from agent.tools.terraform_corrector import TerraformCodeCorrectorTool
            from agent.tools.terraform_documentation_rag_tool import TerraformDocumentationRAGTool
            from agent.tools.other_tf_generator import VariableGeneratorTool, OutputGeneratorTool
            from agent.tools.code_splitter import CodeSplitterTool
            active_src = candidate
            break
        except Exception as exc:
            agent_import_error = exc
            continue

    if active_src is None:
        if agent_import_error:
            raise agent_import_error
        raise RuntimeError("No terraform_rag_agent source path available.")

    if active_src == _LEGACY_AGENT_SRC:
        logger.info("terraform_runner: using legacy DeplAI_old terraform_rag_agent source at %s", active_src)

    collection_map = {
        "aws": "aws_provider_docs",
        "azure": "azure_provider_docs",
        "gcp": "google_provider_docs",
        "kubernetes": "kubernetes_provider_docs",
    }
    collection_name = collection_map.get(provider.lower(), "aws_provider_docs")

    db_path = active_src.parent / "data" / "vector_db"
    legacy_db_path = Path(__file__).resolve().parents[1] / "DeplAI_old" / "terraform_rag_agent" / "data" / "vector_db"
    if not db_path.exists() and legacy_db_path.exists():
        logger.info("terraform_runner: using legacy DeplAI_old vector DB at %s", legacy_db_path)
        db_path = legacy_db_path

    hf_token = os.getenv("HUGGING_FACE_HUB_TOKEN", "")
    tavily_key = os.getenv("TAVILY_API_KEY", "")

    rag_tool = TerraformDocumentationRAGTool(
        db_path=str(db_path),
        collection_name=collection_name,
        hf_token=hf_token,
    )

    web_search_tool = None
    if tavily_key:
        from agent.tools.web_search_tool import WebSearchTool
        web_search_tool = WebSearchTool(api_key=tavily_key)

    corrector_tool = TerraformCodeCorrectorTool(rag_tool=rag_tool, web_search_tool=web_search_tool)

    tools = [
        rag_tool,
        TerraformCodeGeneratorTool(),
        VariableGeneratorTool(),
        OutputGeneratorTool(),
        TerraformValidationTool(),
        corrector_tool,
        DocumentationGeneratorTool(),
        CodeSplitterTool(),
    ]
    if web_search_tool:
        tools.append(web_search_tool)

    # Make the per-request key available to the OpenAI-compatible client without
    # mutating the process-global environment (concurrent requests could race).
    # AgentOrchestrator.__init__ reads os.getenv("OPENAI_API_KEY") once, so we
    # only set it when no key is already present to avoid clobbering another
    # request's key.
    prev_key = os.environ.get("OPENAI_API_KEY")
    prev_base_url = os.environ.get("OPENAI_BASE_URL")
    env_groq_key = os.getenv("GROQ_API_KEY", "").strip()
    key_looks_groq = bool(openai_api_key and openai_api_key.strip().startswith("gsk_"))
    use_groq = bool(env_groq_key) or key_looks_groq

    resolved_base_url = os.getenv("TERRAFORM_AGENT_OPENAI_BASE_URL", "").strip()
    if not resolved_base_url:
        resolved_base_url = os.getenv("GROQ_BASE_URL", "").strip() or "https://api.groq.com/openai/v1"

    default_model = (
        "llama-3.3-70b-versatile"
        if use_groq
        else "llama-3.3-70b-versatile"
    )
    resolved_model = os.getenv("TERRAFORM_AGENT_MODEL", default_model).strip() or default_model
    if openai_api_key and not prev_key:
        os.environ["OPENAI_API_KEY"] = openai_api_key
    elif not prev_key and env_groq_key:
        os.environ["OPENAI_API_KEY"] = env_groq_key
    if not prev_base_url:
        os.environ["OPENAI_BASE_URL"] = resolved_base_url

    try:
        return AgentOrchestrator(tools=tools, llm_model_name=resolved_model)
    finally:
        # Restore original state if we set the key temporarily
        if openai_api_key and not prev_key:
            os.environ.pop("OPENAI_API_KEY", None)
        if not prev_base_url:
            os.environ.pop("OPENAI_BASE_URL", None)


def _collect_output(output_path: str) -> dict[str, str]:
    """Read all .tf/.tfvars files from the agent output directory."""
    files: dict[str, str] = {}
    for filename in os.listdir(output_path):
        if filename.endswith((".tf", ".tfvars")):
            with open(os.path.join(output_path, filename), "r", encoding="utf-8") as f:
                files[filename] = f.read()
    return files


def generate_terraform(
    architecture_json: dict,
    provider: str = "aws",
    project_name: str = "deplai-project",
    openai_api_key: str = "",
) -> Optional[dict]:
    """
    Generate Terraform files from an architecture JSON using the Terraform agent.

    Returns:
        {
          "success": True,
          "terraform_files": {"main.tf": "...", ...},
          "readme": "...",
        }
      or None if dependencies are unavailable (caller should fall back to templates).
    """
    if not _is_available():
        msg = "Terraform agent dependency missing: openai package is not installed."
        logger.warning("terraform_runner: %s", msg)
        return {"success": False, "error": msg}

    try:
        agent = _initialize_agent(provider, openai_api_key)
    except Exception as exc:
        msg = f"Terraform agent initialization failed: {exc}"
        logger.warning("terraform_runner: %s", msg)
        return {"success": False, "error": msg}

    query = (
        f"Generate a complete Terraform project for the following architecture. "
        f"The deployment type is 'Infrastructure-Only'. "
        f"The project name is '{project_name}'. "
        f"The final output should be a full set of valid and deployable HCL files and a README. "
        f"Architecture: {json.dumps(architecture_json, indent=2)}"
    )

    try:
        result = agent.run(query=query, project_name=project_name)
    except Exception as exc:
        msg = f"Terraform agent execution failed: {exc}"
        logger.error("terraform_runner: %s", msg)
        return {"success": False, "error": msg}

    final_answer = result.get("final_answer", {})
    if final_answer.get("status") != "SUCCESS":
        msg = final_answer.get("message", "Agent returned non-SUCCESS status")
        logger.error("terraform_runner: %s", msg)
        return {"success": False, "error": str(msg)}

    output_path = final_answer.get("output_path", "")
    if not output_path or not os.path.isdir(output_path):
        msg = f"Terraform agent produced invalid output path: {output_path}"
        logger.error("terraform_runner: %s", msg)
        return {"success": False, "error": msg}

    terraform_files = _collect_output(output_path)

    readme_path = os.path.join(output_path, "README.md")
    readme = ""
    if os.path.exists(readme_path):
        with open(readme_path, "r", encoding="utf-8") as f:
            readme = f.read()

    # Convert flat filename dict to [{path, content}] list for API response
    files = [
        {"path": f"terraform/{name}", "content": content}
        for name, content in terraform_files.items()
    ]
    if readme:
        files.append({"path": "README.md", "content": readme})

    return {
        "success": True,
        "terraform_files": terraform_files,
        "files": files,
        "readme": readme or "# README not generated.",
    }
