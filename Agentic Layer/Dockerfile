FROM python:3.13-slim

# ── Terraform CLI ──────────────────────────────────────────────────────────────
ENV TERRAFORM_VERSION=1.9.5
ENV TFLINT_VERSION=0.53.0

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl unzip ca-certificates git && \
    # Terraform
    curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" \
      -o /tmp/terraform.zip && \
    unzip /tmp/terraform.zip -d /usr/local/bin && \
    rm /tmp/terraform.zip && \
    chmod +x /usr/local/bin/terraform && \
    # tflint
    curl -fsSL "https://github.com/terraform-linters/tflint/releases/download/v${TFLINT_VERSION}/tflint_linux_amd64.zip" \
      -o /tmp/tflint.zip && \
    unzip /tmp/tflint.zip -d /usr/local/bin && \
    rm /tmp/tflint.zip && \
    chmod +x /usr/local/bin/tflint && \
    # Clean up apt cache
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    # Verify installs
    terraform version && \
    tflint --version
# ──────────────────────────────────────────────────────────────────────────────

WORKDIR /app

# Install build tooling
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Install CPU-only torch first to avoid pulling ~2.5 GB of CUDA libraries
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
