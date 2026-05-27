# Offset Mortgage Tracker

A self-contained web app for tracking an offset mortgage — daily interest, repayments, full amortisation schedule, and monthly reconciliation against your actual lender statements.

Works with any lender that uses offset accounts and daily interest calculation.

---

## Option A — Standalone HTML (simplest)

No server required. Just open the file in a browser.

1. Download `mortgage-tracker-standalone.html`
2. Open it in Chrome, Edge, or Safari
3. Data saves to your browser's localStorage automatically

Share it with anyone — it's a single self-contained file.

---

## Option B — Self-host with Docker

Run it on your own server. Data persists in a Docker volume, accessible from any device on your network.

### Quick start

```bash
git clone https://github.com/whielyrose/Mortgage-offset-tracker.git
cd Mortgage-offset-tracker
docker compose up -d
```

Then open `http://localhost:8765` in your browser.

### Docker Compose

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

Pull the latest images and restart:

```bash
docker compose pull
docker compose up -d
```

### Auto-deploy via GitHub Actions

Pushing to `main` automatically builds and publishes updated images to
`ghcr.io/whielyrose/mortgage-tracker-frontend:latest` and
`ghcr.io/whielyrose/mortgage-tracker-api:latest`.

Pull the new images on your server to update:

```bash
docker compose pull && docker compose up -d
```

---

## Features

### Dashboard
- Live snapshot: outstanding balance, daily interest, payoff time, interest saved by offset
- Balance over time chart — your repayments vs no-offset projection
- Daily interest bar chart for the current month

### Mortgage Setup
- Loan details: original amount, current balance, rate, term, start date
- Repayment amount and frequency (weekly / fortnightly / monthly / quarterly)
- Most recent payment date — used to calculate all future payment dates
- Actual minimum repayment (enter what your lender says, not a calculated estimate)
- Offset accounts: add as many as you like

### Daily Log
Record four types of entries — all persist and feed into calculations:
- **Offset balance** — log today's balance for any offset account
- **Repayment** — log an actual payment made; appears as "Logged ✓" in the schedule
- **Rate change** — log a rate change; updates the effective rate for all projections
- **Extra payment** — log a lump sum (tax return, bonus, etc.); reduces outstanding balance

### Schedule
- Next 24 repayment dates with exact interest/principal split
- Shows which dates have been logged as paid
- Full amortisation table — every year of the loan term, with projected payoff vs 30yr minimum
- Offset savings comparison

### History
- Full loan term breakdown — year by year, collapsible to month, collapsible to individual payment
- Every single payment and interest charge for the life of the loan
- Yearly stacked bar chart (interest vs principal)

### Reconcile
- Enter your actual lender interest charges month by month
- Tracker reconstructs the daily accrual using logged offset history
- Shows exact daily breakdown and explains any gap between estimated and actual
- Statement history table to track accuracy over time

### Data management
- Export all data as JSON (backup)
- Import from a previous export
- Clear all data

---

## How interest is calculated

Interest accrues daily:

```
Daily rate    = Annual rate ÷ 365
Daily interest = (Loan balance − total offset) × daily rate
Monthly charge = sum of daily interest across all days in the month
```

For schedule projections, per-period interest uses the rate divided by periods
per year (e.g. rate ÷ 26 for fortnightly), applied to the offset-reduced
effective balance each period.

Logged rate changes, extra payments, and repayments all update the effective
balance and rate used for all forward projections.
