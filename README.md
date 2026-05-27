# Beyond Bank Mortgage Tracker

A self-contained PWA (Progressive Web App) for tracking your Beyond Bank offset mortgage.
Works offline, installs to desktop or phone, and remembers all your data locally.

---

## Installation

### Option A — Open in browser (works immediately, no install required)
1. Unzip the folder
2. Open `index.html` in Chrome, Edge, or Safari
3. All data is saved in your browser's localStorage automatically

### Option B — Install as a desktop/phone app (PWA)
The app must be served over a local web server for PWA install to work.

**Easiest: use VS Code Live Server**
1. Install the "Live Server" extension in VS Code
2. Right-click `index.html` → "Open with Live Server"
3. Chrome/Edge will show an install icon (⊕) in the address bar — click it

**Or: use Python's built-in server**
```bash
cd mortgage-tracker
python3 -m http.server 8080
```
Then open `http://localhost:8080` in Chrome or Edge.
Click the install icon in the address bar (or the "Install App" button in the app).

**On iPhone/iPad (Safari)**
1. Serve via Python or Live Server as above
2. Open in Safari → Share button → "Add to Home Screen"

---

## Features

### Dashboard
- Live snapshot: outstanding balance, daily interest, payoff time, total interest saved by offset
- Balance over time chart (with vs without offset)
- Daily interest bar chart for the current month

### Mortgage Setup
- Loan details: original amount, current balance, rate, term, start date
- Repayment amount, frequency (weekly / fortnightly / monthly / quarterly)
- **Repayment day selector**: choose which day of the month (for monthly/quarterly) or day of the week (for weekly/fortnightly) your payment comes out
- Offset accounts: add as many as you like

### Daily Log
Record four types of entries — all are remembered and affect interest calculations:
- **Offset balance**: log today's balance for any offset account (replaces the base amount in calculations)
- **Repayment**: log an actual payment made, with a date — appears as "Logged ✓" in the schedule
- **Rate change**: log an RBA rate change — automatically updates the effective rate used in all calculations
- **Extra payment**: log a lump sum payment (tax return, bonus, etc.) — reduces outstanding balance

### Schedule
- Your next 24 repayment dates with interest/principal split for each
- Shows which dates have been logged as paid
- Full amortisation table (year by year)
- Offset savings comparison

### History
- Month-by-month interest vs principal breakdown (bar chart + table)

### Data management
- Export all data as JSON (backup)
- Import from a previous export
- Full offline support via service worker

---

## How interest calculations work

Interest is calculated daily:
- **Daily rate** = Annual rate ÷ 365
- **Daily interest** = (Outstanding balance − total offset) × daily rate

For schedule projections, per-period interest uses the rate divided by periods per year (e.g. rate ÷ 26 for fortnightly), applied to the offset-reduced effective balance each period.

Logged rate changes, extra payments, and repayments all feed into the effective balance and rate used for all forward projections.
