// ── Agent: Tool Contract Sentinel ────────────────────────────────────────────
// Role: Schema Enforcer and Payload Prosecutor
// Goal: Enforce 100% schema-valid tool payloads, block malformed calls.
//
// Internal loop: <thinking> → <critique> → <decision>
// Output: ToolContractResult JSON

import { ToolContractResult, ToolError, ToolName } from '../types';
import { hasRequiredParams, TOOL_REGISTRY } from '../tools';

// Policy rules for each tool
const POLICY_RULES: Partial<Record<ToolName, Array<{
  field: string;
  code: string;
  validate: (params: Record<string, unknown>) => string | null;
}>>> = {
  run_scan: [
    {
      field: 'scan_type',
      code: 'INVALID_ENUM',
      validate: (p) =>
        ['sast', 'sca', 'all'].includes(p.scan_type as string)
          ? null
          : `scan_type must be one of: sast, sca, all. Got: ${p.scan_type}`,
    },
  ],
  start_remediation: [
    {
      field: 'github_token',
      code: 'SENSITIVE_FIELD_USER_SUPPLIED',
      validate: (p) =>
        p.github_token &&
        typeof p.github_token === 'string' &&
        p.github_token.startsWith('auto_fill:')
          ? 'github_token must come from user input, not auto-filled'
          : null,
    },
  ],
  create_github_repo: [
    {
      field: 'repo_name',
      code: 'INVALID_REPO_NAME',
      validate: (p) => {
        const name = p.repo_name as string;
        if (!name) return null; // caught by required_params check
        if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(name))
          return `repo_name contains invalid characters: ${name}`;
        return null;
      },
    },
    {
      field: 'github_pat',
      code: 'SENSITIVE_FIELD_AUTO_FILLED',
      validate: (p) =>
        p.github_pat && (p.github_pat as string).startsWith('auto:')
          ? 'github_pat must be user-provided, not auto-filled'
          : null,
    },
  ],
};

function sanitizeParams(
  tool: ToolName,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const def = TOOL_REGISTRY[tool];
  if (!def) return raw;

  const allowed = new Set([...def.required_params, ...def.optional_params]);
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) continue; // strip unknown fields

    // Trim string values
    sanitized[key] = typeof value === 'string' ? value.trim() : value;
  }

  return sanitized;
}

export function runToolContractSentinel(
  toolName: ToolName,
  rawParams: Record<string, unknown>,
): ToolContractResult {
  // <thinking>
  const def = TOOL_REGISTRY[toolName];
  const errors: ToolError[] = [];

  if (!def) {
    return {
      tool_name: toolName,
      valid: false,
      errors: [{ field: 'tool_name', code: 'UNKNOWN_TOOL', message: `Unknown tool: ${toolName}` }],
      sanitized_params: {},
    };
  }

  // <critique> — check required params
  const { missing } = hasRequiredParams(toolName, rawParams);
  for (const field of missing) {
    errors.push({
      field,
      code: 'MISSING_REQUIRED_FIELD',
      message: `Required field '${field}' is missing or empty`,
    });
  }

  // Policy rule violations
  const rules = POLICY_RULES[toolName] ?? [];
  for (const rule of rules) {
    const msg = rule.validate(rawParams);
    if (msg) {
      errors.push({ field: rule.field, code: rule.code, message: msg });
    }
  }

  // <decision>
  const sanitized = sanitizeParams(toolName, rawParams);

  return {
    tool_name: toolName,
    valid: errors.length === 0,
    errors,
    sanitized_params: sanitized,
  };
}
