import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import type { RowDataPacket } from 'mysql2';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { query } from '@/lib/db';
import pool from '@/lib/db';

const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';
const OPENAI_API = 'https://api.openai.com/v1/chat/completions';
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const GROQ_API_KEY = process.env.GROQ_API_KEY?.trim() || '';
const GROQ_MODEL = process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile';
const OLLAMA_CLOUD_API = 'https://ollama.com/api/chat';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL?.trim() || 'qwen2.5-coder:7b';
const OLLAMA_CLOUD_API_KEY = process.env.OLLAMA_API_KEY?.trim() || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY?.trim() || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL?.trim() || 'openai/gpt-oss-120b';

/** Shape of LLM config the client sends when a user has configured a provider via the LLM picker */
interface LLMConfig {
  provider: 'claude' | 'openai' | 'gemini' | 'groq' | 'openrouter' | 'ollama';
  model: string;
  api_key?: string;
}

// Max iterations for the server-side ReAct loop (generate_code retries)
const MAX_REACT_ITERATIONS = 6;

// Tools that must be executed client-side (require browser, PAT, navigation, etc.)
const CLIENT_TOOLS = new Set(['run_scan', 'navigate_to_results', 'start_remediation', 'create_github_repo', 'ask_for_github_pat', 'generate_architecture', 'estimate_cost']);

interface ApiMessage {
  role: string;
  content: string;
}

interface GeneratedFile {
  path: string;
  content: string;
}

interface ParsedStep {
  thought: string;       // extracted THOUGHT: line(s) — agent's internal reasoning
  message: string;       // user-facing reply
  toolCall: { name: string; params: Record<string, unknown> } | null;
}

const SCAN_INTENT_RE = /\b(scan|security scan|audit|sast|sca|scan my repo|run scan|full audit)\b/i;
const REMEDIATION_INTENT_RE = /\b(remediate|remediation|auto[-\s]?remediate|auto[-\s]?fix|fix (?:vulns?|vulnerabilities|findings|issues)|patch (?:vulns?|vulnerabilities|issues))\b/i;
const REPORT_NAV_INTENT_RE = /\b(open|view|show|take me to|go to|navigate to)\b[\s\S]{0,40}\b(report|results|findings|security analysis|dashboard)\b/i;

function inferScanTypeFromText(text: string): 'all' | 'sast' | 'sca' {
  const t = (text || '').toLowerCase();
  if (/\b(sca|dependency|dependencies|deps)\b/.test(t)) return 'sca';
  if (/\b(sast|code(?:\s+review)?|source)\b/.test(t)) return 'sast';
  return 'all';
}

function resolveProjectFromSelection(text: string, projects: ConnectedProject[]): ConnectedProject | null {
  if (!projects.length) return null;
  if (projects.length === 1) return projects[0];

  const raw = (text || '').trim();
  const t = raw.toLowerCase();
  const ordinalMap: Record<string, number> = {
    '1': 0, '1st': 0, 'first': 0, 'first one': 0,
    '2': 1, '2nd': 1, 'second': 1, 'second one': 1,
    '3': 2, '3rd': 2, 'third': 2, 'third one': 2,
  };
  const normalized = t.replace(/\s+/g, ' ').trim();
  if (normalized in ordinalMap) {
    return projects[ordinalMap[normalized]] ?? null;
  }

  const numericMatch = normalized.match(/^#?\s*(\d+)\s*$/);
  if (numericMatch) {
    const idx = Number(numericMatch[1]) - 1;
    return projects[idx] ?? null;
  }

  const byExactId = projects.find(p => p.id.toLowerCase() === t);
  if (byExactId) return byExactId;

  const byContains = projects.find(p => t.includes(p.name.toLowerCase()) || t.includes(p.id.toLowerCase()));
  if (byContains) return byContains;

  return null;
}

function resolveProjectFromConversation(
  latestUserText: string,
  history: ApiMessage[],
  projects: ConnectedProject[],
): ConnectedProject | null {
  const direct = resolveProjectFromSelection(latestUserText, projects);
  if (direct) return direct;

  const recentWindow = [...history]
    .filter(m => m.role === 'user')
    .slice(-8)
    .map(m => (m.content || '').toLowerCase())
    .join('\n');
  const matches = projects.filter(
    p => recentWindow.includes(p.name.toLowerCase()) || recentWindow.includes(p.id.toLowerCase()),
  );

  if (matches.length === 1) return matches[0];
  if (projects.length === 1) return projects[0];
  return null;
}

function inferRunScanFallback(
  history: ApiMessage[],
  projects: ConnectedProject[],
): { message: string; toolCall: { name: string; params: Record<string, unknown> } } | null {
  const latestUser = [...history].reverse().find(m => m.role === 'user');
  if (!latestUser) return null;

  const latestUserText = (latestUser.content || '').trim();
  const latestUserLower = latestUserText.toLowerCase();
  const latestAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
  const askedForProjectOrScanType = /\b(which project|what type of scan|scan type|full audit|deps-only|code review|would you like|want me to scan|want to scan|shall i scan|ready to scan|let me scan)\b/i.test(latestAssistant);

  const looksLikeChoiceReply = /^(1|2|3|1st|2nd|3rd|first|second|third|first one|second one|third one|yes|yep|yeah|sure|ok|okay|go ahead|run it|do it|please|all|sast|sca|full|full scan)\b/i.test(latestUserLower);

  // Only fire when the LLM already asked which project/scan-type and the user gave a
  // selection reply. Do NOT fire on the initial scan request — the LLM handles that via
  // its own TOOL JSON. The standalone hasScanIntent check was removed because it caused
  // the fallback to trigger on the very first new-chat message before any confirmation.
  if (!(askedForProjectOrScanType && looksLikeChoiceReply)) {
    return null;
  }

  const project = resolveProjectFromConversation(latestUserText, history, projects);
  if (!project) return null;
  const scanType = inferScanTypeFromText(latestUserText);
  const scanLabel = scanType === 'all' ? 'full' : scanType.toUpperCase();

  return {
    message: `Starting a ${scanLabel} scan for **${project.name}** now.`,
    toolCall: {
      name: 'run_scan',
      params: {
        project_id: project.id,
        project_name: project.name,
        scan_type: scanType,
      },
    },
  };
}

function inferStartRemediationFallback(
  history: ApiMessage[],
  projects: ConnectedProject[],
): { message: string; toolCall: { name: string; params: Record<string, unknown> } } | null {
  const latestUser = [...history].reverse().find(m => m.role === 'user');
  if (!latestUser) return null;

  const latestUserText = (latestUser.content || '').trim();
  const latestUserLower = latestUserText.toLowerCase();
  const latestAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
  const askedForRemediationProject = /\b(which project|what project|choose a project).*(remediat|fix)\b/i.test(latestAssistant);

  const looksLikeChoiceReply = /^(1|2|3|1st|2nd|3rd|first|second|third|first one|second one|third one|yes|go ahead|run it|do it)\b/.test(latestUserLower);

  // Only fire when the LLM already asked which project to remediate and the user gave a
  // selection reply. Same reasoning as inferRunScanFallback — standalone intent check removed.
  if (!(askedForRemediationProject && looksLikeChoiceReply)) {
    return null;
  }

  const project = resolveProjectFromConversation(latestUserText, history, projects);
  if (!project) return null;

  return {
    message: `Starting remediation for **${project.name}** now.`,
    toolCall: {
      name: 'start_remediation',
      params: {
        project_id: project.id,
        project_name: project.name,
      },
    },
  };
}

function inferNavigateToResultsFallback(
  history: ApiMessage[],
  projects: ConnectedProject[],
): { message: string; toolCall: { name: string; params: Record<string, unknown> } } | null {
  const latestUser = [...history].reverse().find(m => m.role === 'user');
  if (!latestUser) return null;

  const latestUserText = (latestUser.content || '').trim();
  const recentUserText = [...history]
    .filter(m => m.role === 'user')
    .slice(-6)
    .map(m => m.content)
    .join('\n')
    .toLowerCase();

  const hasReportNavIntent =
    REPORT_NAV_INTENT_RE.test(latestUserText.toLowerCase()) ||
    REPORT_NAV_INTENT_RE.test(recentUserText);
  if (!hasReportNavIntent) return null;

  const project = resolveProjectFromConversation(latestUserText, history, projects);
  if (!project) return null;

  return {
    message: `Opening the security report for **${project.name}** now.`,
    toolCall: {
      name: 'navigate_to_results',
      params: {
        project_id: project.id,
        project_name: project.name,
      },
    },
  };
}

// ── System prompt ──────────────────────────────────────────────────────────────

interface ConnectedProject {
  id: string;
  name: string;
  type: string;
}

function buildSystemPrompt(projects: ConnectedProject[]): string {
  const list = projects.length
    ? projects.map(p => `  - "${p.name}" (id: ${p.id}, type: ${p.type})`).join('\n')
    : '  (no projects connected yet)';

  return `You are DeplAI — an elite security engineer AI embedded in the DeplAI platform.

REASONING FORMAT — ReAct
Every response MUST follow this exact format:
THOUGHT: <your reasoning in one line>
<your user-facing message>
TOOL:{"name":"tool_name","params":{...}}

The TOOL: line is MANDATORY when an action is needed. It MUST be the very last line.
The TOOL: line must contain valid JSON immediately after the colon — no spaces before the brace.
Example: TOOL:{"name":"run_scan","params":{"project_id":"abc123","project_name":"myrepo","scan_type":"all"}}

If no tool is needed, omit the TOOL: line entirely and just write your response.

CONNECTED PROJECTS:
${list}

TOOLS:
• run_scan — params: {project_id, project_name, scan_type:"all"|"sast"|"sca"}
• navigate_to_results — params: {project_id, project_name} — MUST use for any "show report/results/findings" request — never reply with plain text
• get_scan_report_context — params: {project_id, project_name} — MUST use before summarizing report/finding output
• generate_code — params: {app_type, name, description, style, requirements}
• create_github_repo — params: {name, description, is_private, enable_pages}
• start_remediation — params: {project_id, project_name, github_token}
• ask_for_github_pat — params: {} — use when user asks which GitHub token permissions are needed
• generate_architecture — params: {prompt, provider:"aws"|"azure"|"gcp"} — generates architecture JSON from user description; use for architecture design requests
• estimate_cost — params: {provider:"aws"|"azure"|"gcp"} — estimates monthly cloud costs; use after architecture is generated or user asks for cost estimation

RULES:
- The assistant must support three modes seamlessly:
  1) Build enterprise-grade websites/apps from chat
  2) Scan and remediate repositories from chat
  3) Answer normal general questions directly like a regular LLM
- Only use project IDs from the list above. Never invent IDs.
- Exactly 1 project → scan it directly. Multiple projects and user hasn't named one → ask once which project AND scan type in a single question. Once the user answers, immediately call run_scan — do not ask again.
- navigate_to_results is MANDATORY for any "report/results/findings/show me" request — never plain text.
- For report summary/explanation requests, call get_scan_report_context first, then answer using the returned context.
- For "build a web app/site" requests, default to app_type:"static" unless the user explicitly asks for a framework.
- After generate_code, immediately call create_github_repo.
- For web app/site deployment requests, set create_github_repo.enable_pages to true.
- Before creating a repo, clearly ask for a GitHub token with permissions:
  - Classic PAT: repo
  - Fine-grained token: Contents (read/write), Pages (read/write), Metadata (read-only)
- After start_remediation, stop — UI shows progress card.
- For architecture design requests ("design an architecture", "what services should I use", "plan my infra"), use generate_architecture.
- After generate_architecture succeeds, offer to estimate costs using estimate_cost.
- For general Q&A that does not require tools, answer directly without calling a tool.
- Keep responses conversational and agentic: acknowledge actions, explain what happened, and suggest a useful next step.
- Never expose raw error JSON. Give one plain-language sentence + next step.`;
}

// ── LLM call (Groq -> Ollama Cloud -> OpenRouter fallback) ───────────────────

async function callLLM(
  messages: ApiMessage[],
  system: string,
  maxTokens = 2048,
  temperature = 0.7,
  clientConfig?: LLMConfig | null,
): Promise<string | null> {
  const normalizedMessages = [
    { role: 'system', content: system },
    ...messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
  ];

  const callOpenAICompatible = async (
    url: string,
    apiKey: string,
    model: string,
    extraHeaders?: Record<string, string>,
  ): Promise<string | null> => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(extraHeaders ?? {}),
      };
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: normalizedMessages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.choices?.[0]?.message?.content?.trim() ?? null;
    } catch {
      return null;
    }
  };

  const callAnthropic = async (apiKey: string, model: string): Promise<string | null> => {
    try {
      const res = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          system,
          max_tokens: maxTokens,
          temperature,
          messages: messages
            .filter(m => m.role === 'assistant' || m.role === 'user')
            .map(m => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: [{ type: 'text', text: m.content }],
            })),
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const content = Array.isArray(data?.content) ? data.content : [];
      const textPart = content.find((p: unknown) => (
        typeof p === 'object' &&
        p !== null &&
        'type' in p &&
        (p as { type?: string }).type === 'text' &&
        'text' in p
      )) as { text?: string } | undefined;
      return textPart?.text?.trim() ?? null;
    } catch {
      return null;
    }
  };

  const callGemini = async (apiKey: string, model: string): Promise<string | null> => {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: messages.map(m => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            })),
            generationConfig: {
              temperature,
              maxOutputTokens: maxTokens,
            },
          }),
          signal: AbortSignal.timeout(90_000),
        },
      );
      if (!res.ok) return null;
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) return null;
      const text = parts
        .map((p: unknown) => (typeof p === 'object' && p !== null && 'text' in p ? String((p as { text?: unknown }).text ?? '') : ''))
        .join('')
        .trim();
      return text || null;
    } catch {
      return null;
    }
  };

  const callOllama = async (url: string, model: string, apiKey?: string): Promise<string | null> => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: normalizedMessages,
          stream: false,
          options: {
            temperature,
            num_predict: maxTokens,
          },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.message?.content?.trim() ?? null;
    } catch {
      return null;
    }
  };

  if (clientConfig?.api_key?.trim()) {
    const key = clientConfig.api_key.trim();
    const model = clientConfig.model?.trim() || OLLAMA_MODEL;
    const provider = clientConfig.provider;

    const fromClient = (() => {
      switch (provider) {
        case 'openai':
          return callOpenAICompatible(OPENAI_API, key, model);
        case 'groq':
          return callOpenAICompatible(GROQ_API, key, model);
        case 'openrouter':
          return callOpenAICompatible(OPENROUTER_API, key, model, {
            'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
            'X-Title': 'DeplAI',
          });
        case 'claude':
          return callAnthropic(key, model);
        case 'gemini':
          return callGemini(key, model);
        case 'ollama':
          return key ? callOllama(OLLAMA_CLOUD_API, model, key) : Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    })();

    const clientResult = await fromClient;
    if (clientResult) return clientResult;
  }

  const callGroq = async (): Promise<string | null> => {
    if (!GROQ_API_KEY) return null;
    return callOpenAICompatible(GROQ_API, GROQ_API_KEY, GROQ_MODEL);
  };

  const groq = await callGroq();
  if (groq) return groq;

  if (OLLAMA_CLOUD_API_KEY) {
    const cloud = await callOllama(OLLAMA_CLOUD_API, OLLAMA_MODEL, OLLAMA_CLOUD_API_KEY);
    if (cloud) return cloud;
  }

  if (OPENROUTER_API_KEY) {
    const openrouter = await callOpenAICompatible(
      OPENROUTER_API,
      OPENROUTER_API_KEY,
      OPENROUTER_MODEL,
      {
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'DeplAI',
      },
    );
    if (openrouter) return openrouter;
  }

  return null;
}
// ── Parse a single ReAct step from raw LLM output ─────────────────────────────
// Format:
//   THOUGHT: <reasoning>
//   <user-facing message lines>
//   [TOOL:{...}]   ← optional, must be last line

function parseStep(raw: string): ParsedStep {
  let text = raw.trim();
  let thought = '';

  // Extract THOUGHT: from the beginning (may span multiple lines if indented)
  const thoughtMatch = text.match(/^THOUGHT:\s*(.+?)(?:\n|$)/i);
  if (thoughtMatch) {
    thought = thoughtMatch[1].trim();
    text = text.slice(thoughtMatch[0].length).trim();
  }

  // Extract TOOL: from the very end — or at the very start when THOUGHT was the only preceding line
  // Also try ACTION: which some LLMs use instead of TOOL:
  let toolCall: ParsedStep['toolCall'] = null;
  let message = text;

  // Try multiple patterns: TOOL:{...} or ACTION:{...} at end or start
  const toolPatterns = [
    { idx: text.lastIndexOf('\nTOOL:'), prefix: 6 },
    { idx: text.lastIndexOf('\nACTION:'), prefix: 8 },
  ];

  let matched = false;
  for (const { idx, prefix } of toolPatterns) {
    if (idx !== -1) {
      const jsonStr = text.slice(idx + prefix).trim();
      message = text.slice(0, idx).trim();
      try {
        const parsed = JSON.parse(jsonStr) as { name: string; params: Record<string, unknown> };
        if (parsed?.name) { toolCall = parsed; matched = true; break; }
      } catch { /* malformed — try next pattern */ }
    }
  }

  if (!matched) {
    if (text.startsWith('TOOL:')) {
      const jsonStr = text.slice(5).trim();
      message = '';
      try {
        const parsed = JSON.parse(jsonStr) as { name: string; params: Record<string, unknown> };
        if (parsed?.name) toolCall = parsed;
      } catch { /* malformed TOOL: — treat as plain text */ }
    } else if (text.startsWith('ACTION:')) {
      const jsonStr = text.slice(7).trim();
      message = '';
      try {
        const parsed = JSON.parse(jsonStr) as { name: string; params: Record<string, unknown> };
        if (parsed?.name) toolCall = parsed;
      } catch { /* malformed ACTION: — treat as plain text */ }
    } else {
      // Last-resort: try to find a JSON object with "name" key embedded in the text
      const jsonMatch = text.match(/\{[^{}]*"name"\s*:\s*"[^"]+"\s*,[^{}]*"params"\s*:\s*\{[^}]*\}[^{}]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as { name: string; params: Record<string, unknown> };
          if (parsed?.name) {
            toolCall = parsed;
            message = text.replace(jsonMatch[0], '').trim();
          }
        } catch { /* fallthrough */ }
      }
    }
  }

  // Safety net: strip any THOUGHT: lines the LLM accidentally left inside the
  // user-facing message body (should be caught above, but LLMs are imperfect).
  message = message.replace(/^THOUGHT:.*$/gim, '').trim();

  return { thought, message, toolCall };
}

// ── Code generation (called inside the ReAct loop) ────────────────────────────

interface CodeGenResult {
  files: GeneratedFile[];
  qualityIssues: string[];
  attempts: number;
}

const REQUIRED_FILE_PATTERNS: Record<string, RegExp[]> = {
  flask: [/(^|\/)app\.py$/i, /(^|\/)requirements\.txt$/i, /(^|\/)README\.md$/i],
  static: [/(^|\/)index\.html$/i, /(^|\/)README\.md$/i],
  react: [/(^|\/)package\.json$/i, /(^|\/)src\/App\.(jsx|tsx)$/i, /(^|\/)README\.md$/i],
  express: [/(^|\/)package\.json$/i, /(^|\/)server\.js$/i, /(^|\/)README\.md$/i],
  nextjs: [/(^|\/)package\.json$/i, /(^|\/)src\/app\/page\.tsx$/i, /(^|\/)README\.md$/i],
};

function normalizeAppType(appType: string): keyof typeof REQUIRED_FILE_PATTERNS {
  if (appType in REQUIRED_FILE_PATTERNS) {
    return appType as keyof typeof REQUIRED_FILE_PATTERNS;
  }
  return 'static';
}

function parseGeneratedFiles(raw: string): GeneratedFile[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is GeneratedFile =>
        f !== null &&
        typeof f === 'object' &&
        typeof f.path === 'string' &&
        f.path.length > 0 &&
        typeof f.content === 'string',
    );
  } catch {
    return [];
  }
}

function assessGeneratedFiles(files: GeneratedFile[], appType: string): string[] {
  if (!files.length) {
    return ['No files were generated'];
  }

  const issues: string[] = [];
  const normalized = normalizeAppType(appType);
  const patterns = REQUIRED_FILE_PATTERNS[normalized];
  const paths = files.map(f => f.path.replace(/\\/g, '/'));

  for (const pattern of patterns) {
    if (!paths.some(p => pattern.test(p))) {
      issues.push(`Missing required file pattern: ${pattern.toString()}`);
    }
  }

  for (const file of files) {
    const path = file.path.replace(/\\/g, '/');
    const content = file.content || '';
    if (!content.trim()) {
      issues.push(`File "${path}" is empty`);
      continue;
    }
    if (content.includes('```')) {
      issues.push(`File "${path}" contains markdown code fences`);
    }
    if (/\bTODO\b/i.test(content) || /\bFIXME\b/i.test(content)) {
      issues.push(`File "${path}" contains TODO/FIXME placeholders`);
    }
    if (/lorem ipsum/i.test(content)) {
      issues.push(`File "${path}" contains placeholder copy`);
    }
  }

  return issues;
}

async function generateArchitecturePlan(
  params: Record<string, string>,
  clientConfig?: LLMConfig | null,
): Promise<string> {
  const { app_type = 'static', name = 'my-app', description = '', requirements = '' } = params;
  const planningPrompt =
    `Create an enterprise architecture plan for a ${app_type} app named "${name}".\n` +
    `Description: ${description || requirements || 'Web application'}\n` +
    `Requirements: ${requirements || description || 'production-ready baseline'}\n\n` +
    `Return plain markdown with these exact headings:\n` +
    `- Architecture\n- Security Controls\n- Deployment Plan\n- File Plan\n` +
    `Be concise and implementation-ready.`;

  const text = await callLLM(
    [{ role: 'user', content: planningPrompt }],
    'You are a principal engineer. Produce practical, production-ready architecture plans.',
    1500,
    0.1,
    clientConfig,
  );

  return text?.trim() || '';
}

async function generateCode(
  params: Record<string, string>,
  clientConfig?: LLMConfig | null,
): Promise<CodeGenResult> {
  const { app_type = 'static', name = 'MyApp', description = '', style = 'dark', requirements = '' } = params;
  const normalizedAppType = normalizeAppType(app_type);
  const architecturePlan = await generateArchitecturePlan(params, clientConfig);
  const MAX_ATTEMPTS = 3;
  let lastFiles: GeneratedFile[] = [];
  let lastIssues: string[] = ['No generation attempt performed yet'];

  const fileGuide: Record<string, string> = {
    flask: '- app.py\n- templates/index.html\n- static/css/style.css\n- static/js/main.js\n- requirements.txt\n- Procfile\n- render.yaml\n- README.md',
    static: '- index.html\n- css/style.css\n- js/main.js\n- README.md',
    react: '- package.json\n- public/index.html\n- src/index.jsx\n- src/App.jsx\n- src/App.css\n- README.md',
    express: '- package.json\n- server.js\n- public/index.html\n- public/css/style.css\n- Procfile\n- render.yaml\n- README.md',
    nextjs: '- package.json\n- next.config.js\n- src/app/page.tsx\n- src/app/layout.tsx\n- src/app/globals.css\n- README.md',
  };

  const codegenSystem =
    'You are an expert full-stack developer. Think through architecture internally, then output only valid JSON. ' +
    'Return ONLY a JSON array of { "path": string, "content": string }. No markdown fences and no prose.';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const priorIssueText = attempt === 1 ? '' : `\nQuality failures from previous attempt:\n- ${lastIssues.join('\n- ')}\n`;
    const prompt =
      `Generate a complete, production-ready ${normalizedAppType} application called "${name}".\n\n` +
      `Description: ${description || requirements || 'A full-featured web application'}\n` +
      `Style: ${style} theme (enterprise-grade)\n` +
      `Requirements: ${requirements || description || 'All standard features for this app type'}\n\n` +
      `Architecture Plan:\n${architecturePlan || 'Follow best-practice layered architecture.'}\n` +
      priorIssueText +
      `Required files:\n${fileGuide[normalizedAppType]}\n\n` +
      `Quality gates:\n` +
      `- Production-ready and runnable immediately\n` +
      `- No TODO/FIXME placeholders, no lorem ipsum\n` +
      `- No markdown fences in file content\n` +
      `- Secure defaults: input validation, safe secret handling, least privilege patterns\n` +
      `- README with setup and deployment instructions\n\n` +
      `Return ONLY the JSON array.`;

    const raw = await callLLM([{ role: 'user', content: prompt }], codegenSystem, 16000, 0.15, clientConfig);
    if (!raw) {
      lastIssues = ['LLM returned no output'];
      continue;
    }

    const files = parseGeneratedFiles(raw);
    const qualityIssues = assessGeneratedFiles(files, normalizedAppType);
    lastFiles = files;
    lastIssues = qualityIssues;

    if (files.length > 0 && qualityIssues.length === 0) {
      return { files, qualityIssues: [], attempts: attempt };
    }
  }

  return { files: lastFiles, qualityIssues: lastIssues, attempts: MAX_ATTEMPTS };
}

interface ScanSupplyChainFinding {
  cve_id: string;
  name: string;
  severity: string;
  fix_version: string | null;
}

interface ScanCodeSecurityFinding {
  cwe_id: string;
  title: string;
  severity: string;
  count: number;
}

interface ScanResultsData {
  supply_chain: ScanSupplyChainFinding[];
  code_security: ScanCodeSecurityFinding[];
}

interface ScanReportContext {
  project_id: string;
  project_name: string;
  status: 'found' | 'not_found' | 'not_initiated' | 'running' | 'error';
  totals: {
    total_findings: number;
    supply_chain: number;
    code_security: number;
    auto_fixable: number;
  };
  severity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    unknown: number;
  };
  top_supply_chain: Array<{ cve_id: string; package: string; severity: string; fix_version: string | null }>;
  top_code_security: Array<{ cwe_id: string; title: string; severity: string; count: number }>;
  note?: string;
  error?: string;
}

function severityRank(severity: string): number {
  const s = severity.toLowerCase();
  if (s === 'critical') return 0;
  if (s === 'high') return 1;
  if (s === 'medium') return 2;
  if (s === 'low') return 3;
  return 4;
}

function normalizeSeverity(severity: unknown): 'critical' | 'high' | 'medium' | 'low' | 'unknown' {
  const s = String(severity || '').toLowerCase();
  if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low') return s;
  return 'unknown';
}

function summarizeScanData(projectId: string, projectName: string, status: ScanReportContext['status'], data: ScanResultsData | null): ScanReportContext {
  if (!data) {
    return {
      project_id: projectId,
      project_name: projectName,
      status,
      totals: { total_findings: 0, supply_chain: 0, code_security: 0, auto_fixable: 0 },
      severity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
      top_supply_chain: [],
      top_code_security: [],
      note: status === 'running'
        ? 'Scan is still running. Summary is not available yet.'
        : status === 'not_initiated'
          ? 'No scan report exists yet for this project.'
          : 'Scan completed with no persisted findings.',
    };
  }

  const severity = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const item of data.supply_chain || []) {
    const key = normalizeSeverity(item.severity);
    severity[key] += 1;
  }
  for (const item of data.code_security || []) {
    const key = normalizeSeverity(item.severity);
    severity[key] += Number(item.count || 0);
  }

  const topSupply = [...(data.supply_chain || [])]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, 8)
    .map(v => ({
      cve_id: v.cve_id || 'N/A',
      package: v.name || 'unknown-package',
      severity: normalizeSeverity(v.severity),
      fix_version: v.fix_version ?? null,
    }));

  const topCode = [...(data.code_security || [])]
    .sort((a, b) => {
      const sev = severityRank(a.severity) - severityRank(b.severity);
      if (sev !== 0) return sev;
      return Number(b.count || 0) - Number(a.count || 0);
    })
    .slice(0, 8)
    .map(v => ({
      cwe_id: v.cwe_id || 'unknown',
      title: v.title || 'Unknown weakness',
      severity: normalizeSeverity(v.severity),
      count: Number(v.count || 0),
    }));

  const autoFixable = (data.supply_chain || []).filter(v => !!v.fix_version).length;
  const codeCount = (data.code_security || []).reduce((sum, item) => sum + Number(item.count || 0), 0);
  const scCount = (data.supply_chain || []).length;

  return {
    project_id: projectId,
    project_name: projectName,
    status,
    totals: {
      total_findings: scCount + codeCount,
      supply_chain: scCount,
      code_security: codeCount,
      auto_fixable: autoFixable,
    },
    severity,
    top_supply_chain: topSupply,
    top_code_security: topCode,
  };
}

async function fetchScanReportContext(
  userId: string,
  projectId: string,
  projectName: string,
): Promise<ScanReportContext> {
  const ownership = await verifyProjectOwnership(userId, projectId);
  if ('error' in ownership) {
    return {
      project_id: projectId,
      project_name: projectName,
      status: 'error',
      totals: { total_findings: 0, supply_chain: 0, code_security: 0, auto_fixable: 0 },
      severity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
      top_supply_chain: [],
      top_code_security: [],
      error: 'Project not found or access denied.',
    };
  }

  try {
    const statusRes = await fetch(`${AGENTIC_URL}/api/scan/status/${projectId}`, {
      headers: agenticHeaders(),
      signal: AbortSignal.timeout(20_000),
    });
    const statusJson = statusRes.ok ? await statusRes.json().catch(() => ({ status: 'not_initiated' })) : { status: 'not_initiated' };
    const rawStatus = String(statusJson.status || 'not_initiated');
    const status: ScanReportContext['status'] =
      rawStatus === 'found' || rawStatus === 'not_found' || rawStatus === 'running'
        ? rawStatus
        : 'not_initiated';

    if (status !== 'found') {
      return summarizeScanData(projectId, projectName, status, null);
    }

    const resultsRes = await fetch(`${AGENTIC_URL}/api/scan/results/${projectId}`, {
      headers: agenticHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resultsRes.ok) {
      return {
        project_id: projectId,
        project_name: projectName,
        status: 'error',
        totals: { total_findings: 0, supply_chain: 0, code_security: 0, auto_fixable: 0 },
        severity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
        top_supply_chain: [],
        top_code_security: [],
        error: 'Scan report exists but details could not be fetched.',
      };
    }

    const payload = await resultsRes.json() as { data?: ScanResultsData };
    const data = payload?.data && typeof payload.data === 'object'
      ? payload.data
      : { supply_chain: [], code_security: [] };

    return summarizeScanData(projectId, projectName, 'found', data);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown scan report error';
    return {
      project_id: projectId,
      project_name: projectName,
      status: 'error',
      totals: { total_findings: 0, supply_chain: 0, code_security: 0, auto_fixable: 0 },
      severity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
      top_supply_chain: [],
      top_code_security: [],
      error: msg,
    };
  }
}

// ── ReAct loop ─────────────────────────────────────────────────────────────────
// Runs entirely server-side for generate_code (Thought → Action → Observation → repeat).
// Breaks out and returns for client-side tools (run_scan, create_github_repo, etc.).

interface ReActResult {
  thought: string;
  message: string;
  toolCall: { name: string; params: Record<string, unknown> } | null;
  generatedFiles: GeneratedFile[] | null;
  observations: string[];   // surfaced to the activity panel
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

async function runReAct(
  userMessages: ApiMessage[],
  system: string,
  userId: string,
  projects: ConnectedProject[],
  clientConfig?: LLMConfig | null,
): Promise<ReActResult> {
  const history: ApiMessage[] = [...userMessages];
  const observations: string[] = [];
  let lastThought = '';
  let lastMessage = '';
  let previousStepSignature = '';
  let repeatedStepCount = 0;

  for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
    const raw = await callLLM(history, system, 2048, 0.7, clientConfig);
    if (!raw) break;

    const step = parseStep(raw);
    lastThought = step.thought || lastThought;
    lastMessage = step.message || lastMessage;
    const stepSignature = step.toolCall
      ? `${step.toolCall.name}::${stableStringify(step.toolCall.params || {})}`
      : `none::${(step.message || '').trim().slice(0, 160)}`;
    if (stepSignature === previousStepSignature) {
      repeatedStepCount += 1;
    } else {
      previousStepSignature = stepSignature;
      repeatedStepCount = 0;
    }

    if (repeatedStepCount >= 2) {
      return {
        thought: step.thought || lastThought,
        message:
          step.message ||
          "I kept repeating the same step. Tell me the exact project and action, and I'll continue.",
        toolCall: null,
        generatedFiles: null,
        observations: [...observations, 'Loop guard triggered: repeated model step.'],
      };
    }

    // No tool — plain conversation reply
    if (!step.toolCall) {
      return { thought: step.thought, message: step.message, toolCall: null, generatedFiles: null, observations };
    }

    const { name, params } = step.toolCall;

    if (name === 'get_scan_report_context') {
      const explicitProjectId = typeof params.project_id === 'string' ? params.project_id.trim() : '';
      const resolvedProjectId = explicitProjectId || (projects.length === 1 ? projects[0].id : '');
      const project = projects.find(p => p.id === resolvedProjectId);
      const resolvedProjectName =
        (typeof params.project_name === 'string' && params.project_name.trim()) ||
        project?.name ||
        resolvedProjectId ||
        'project';

      history.push({ role: 'assistant', content: raw });

      if (!resolvedProjectId) {
        const projectList = projects.length
          ? projects.map(p => `- ${p.name} (id: ${p.id})`).join('\n')
          : '(no connected projects found)';
        return {
          thought: step.thought || lastThought,
          message:
            `I need a project before I can fetch scan results.\n` +
            `Choose one from your workspace:\n${projectList}`,
          toolCall: null,
          generatedFiles: null,
          observations: [
            ...observations,
            'get_scan_report_context requested without a resolvable project_id; returned direct project selection prompt.',
          ],
        };
      }

      const reportContext = await fetchScanReportContext(userId, resolvedProjectId, resolvedProjectName);
      observations.push(`Fetched scan report context for "${resolvedProjectName}" (status: ${reportContext.status}).`);
      history.push({
        role: 'user',
        content: `OBSERVATION: SCAN_REPORT_CONTEXT ${JSON.stringify(reportContext)}`,
      });
      continue;
    }

    // Client-side tool — return immediately so the browser executes it
    if (CLIENT_TOOLS.has(name)) {
      return { thought: step.thought, message: step.message, toolCall: step.toolCall, generatedFiles: null, observations };
    }

    // Server-side: generate_code — execute and observe
    if (name === 'generate_code') {
      const obs = `Iteration ${i + 1}: calling generate_code for "${String(params.name)}"…`;
      observations.push(obs);

      const codegen = await generateCode(params as Record<string, string>, clientConfig);
      const files = codegen.files;

      if (files.length > 0) {
        const qualityLine = codegen.qualityIssues.length
          ? `Quality gate raised ${codegen.qualityIssues.length} issue(s): ${codegen.qualityIssues.slice(0, 3).join('; ')}`
          : `Quality gates passed after ${codegen.attempts} attempt(s).`;
        return {
          thought: step.thought,
          message: step.message,
          toolCall: step.toolCall,
          generatedFiles: files,
          observations: [...observations, `Generated ${files.length} files successfully.`, qualityLine],
        };
      }

      // Empty result — inject OBSERVATION and let the model retry
      const qualityIssueText = codegen.qualityIssues.length
        ? codegen.qualityIssues.slice(0, 6).join('; ')
        : 'No files were returned.';
      observations.push(`Code generation failed quality checks: ${qualityIssueText}`);
      history.push({ role: 'assistant', content: raw });
      history.push({
        role: 'user',
        content:
          'OBSERVATION: The previous generate_code output failed enterprise quality gates. ' +
          `Issues: ${qualityIssueText}. ` +
          'Please regenerate with complete, production-ready files and return ONLY a raw JSON array.',
      });
      continue;
    }

    // Unknown server-side tool — just return
    return { thought: step.thought, message: step.message, toolCall: step.toolCall, generatedFiles: null, observations };
  }

  return {
    thought: lastThought,
    message: lastMessage || "I got stuck in a reasoning loop. Could you rephrase your request?",
    toolCall: null,
    generatedFiles: null,
    observations,
  };
}

// ── Route handler ──────────────────────────────────────────────────────────────

const MAX_MESSAGES_PER_SESSION = 200;

/** Auto-title: first 60 chars of the first user message */
function deriveTitle(messages: ApiMessage[]): string {
  const first = messages.find(m => m.role === 'user');
  return (first?.content ?? 'New chat').slice(0, 60);
}

async function persistExchange(
  userId: string,
  sessionId: string,
  userMsg: ApiMessage,
  result: ReActResult,
) {
  try {
    // Verify session ownership
    const [session] = await query<{ id: string; message_count: number }[]>(
      'SELECT id, message_count FROM chat_sessions WHERE id = ? AND user_id = ?',
      [sessionId, userId],
    );
    if (!session) return;

    const remaining = MAX_MESSAGES_PER_SESSION - session.message_count;
    // Need room for the user message and, when we have one, the assistant reply.
    // If only 1 slot remains but we have an assistant message, skip the whole
    // exchange to avoid persisting a dangling user message with no response.
    if (remaining <= 0 || (remaining === 1 && !!result.message)) return;

    const toInsert: { role: string; content: string; metadata: object | null }[] = [];

    toInsert.push({ role: 'user', content: userMsg.content, metadata: null });

    if (remaining >= 2 && result.message) {
      toInsert.push({
        role: 'assistant',
        content: result.message,
        metadata: {
          thought: result.thought || null,
          tool_call: result.toolCall || null,
          observations: result.observations.length ? result.observations : null,
          generated_file_paths: result.generatedFiles?.map(f => f.path) ?? null,
        },
      });
    }

    for (const msg of toInsert) {
      await query(
        'INSERT INTO chat_messages (id, session_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)',
        [randomUUID(), sessionId, msg.role, msg.content, msg.metadata ? JSON.stringify(msg.metadata) : null],
      );
    }

    await query(
      'UPDATE chat_sessions SET message_count = message_count + ?, updated_at = NOW() WHERE id = ?',
      [toInsert.length, sessionId],
    );
  } catch (e) {
    console.error('[chat/persist]', e);
  }
}

export async function POST(req: NextRequest) {
  const { user, error } = await requireAuth();
  if (error) return error;

  try {
    const body = await req.json();
    const messages: ApiMessage[] = body.messages ?? [];
    const projects: { id: string; name: string; type: string }[] = body.context?.projects ?? [];
    const sessionId: string | null = body.session_id ?? null;
    const isNewSession: boolean = body.is_new_session === true;
    const clientConfig: LLMConfig | null = body.llm_config ?? null;

    // Create a new session in DB if requested
    let resolvedSessionId = sessionId;
    if (isNewSession && user) {
      interface CountRow extends RowDataPacket {
        count: number;
      }
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // Lock the user's session rows for this transaction to prevent concurrent
        // requests from both seeing count < 50 and both inserting a new session,
        // which would exceed the per-user cap.
        const [rows] = await conn.execute<CountRow[]>(
          'SELECT COUNT(*) AS count FROM chat_sessions WHERE user_id = ? FOR UPDATE',
          [user.id],
        );
        const count = Number(rows[0]?.count ?? 0);
        if (count >= 50) {
          await conn.execute(
            'DELETE FROM chat_sessions WHERE user_id = ? ORDER BY updated_at ASC LIMIT 1',
            [user.id],
          );
        }
        const newId = randomUUID();
        const title = deriveTitle(messages);
        await conn.execute(
          'INSERT INTO chat_sessions (id, user_id, title) VALUES (?, ?, ?)',
          [newId, user.id, title],
        );
        await conn.commit();
        resolvedSessionId = newId;
      } catch (e) {
        await conn.rollback().catch(() => {});
        console.error('[chat/new-session]', e);
      } finally {
        conn.release();
      }
    }

    const system = buildSystemPrompt(projects);
    let result = await runReAct(messages, system, user.id, projects, clientConfig);

    // Guard: if the LLM returned a confirmation-required tool call (run_scan /
    // start_remediation) but its message also contains a clarifying question,
    // strip the tool call so the user can answer first.  This prevents the LLM
    // from simultaneously asking "which project?" and firing off the scan.
    const CONFIRMATION_TOOLS = new Set(['run_scan', 'start_remediation']);
    if (
      result.toolCall &&
      CONFIRMATION_TOOLS.has(result.toolCall.name) &&
      result.message?.includes('?')
    ) {
      result = { ...result, toolCall: null };
    }

    // Deterministic safety net:
    // If the LLM confirms a scan in plain text but fails to emit TOOL JSON
    // (common with "1st one"/ordinal follow-ups), infer and trigger run_scan.
    // Do NOT fire if the LLM asked a clarifying question — that means it is
    // handling disambiguation and a tool call would fire prematurely.
    const llmAskedQuestion = !!result.message?.trim() && result.message.includes('?');
    if (!result.toolCall && !llmAskedQuestion) {
      const inferred = inferRunScanFallback(messages, projects);
      if (inferred) {
        result = {
          ...result,
          message: result.message?.trim() ? result.message : inferred.message,
          toolCall: inferred.toolCall,
          observations: [
            ...result.observations,
            'Fallback tool resolver triggered: inferred run_scan from user selection.',
          ],
        };
      }
    }
    if (!result.toolCall && !llmAskedQuestion) {
      const inferred = inferStartRemediationFallback(messages, projects);
      if (inferred) {
        result = {
          ...result,
          message: result.message?.trim() ? result.message : inferred.message,
          toolCall: inferred.toolCall,
          observations: [
            ...result.observations,
            'Fallback tool resolver triggered: inferred start_remediation from user selection.',
          ],
        };
      }
    }
    if (!result.toolCall && !llmAskedQuestion) {
      const inferred = inferNavigateToResultsFallback(messages, projects);
      if (inferred) {
        result = {
          ...result,
          message: result.message?.trim() ? result.message : inferred.message,
          toolCall: inferred.toolCall,
          observations: [
            ...result.observations,
            'Fallback tool resolver triggered: inferred navigate_to_results from user selection.',
          ],
        };
      }
    }

    if (!result.message && !result.toolCall) {
      return NextResponse.json({
        thought: '',
        message:
          `I couldn't reach any LLM backend. Tried Groq (${GROQ_MODEL})` +
          `${OLLAMA_CLOUD_API_KEY ? `, Ollama Cloud (${OLLAMA_MODEL})` : ''}` +
          `${OPENROUTER_API_KEY ? `, then OpenRouter (${OPENROUTER_MODEL})` : ''}.`,
        tool_call: null,
        generated_files: null,
        observations: [],
        session_id: resolvedSessionId,
      });
    }

    // Persist the latest user+assistant exchange to DB
    if (resolvedSessionId && user && messages.length > 0) {
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      if (lastUserMsg) {
        await persistExchange(user.id, resolvedSessionId, lastUserMsg, result);
      }
    }

    return NextResponse.json({
      thought: result.thought,
      message: result.message,
      tool_call: result.toolCall,
      generated_files: result.generatedFiles,
      observations: result.observations,
      session_id: resolvedSessionId,
    });
  } catch (err: unknown) {
    console.error('[/api/chat]', err);
    return NextResponse.json({
      thought: '',
      message: 'Something went wrong. Please try again.',
      tool_call: null,
      generated_files: null,
      observations: [],
    });
  }
}
