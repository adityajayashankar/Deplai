The safest approach is to make tenant generation manifest-driven, not prompt-driven. AI agents should only write to a narrow allowlist of branding and presentation files, fill a small set of per-tenant templates, and supply environment variables for operational settings. Core backend logic, schema, auth, payments, scheduling, and secret-bearing files should be read-only.

**1. Modify Directly**
These are the best direct-edit targets for tenant customization because they are mostly presentation, metadata, and routing configuration.

- Branding metadata:
  data.js
  data.js
- Public-facing shell and identity:
  Topbar.jsx
  index.js
  index.js
  index.js
  _app.js
  _app.js
- Theme and visual identity:
  tailwind.config.js
  tailwind.config.js
  globals.css
  globals.css
  index.jsx
  index.jsx
- Tenant-visible domain and media mapping:
  domainConfig.js
  domainConfig.js
  apiSetup.js
  apiSetup.js
  videoAPIutil.js
- Assets only:
  assets
  assets

Direct modification should still be constrained by a tenant manifest with fields like company name, logo paths, colors, URLs, contact info, and enabled portals. Agents should populate known placeholders, not invent structure.

**2. Configure Through Environment Variables**
Anything operational, environment-specific, secret-bearing, or integration-specific should move behind env vars rather than AI edits.

Use environment variables for:

- API base URLs and origin selection currently embedded in:
  apiSetup.js
  apiSetup.js
- Public domains and callback URLs currently embedded in:
  domainConfig.js
  domainConfig.js
  videoAPIutil.js
- Backend runtime and integrations currently loaded or referenced from:
  index.js
  schema.prisma
  order.controller.js
  email.js
  email.config.js
  apiSetup.js
  generateJwt.js
  generateRoomId.js
  forms.controller.js

In practice, the generation system should emit per-tenant env files or secret manager entries for values like:

- `DATABASE_URL`
- `PORT`
- `NEXT_PUBLIC_API_BASE`
- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_VIDEO_API_BASE`
- `RAZORPAY_KEY_ID`
- `RAZORPAY_API_SECRET`
- `MAILGUN_API_KEY`
- `MAILGUN_DOMAIN`
- `EMAIL`
- `EMAIL_PASSWORD`
- `MEETIFY_ENDPOINT`
- `MEETIFY_API_KEY`
- `MEETIFY_COMPANY_NAME`
- `MS_APP_ACCESS_KEY`
- `MS_APP_SECRET_KEY`

The rule is simple: if changing the value could break deployment, security, auth, payments, or third-party connectivity, it should be configuration, not a source edit.

**3. Copy As Templates**
The safest generation model is to keep a canonical base repo and stamp tenant-specific overlays from templates.

Files and directories that should be templated per instance:

- Tenant metadata files:
  data.js
  data.js
- Domain and URL maps:
  domainConfig.js
  domainConfig.js
  videoAPIutil.js
- Theme configuration:
  tailwind.config.js
  tailwind.config.js
  globals.css
  globals.css
- Tenant entry pages:
  index.js
  index.js
  index.js
- Static assets:
  assets
  assets

The right pattern is:

1. Keep these files in a `tenant-template` layer or manifest-driven generator.
2. Generate instance-specific versions from structured inputs.
3. Avoid freeform AI rewriting of the rest of the codebase.

For shell files like _app.js and _app.js, use small guarded replacements only for favicon, title, or wrapper branding, not full regeneration.

**4. Must Never Change Automatically**
These files are too sensitive, too coupled, or too secret-bearing for unsupervised AI edits.

- Core backend bootstrap and routing:
  index.js
- Database schema and migrations:
  schema.prisma
  migrations
- Auth, permissions, error handling:
  authenticateToken.js
  errorHandling.js
  auth.controller.js
- Core workflows with tight coupling:
  session.controller.js
  session.js
  order.controller.js
  community.controller.js
  getById.js
- Schedulers and job logic:
  emailScheduler.js
  remainderMailsSender.js
- Secret-bearing or credential files:
  .env
  credentials.json
  token.json
  email.js
  email.config.js
  apiSetup.js
  generateJwt.js
  generateRoomId.js
- Deployment/infrastructure definitions:
  docker-compose.yml
  dockerfile

If a tenant truly needs different workflow logic, treat that as a reviewed engineering change, not an automatic customization.

**5. Validation Before Accepting Changes**
This is the critical part. Safety comes less from “smart prompts” and more from hard validation gates.

Use a five-layer validation pipeline.

1. Manifest validation
   Validate the tenant manifest against a strict schema before any file is touched.
   Required fields should include brand name, logo asset names, color palette, domains, enabled apps, and integration mode selections.
   Reject unknown fields and disallow arbitrary code snippets in manifest values.

2. Allowlist-based file policy
   The generator should only be allowed to write to the approved customization/template files.
   If the agent attempts to edit any file outside the allowlist, reject the run.
   Keep a second denylist for never-edit files, especially the backend core and secret files.

3. Static validation after generation
   Run:
   - JSON and config validation
   - Next.js build checks for each frontend
   - lint checks where configured
   - import/path existence validation for logos, favicons, and public assets
   - environment key completeness checks
   - link/domain consistency checks between generated URLs and env vars

4. Behavioral smoke tests
   At minimum, validate:
   - landing page renders
   - logo and favicon load
   - frontend can resolve API base URL
   - auth pages still mount
   - main navigation renders
   - no missing asset references
   - backend starts with provided env vars
   - Prisma can connect without schema drift

5. Diff and risk review
   Before acceptance, classify the generated diff:
   - low risk: branding, assets, theme, text, allowed config maps
   - medium risk: app shell metadata, URL routing config
   - high risk: anything touching backend workflows, auth, schema, payments, schedulers, or secrets

Only auto-accept low-risk diffs. Medium-risk diffs should require a policy check. High-risk diffs should be blocked.

**Recommended Operating Model**
The safest end-to-end design is:

1. Base repo remains immutable.
2. Tenant manifest is the source of truth.
3. Generator copies a small set of known templates and assets.
4. Environment variables provide runtime differences.
5. Validation gates block any edits outside approved zones.
6. Backend workflow files are read-only unless a human explicitly approves a custom fork.

That keeps AI agents in the role of structured customizers, not autonomous architects of production logic.
