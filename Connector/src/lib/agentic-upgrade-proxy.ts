import http from 'http';
import https from 'https';
import type { Duplex } from 'stream';
import { AGENTIC_URL } from '@/lib/agentic';

const AGENTIC_PREFIX = '/agentic';
const AGENTIC_WS_PREFIX = '/agentic/ws';

function isAgenticWsUpgrade(url: string): boolean {
  const path = url.split('?')[0] || '';
  return path === AGENTIC_WS_PREFIX || path.startsWith(`${AGENTIC_WS_PREFIX}/`);
}

function targetUrl(): URL {
  return new URL(AGENTIC_URL || 'http://127.0.0.1:8000');
}

function proxyPath(url: string): string {
  const stripped = url.startsWith(AGENTIC_PREFIX) ? url.slice(AGENTIC_PREFIX.length) : url;
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

function writeSocketError(socket: Duplex, status: number, reason: string) {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  } catch {
    /* ignore */
  }
  try {
    socket.destroy();
  } catch {
    /* ignore */
  }
}

function proxyAgenticUpgrade(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer) {
  const target = targetUrl();
  const isTls = target.protocol === 'https:';
  const transport = isTls ? https : http;
  const headers = { ...req.headers, host: target.host };
  const proxyReq = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isTls ? 443 : 80),
    path: proxyPath(req.url || '/'),
    method: 'GET',
    headers,
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    const responseLines = [`HTTP/1.1 ${proxyRes.statusCode || 101} ${proxyRes.statusMessage || 'Switching Protocols'}`];
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value == null) continue;
      responseLines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }
    clientSocket.write(`${responseLines.join('\r\n')}\r\n\r\n`);
    if (proxyHead?.length) proxySocket.write(proxyHead);
    if (head?.length) proxySocket.write(head);
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });

  proxyReq.on('response', (proxyRes) => {
    const responseLines = [`HTTP/1.1 ${proxyRes.statusCode || 502} ${proxyRes.statusMessage || 'Bad Gateway'}`];
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value == null) continue;
      responseLines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }
    clientSocket.write(`${responseLines.join('\r\n')}\r\n\r\n`);
    proxyRes.pipe(clientSocket);
  });

  proxyReq.on('error', () => {
    writeSocketError(clientSocket, 502, 'Bad Gateway');
  });

  proxyReq.end();
}

export function installAgenticUpgradeProxy() {
  const originalEmit = http.Server.prototype.emit;
  if ((originalEmit as { __deplaiAgenticProxy?: boolean }).__deplaiAgenticProxy) return;

  function patchedEmit(this: http.Server, event: string, ...args: unknown[]): boolean {
    if (event === 'upgrade') {
      const req = args[0] as http.IncomingMessage | undefined;
      const socket = args[1] as Duplex | undefined;
      const head = (args[2] as Buffer | undefined) || Buffer.alloc(0);
      const url = req?.url || '';
      if (req && socket && url.startsWith(AGENTIC_PREFIX)) {
        if (!isAgenticWsUpgrade(url)) {
          writeSocketError(socket, 404, 'Not Found');
          return true;
        }
        proxyAgenticUpgrade(req, socket, head);
        return true;
      }
    }
    return originalEmit.apply(this, [event, ...args] as unknown as Parameters<http.Server['emit']>);
  }
  (patchedEmit as { __deplaiAgenticProxy?: boolean }).__deplaiAgenticProxy = true;
  http.Server.prototype.emit = patchedEmit as typeof http.Server.prototype.emit;
}
