# Offset Mortgage Tracker

A self-contained web app for tracking an offset mortgage. Calculates daily interest on your effective balance (loan minus offset accounts), projects your full repayment schedule, reconciles against your actual lender statements, and tracks property equity over time.

Works with any lender that uses offset accounts and daily interest accrual.

---

## Screenshots

![Dashboard](docs/screenshot-dashboard.png)
![History](docs/screenshot-history.png)
![Daily Log & Reconcile](docs/screenshot-reconcile-log.png)

---

## Use cases

### Use case A — Standalone (no server required)

The simplest option. Download a single HTML file, open it in any browser, and it works immediately. All data saves to your browser's localStorage. Nothing to install, no server, no Docker.

Best for: individuals who want to track their mortgage on one device and don't need to sync with any other tools.

1. Download `mortgage-tracker-standalone.html` from the releases section
2. Open it in Chrome, Edge, or Safari
3. Enter your mortgage details in the **Mortgage Setup** tab
4. Start logging your offset balances in the **Daily Log** tab

Data persists in the browser — clearing browser data will erase it. Use the **Export** button to back up your data as JSON regularly.

---

### Use case B — Self-hosted with Docker (server + data persistence)

Run the app on your own server. All data is stored server-side in a Docker volume — accessible from any device, survives browser clears, and never leaves your network.

Best for: homelab users who want persistent data, multi-device access, and optional Actual Budget integration.

#### Without Actual Budget sync

Paste this into your container manager (Dockhand, Portainer, etc.):

```yaml
services:

  frontend:
    image: ghcr.io/whielyrose/mortgage-tracker-frontend:latest
    container_name: mortgage-tracker-frontend
    restart: unless-stopped
    ports:
      - "8765:80"
    depends_on:
      - api

  api:
    image: ghcr.io/whielyrose/mortgage-tracker-api:latest
    container_name: mortgage-tracker-api
    restart: unless-stopped
    volumes:
      - mortgage_data:/data

volumes:
  mortgage_data:
```

Open `http://your-server-ip:8765` and enter your mortgage details manually.

---

#### With Actual Budget sync (nightly auto-update of offset balances)

If you run [Actual Budget](https://actualbudget.org) self-hosted, the `actual-sync` container connects to it nightly at 11:50pm, reads all on-budget account balances, totals them, and posts the result to the mortgage tracker as a dated offset balance log entry. Your offset total updates automatically without any manual entry.

```yaml
services:

  frontend:
    image: ghcr.io/whielyrose/mortgage-tracker-frontend:latest
    container_name: mortgage-tracker-frontend
    restart: unless-stopped
    ports:
      - "8765:80"
    depends_on:
      - api

  api:
    image: ghcr.io/whielyrose/mortgage-tracker-api:latest
    container_name: mortgage-tracker-api
    restart: unless-stopped
    volumes:
      - mortgage_data:/data

  actual-sync:
    image: ghcr.io/whielyrose/mortgage-tracker-actual-sync:latest
    container_name: mortgage-tracker-actual-sync
    restart: "no"
    environment:
      - ACTUAL_SERVER_URL=https://your-actual-budget-url.com
      - ACTUAL_SERVER_PASSWORD=your-actual-password
      - ACTUAL_SYNC_ID=your-sync-id-from-actual-settings
      - MORTGAGE_API_URL=http://mortgage-tracker-api:8000
    volumes:
      - actual_sync_cache:/tmp/actual-cache

  cron:
    image: mcuadros/ofelia:latest
    container_name: mortgage-tracker-cron
    restart: unless-stopped
    depends_on:
      - actual-sync
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    command: daemon --docker
    labels:
      ofelia.job-run.actual-sync.schedule: "0 50 23 * * *"
      ofelia.job-run.actual-sync.container: "mortgage-tracker-actual-sync"

volumes:
  mortgage_data:
  actual_sync_cache:
```

**Getting your Actual Budget Sync ID:**
Open Actual Budget → Settings → Show advanced settings → copy the Sync ID.

**Notes:**
- `actual-sync` has `restart: "no"` — it runs, does its job, then stops. It appearing as "offline" in your container manager is expected and correct.
- `cron` (Ofelia) stays running permanently and triggers `actual-sync` each night.
- The sync reads all on-budget, open accounts and sums their balances. It never writes to Actual Budget.
- The cache is cleared before each run to avoid stale migration state from Actual Budget version updates.

---

## Features

### Dashboard

- 6-metric snapshot: outstanding balance, total offset balance, daily interest, payoff time, equity, and LVR
- LVR colour-coded: green below 60%, amber 60–80%, red above 80%
- Balance over time chart — your repayments (with offset) vs no-offset projection
- Daily interest bar chart showing accrual across the current month
- Property value and equity over time chart (appears once property value is entered)
- Next repayment countdown banner

### Mortgage Setup

- Loan details: original amount, current outstanding balance, interest rate, term, start date
- Repayment amount and frequency (weekly, fortnightly, monthly, quarterly)
- Most recent payment date — used to calculate all future payment dates precisely
- Actual minimum repayment field — enter what your lender says rather than a calculated estimate (lenders set this at each review using the balance at that time, which differs from the current balance)
- Offset accounts: add as many accounts as needed, each tracked by name and balance
- Property value: enter an estimated property value and log a history of estimates over time
- Purchase price and purchase date: used as the baseline for capital growth calculations

### Daily Log

Four entry types — all persist server-side and feed directly into every calculation:

- **Offset balance** — log the current balance of any named offset account. The most recent entry per account is used for all interest calculations. When using Actual Budget sync, this is updated automatically each night.
- **Repayment** — log an actual payment made with a date. Appears as "Logged ✓" on the Schedule page for that date.
- **Rate change** — log an interest rate change with an effective date. The tracker uses this rate for all projections from that date forward. Historical reconcile calculations apply the correct rate for each day.
- **Extra payment** — log a lump sum payment (tax return, bonus, etc.) which reduces the outstanding balance used in all forward projections.

### Schedule

- Your next 24 repayment dates with the exact interest and principal split for each payment
- Logged repayments shown as "Logged ✓" with the actual amount recorded
- Full amortisation table — every year from loan start to end of term, showing:
  - Your actual repayments with current offset maintained
  - The 30-year minimum repayment baseline side by side
  - Projected payoff year highlighted with a "PAID OFF" badge
  - 30-year term end highlighted for comparison
- Offset savings comparison — total interest saved, time saved, and payoff dates with and without offset

### History

- Yearly stacked bar chart (interest vs principal) across the full loan term
- Three-level collapsible tree: Year → Month → individual payment
  - Every single fortnightly payment for the entire life of the loan
  - Exact date, interest component, principal component, payment amount, and running balance
  - Past periods faded; today's payment tagged
  - Payoff payment tagged with "PAID OFF"
- Controls: Expand years, Collapse all, jump-to search (type a year or month)
- Totals row: cumulative interest and principal across the full term
- Lazy rendering — only the data you expand is added to the page, so the full 30-year schedule loads without freezing

### Reconcile

- Enter your actual lender interest charges from your monthly statement
- The tracker reconstructs the daily accrual for that month using your logged offset history, applying the correct rate for each day
- Shows the exact daily breakdown (effective balance, offset total, daily interest, running total)
- Explains any gap between estimated and actual in plain language
- Improves accuracy as you log more daily offset balances — unlogged days use the base settings balance
- Statement history table accumulates all past entries for ongoing accuracy tracking

### Property value tracking

- Log a history of property value estimates with dates and source notes (e.g. "Domain estimate")
- Each logged estimate appears in the estimate history table with growth from purchase price
- Equity chart on the dashboard plots property value, equity, and loan balance over time from purchase date to today

### Data management

- Export all data as JSON (backup or migration)
- Import from a previous export
- Clear all data

---

## How interest is calculated

Interest accrues daily on the effective balance (loan balance minus total offset):

```
Daily rate     = Annual rate ÷ 365
Effective bal  = Loan balance − total offset balance
Daily interest = Effective balance × daily rate
Monthly charge = Sum of daily interest across all days in the month
```

For repayment schedule projections, per-period interest uses the rate divided by periods per year:

```
Fortnightly rate = Annual rate ÷ 26
Period interest  = Effective balance × fortnightly rate
Principal paid   = Repayment amount − period interest
```

The offset is re-applied every period — it is not a one-time reduction to the principal. This accurately reflects how offset accounts work: the loan balance remains the same, but interest is only charged on the difference.

**What feeds into calculations:**
- The most recent offset balance log entry per account (or base settings if none logged)
- Any rate change log entries — applied from their effective date forward
- Any repayment or extra payment log entries — reduce the outstanding balance used in projections
- The lender-provided actual minimum repayment (used for the 30-year term comparison baseline)

---

## Auto-deploy via GitHub Actions

Pushing to `main` builds and publishes three Docker images to GitHub Container Registry:

- `ghcr.io/whielyrose/mortgage-tracker-frontend:latest`
- `ghcr.io/whielyrose/mortgage-tracker-api:latest`
- `ghcr.io/whielyrose/mortgage-tracker-actual-sync:latest`

Pull updated images on your server:

```bash
docker compose pull && docker compose up -d
```

---

## Tech stack

| Component | Technology |
|-----------|-----------|
| Frontend | Vanilla HTML/CSS/JS, Chart.js, PWA-ready |
| API | Python FastAPI, data stored as JSON on a Docker volume |
| Actual sync | Node.js 22, @actual-app/api |
| Scheduler | Ofelia (Docker-native cron) |
| Web server | Nginx Alpine |
