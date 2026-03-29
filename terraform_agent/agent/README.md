# LangGraph Infrastructure Agent

Production-ready LangGraph workflow that reads repository signals, infers infrastructure needs, generates modular Terraform, validates output, and refines up to 3 loops.

## Graph

START -> RepoParserNode -> InfraPlannerNode -> TerraformGeneratorNode -> ValidatorNode

- If validation fails and retry_count < 3: ValidatorNode -> RefinerNode -> ValidatorNode
- Else: ValidatorNode -> FinalOutputNode -> END

## Install

```bash
cd terraform_agent/agent
python -m venv .venv
. .venv/Scripts/activate  # Windows PowerShell: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Environment

```bash
export XAI_API_KEY="<your-key>"
# PowerShell:
# $env:XAI_API_KEY = "<your-key>"
```

## One-time remote state bootstrap (example)

```bash
aws s3 mb s3://my-terraform-state-bucket
aws dynamodb create-table \
  --table-name my-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

## Run

```bash
python main.py
```

Outputs are written to:

- `output/<timestamp>/terraform/...`

## Notes

- LLM provider: xAI via OpenAI-compatible API (`https://api.x.ai/v1`)
- Model: `grok-4`
- All structured outputs use JSON mode.
- Validator enforces security and module/remote-state rules.
