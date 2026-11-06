# MailQueue API

A small monolithic backend that accepts emails through a REST API, **queues** them, and sends
them in the background with [Resend](https://resend.com). Every email is stored in PostgreSQL with
its status (`pending`, `sent` or `failed`), failed sends are **retried 3 times** with exponential
backoff, and a `GET /health` endpoint reports app and database status for uptime monitoring.

**Stack:** Node.js 22 · TypeScript · Express 5 · PostgreSQL · pg-boss · Resend · Zod · node-pg-migrate
· pino · Vitest + Supertest

---

## Contents

- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Getting started (local)](#getting-started-local)
- [Environment variables](#environment-variables)
- [API reference and example requests](#api-reference-and-example-requests)
- [Email lifecycle and retries](#email-lifecycle-and-retries)
- [Testing](#testing)
- [Deployment on Render](#deployment-on-render)
- [Monitoring with Asniher](#monitoring-with-asniher)
- [Logging](#logging)
- [Security notes](#security-notes)
- [Known limitations](#known-limitations)

---

## How it works

1. A client sends `POST /emails` with `to`, `subject` and `body`.
2. The API validates the input, then in **one database transaction** saves an `email_jobs` row
   with status `pending` **and** adds a job to the queue. It answers immediately with
   `202 Accepted` and the job id. The endpoint never sends email itself.
3. A separate **worker** process takes jobs off the queue and sends them through Resend.
4. On success the row becomes `sent`. On failure the worker retries with growing delays; after the
   first attempt plus 3 retries the row becomes `failed` and the last error is stored.
5. The client can check the result at any time with `GET /emails/:id`.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant A as API (web service)
    participant DB as PostgreSQL<br/>(email_jobs + pg-boss queue)
    participant W as Worker (background)
    participant R as Resend

    C->>A: POST /emails {to, subject, body}
    A->>A: validate (Zod)
    A->>DB: BEGIN · INSERT email_jobs (pending) · enqueue job · COMMIT
    A-->>C: 202 Accepted {id, status: "pending"}
    W->>DB: fetch next job
    W->>DB: attempts = attempts + 1
    W->>R: send email (idempotency key = job id)
    alt delivered
        R-->>W: message id
        W->>DB: status = sent, provider_message_id, sent_at
    else temporary error and retries left
        R-->>W: error
        W->>DB: last_error (stays pending)
        W->>DB: queue retries later (backoff)
    else permanent error or no retries left
        W->>DB: status = failed, last_error
    end
    C->>A: GET /emails/:id
    A-->>C: 200 {status: "sent" | "pending" | "failed"}
```

## Architecture

The code is organised in **four layers**. Each layer may only call the layer directly below it.

```mermaid
flowchart TB
    subgraph entry["Entry points (composition roots)"]
        S["src/server.ts<br/>API process"]
        WK["src/worker.ts<br/>Worker process"]
    end

    subgraph api["api layer: HTTP + queue job handlers"]
        R["routes"] --> CT["controllers"]
        MW["middleware<br/>API key · logging · errors"]
        V["request validation (Zod)"]
        JH["workers/sendEmail.handler"]
    end

    subgraph services["services layer: business logic"]
        ES["EmailService<br/>submit · get · list"]
        DS["EmailDeliveryService<br/>send · retry rules"]
        HS["HealthService"]
    end

    subgraph data["data layer: all external I/O"]
        REPO["EmailJobRepository<br/>(all SQL)"]
        HR["HealthRepository"]
        Q["PgBossEmailQueue"]
        RP["ResendEmailProvider"]
        TX["TransactionRunner"]
    end

    subgraph models["models layer: entities, DTOs, schemas, errors"]
        M["EmailJob · EmailStatus · DTOs · Zod schemas · domain errors"]
    end

    S --> api
    WK --> api
    CT --> ES
    CT --> HS
    JH --> DS
    ES --> REPO
    ES --> Q
    ES --> TX
    DS --> REPO
    DS --> RP
    HS --> HR
    REPO --> PG[("PostgreSQL")]
    HR --> PG
    Q --> PG
    RP --> RS(["Resend API"])
    api -.-> models
    services -.-> models
    data -.-> models
```

| Layer                         | Responsibility                                                              | Not allowed                               |
| ----------------------------- | --------------------------------------------------------------------------- | ----------------------------------------- |
| **api** (`src/api`)           | Routes, controllers, request validation, HTTP responses, queue job handlers | SQL, business rules, importing `src/data` |
| **services** (`src/services`) | Business logic: queuing, delivery and retry rules, health evaluation        | HTTP (`express`, status codes), SQL       |
| **data** (`src/data`)         | Repositories (all SQL), pg-boss queue, Resend client, transactions          | Importing `api` or `services`             |
| **models** (`src/models`)     | Entities, DTOs, Zod schemas, domain errors                                  | Importing any other layer                 |

`src/config` (environment validation) and `src/lib` (logger, shutdown) are small shared helpers.
`server.ts` and `worker.ts` are the **composition roots**: the only files that create objects from
every layer and connect them (dependency injection).

**The rules are enforced automatically.** `npm run lint:arch` runs
[dependency-cruiser](.dependency-cruiser.cjs) and fails the build if, for example:

- a controller imports a repository (api → data skips the services layer),
- `pg`, `pg-boss` or `resend` is imported outside `src/data`,
- `express` is imported outside `src/api`,
- a model imports from another layer, or there is a circular dependency.

Services throw **domain errors** (for example `EmailJobNotFoundError`). Only the api layer's error
handler turns them into HTTP status codes (`404`), so services stay free of HTTP concerns.

**Monolith, one or two processes.** It is one codebase and one repository, with the API and the
worker kept apart in the code. They can be run in two ways:

| Mode                   | How                                                 | When to use                                                                                   |
| ---------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Separate processes** | `npm start` (API) + `npm run start:worker` (worker) | The API stays fast even when Resend is slow; the worker can be scaled or restarted on its own |
| **Single process**     | `npm start` with `RUN_WORKER_IN_API=true`           | One service instead of two, e.g. on hosting plans without background workers                  |

Both modes use the same worker code (`src/startEmailWorker.ts`), and either way the HTTP endpoints
only enqueue jobs; they never send email themselves. **The deployed app uses the single-process
mode** so that it runs entirely on Render's free plan.

## Project structure

```
mailqueue-api/
├── src/
│   ├── api/                 # LAYER 1: HTTP and queue entry points
│   │   ├── app.ts           #   builds the Express app (no listen, so tests can use it)
│   │   ├── controllers/     #   email.controller.ts, health.controller.ts
│   │   ├── routes/          #   email.routes.ts, health.routes.ts
│   │   ├── middleware/      #   apiKey.ts, errorHandler.ts, requestLogger.ts
│   │   ├── workers/         #   sendEmail.handler.ts (queue job -> delivery service)
│   │   └── validation.ts    #   parseRequest() + RequestValidationError
│   ├── services/            # LAYER 2: business logic
│   │   ├── email.service.ts
│   │   ├── emailDelivery.service.ts
│   │   └── health.service.ts
│   ├── data/                # LAYER 3: database, queue and Resend access
│   │   ├── db.ts, transaction.ts
│   │   ├── repositories/    #   emailJob.repository.ts, health.repository.ts
│   │   ├── queue/           #   emailQueue.ts (pg-boss)
│   │   └── providers/       #   resend.provider.ts
│   ├── models/              # LAYER 4: entities, DTOs, schemas, errors
│   ├── config/              # env.ts (Zod-validated environment), appInfo.ts
│   ├── lib/                 # logger.ts, shutdown.ts
│   ├── server.ts            # API process entry point
│   └── worker.ts            # worker process entry point
├── migrations/              # SQL migrations (node-pg-migrate)
├── scripts/seed.ts          # sample data
├── tests/
│   ├── unit/                # services, API (Supertest), provider, config
│   └── integration/         # real PostgreSQL + real pg-boss queue
├── docs/                    # monitoring screenshot
├── render.yaml              # Render Blueprint (database + API + worker)
└── .env.example             # every environment variable, with placeholder values
```

## Getting started (local)

### Prerequisites

- **Node.js 22** or newer (`node -v`)
- **PostgreSQL 14** or newer, running locally (`psql --version`)
- A **Resend** account and API key, only needed to actually send email (https://resend.com/api-keys)

### 1. Install dependencies

```bash
git clone https://github.com/<your-username>/mailqueue-api.git
cd mailqueue-api
npm install
```

### 2. Create the databases

Create a database user and two databases: one for development and one that the tests are allowed to
wipe (its name must end in `_test`). In `psql` as the `postgres` superuser:

```sql
CREATE ROLE mailqueue LOGIN PASSWORD 'choose_a_password';
CREATE DATABASE mailqueue OWNER mailqueue;
CREATE DATABASE mailqueue_test OWNER mailqueue;
```

> **Windows:** open "SQL Shell (psql)" from the Start menu (installed with PostgreSQL), log in as
> `postgres` with the password you chose during installation, and paste the three lines above.

### 3. Configure the environment

```bash
cp .env.example .env
```

On Windows PowerShell use `Copy-Item .env.example .env`. Then edit `.env`: set the password in
`DATABASE_URL` and `TEST_DATABASE_URL`, and set `RESEND_API_KEY` and `EMAIL_FROM` for the worker.

### 4. Create the tables and add sample data

```bash
npm run migrate
npm run seed
```

### 5. Run the API and the worker (two terminals)

```bash
npm run dev          # API on http://localhost:3000 (restarts on file changes)
npm run dev:worker   # background worker
```

Open http://localhost:3000/health. You should see `"status": "ok"`.

### Production build

```bash
npm run build
npm start              # API
npm run start:worker   # worker
```

## Environment variables

Configuration comes **only** from environment variables (from `.env` locally, from the Render
dashboard in production). Each process validates its variables at startup and stops with a clear
message if one is missing or invalid. Error messages never print the value, because values can be
secrets.

| Variable                    | Used by     | Required          | Default       | Description                                                               |
| --------------------------- | ----------- | ----------------- | ------------- | ------------------------------------------------------------------------- |
| `DATABASE_URL`              | API, worker | **yes**           |               | PostgreSQL URL `postgres://user:password@host:5432/db`                    |
| `NODE_ENV`                  | both        | no                | `development` | `development`, `test` or `production`                                     |
| `LOG_LEVEL`                 | both        | no                | `info`        | `fatal` `error` `warn` `info` `debug` `trace` `silent`                    |
| `DATABASE_SSL`              | both        | no                | `false`       | Use TLS to the database (needed over the public internet)                 |
| `DATABASE_POOL_MAX`         | API         | no                | `10`          | Maximum database connections                                              |
| `EMAIL_MAX_RETRIES`         | both        | no                | `3`           | Retries after the first failed attempt (3 to 10)                          |
| `EMAIL_RETRY_DELAY_SECONDS` | both        | no                | `10`          | First retry delay; doubles each retry                                     |
| `PORT`                      | API         | no                | `3000`        | HTTP port (Render sets it automatically)                                  |
| `API_KEY`                   | API         | **in production** |               | Clients send it as `X-API-Key` to use `/emails` (16+ characters)          |
| `RUN_WORKER_IN_API`         | API         | no                | `false`       | `true` = the API process also runs the email worker (single-service mode) |
| `RESEND_API_KEY`            | worker\*    | **yes**\*         |               | Resend API key (starts with `re_`)                                        |
| `EMAIL_FROM`                | worker\*    | **yes**\*         |               | Sender, e.g. `MailQueue <onboarding@resend.dev>`                          |
| `WORKER_CONCURRENCY`        | worker\*    | no                | `2`           | Emails sent in parallel                                                   |

\* Needed by whichever process runs the worker: the worker process, or the API when
`RUN_WORKER_IN_API=true`. The API refuses to start if the flag is on and these are missing.
| `TEST_DATABASE_URL` | tests | for tests | | Test database (name must end with `_test`) |

`.env` is listed in `.gitignore` and is never committed. [`.env.example`](.env.example) lists every
variable with placeholder values only.

## API reference and example requests

In the examples, `BASE` is `http://localhost:3000` locally or your Render URL in production, and
`KEY` is your `API_KEY` (not needed locally if `API_KEY` is unset).

```bash
BASE=http://localhost:3000
KEY=replace-with-your-api-key
```

> **Windows PowerShell:** type `curl.exe` instead of `curl`, and set variables with
> `$BASE="http://localhost:3000"`. You can also use Postman or Thunder Client in VS Code.

All errors use the same shape:
`{ "error": { "code": "...", "message": "...", "details": [...] } }`.

### `GET /health`

No API key needed. Returns **200** when the app and database are up and **503** when the database
cannot be reached.

```bash
curl -i $BASE/health
```

```http
HTTP/1.1 200 OK
Cache-Control: no-store

{"status":"ok","timestamp":"2026-11-05T23:08:48.090Z",
 "app":{"name":"mailqueue-api","version":"1.0.0","environment":"production","status":"up","uptimeSeconds":3},
 "database":{"status":"up","latencyMs":6}}
```

With the database down:

```http
HTTP/1.1 503 Service Unavailable

{"status":"error","timestamp":"...","app":{...,"status":"up"},
 "database":{"status":"down","error":"Database is unreachable"}}
```

### `POST /emails` — queue an email

| Field     | Rules                                             |
| --------- | ------------------------------------------------- |
| `to`      | valid email address, max 320 characters (trimmed) |
| `subject` | 1 to 998 characters, no line breaks (trimmed)     |
| `body`    | plain text, 1 to 100 000 characters               |

```bash
curl -i -X POST $BASE/emails \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KEY" \
  -d '{"to":"you@example.com","subject":"Hello from MailQueue","body":"This email went through the queue."}'
```

```http
HTTP/1.1 202 Accepted
Location: /emails/96e05e26-a9b9-4486-a100-511926596632

{"data":{"id":"96e05e26-a9b9-4486-a100-511926596632","to":"you@example.com",
 "subject":"Hello from MailQueue","body":"This email went through the queue.",
 "status":"pending","attempts":0,"lastError":null,"providerMessageId":null,"sentAt":null,
 "createdAt":"2026-11-05T23:08:48.116Z","updatedAt":"2026-11-05T23:08:48.116Z"}}
```

Invalid input returns `400`:

```bash
curl -X POST $BASE/emails -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"to":"nope","subject":"","body":"Hello"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": [
      { "path": "to", "message": "to must be a valid email address" },
      { "path": "subject", "message": "subject must not be empty" }
    ]
  }
}
```

### `GET /emails/:id` — check one email

```bash
curl $BASE/emails/96e05e26-a9b9-4486-a100-511926596632 -H "X-API-Key: $KEY"
```

Example response after the worker has sent the email (`providerMessageId` is the id Resend
returns; values shortened):

```json
{
  "data": {
    "id": "96e05e26-...",
    "status": "sent",
    "attempts": 1,
    "lastError": null,
    "providerMessageId": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    "sentAt": "2026-11-05T23:08:50.002Z",
    "...": "..."
  }
}
```

`404` for an unknown id, `400` if the id is not a UUID.

### `GET /emails` — list emails

Query parameters: `status` (`pending` | `sent` | `failed`), `limit` (1 to 100, default 20),
`offset` (default 0). Newest first.

```bash
curl "$BASE/emails?status=failed&limit=10" -H "X-API-Key: $KEY"
```

```json
{
  "data": [
    {
      "id": "...",
      "to": "bounced@example.com",
      "status": "failed",
      "attempts": 4,
      "lastError": "Resend rejected the email (validation_error): ...",
      "...": "..."
    }
  ],
  "pagination": { "limit": 10, "offset": 0, "total": 1 }
}
```

### Status codes

| Code  | When                                        |
| ----- | ------------------------------------------- |
| `200` | Success (`GET`)                             |
| `202` | Email accepted and queued (`POST /emails`)  |
| `400` | Validation error or malformed JSON          |
| `401` | Missing or wrong API key                    |
| `404` | Unknown email id or route                   |
| `413` | Request body larger than 256 KB             |
| `500` | Unexpected error (details only in the logs) |
| `503` | `/health` only: database unreachable        |

## Email lifecycle and retries

```mermaid
stateDiagram-v2
    [*] --> pending: POST /emails
    pending --> sent: Resend accepted the email
    pending --> pending: temporary error and retries left (attempts + 1)
    pending --> failed: permanent error, or 1 attempt + 3 retries used
    sent --> [*]
    failed --> [*]
```

- **At least 3 retries.** pg-boss is configured with `retryLimit: 3` (`EMAIL_MAX_RETRIES`), so a
  failing email is tried **4 times in total**: the first attempt and 3 retries. The configuration
  refuses values below 3.
- **Exponential backoff.** Each retry waits about twice as long as the one before, starting from
  `EMAIL_RETRY_DELAY_SECONDS` (with a little randomness so retries do not all hit Resend at once).
  With the production setting of 30 seconds: about 30 s, 1 min, 2 min.
- **Temporary vs permanent errors.** Network errors, rate limits (`429`) and Resend server errors
  (`5xx`) are retried. Errors that a retry cannot fix (invalid recipient, invalid API key,
  unverified sender) mark the email `failed` straight away.
- **No duplicate emails.** Each send uses the Resend idempotency key `email-job-<id>`. If an attempt
  reaches Resend but the worker crashes before saving the result, the retry does not send a
  second copy.
- **Nothing stays pending forever.** Jobs expire after 120 s if a worker hangs, which counts as a
  failed attempt. A job that uses up all retries without finishing (for example, the worker crashed
  during the last attempt) goes to a dead-letter queue, and the worker marks it `failed`.
- **Status changes are one-way.** The repository only updates rows that are still `pending`, and a
  database constraint guarantees `sent_at` is set exactly when the status is `sent`.

## Testing

```bash
npm test                  # all tests (needs PostgreSQL and TEST_DATABASE_URL)
npm run test:unit         # unit tests only, no database needed
npm run test:integration  # integration tests only
npm run check             # typecheck + lint + architecture rules + formatting + all tests
```

| Suite       | What is covered                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Env validation; `EmailService`; delivery and retry rules (`EmailDeliveryService`); `HealthService`; every endpoint via Supertest (validation, 202/400/401/404/413/500, health 200/503); Resend error classification; queue job handlers                                                                                                               |
| Integration | Migration up/down and every database constraint; repository against real PostgreSQL; transaction rollback; **end-to-end flow with the real pg-boss queue**: email sent, 4 attempts then `failed`, permanent error fails at once, success on retry, nothing saved if enqueueing fails; `/health` with a reachable (200) and unreachable (503) database |

Integration tests replace only Resend with a fake, so they never send real email. A safety check
refuses to run them against any database whose name does not end in `_test`.

## Deployment on Render

The repository includes a [Render Blueprint](render.yaml) that creates two resources, both on
Render's **free plan**:

| Resource        | Type                                     | Start command                  |
| --------------- | ---------------------------------------- | ------------------------------ |
| `mailqueue-db`  | PostgreSQL                               |                                |
| `mailqueue-api` | Web Service (`healthCheckPath: /health`) | `npm run migrate && npm start` |

The web service runs with `RUN_WORKER_IN_API=true`, so it serves the API **and** processes the
email queue. Free Render plans have no Background Workers; to use a separate worker service on a
paid plan instead, uncomment the worker block at the end of `render.yaml` and set
`RUN_WORKER_IN_API` to `false`.

Steps:

1. Push this repository to GitHub.
2. In the [Render dashboard](https://dashboard.render.com), choose **New → Blueprint** and select
   the repository. Render reads `render.yaml`.
3. When asked, enter the secrets that are not stored in git:
   - `RESEND_API_KEY`: your Resend key
   - `EMAIL_FROM`: e.g. `MailQueue <onboarding@resend.dev>`
4. Click **Apply**. Render creates the database, builds the service, and runs the migrations
   before the API starts.
5. `API_KEY` is generated automatically. Copy it from **mailqueue-api → Environment**; clients
   need it in the `X-API-Key` header.
6. Open `https://<your-service>.onrender.com/health`. It should return `200` with
   `"database":{"status":"up",...}`.

Notes:

- `DATABASE_URL` uses Render's **internal** connection string, so `DATABASE_SSL` stays `false`;
  the database also refuses connections from the internet (`ipAllowList: []`).
- The build uses `npm ci --include=dev` because TypeScript is a dev dependency and is needed for
  `npm run build`, even though `NODE_ENV=production`.
- Render sends `SIGTERM` on every deploy. The service shuts down gracefully: it finishes open
  requests and in-progress emails first.
- Free web services sleep after a period of no traffic and take a few seconds to wake up. While
  the service sleeps, the embedded worker sleeps too; queued emails stay safely in PostgreSQL and
  are sent when it wakes up. Regular monitoring checks keep the service awake.

## Monitoring with Asniher

The deployed `GET /health` endpoint is monitored with [Asniher](https://asniher.com/).

1. Sign in to Asniher and create a new **HTTP(S) / uptime monitor**.
2. URL: `https://<your-service>.onrender.com/health`. Method: `GET`. No headers are needed,
   because `/health` is public.
3. Expected result: HTTP status **200**. Any other status, including `503` when the database is
   down, counts as **down**. If keyword checks are offered, the response body contains
   `"status":"ok"` when healthy.
4. Choose the shortest check interval your plan allows, and add your email as an alert contact.
5. Save, wait for the first checks to show as **up**, and take a screenshot of the monitor.

Because `/health` queries the database on every call, the monitor detects both an application
outage (no response) and a database outage (`503`). Successful health checks are not written to
the request log, so frequent monitoring does not flood the logs.

**Monitor screenshot:**

![Asniher monitor for GET /health](docs/asniher-monitor.png)

## Logging

Both processes write structured JSON logs with [pino](https://getpino.io), which you can search in
Render's **Logs** tab. Every HTTP request gets one log line (method, URL, status, duration) and an
`X-Request-Id` response header that matches the log line. The worker logs every attempt with the
email job id, attempt number and retries left. API keys and authorization headers are redacted,
and email bodies are never logged.

```json
{
  "level": 40,
  "time": "2026-11-05T23:09:12.120Z",
  "name": "mailqueue-worker",
  "emailJobId": "96e05e26-...",
  "attempt": 2,
  "retriesLeft": 2,
  "msg": "Email delivery failed; will retry"
}
```

## Security notes

- `/emails` requires an API key in production (timing-safe comparison); `/health` stays public for
  monitoring.
- All input is validated with Zod, including size limits; line breaks in subjects are rejected to
  prevent email header injection. Request bodies are limited to 256 KB.
- SQL uses parameterised queries only, and database constraints back up the API validation.
- 500 responses and the health check never expose internal error details or hostnames.
- The app connects as a database user that is not a superuser.

## Known limitations

- **Resend test mode:** without a verified domain, Resend only sends from `onboarding@resend.dev`
  and only delivers to the address of your own Resend account. Verify a domain in Resend to send to
  anyone.
- **Free Render PostgreSQL** databases expire after a limited time; upgrade the plan for long-term use.
- `npm audit` reports a moderate advisory in `minimatch`/`glob`, used inside `node-pg-migrate`
  and ESLint to match file paths from our own configuration (no user input reaches them). The
  only automatic fix downgrades those tools to older major versions, so it was not applied.
- No rate limiting per client; an API gateway or a package such as `express-rate-limit` could add it.
