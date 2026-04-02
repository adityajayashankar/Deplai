I’m mapping the repository from the top down first, then I’ll drill into entry points, configuration, and the safest customization surfaces so the final report is grounded in actual code paths.

Read memory

I’m setting a concrete analysis plan now so I can cover architecture, runtime flow, integrations, data, and deployment without missing any of your requirements.

Created 5 todos

I’m collecting the core manifests and top-level layout in parallel so I can identify the actual apps, frameworks, and deployment model before tracing behavior.

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/README.md)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/package.json)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/package.json)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/expert/package.json)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/package.json)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/corporates/package.json)

The repo is shaping up as a multi-app monorepo: several Next.js frontends around one Express/Prisma backend. Next I’m tracing actual startup files, API registration, config loading, and scheduled/background behavior.

Searched for regex `node-cron|node-schedule|scheduleJob|cron.schedule|setInterval\(|agenda|bull|queue` (`**/backend/**`), 21 results

Searched for regex `process\.env|NEXT_PUBLIC_` (`**/{backend,frontend,admin-frontend,expert,corporates}/**`), 44 results

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/utils/domainConfig.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/index.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/prisma/schema.prisma#1-1), lines 1 to 320

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/_app.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/pages/_app.js)

I’ve confirmed the runtime stack. The backend is a single Express process mounting many domain routers, and the repo contains multiple separate Next.js portals rather than one frontend. I’m now tracing representative request flow, deployment artifacts, and customization files.

Searched for files matching `**/backend/api/**/*.route.js`, 28 matches

Searched for files matching `**/backend/api/**/*.controller.js`, 30 matches

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/services)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/.github)

Searched for files matching `**/*Dockerfile*`, 1 match

Searched for files matching `**/docker-compose*.yml`, 1 match

Searched for files matching `**/.github/workflows/**`, no matches

I’ve ruled out CI/Kubernetes from the repository itself so far. The next pass is focused on how requests flow through the backend and how each frontend chooses domains, APIs, and brand-specific behavior.

Searched for regex `new PrismaClient|@prisma/client|prisma\.` (`**/backend/**`), 120 results

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/deploy.sh)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/ecosystem.json)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/session/session.route.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/session/session.controller.js#1-1), lines 1 to 260

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/middleware/emailScheduler.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/utils/apiSetup.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/utils/apiSetup.js)

I’m moving from structure into extension points now: branding, environment-driven URLs, and third-party integration seams. That should let me separate what is safe for automated customization from what is tightly coupled to core flows.

Searched for regex `aws-sdk|googleapis|razorpay|mailgun|nodemailer|socket\.io|webhook|axios\(|fetch\(|@100mslive|MEETIFY|MS_APP|DATABASE_URL` (`**/{backend,frontend,admin-frontend}/**`), 200 results

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/services/email/config/email.config.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/dockerfile)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/Dockerfile)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/next.config.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/next.config.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/docker-compose.yml)

I’ve verified Dockerized local deployment for the backend and a PM2-based deployment path for the main frontend. I’m filling in the remaining gaps now: role-specific apps, storage/video/email integrations, and where brand-specific assets are wired into the UI.

Searched for regex `AWS\.S3|new AWS\.S3|S3\(|upload\(|credentials\.json|token\.json|google\.auth|googleapis` (`**/{backend,frontend,admin-frontend}/**`), 49 results

Searched for regex `socket\.io-client|io\(` (`**/{frontend,admin-frontend}/**`), 21 results

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/components/theme)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/public/assets)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/expert/pages/index.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/corporates/pages/index.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/pages/index.js)

I’ve confirmed direct browser-side AWS uploads and Google Forms integration, which are important both for customization and for operational risk. I’m reading the exact utility files that centralize hostnames and media endpoints so I can call out the best automation touchpoints precisely.

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/utils/domainConfig.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/utils/videoAPIutil.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/components/theme/index.jsx)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/index.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/forms/forms.controller.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/components/topbar/Topbar.jsx#1-1), lines 1 to 240

I’ve got the customization seams on the frontend side: logos, titles, domains, media endpoints, and landing composition. I’m reading one payment flow and one shared backend helper next so I can describe the real API → helper → database pattern instead of guessing.

Searched for regex `feature flag|featureFlag|isEnabled|isActive|isApproved|isArchived` (`**/{backend,frontend,admin-frontend}/**`), 87 results

Searched for regex `credentials\.json|token\.json|\.env|dotenv\.config\(` (`**/backend/**`), 33 results

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/order/order.route.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/order/order.controller.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/services/getById.js#1-1), lines 1 to 260

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/utils/remainderMailsSender.js)

I’ve built a working picture from the source, but I want a second pass over the repo to catch anything easy to miss in a monorepo this size. I’m using a read-only exploration subagent for that sanity check before I write the report.

Repo architecture scan

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/package.json#1-1), lines 1 to 50

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/package.json#1-1), lines 1 to 50

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/package.json#1-1), lines 1 to 50

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/index.js#1-1), lines 1 to 50

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/dockerfile)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/index.js#50-50), lines 50 to 119

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/next.config.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/next.config.js)

Searched for regex `REACT_APP_|NEXT_PUBLIC_|process\.env\.` (`**/backend/index.js`), 1 result

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/prisma)

Searched for regex `process\.env|aws-sdk|googleapis|mailgun|razorpay|100ms|Stripe` (`**/backend/api/**/*.{js,controller,route}*`), 30 results

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/_app.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/pages/_app.js)

Searched for files matching `**/\.env* **/config*`, no matches

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/prisma/schema.prisma#1-1), lines 1 to 100

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/utils/domainConfig.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/utils/domainConfig.js)

Searched for text `theme config branding`, no results

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/corporates/package.json)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/expert/package.json)

Searched for text `config menu nav` (`**/{sidebar,theme,layout}/**`), no results

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/components/theme)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/tailwind.config.js#1-1), lines 1 to 30

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/components/sidebar)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/components/layout)

Searched for text `.*` (`**/admin-frontend/utils/apiSetup.js`), 50 results

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/utils/data.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/ecosystem.json)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/utils/apiSetup.js#1-1), lines 1 to 40

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/docker-compose.yml#1-1), lines 1 to 40

Searched for text `controller route` (`**/backend/api/{payment,order,session}/**`), no results

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/session/session.controller.js#1-1), lines 1 to 60

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/services)

Searched for text `exports` (`**/backend/api/session/session.controller.js`), 17 results

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/mail/email.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/store/store.js#1-1), lines 1 to 30

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/auth/auth.controller.js#1-1), lines 1 to 40

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/payment/payment.route.js)

The cross-check is ready. I’m reading it now and reconciling it against the files I already inspected so the final report is accurate and not just broad.

Read [](file:///Users/safwanahmed/Library/Application%20Support/Code/User/workspaceStorage/5ab06ad34b70a81bb3c0d4a70c9ad71f/GitHub.copilot-chat/chat-session-resources/f7d7d7ad-cc5e-4d8d-a0e5-1282311e88c6/call_PpQxTalZjafnsQjp8Yijnu2u__vscode-1773207760389/content.txt)

The cross-check surfaced a couple of likely high-value files, including a shared branding data file. I’m verifying those directly and checking Prisma migrations so the report can distinguish confirmed facts from assumptions.

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/utils/data.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/mail/email.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/prisma)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/prisma/migrations)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/store/store.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/store/store.js)

I’ve confirmed a central branding data object in the admin app and Prisma migrations across 2022–2023. I’m doing one last targeted pass over frontend branding/config files so the modification-surface section can point to concrete, low-risk files.

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/tailwind.config.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/utils/data.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/tailwind.config.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/components/theme/index.jsx)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/styles/globals.css)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/admin-frontend/styles/globals.css)

I have enough confirmed detail now to write the report: app topology, entry points, data model, deployment artifacts, integration seams, and the safest places for automation to modify tenants. I’m switching to synthesis and closing the analysis plan.

Starting: *Write architecture report* (5/5)

**Architecture Report**

**1. High-Level Architecture**
This repository is a monorepo, but the runtime architecture is not microservices. It is a modular monolith made of one shared backend API plus multiple separate frontend applications.

- The backend is a single Express application in index.js that mounts many domain routers under one process.
- The frontends are separate Next.js apps for different personas:
  package.json is the main user-facing app,
  package.json is the admin dashboard,
  package.json is a lightweight expert portal,
  package.json is a lightweight corporate portal.
- Languages and frameworks are mainly JavaScript, Node.js, Express, React, Next.js, Prisma, PostgreSQL, Tailwind CSS, SCSS, Redux Toolkit, and Redux Persist.
- The interaction model is straightforward:
  browser apps call REST endpoints on the backend,
  the backend uses Prisma against PostgreSQL,
  and selected flows call third-party services for payments, video, email, storage, and Google Forms/Sheets.

A useful mental model is: one platform backend, multiple branded or role-specific web clients.

**2. Repository Structure**
The main folders break down cleanly by runtime responsibility.

- _app.js
  Main customer-facing Next.js app. Uses Redux, persisted client state, and the 100ms room provider.
- _app.js
  Admin portal. Wraps all pages with shared navbar, loader, Redux provider, and persisted state.
- index.js
  Standalone expert-facing landing app. Much thinner than the main frontend.
- index.js
  Standalone corporate-facing landing app. Also thin and mostly presentational.
- index.js
  Main backend server entry. This is the API hub for the whole platform.
- session.route.js
  Representative of the backend/api structure. Each domain typically has routes plus a controller.
- getById.js
  Shared backend helper layer. This is one of the few places resembling a reusable service layer.
- email.config.js
  Backend service integration layer for email transport.
- emailScheduler.js
  Cross-cutting runtime behavior such as scheduled mail jobs.
- schema.prisma
  Data model definition.
- migrations
  Migration history for the database schema.
- docker-compose.yml
  Local infra for backend plus Postgres and pgAdmin.
- deploy.sh
  Manual deployment script for the main frontend.
- ecosystem.json
  PM2 runtime configuration for frontend deployment.
- .github
  Only issue templates are present. I did not find CI workflows in the repo.

There are no dedicated top-level workflows, infra, or deployments directories. Those concerns are embedded inside backend and frontend app folders.

**3. Entry Points**
The main system entry points are clear.

- Backend server startup:
  index.js loads environment config, sets up middleware, mounts routers, and starts listening on the configured port.
- Frontend app entry:
  _app.js is the primary user app shell.
  _app.js is the admin shell.
- Frontend landing entry:
  index.js,
  index.js,
  index.js.
- API route registration:
  index.js mounts all domain routers under /api/v1.
- Background jobs:
  session.route.js schedules reminder emails with node-cron.
  emailScheduler.js schedules a daily email job with node-schedule.
- Scheduled jobs are not separate worker processes. They run inside the backend web process.
- I did not find a dedicated queue worker, job runner, or workflow engine.

**4. Configuration System**
Configuration is split between environment variables, hardcoded frontend runtime maps, and Next.js build config.

- Backend environment loading starts in index.js.
- Database configuration is defined in schema.prisma through DATABASE_URL.
- The workspace contains .env, so current operation depends partly on a local env file inside the repo.
- Frontend API base URLs are centralized in:
  apiSetup.js
  and apiSetup.js.
- Frontend domain-level URL mapping is in:
  domainConfig.js
  and domainConfig.js.
- Media/video host mapping is in videoAPIutil.js.
- Next.js image/CDN allowlists are configured in:
  next.config.js
  and next.config.js.

The config flow is currently uneven:
backend settings mostly come from environment variables,
but frontend settings are often hardcoded into utility files rather than injected via public env variables.
That matters for automation because tenant generation is easier if config is declarative and centralized.

There is no formal feature flag system. Feature exposure is mostly driven by role checks and database flags such as isActive, isApproved, and isArchived in schema.prisma.

**5. Customization Points**
There are several good customization seams, especially for branding and UI.

- Branding metadata:
  data.js
  and data.js.
  These files contain company name, logo paths, title text, contact data, token/storage identifiers, and descriptive copy.
- Landing page composition:
  index.js,
  index.js,
  index.js.
- Navbar and visible logo:
  Topbar.jsx.
- Favicon and shell-level head content:
  _app.js
  and _app.js.
- Theme palette and typography:
  tailwind.config.js,
  tailwind.config.js,
  globals.css,
  globals.css.
- Theme selector UI:
  index.jsx
  and index.jsx.
- Runtime domain/media customization:
  domainConfig.js,
  domainConfig.js,
  videoAPIutil.js.

For behavior customization, the main seams are backend domain modules:

- Sessions and meeting behavior:
  session.route.js,
  session.controller.js,
  session.js.
- Payments and purchase flow:
  order.route.js,
  order.controller.js.
- Communities, blogs, forms, resources, questions, and requests each follow the same route/controller pattern under backend/api.

**6. Workflow and Business Logic**
The core business logic lives primarily in backend controllers, with some shared helper modules. This is not a clean layered architecture; many controllers talk to Prisma directly.

A representative request flow looks like this:

- Express mounts the route in index.js.
- A domain router such as session.route.js binds path plus auth middleware plus controller function.
- The controller such as session.controller.js handles request parsing, authorization assumptions, Prisma reads and writes, and external calls.
- Shared lookup helpers are in getById.js.
- Session-specific helper logic is split into session.js.
- Persistence happens via Prisma models defined in schema.prisma.

The payment flow is a good concrete example:

- Route in order.route.js
- Controller in order.controller.js
- It creates a Razorpay order, verifies the payment signature, writes Order and SessionOrderMapping records, updates Attendance, and sends a confirmation email.

The workflow model is code-driven, not engine-driven.
I did not find Temporal, Camunda, BullMQ, Step Functions, XState, or any other workflow/state-machine framework.
Business processes are encoded directly in controller logic plus status fields in the database.

**7. Integrations**
Confirmed external integrations in source code are:

- PostgreSQL via Prisma:
  schema.prisma
- Razorpay payments:
  order.controller.js
- 100ms video:
  _app.js,
  generateJwt.js,
  generateRoomId.js
- Meetify meeting integration:
  apiSetup.js,
  session.js,
  meetify.js
- Mailgun transactional email:
  email.js
- Nodemailer-based mail transport:
  email.config.js
- Google Forms and Google Sheets:
  forms.controller.js,
  credentials.json
- AWS S3 and CloudFront for uploads/media:
  CreatePost.js,
  ParentImageUpload.js,
  ImageUploader.js,
  ParentImageUpload.js,
  videoAPIutil.js
- Socket.io client usage exists in UI:
  Layout.js
  and index.js

I did not find a matching socket.io server implementation in the backend source I inspected, so chat may depend on an external realtime service or an omitted component.

**8. Data Layer**
The data layer is one of the most structurally complete parts of the repo.

- Database type: PostgreSQL
- ORM/query layer: Prisma
- Schema definition: schema.prisma
- Migration history: migrations

Important domain entities include User, Partner, Admin, Expert, Community, SubCommunity, Channels, Session, SessionSlot, Attendance, Order, Transaction, Wallet, Blog, Resource, CouponCode, and custom form-related models in Prisma.

The data model indicates the real business center of the app:
communities,
sessions and session slots,
attendance and purchases,
role-specific users,
content and discussion,
and related approval/archive flags.

**9. Deployment**
Deployment is partially containerized and partially manual.

- Local/backend Docker stack:
  docker-compose.yml
  runs Postgres, pgAdmin, and the backend API container.
- Backend container build:
  dockerfile
- Frontend container exists:
  Dockerfile
  but it starts the dev server, so it does not look like the primary production deployment artifact.
- PM2 runtime for frontend:
  ecosystem.json
- Manual deployment script:
  deploy.sh

I did not find Kubernetes manifests, Helm charts, Terraform, Pulumi, or GitHub Actions workflows.
The deployment model looks like:
Docker Compose for local backend development,
and manual or server-based PM2 deployment for at least the main frontend.

**10. Modification Surface for an Automated Customization Agent**
These are the safest places to modify, in descending order of safety.

1. Branding and tenant identity
   Use data.js, data.js, Topbar.jsx, and public asset references.
   These are safe because they are presentation-oriented and have limited coupling to business rules.

2. Theme, colors, typography, and shell styling
   Use tailwind.config.js, tailwind.config.js, globals.css, and globals.css.
   These are safe because they mainly affect visual design, not runtime behavior.

3. Runtime endpoints and environment selection
   Use apiSetup.js, apiSetup.js, domainConfig.js, domainConfig.js, and videoAPIutil.js.
   These are safe because they centralize environment-specific hostnames and URLs.

4. Feature enablement through data flags
   Use database-backed flags in schema.prisma and the controllers that consume them, especially community, blog, expert, and session controllers.
   This is safer than scattering conditional logic in multiple frontend pages.

5. Workflow customization in core domains
   Modify session.controller.js, session.js, order.controller.js, and analogous community/blog/forms modules.
   This is the right place for workflow changes because the backend is the system of record. Frontend changes alone would be brittle.

6. New integrations
   Extend dedicated adapter-like files such as email.js, email.config.js, forms.controller.js, apiSetup.js, and order.controller.js.
   These are safer because they already isolate external-provider concerns.

The least safe surfaces for automation are scattered JSX pages with embedded business assumptions, and controller files that mix validation, orchestration, and persistence heavily. Those should be modified through templates or targeted transforms, not broad search-replace.

**Architectural Conclusion**
The repository is best understood as a multi-portal platform built around one shared backend and one shared relational data model. For an automated instance generator, the strongest strategy would be:

- Treat frontend branding, theme, and domain utilities as tenant overlays.
- Treat backend domain modules as reusable workflows.
- Add a declarative tenant manifest that drives branding, URLs, enabled modules, payment/video providers, and content defaults.
- Avoid per-tenant forking of controller code unless the workflow truly diverges.

One important operational note: the repo currently contains sensitive configuration artifacts such as .env, credentials.json, and likely token material. That is relevant to your automation plan because tenant generation should externalize secrets rather than cloning them into generated instances.

1. If you want, I can turn this report into a tenant-customization blueprint that maps each customizable field to a file, data model, and generation rule.
2. If you want, I can also propose a target architecture for making this codebase truly instance-generatable with a manifest-driven customization system.