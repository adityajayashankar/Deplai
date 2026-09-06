import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { query, withNamedLock } from '@/lib/db';
import { executeChat } from '@/lib/ai-platform/gateway';
import type { ChatMessage, ChatTool } from '@/lib/ai-platform/types';

export async function POST(request: NextRequest) {
  const [encoded, signature] = (request.headers.get('authorization') || '').replace(/^Bearer /, '').split('.');
  const key = process.env.DEPLAI_SERVICE_KEY;
  if (!key || !encoded || !signature) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const expected = Buffer.from(createHmac('sha256', key).update(encoded).digest('hex'));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const scope = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { user: string; org: string; run: string; model: string; exp: number };
  if (scope.exp < Date.now() / 1000 || !/^[a-zA-Z0-9-]{1,80}$/.test(scope.run)) return NextResponse.json({ error: 'Expired wiki capability' }, { status: 401 });
  await query('CREATE TABLE IF NOT EXISTS security_wiki_attempts (run_id VARCHAR(80) PRIMARY KEY, attempts INT NOT NULL DEFAULT 0)');
  const allowed = await withNamedLock(`wiki:${scope.run}`, 3, async () => {
    const rows = await query<Array<{ attempts: number }>>('SELECT attempts FROM security_wiki_attempts WHERE run_id = ?', [scope.run]);
    if ((rows[0]?.attempts || 0) >= 2) return false;
    await query('INSERT INTO security_wiki_attempts (run_id, attempts) VALUES (?, 1) ON DUPLICATE KEY UPDATE attempts = attempts + 1', [scope.run]);
    return true;
  });
  if (!allowed) return NextResponse.json({ error: 'Wiki inference budget exhausted; use direct source context' }, { status: 429 });
  const body = await request.json();
  const messages: ChatMessage[] = (body.messages || []).map((message: Record<string, unknown>) => ({
    role: message.role, content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''),
    toolCallId: message.tool_call_id,
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })) : undefined,
  }));
  const tools: ChatTool[] = (body.tools || []).map((tool: { function: ChatTool }) => tool.function);
  try {
    const result = await executeChat({ userId: scope.user, organizationId: scope.org, source: 'security' }, {
      model: scope.model, accessMode: 'platform', routingPolicy: 'cost_optimized', stream: false, messages, tools, maxTokens: Math.min(Number(body.max_tokens) || 4096, 4096),
      metadata: { product: 'security', stage: 'openwiki', remediation_run_id: scope.run },
    });
    return NextResponse.json({ id: result.requestId, object: 'chat.completion', model: result.model,
      choices: [{ index: 0, finish_reason: result.finishReason, message: { role: 'assistant', content: result.output,
        tool_calls: result.toolCalls.map((call) => ({ id: randomUUID(), type: 'function', function: call })) } }],
      usage: { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens, total_tokens: result.usage.totalTokens } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Wiki request failed' }, { status: 503 });
  }
}
