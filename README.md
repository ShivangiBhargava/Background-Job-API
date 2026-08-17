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

**Terminal 2 — the Inngest Dev Server**
```bash
npx inngest-cli@latest dev -u http://localhost:3000/api/inngest
```

Open the dashboard: **http://localhost:8288**

---
```

