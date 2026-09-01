import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  agenticUpstreamWebSocketPath,
  buildAgenticWebSocketUrl,
  resolveAgenticWsBaseFromConfig,
  resolveBrowserAgenticWsBase,
  resolvePublicHttpOrigin,
  stripAgenticPublicPrefix,
} from './agentic-websocket';

describe('agentic-websocket URL construction', () => {
  it('builds the browser scan URL under /agentic', () => {
    const url = buildAgenticWebSocketUrl(
      'wss://deplai.in/agentic',
      'scan',
      'project-123',
      'payload.sig',
    );
    assert.equal(url, 'wss://deplai.in/agentic/ws/scan/project-123?token=payload.sig');
  });

  it('normalizes a trailing slash on the ws base', () => {
    const url = buildAgenticWebSocketUrl(
      'wss://deplai.in/agentic/',
      'remediate',
      'abc',
      'tok',
    );
    assert.equal(url, 'wss://deplai.in/agentic/ws/remediate/abc?token=tok');
  });

  it('encodes project IDs for the path segment', () => {
    const url = buildAgenticWebSocketUrl(
      'wss://deplai.in/agentic',
      'pipeline',
      'id/with/slash',
      'tok',
    );
    assert.equal(
      url,
      'wss://deplai.in/agentic/ws/pipeline/id%2Fwith%2Fslash?token=tok',
    );
  });
});

describe('agentic-websocket Caddy prefix stripping', () => {
  it('maps /agentic/ws/scan/{id} to FastAPI /ws/scan/{id}', () => {
    const upstream = stripAgenticPublicPrefix('/agentic/ws/scan/project-123');
    assert.equal(upstream, agenticUpstreamWebSocketPath('scan', 'project-123'));
    assert.equal(upstream, '/ws/scan/project-123');
  });

  it('documents the handle_path /agentic/ws/* pitfall', () => {
    // handle_path /agentic/ws/* strips "/agentic/ws", which is incorrect for FastAPI.
    const wrongStrip = '/agentic/ws/scan/project-123'.replace(/^\/agentic\/ws/, '') || '/';
    assert.equal(wrongStrip, '/scan/project-123');
    assert.notEqual(wrongStrip, '/ws/scan/project-123');
  });

  it('maps handle_path /agentic/* style stripping', () => {
    const upstream = stripAgenticPublicPrefix('/agentic/ws/remediate/p-1');
    assert.equal(upstream, '/ws/remediate/p-1');
  });
});

describe('resolvePublicHttpOrigin', () => {
  it('prefers X-Forwarded-Host/Proto from Caddy', () => {
    const origin = resolvePublicHttpOrigin({
      requestOrigin: 'http://localhost:3000',
      forwardedHost: 'deplai.in',
      forwardedProto: 'https',
      hostHeader: 'connector:3000',
    });
    assert.equal(origin, 'https://deplai.in');
  });

  it('uses Host header when forwarded headers are absent', () => {
    const origin = resolvePublicHttpOrigin({
      requestOrigin: 'http://localhost:3000',
      hostHeader: 'deplai.in',
    });
    assert.equal(origin, 'https://deplai.in');
  });

  it('falls back to NEXT_PUBLIC_APP_URL when request origin is internal', () => {
    const origin = resolvePublicHttpOrigin({
      requestOrigin: 'http://localhost:3000',
      publicAppUrl: 'https://deplai.in',
    });
    assert.equal(origin, 'https://deplai.in');
  });
});

describe('resolveAgenticWsBaseFromConfig', () => {
  it('prefers same-origin request origin in production', () => {
    const base = resolveAgenticWsBaseFromConfig({
      forwardedHost: 'deplai.in',
      forwardedProto: 'https',
      requestOrigin: 'http://localhost:3000',
      publicEnvWsUrl: 'wss://deplai.in/agentic',
    });
    assert.equal(base, 'wss://deplai.in/agentic');
  });

  it('uses configured public ws url when the browser is on localhost', () => {
    const base = resolveAgenticWsBaseFromConfig({
      publicEnvWsUrl: 'wss://deplai.in/agentic',
      browser: { protocol: 'http:', host: 'localhost:3000' },
    });
    assert.equal(base, 'wss://deplai.in/agentic');
  });

  it('falls back to same-origin /agentic for local-only env', () => {
    const base = resolveAgenticWsBaseFromConfig({
      publicEnvWsUrl: 'ws://localhost:3000/agentic',
      browser: { protocol: 'http:', host: 'localhost:3000' },
    });
    assert.equal(base, 'ws://localhost:3000/agentic');
  });

  it('uses a direct local agentic ws base when configured', () => {
    const base = resolveAgenticWsBaseFromConfig({
      publicEnvWsUrl: 'ws://127.0.0.1:8000',
      browser: { protocol: 'http:', host: 'localhost:3000' },
    });
    assert.equal(base, 'ws://127.0.0.1:8000');
  });
});

describe('resolveBrowserAgenticWsBase', () => {
  it('always uses same-origin on a public production hostname', () => {
    const base = resolveBrowserAgenticWsBase({
      browser: { protocol: 'https:', host: 'deplai.in' },
      publicEnvWsUrl: 'wss://deplai.in/agentic',
    });
    assert.equal(base, 'wss://deplai.in/agentic');
  });

  it('ignores a stale localhost ws-config on production pages', () => {
    const base = resolveBrowserAgenticWsBase({
      browser: { protocol: 'https:', host: 'deplai.in' },
      publicEnvWsUrl: 'ws://localhost:3000/agentic',
    });
    assert.equal(base, 'wss://deplai.in/agentic');
  });

  it('uses direct local agentic ws when configured on localhost', () => {
    const base = resolveBrowserAgenticWsBase({
      browser: { protocol: 'http:', host: 'localhost:3000' },
      publicEnvWsUrl: 'ws://127.0.0.1:8000',
    });
    assert.equal(base, 'ws://127.0.0.1:8000');
  });
});
