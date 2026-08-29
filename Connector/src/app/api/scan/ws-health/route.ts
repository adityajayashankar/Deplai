import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import http from 'node:http';
import { requireAuth } from '@/lib/auth';
import { requireEnv } from '@/lib/env';
import { AGENTIC_URL } from '@/lib/agentic';
import {
  agenticUpstreamWebSocketPath,
  buildAgenticWebSocketUrl,
  resolveAgenticWsBaseFromConfig,
} from '@/lib/agentic-websocket';
function mintWsToken(userId: string, projectId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      sub: String(userId),
      project_id: projectId,
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  ).toString('base64url');
  const secret = requireEnv('WS_TOKEN_SECRET');
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function probeAgenticWebSocket(pathWithQuery: string): Promise<{
  upgraded: boolean;
  statusCode?: number;
  firstMessage?: string;
  error?: string;
}> {
  return new Promise((resolve) => {
    const target = new URL(AGENTIC_URL || 'http://127.0.0.1:8000');
    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      path: pathWithQuery,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        Host: target.host,
      },
      timeout: 10_000,
    });

    let settled = false;
    const finish = (result: {
      upgraded: boolean;
      statusCode?: number;
      firstMessage?: string;
      error?: string;
    }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('upgrade', (res, socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 0) {
          finish({
            upgraded: true,
            statusCode: res.statusCode,
            firstMessage: buffer.toString('utf8', 0, Math.min(buffer.length, 240)),
          });
          socket.destroy();
        }
      });
      socket.setTimeout(3000, () => {
        finish({ upgraded: true, statusCode: res.statusCode });
        socket.destroy();
      });
    });

    req.on('response', (res) => {
      finish({
        upgraded: false,
        statusCode: res.statusCode,
        error: `Agentic returned HTTP ${res.statusCode} instead of a WebSocket upgrade.`,
      });
      res.resume();
    });

    req.on('timeout', () => {
      req.destroy();
      finish({ upgraded: false, error: 'Timed out probing Agentic WebSocket endpoint.' });
    });

    req.on('error', (error) => {
      finish({
        upgraded: false,
        error: error instanceof Error ? error.message : 'Failed to reach Agentic WebSocket endpoint.',
      });
    });

    req.end();
  });
}

export async function GET() {
  const { error, user } = await requireAuth();
  if (error) return error;

  const projectId = 'ws-health-check';
  const token = mintWsToken(String(user!.id), projectId);
  const probePath = `${agenticUpstreamWebSocketPath('scan', projectId)}?token=${encodeURIComponent(token)}`;

  const direct = await probeAgenticWebSocket(probePath);
  const publicWsBase = resolveAgenticWsBaseFromConfig({
    requestOrigin: process.env.NEXT_PUBLIC_APP_URL || undefined,
  });
  const publicBrowserUrl = buildAgenticWebSocketUrl(publicWsBase, 'scan', projectId, token);

  return NextResponse.json({
    success: direct.upgraded,
    agentic_url: AGENTIC_URL,
    public_ws_base: publicWsBase,
    public_browser_url_example: `${publicBrowserUrl.split('?')[0]}?token=…`,
    agentic_upstream_path_example: `${probePath.split('?')[0]}?token=…`,
    direct_probe: direct,
    hints: direct.upgraded
      ? [
          'Connector can reach the Agentic scan WebSocket over the Docker network.',
          'Recreate Caddy after deploy/Caddyfile changes so /agentic/ws/* strips only /agentic.',
        ]
      : [
          'Connector cannot upgrade to the Agentic scan WebSocket. Check agentic-layer logs and AGENTIC_LAYER_URL.',
          'After changing deploy/Caddyfile, run: docker compose --env-file deploy/.env -f docker-compose.production.yml up -d --force-recreate caddy',
        ],
  });
}