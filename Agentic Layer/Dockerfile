# syntax=docker/dockerfile:1

# Build this image from the repository root. The Agentic Layer imports the
# Terraform Agent, remediation pipeline, KG agent, and diagram/cost agent at
# runtime, so a production image must package all of them together.
FROM python:3.13-slim-bookworm

ARG TERRAFORM_VERSION=1.9.5
ARG TFLINT_VERSION=0.53.0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH="/workspace/Agentic Layer:/workspace:/workspace/Terraform Agent" \
    DEPLAI_WORKSPACE_ROOT=/workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gcc git unzip \
    && curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" \
      -o /tmp/terraform.zip \
    && unzip /tmp/terraform.zip -d /usr/local/bin \
    && curl -fsSL "https://github.com/terraform-linters/tflint/releases/download/v${TFLINT_VERSION}/tflint_linux_amd64.zip" \
      -o /tmp/tflint.zip \
    && unzip /tmp/tflint.zip -d /usr/local/bin \
    && rm -f /tmp/terraform.zip /tmp/tflint.zip \
    && terraform version \
    && tflint --version \
    && rm -rf /var/lib/apt/lists/*

# Install every Python dependency set before copying source, keeping rebuilds
# quick when only application code changes.
COPY ["Agentic Layer/requirements.txt", "/tmp/requirements/agentic.txt"]
COPY ["Terraform Agent/agent/requirements.txt", "/tmp/requirements/terraform-agent.txt"]
COPY ["KGagent/requirements.txt", "/tmp/requirements/kgagent.txt"]
COPY ["Diagram-Cost-Agent/requirements.txt", "/tmp/requirements/diagram-cost.txt"]

# CPU-only PyTorch avoids pulling CUDA libraries into a server image.
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install \
      -r /tmp/requirements/agentic.txt \
      -r /tmp/requirements/terraform-agent.txt \
      -r /tmp/requirements/kgagent.txt \
      -r /tmp/requirements/diagram-cost.txt

# Preserve the workspace layout. It is required by planning_runtime.repo_root(),
# Stage 7's Diagram-Cost-Agent subprocess, and the KG agent fallback imports.
WORKDIR /workspace/Agentic Layer
COPY ["Agentic Layer/", "/workspace/Agentic Layer/"]
COPY ["Terraform Agent/", "/workspace/Terraform Agent/"]
COPY ["remediation_pipeline/", "/workspace/remediation_pipeline/"]
COPY ["KGagent/", "/workspace/KGagent/"]
COPY ["Diagram-Cost-Agent/", "/workspace/Diagram-Cost-Agent/"]

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin deplai \
    && mkdir -p /workspace/runtime /workspace/iac-workspaces \
    && chown -R deplai:deplai /workspace
USER deplai

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD python -c "from urllib.request import urlopen; urlopen('http://127.0.0.1:8000/ready', timeout=3)"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
