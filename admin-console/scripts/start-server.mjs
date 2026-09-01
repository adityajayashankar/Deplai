import { createServer } from 'node:http';
import { parse } from 'node:url';
import next from 'next';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.ADMIN_BIND_HOST || '127.0.0.1';
const port = Number(process.env.ADMIN_PORT || 3100);

if (process.env.NODE_ENV === 'production' && hostname === '0.0.0.0' && process.env.ADMIN_ALLOW_UNSAFE_BIND !== 'true') {
  throw new Error('Refusing to bind admin console to 0.0.0.0 without ADMIN_ALLOW_UNSAFE_BIND=true');
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  createServer((req, res) => {
    const parsedUrl = parse(req.url || '/', true);
    handle(req, res, parsedUrl);
  }).listen(port, hostname, () => {
    console.log(`Deplai admin console listening on http://${hostname}:${port}`);
  });
});
