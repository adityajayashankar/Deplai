# DeplAI Stage 7 Agent

LangGraph-based Stage 7 agent that:
1. Builds a structured AWS diagram from `infra_plan`.
2. Estimates monthly costs using a static pricing table first.
3. Evaluates budget gate status (`PASS | WARN | FAIL`).
4. Emits Stage 7.5 approval payload JSON.

## Structure

```
diagram_cost-estimation_agent/
├── main.py
├── graph.py
├── state.py
├── nodes/
├── tools/
├── prompts/
├── models/
├── requirements.txt
└── README.md
```

## Setup

```bash
cd diagram_cost-estimation_agent
pip install -r requirements.txt
```

Set Groq key only if you want LLM fallback for unknown resource types:

```bash
export GROQ_API_KEY=your_key_here
```

PowerShell:

```powershell
$env:GROQ_API_KEY="your_key_here"
```

## Run

```bash
python main.py
```

This writes:

`output/stage7_approval_payload.json`
