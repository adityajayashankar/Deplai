import assert from 'node:assert/strict';
import test from 'node:test';
import { AiPlatformError } from '../errors';
import { getProviderDefinition } from './definitions';
import { OpenAICompatibleAdapter } from './openai-compatible';

function adapter(): OpenAICompatibleAdapter {
  const definition = getProviderDefinition('openrouter');
  assert.ok(definition);
  return new OpenAICompatibleAdapter(definition);
}

test('OpenRouter 429 without Retry-After carries the actual account reset time', async () => {
  const previousFetch = globalThis.fetch;
  const reset = Date.now() + 300_000;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded' } }), {
    status: 429, headers: { 'x-ratelimit-limit': '50', 'x-ratelimit-reset': String(reset) },
  });
  try {
    await assert.rejects(adapter().chat({ secret: 'test-secret', model: 'openrouter/free',
      messages: [{ role: 'user', content: 'Reply OK.' }] }),
    (error: unknown) => error instanceof AiPlatformError && error.code === 'RATE_LIMIT'
      && error.detail?.quotaScope === 'account' && error.detail?.rateLimitSource === 'provider'
      && error.detail?.cooldownSource === 'provider_hint'
      && Number(error.detail?.retryAfterSeconds) >= 299 && Number(error.detail?.retryAfterSeconds) <= 300);
  } finally { globalThis.fetch = previousFetch; }
});

test('rejects a successful HTTP response with no completion content', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'request-empty',
    choices: [{ message: { content: '' }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    await assert.rejects(
      adapter().chat({
        secret: 'test-secret',
        model: 'test-model',
        messages: [{ role: 'user', content: 'Return a JSON object.' }],
      }),
      (error: unknown) => error instanceof AiPlatformError
        && error.code === 'PROVIDER_UNAVAILABLE'
        && error.retryable
        && error.detail?.emptyResponse === true,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('accepts a tool-only completion', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'request-tool',
    choices: [{
      message: {
        content: '',
        tool_calls: [{ function: { name: 'inspect', arguments: '{}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const result = await adapter().chat({
      secret: 'test-secret',
      model: 'test-model',
      messages: [{ role: 'user', content: 'Inspect this.' }],
    });
    assert.equal(result.text, '');
    assert.equal(result.toolCalls.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});


test('GLM paid requests enforce provider price ceilings and output reservation', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'z-ai/glm-5.3-flash');
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.reasoning, { max_tokens: 512 });
    assert.deepEqual(body.provider.max_price, { prompt: 0.15, completion: 0.50 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
  };
  try { await adapter().chat({ secret: 'test-secret', model: 'z-ai/glm-5.3-flash', maxTokens: 4096,
    messages: [{ role: 'user', content: 'Reply OK.' }] }); }
  finally { globalThis.fetch = previousFetch; }
});
