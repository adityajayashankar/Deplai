// Requires operator-installed Playwright and Chromium on the dedicated proof host.
// This fixed harness, not imported repository code, may write the synthetic worktree.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const [origin, visibilityFile] = process.argv.slice(2);
if (!/^https:\/\/localhost:\d+$/.test(origin)) throw new Error('Loopback proof origin required');
const browser = await chromium.launch({ headless: true });
const results = {};
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); // Runner independently validates the ephemeral TLS certificate.
  const page = await context.newPage();
  await page.goto(origin);
  assert.equal(await page.title(), 'Preview boundary proof'); results.path_routing = 'PASS';
  const login = await page.evaluate(async () => {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'X-Proof-CSRF': 'synthetic-only' }, credentials: 'same-origin' });
    return [response.status, (await fetch('/api/me', { credentials: 'same-origin' })).status];
  });
  assert.deepEqual(login, [200, 200]);
  const cookie = (await context.cookies()).find(c => c.name === 'proof_session');
  assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Lax' && cookie.path === '/api' && cookie.domain === 'localhost');
  results.cookie_roundtrip = 'PASS';
  assert.equal((await context.request.post(origin + '/api/login', { headers: { Origin: 'https://other.invalid', 'X-Proof-CSRF': 'synthetic-only' } })).status(), 403);
  results.csrf = 'PASS';
  const smallBody = await page.evaluate(async () => (await fetch('/api/body', { method: 'POST', headers: { 'X-Proof-CSRF': 'synthetic-only' }, body: 'x'.repeat(1024 * 1024) })).status);
  assert.equal(smallBody, 200);
  const largeBody = await context.request.post(origin + '/api/body', { data: 'x'.repeat(3 * 1024 * 1024), headers: { Origin: origin, 'X-Proof-CSRF': 'synthetic-only' } });
  assert.equal(largeBody.status(), 413); results.body_size = 'PASS';
  await page.evaluate(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSE timeout')), 5000);
    const source = new EventSource('/api/events'); const values = [];
    source.onmessage = event => { values.push(event.data); if (values.length === 2) { clearTimeout(timer); source.close(); values.join(',') === 'first,second' ? resolve() : reject(new Error('SSE mismatch')); } };
    source.onerror = () => { source.close(); clearTimeout(timer); reject(new Error('SSE failed')); };
  })); results.sse = 'PASS';
  await page.evaluate(() => new Promise((resolve, reject) => {
    const ws = new WebSocket(location.origin.replace('https:', 'wss:') + '/ws');
    const timer = setTimeout(() => reject(new Error('WS timeout')), 5000);
    ws.onmessage = event => { clearTimeout(timer); ws.close(); event.data === 'websocket-ok' ? resolve() : reject(new Error('WS mismatch')); };
  })); results.websocket = 'PASS';
  await page.evaluate(() => {
    window.proofMessages = []; window.proofSocket = new WebSocket(location.origin.replace('https:', 'wss:') + '/hmr');
    window.proofSocket.onmessage = event => window.proofMessages.push(event.data);
  });
  await page.waitForFunction(() => window.proofMessages.includes('before'), undefined, { timeout: 5000 });
  await writeFile(visibilityFile, 'after');
  await page.waitForFunction(() => window.proofMessages.includes('after'), undefined, { timeout: 5000 });
  assert.equal(await page.evaluate(() => fetch('/api/file').then(r => r.text())), 'after');
  results.hot_reload = 'PASS'; results.worktree_visibility = 'PASS';
  await context.close();
} finally { await browser.close(); console.log(JSON.stringify(results)); }
