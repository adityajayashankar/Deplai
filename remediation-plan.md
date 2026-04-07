# DeplAI — Remediation Agent: Full Build Plan

## Overview

This module sits downstream of the repo scanner (SAST + SCA). It reads vulnerability JSON from Docker volumes, batches fixes using free-tier LLMs, produces unified diffs, and optionally sends a GitHub PR. It is composed of **7 discrete agent modules** with clean typed interfaces between them.

---

## Multi-Agent Architecture

```
VulnIngester → Grouper → SnippetExtractor → LLMRouter → FixGenerator → DiffValidator → RemediationUI
```

Each module is a standalone agent/class with a typed input and output (use Pydantic models). They communicate via in-memory queues or direct function calls — no shared state except a lightweight quota counter for the LLM router.

---

## Module 1 — VulnIngester

**Responsibility:** Read and normalize scanner output from Docker volumes.

**Input:** Mounted paths — `/mnt/scan-results/sast.json`, `/mnt/scan-results/sca.json`

**Output:** `List[Vulnerability]`

```python
class Vulnerability(BaseModel):
    id: str                  # uuid or scanner-assigned ID
    file: str                # relative filepath in repo
    line_start: int
    line_end: int
    rule_id: str
    severity: Literal["critical", "high", "medium", "low"]
    description: str
    cwe: Optional[str]
    type: Literal["sast", "sca"]
```

**Notes:**
- SAST: map directly from scanner output fields.
- SCA: `file` = manifest file (e.g. `package.json`, `requirements.txt`), `line_start` = dependency declaration line.
- Normalize severity strings (e.g. `CRITICAL` → `critical`).

---

## Module 2 — Grouper + Prioritizer

**Responsibility:** Batch vulns by file, deduplicate, and sort for cost-efficient LLM calls.

**Input:** `List[Vulnerability]`

**Output:** `List[FileGroup]`

```python
class FileGroup(BaseModel):
    filepath: str
    language: str                  # detected from extension
    vulns: List[Vulnerability]     # sorted by line_start
    max_severity: str
```

**Rules:**
- Group all vulns sharing the same `file` into one `FileGroup` → one LLM call per file.
- Deduplicate by `(rule_id, line_start)`.
- Sort groups by `max_severity` descending (critical first).
- Detect language from file extension (`.py` → Python, `.ts` → TypeScript, etc.)

---

## Module 3 — SnippetExtractor

**Responsibility:** Extract minimal code context per vuln to keep LLM token usage low.

**Input:** `FileGroup` + repo root path (local clone or GitHub API access token)

**Output:** `SnippetBundle`

```python
class Snippet(BaseModel):
    vuln_id: str
    line_start: int
    line_end: int
    code: str           # extracted lines with inline vuln comment

class SnippetBundle(BaseModel):
    filepath: str
    language: str
    imports_block: str  # first ~15 lines of the file
    snippets: List[Snippet]
    token_estimate: int
```

**Extraction logic:**
- Per vuln: extract `[line_start - 30, line_end + 30]` (clamped to file bounds).
- Prepend import/require block (first 15 lines) only if not already in the window.
- For SCA: extract only `line_start ± 3` lines around the dependency declaration.
- Annotate each snippet with an inline comment: `# VULN: {rule_id} — {description}`.
- **Token cap:** If combined snippets for a FileGroup exceed ~2500 tokens (~9000 chars), split into sub-groups and issue separate LLM calls.

---

## Module 4 — LLMRouter

**Responsibility:** Route each LLM call to the best available free-tier provider, with fallback.

**Input:** Prompt string + estimated token count

**Output:** Raw LLM response string

**Provider priority:**

| Priority | Provider | Model | Free Tier | Best For |
|----------|----------|-------|-----------|----------|
| 1 | Groq | `llama-3.3-70b-versatile` | 14,400 req/day | Speed, code quality |
| 2 | OpenRouter | `deepseek/deepseek-chat-v3-0324:free` | 50 req/day | Complex vulns |
| 3 | Ollama Cloud | `qwen2.5-coder:7b` | Self-hosted | No rate limits |
| 4 | OpenCode API | GPT-4o-mini equivalent | Paid fallback | Last resort |

**Router logic:**
- Maintain in-memory (or Redis) counters per provider: `{provider: calls_used_today}`.
- On each call: pick highest-priority provider with remaining quota.
- On `429 rate limit`: immediately try next provider (single retry, no wait).
- Reset counters at UTC midnight.
- Log provider used per call for cost tracking.

---

## Module 5 — FixGenerator

**Responsibility:** Build the LLM prompt and parse the diff response.

**Input:** `SnippetBundle`

**Output:** `Fix`

```python
class Fix(BaseModel):
    filepath: str
    diff: str                      # unified diff string
    vulns_addressed: List[str]     # vuln IDs covered
    provider_used: str
    tokens_used: int
    status: Literal["auto", "needs_review"]
```

**Prompt template:**
```
You are a security fix assistant. Given a code snippet and vulnerabilities,
return ONLY a unified diff (--- / +++ format) that fixes all listed issues.
Do not explain. Do not include unchanged lines beyond the hunk context.

File: {filepath}
Language: {language}
Vulnerabilities:
{vuln_list}

Imports:
{imports_block}

Code:
{snippets}
```

**Response parsing:**
- Extract unified diff lines: filter for lines starting with `---`, `+++`, `@@`, ` `, `+`, `-`.
- Strip any prose the model adds before/after the diff block.
- If no valid diff found after parsing: mark `status = needs_review`, store raw response for UI display.

---

## Module 6 — DiffValidator

**Responsibility:** Validate diffs before surfacing to UI. Catch malformed patches and syntax errors.

**Input:** `Fix` + repo root path

**Output:** `Fix` (with updated `status`)

**Validation steps:**
1. **Parse diff:** Use `python-patch` or `whatthepatch` — reject malformed hunks.
2. **Apply to temp copy:** Apply patch to an in-memory copy of the file; check result is valid UTF-8 and non-empty.
3. **Lint gate:**
   - Python: `py_compile.compile(tempfile)`
   - JS/TS: parse with `acorn` or `@typescript-eslint/parser` (parse-only, no type-check)
   - Go: `go vet`
   - Other: skip lint, mark `auto`
4. **Status assignment:**
   - All checks pass → `status = "auto"`
   - Lint fails → `status = "needs_review"` (still show in UI with warning badge, do NOT block)
   - Diff unparseable → discard fix, log error

---

## Module 7 — RemediationUI

**Responsibility:** Display diffs, handle user accept/reject, fire GitHub PR, and support refresh/track navigation.

### 7a — Diff Viewer

- Per-file expandable cards.
- Syntax-highlighted unified diff (use `react-diff-viewer-continued` or Monaco Editor diff mode).
- Badge per fix:
  - ✅ `auto` — passed all validation
  - ⚠️ `needs_review` — lint warning, manual inspection recommended
- Accept / Reject toggle per file (default: Accept for `auto`, Reject for `needs_review`).

### 7b — GitHub PR Button (Optional)

Fires only on user click. Flow:

1. Create branch: `deplai/fix-{timestamp}`
2. Apply all **accepted** diffs via GitHub Contents API:
   - `GET /repos/{owner}/{repo}/contents/{path}` → get current SHA
   - `PUT /repos/{owner}/{repo}/contents/{path}` with base64-encoded patched content + SHA
3. `POST /repos/{owner}/{repo}/pulls`:
   - Title: `[DeplAI] Security fixes — {N} vulns addressed`
   - Body: auto-generated markdown table of fixed vulns (ID, severity, file, rule)

**Required:** GitHub OAuth token (user-supplied or from existing DeplAI auth).

### 7c — Refresh Button

- Re-runs Stage 1→3: re-reads Docker volume, re-normalizes, re-extracts snippets.
- OR routes to next track: pass `track` param (`deployment`, `customization`, etc.) to the top-level orchestrator.

---

## Data Flow Summary

```
Docker Volume (sast.json, sca.json)
         │
         ▼
   [VulnIngester]
   List[Vulnerability]
         │
         ▼
   [Grouper]
   List[FileGroup]  ← 1 group = 1 LLM call
         │
         ▼
   [SnippetExtractor]
   SnippetBundle per file  ← max ~2500 tokens each
         │
         ▼
   [LLMRouter] ← Groq → OpenRouter → Ollama → OpenCode
         │
         ▼
   [FixGenerator]
   Fix { filepath, diff, vulns_addressed }
         │
         ▼
   [DiffValidator]
   Fix { status: auto | needs_review }
         │
         ▼
   [RemediationUI]
   ├── Diff viewer (accept/reject per file)
   ├── GitHub PR button (optional)
   └── Refresh / Next Track button
```

---

## Cost Model

| Scenario | LLM Calls | Provider | Cost |
|----------|-----------|----------|------|
| Small repo (5 vuln files) | 5 calls | Groq free | $0.00 |
| Medium repo (20 vuln files) | 20 calls | Groq free | $0.00 |
| Large repo (50 vuln files) | 50 calls | Groq + OpenRouter free | $0.00 |
| Overflow (paid fallback) | Per file | OpenCode/GPT-4o-mini | ~$0.003/file |

Worst case: 100 files all hitting paid fallback = ~$0.30. Well within $0.50 cap.

---

## Implementation Notes for the Agent

- Use **Pydantic v2** for all data models — strict typing catches interface mismatches early.
- The **LLMRouter must be a standalone class** — FixGenerator calls it via interface, never directly imports provider SDKs.
- GitHub PR logic lives **entirely in the UI layer** — backend only produces diffs, never commits.
- Store quota counters in **Redis** if multi-worker, else in-memory dict with a daily reset cron.
- Wrap all LLM calls in `try/except` with a 10s timeout — a hung provider should not stall the pipeline.
- Run DiffValidator in a **threadpool** (it does subprocess calls for linting) — don't block the async event loop.
- The UI should optimistically render fixes as they arrive (streaming from backend via SSE or WebSocket), not wait for all files to be processed.

---

## Directory Structure (suggested)

```
remediation/
├── models.py              # Pydantic schemas (Vulnerability, FileGroup, Fix, etc.)
├── ingester.py            # Module 1: VulnIngester
├── grouper.py             # Module 2: Grouper + Prioritizer
├── extractor.py           # Module 3: SnippetExtractor
├── router.py              # Module 4: LLMRouter
├── generator.py           # Module 5: FixGenerator
├── validator.py           # Module 6: DiffValidator
├── orchestrator.py        # Wires all modules, exposes FastAPI endpoints
└── ui/
    ├── DiffViewer.tsx
    ├── PRButton.tsx
    └── RefreshButton.tsx
```

---

## API Endpoints (FastAPI)

```
POST /remediation/run          # Trigger full pipeline, returns SSE stream of Fix objects
GET  /remediation/status       # Current quota usage per LLM provider
POST /remediation/pr           # Create GitHub PR from accepted fixes (body: { fixes: Fix[] })
POST /remediation/refresh      # Re-run scan from volume
POST /remediation/navigate     # Route to next track (body: { track: "deployment" | "customization" })
```