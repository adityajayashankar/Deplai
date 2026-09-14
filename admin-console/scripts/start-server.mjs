import { createServer } from 'node:http';
import { parse } from 'node:url';
import next from 'next';
import { existsSync } from 'node:fs';
import { adminListenHost, setAdminPeerHeaders } from './server-boundary.mjs';

const dev = process.env.NODE_ENV !== 'production';
const hostname = adminListenHost(process.env, existsSync('/.dockerenv'));
const port = Number(process.env.ADMIN_PORT || 3100);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  createServer((req, res) => {
    setAdminPeerHeaders(req);
    const parsedUrl = parse(req.url || '/', true);
    handle(req, res, parsedUrl);
  }).listen(port, hostname, () => {
    console.log(`Deplai admin console listening on http://${hostname}:${port}`);
  });
});
