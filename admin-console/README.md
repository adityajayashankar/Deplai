# Deplai Owner Admin Console

Private owner control plane for Deplai. This application is intentionally separate from `Connector/`.

## Quick start

```bash
npm install
cp .env.example .env.local
npm run migrate
npm run admin:bootstrap
npm run dev
```

Visit `http://127.0.0.1:3100`.

See `docs/admin-console-security.md` for production access, threat model, and operational guidance.
