I’m mapping the backend’s internal dependencies now so the graph reflects actual route, controller, helper, middleware, database, and integration relationships instead of just folder names.

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/middleware/authenticateToken.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/middleware/errorHandling.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/mail/email.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/auth/auth.route.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/auth/auth.controller.js#1-1), lines 1 to 280

I’ve confirmed the core middleware and auth path; I’m reading the shared session helper and scheduler dependencies next so the graph covers both request-time and background execution paths.

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/session/session.js#1-1), lines 1 to 260

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/api/user/user.controller.js#1-1), lines 1 to 220

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/services/email/notificationMailer.js)

Read [](file:///Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/backend/utils/sendMail.js)

I’ve got enough structure to generate a backend dependency graph that covers both HTTP and scheduled paths, and I’m rendering it now so the flow is easier to reason about.



The backend dependency graph is centered on one Express process in index.js. Every HTTP request enters there, passes common middleware, gets dispatched to a domain router, then into a controller that talks directly to Prisma and any needed integrations.

**Dependency Graph**
The rendered graph is above. The important dependency edges are:

- App bootstrap:
  index.js -> routers under api
- Route protection:
  routers -> authenticateToken.js
- Domain execution:
  routers -> controllers such as session.controller.js, auth.controller.js, order.controller.js
- Shared backend helpers:
  controllers -> getById.js
- Session-specific helper layer:
  session.controller.js -> session.js
- Persistence:
  most controllers instantiate Prisma directly and query models in schema.prisma
- Error handling:
  controllers and helpers -> errorHandling.js
- Integrations:
  payment -> order.controller.js
  email -> email.js, sendMail.js, notificationMailer.js
  meetify -> apiSetup.js, session.js
  video token helpers -> generateJwt.js, generateRoomId.js
  Google APIs -> forms.controller.js

**How Requests Flow**
A normal request flow is:

1. A frontend calls the API on a route mounted in index.js.
2. Express applies generic middleware: CORS, JSON parsing, and Morgan logging in index.js.
3. The request enters a route module such as session.route.js or auth.route.js.
4. If the endpoint is protected, the route invokes a role-specific JWT guard from authenticateToken.js.
5. The route calls a controller function. Controllers are the real orchestration layer in this codebase.
6. The controller may:
   query Prisma directly
   call shared helper functions like getById.js
   call domain helpers like session.js
   call third-party integrations such as Razorpay, Mailgun, Meetify, or Google APIs
7. Prisma executes queries against PostgreSQL as defined by schema.prisma.
8. Any thrown errors are normalized by errorHandling.js.
9. The response returns as JSON to the frontend.

**Representative Request Paths**

- Auth flow:
  auth.route.js -> auth.controller.js -> Prisma + token helpers + mailer
- Session flow:
  session.route.js -> session.controller.js -> session.js -> Prisma + Meetify + 100ms helpers
- Order/payment flow:
  order.route.js -> order.controller.js -> Razorpay + Prisma + email
- Forms flow:
  forms.route.js -> forms.controller.js -> Google Forms/Sheets + Prisma

**Background Flow**
The backend also has non-request flows running inside the same Node process.

- Session reminder cron:
  session.route.js -> remainderMailsSender.js -> Prisma + Mailgun
- Daily email scheduler:
  emailScheduler.js -> user.controller.js -> Prisma + notificationMailer.js

**What This Means Architecturally**
The backend is not layered as router -> service -> repository in a strict sense. It is closer to:

- Express app
- route modules
- controller-heavy domain modules
- a thin set of shared helpers
- Prisma directly in many places
- integrations called from controllers/helpers

That means request flow is easy to trace, but dependency coupling is fairly high. The most important dependency hubs are:

- index.js
- authenticateToken.js
- getById.js
- session.controller.js
- order.controller.js
- schema.prisma

If you want, I can turn this next into one of these:

1. A machine-readable backend dependency map as JSON.
2. A per-route request flow table showing router, middleware, controller, DB models, and external integrations.
3. A safer refactoring plan that separates controllers, services, and integrations for automation.

graph TD
    A[Clients / Frontends] --> B[Express App<br/>backend/index.js]
    B --> C[CORS + JSON + Morgan]
    B --> D[Route Modules<br/>backend/api/*/*.route.js]
    D --> E[Auth Middleware<br/>middleware/authenticateToken.js]
    D --> F[Controllers<br/>backend/api/*/*.controller.js]
    F --> G[Shared Helpers<br/>backend/api/services/getById.js]
    F --> H[Domain Helpers<br/>backend/api/session/session.js<br/>auth.service.js<br/>event.service.js]
    F --> I[Prisma Client<br/>@prisma/client]
    I --> J[(PostgreSQL)]
    F --> K[Mailgun<br/>api/mail/email.js<br/>utils/sendMail.js]
    F --> L[Nodemailer<br/>services/email/*]
    F --> M[Meetify API<br/>utils/apiSetup.js]
    F --> N[100ms Token Helpers<br/>utils/generateJwt.js<br/>utils/generateRoomId.js]
    F --> O[Google APIs<br/>api/forms/forms.controller.js]
    F --> P[Razorpay<br/>api/order/order.controller.js]
    B --> Q[Error Handler<br/>middleware/errorHandling.js]
    B --> R[Cron / Schedulers]
    R --> S[Session Reminder Job<br/>api/session/session.route.js]
    R --> T[Daily Email Job<br/>middleware/emailScheduler.js]
    S --> U[utils/remainderMailsSender.js]
    T --> V[api/user/user.controller.js]
    U --> I
    U --> K
    V --> I
    T --> L