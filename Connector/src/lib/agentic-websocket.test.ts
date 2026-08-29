import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  agenticUpstreamWebSocketPath,
  buildAgenticWebSocketUrl,
  resolveAgenticWsBaseFromConfig,
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

describe('resolveAgenticWsBaseFromConfig', () => {
  it('prefers same-origin request origin in production', () => {
    const base = resolveAgenticWsBaseFromConfig({
      requestOrigin: 'https://deplai.in',
      publicEnvWsUrl: 'wss://deplai.in/agentic',
    });
    assert.equal(base, 'wss://deplai.in/agentic');
  });

  it('falls back to same-origin /agentic when env host mismatches', () => {
    const base = resolveAgenticWsBaseFromConfig({
      publicEnvWsUrl: 'wss://deplai.in/agentic',
      browser: { protocol: 'https:', host: 'localhost:3000' },
    });
    assert.equal(base, 'wss://localhost:3000/agentic');
  });
});
