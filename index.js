// ─── Background Job API ────────────────────────────────────────────────────
// Stages 0–4 + stretch: health, Inngest wiring, 202 pattern, retries, cron
// Inngest v4 API: triggers live inside the first (options) argument
// ──────────────────────────────────────────────────────────────────────────

const express = require("express");
const { Inngest } = require("inngest");
const { serve } = require("inngest/express");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");

// ── In-memory store (resets on restart — intentional, same as A1) ──────────
// Shape: { [id]: { id, topic, status, result?, createdAt, updatedAt } }
const reports = {};

// ── Inngest client ──────────────────────────────────────────────────────────
const inngest = new Inngest({ id: "report-api" });

// =============================================================================
// INNGEST FUNCTIONS  (Inngest v4: triggers go in the FIRST argument object)
// =============================================================================

// ── Stage 1 — smoke-test (invoke from the dashboard to confirm wiring) ───────
const sayHello = inngest.createFunction(
  { id: "say-hello", triggers: [{ event: "test/hello" }] },
  async ({ step }) => {
    await step.sleep("wait-a-moment", "5s");
    return "Hello from the background!";
  }
);

// ── Stage 2+3 — report worker ───────────────────────────────────────────────
const makeReport = inngest.createFunction(
  {
    id: "make-report",
    triggers: [{ event: "report/requested" }],
    retries: 2,           // Stage 3: 2 retries → 3 total attempts, then Failed
    concurrency: { limit: 2 }, // Stretch: at most 2 reports run at once
  },
  async ({ event, step }) => {
    const { id, topic } = event.data;

    // Stretch — idempotency guard: if already done, skip the slow work
    if (reports[id] && reports[id].status === "done") {
      return { skipped: true, reason: "already done" };
    }

    // Step 1 — simulate slow work (AI call, big export, 8-second stand-in)
    await step.sleep("do-the-slow-work", "8s");

    // Step 2 — build result and persist it
    const result = await step.run("build-report", async () => {
      // Stage 3 — fail trigger so we can watch retries in the dashboard
      if (topic === "fail") {
        throw new Error("The report oven is broken!");
      }

      const payload = {
        summary: `Report on "${topic}" generated at ${new Date().toISOString()}`,
        wordCount: Math.floor(Math.random() * 500) + 100,
        topic,
      };

      reports[id] = {
        ...reports[id],
        status: "done",
        result: payload,
        updatedAt: new Date().toISOString(),
      };

      // Stretch "email" — write result to outbox/<id>.txt
      fs.mkdirSync("outbox", { recursive: true });
      fs.writeFileSync(`outbox/${id}.txt`, JSON.stringify(payload, null, 2), "utf8");

      return payload;
    });

    return result;
  }
);

// ── Stage 4 — heartbeat cron (every minute for testing) ────────────────────
const heartbeat = inngest.createFunction(
  { id: "heartbeat", triggers: [{ cron: "* * * * *" }] },
  async ({ step }) => {
    return await step.run("log-summary", async () => {
      const counts = { pending: 0, done: 0, failed: 0 };
      for (const r of Object.values(reports)) {
        counts[r.status] = (counts[r.status] || 0) + 1;
      }
      const line =
        `[heartbeat] ${new Date().toISOString()} — ` +
        `pending: ${counts.pending || 0}, done: ${counts.done || 0}, failed: ${counts.failed || 0}`;
      console.log(line);
      return counts;
    });
  }
);

// ── Stretch — cleanup cron: delete done reports older than 10 minutes ───────
const cleanup = inngest.createFunction(
  { id: "cleanup-old-reports", triggers: [{ cron: "*/10 * * * *" }] },
  async ({ step }) => {
    return await step.run("delete-stale-reports", async () => {
      const cutoff = Date.now() - 10 * 60 * 1000;
      let deleted = 0;
      for (const [id, r] of Object.entries(reports)) {
        if (r.status === "done" && new Date(r.updatedAt).getTime() < cutoff) {
          delete reports[id];
          deleted++;
        }
      }
      console.log(`[cleanup] removed ${deleted} stale report(s)`);
      return { deleted };
    });
  }
);

// =============================================================================
// EXPRESS APP
// =============================================================================

const app = express();
app.use(express.json());

// ── Stage 0 — health check ──────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Stage 2 — POST /reports : accept instantly, fire background job ─────────
app.post("/reports", async (req, res) => {
  const { topic } = req.body || {};

  // Stage 3 — validation: bad input is rejected at the door, never queued.
  // Missing topic always fails → no point retrying. Retry is for transient faults.
  if (!topic || typeof topic !== "string" || topic.trim() === "") {
    return res.status(400).json({
      error: "topic is required",
      hint: 'Send { "topic": "your subject" } in the request body.',
    });
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  // Persist the pending record immediately so the status endpoint can answer
  reports[id] = { id, topic: topic.trim(), status: "pending", createdAt: now, updatedAt: now };

  // Fire the event — Inngest picks it up asynchronously; we don't wait
  // NOTE: this requires the Inngest Dev Server to be running (Terminal 2).
  // Without it, Inngest can't receive the event and will throw.
  try {
    await inngest.send({ name: "report/requested", data: { id, topic: topic.trim() } });
  } catch (err) {
    // Clean up the pending record — no worker will ever process it
    delete reports[id];
    console.error("[inngest.send error]", err.message);
    return res.status(503).json({
      error: "Job queue unavailable. Is the Inngest Dev Server running?",
      hint: "npx inngest-cli@latest dev -u http://localhost:3000/api/inngest",
    });
  }

  // Return 202 Accepted — well under one second, even though work takes 8 s
  return res.status(202).json({ id, status: "pending" });
});

// ── Stage 2 — GET /reports/:id : poll for status ────────────────────────────
app.get("/reports/:id", (req, res) => {
  const report = reports[req.params.id];
  if (!report) return res.status(404).json({ error: "report not found" });
  return res.json(report);
});

// ── Stretch — GET /reports : list all reports ───────────────────────────────
app.get("/reports", (_req, res) => {
  const list = Object.values(reports).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json({ count: list.length, reports: list });
});

// ── Inngest handler — Dev Server posts here to execute functions ─────────────
app.use(
  "/api/inngest",
  serve({ client: inngest, functions: [sayHello, makeReport, heartbeat, cleanup] })
);

// =============================================================================
// START
// =============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀  API ready at http://localhost:${PORT}`);
  console.log(`   Health   GET  /health`);
  console.log(`   Reports  POST /reports          { "topic": "cats" }`);
  console.log(`   Status   GET  /reports/:id`);
  console.log(`   All      GET  /reports`);
  console.log(`   Inngest  http://localhost:${PORT}/api/inngest`);
  console.log(`\n📋  Dashboard: http://localhost:8288`);
  console.log(`   Dev Server command:`);
  console.log(`   npx inngest-cli@latest dev -u http://localhost:${PORT}/api/inngest\n`);
});
