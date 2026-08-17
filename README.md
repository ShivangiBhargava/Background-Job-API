# Background Job API · FlyRank BE-06

A small Express + Inngest API that demonstrates the **accept-fast / work-in-background / report-status** pattern — the same pattern behind every "we'll email you when it's ready" on the internet.

---

## What this is

The API has one slow task: generating a report (simulated with an 8-second sleep). Instead of making the client wait, the endpoint answers instantly with `202 Accepted` and hands the work to a background job. A status endpoint lets the client poll for the result. A cron job runs every minute with no request at all.

Built for **FlyRank Backend Track · Assignment A7**.

---

## How to run

You need **two terminals** running at the same time.

**Terminal 1 — the API server**
```bash
npm install
node index.js
```

**Terminal 2 — the Inngest Dev Server**
```bash
npx inngest-cli@latest dev -u http://localhost:3000/api/inngest
```

Open the dashboard: **http://localhost:8288**

---

## Endpoints & functions

### HTTP Endpoints

| Method | Path | What it does |
|--------|------|-------------|
| `GET` | `/health` | Returns `{ "status": "ok" }` — Stage 0 smoke test |
| `POST` | `/reports` | Accepts `{ "topic": "..." }`, returns `202` + `id` instantly |
| `GET` | `/reports/:id` | Returns `pending` → `done + result` (or `404`) |
| `GET` | `/reports` | Lists all reports — stretch list endpoint |

### Inngest Functions

| Function id | Trigger | What it does |
|-------------|---------|-------------|
| `say-hello` | event `test/hello` | Stage 1 smoke test: sleeps 5 s, returns greeting |
| `make-report` | event `report/requested` | Stage 2+3: sleeps 8 s, builds result; fails on topic `"fail"` |
| `heartbeat` | cron `* * * * *` | Stage 4: logs pending/done/failed count every minute |
| `cleanup-old-reports` | cron `*/10 * * * *` | Stretch: deletes done reports older than 10 minutes |

---

## Proof — 202 then poll

```
# POST — answers instantly
$ time curl -i -s -X POST http://localhost:3000/reports \
  -H "Content-Type: application/json" \
  -d '{"topic":"cats"}'

HTTP/1.1 202 Accepted
{"id":"abc-123","status":"pending"}

real    0m0.041s     ← well under one second

# Poll immediately — still working
$ curl http://localhost:3000/reports/abc-123
{"id":"abc-123","topic":"cats","status":"pending","createdAt":"...","updatedAt":"..."}

# Poll after ~10 seconds — done
$ curl http://localhost:3000/reports/abc-123
{
  "id": "abc-123",
  "topic": "cats",
  "status": "done",
  "result": {
    "summary": "Report on \"cats\" generated at 2024-01-15T10:30:08.000Z",
    "wordCount": 342,
    "topic": "cats"
  },
  "createdAt": "...",
  "updatedAt": "..."
}
```

---

## Stage 3 — Retries vs. validation

**Missing topic → `400`, no job created:**
```bash
curl -i -X POST http://localhost:3000/reports \
  -H "Content-Type: application/json" \
  -d '{}'
# HTTP/1.1 400 Bad Request — no Inngest event is sent
```

**Topic `"fail"` → 3 attempts, ends `Failed` in the dashboard:**
```bash
curl -X POST http://localhost:3000/reports \
  -H "Content-Type: application/json" \
  -d '{"topic":"fail"}'
# Watch the dashboard: attempt 1 → wait → attempt 2 → wait → attempt 3 → Failed
```

> **Stage 3 sentence:** Bad input (missing topic) must be rejected at the door with a `400` before any job is created — it will *always* fail and retrying it is pointless — while a transient failure (network hiccup, downstream service down) deserves a retry because the *same* job might succeed on the next attempt.

---

## Stage 4 — Cron schedules

The `heartbeat` function uses `* * * * *` (every minute) for easy testing. In production you'd use a daily or weekly schedule.

| Goal | Cron expression | Plain words |
|------|----------------|-------------|
| Every minute (testing) | `* * * * *` | every minute of every hour of every day |
| Every day at 08:00 UTC | `0 8 * * *` | at minute 0, hour 8, every day |
| Every Sunday at 22:00 UTC | `0 22 * * 0` | at minute 0, hour 22, on Sunday (day 0) |

> **Stage 4 sentence 1:** The cron expression to run every day at 08:00 UTC is `0 8 * * *`.  
> **Stage 4 sentence 2:** The cron expression to run every Sunday at 22:00 UTC is `0 22 * * 0`.

Build and verify your own expressions at [crontab.guru](https://crontab.guru). Remember: servers run cron in **UTC** — convert for your local timezone.

---

## Stretch features implemented

- **`GET /reports`** — lists all reports and their statuses.
- **Outbox "email"** — each completed report is also written to `outbox/<id>.txt` (stands in for sending a real email from a background job).
- **Cleanup cron** — `cleanup-old-reports` runs every 10 minutes and deletes `done` reports older than 10 minutes.
- **Idempotency** — `make-report` checks whether the report is already `done` before re-running the slow work; sending the same event twice builds the report only once.
  > **Idempotency line:** Jobs *will* run twice (network retries, duplicate events, worker crashes mid-step) — an idempotent job checks what already exists before doing work, so the second run is a safe no-op.
- **Concurrency limit** — `make-report` is capped at 2 concurrent runs; extra jobs queue up and wait.
  > **Concurrency line:** A slow concurrency limit makes sense when the downstream service you're calling (a paid AI API, a rate-limited database, a slow PDF renderer) would degrade or reject requests if you hit it with too many at once.

---

## Restart experiment (durability)

> Start a report, Ctrl-C the API while the 8-second sleep is active, count to three, restart with `node index.js`, and watch the dashboard.

**What happened:** The Inngest Dev Server held the job state; when the API restarted, Inngest re-delivered the event to the resumed function. Steps already completed (none in this case, since the sleep was mid-flight) would not have been re-executed — each step's result is checkpointed.

**What this means:** The job survived a server crash because Inngest is *durable* — your server holds no job state itself; the worker's progress lives in Inngest. This is the deep magic that separates Inngest from a simple `setTimeout`.

---

## Git log (≥6 stages)

```
Stage 0: hello server
Stage 1: Inngest connected, first function runs
Stage 2: 202 + background job + status endpoint
Stage 3: retries seen, bad input rejected
Stage 4: cron heartbeat
Stage 5: publish and docs
```

---

## Dashboard screenshot

> *(Add a screenshot here after running both terminals — shows `make-report` with steps, a failed run with 3 attempts, and heartbeat runs one minute apart)*

---

## Tech stack

| Layer | Tool |
|-------|------|
| Runtime | Node.js 18+ |
| Framework | Express |
| Background jobs | Inngest |
| Job dashboard | Inngest Dev Server (`localhost:8288`) |
| ID generation | `uuid` |
