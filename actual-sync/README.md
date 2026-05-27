# actual-sync — Actual Budget → Mortgage Tracker

Runs nightly at 11:50pm, reads all on-budget account balances from your
Actual Budget server, and logs the total as an offset balance entry in
the mortgage tracker. The mortgage tracker then uses this for all its
daily interest and projection calculations.

---

## One-time setup on your server

### 1. Create the env file

```bash
mkdir -p /opt/mortgage-tracker
cp actual-sync/.env.example /opt/mortgage-tracker/.env
nano /opt/mortgage-tracker/.env
```

Fill in:
- `ACTUAL_SERVER_URL` — your Actual Budget Tailscale IP and port (e.g. `http://100.x.x.x:5006`)
- `ACTUAL_SERVER_PASSWORD` — your Actual Budget server password
- `ACTUAL_SYNC_ID` — from Actual: Settings → Show advanced settings → Sync ID

### 2. Get your Sync ID from Actual Budget

1. Open Actual Budget in your browser
2. Go to **Settings** (bottom left)
3. Click **Show advanced settings**
4. Copy the **Sync ID** (looks like `a1b2c3d4-e5f6-7890-abcd-ef1234567890`)

### 3. Make the package public on GitHub

After the first push builds the image, go to:
`https://github.com/whielyrose?tab=packages`

Find `mortgage-tracker-actual-sync` → **Package settings** → **Change visibility** → **Public**

### 4. Deploy in Dockhand

Update your mortgage-tracker stack with the new `docker-compose.yml` which
includes the `actual-sync` and `cron` services. Click **Deploy**.

---

## Testing it manually

To run a sync immediately without waiting for 11:50pm:

```bash
# Dry run first — reads Actual but writes nothing
docker run --rm \
  --env-file /opt/mortgage-tracker/.env \
  -e DRY_RUN=true \
  --network mortgage-tracker_default \
  ghcr.io/whielyrose/mortgage-tracker-actual-sync:latest

# Real run
docker run --rm \
  --env-file /opt/mortgage-tracker/.env \
  --network mortgage-tracker_default \
  ghcr.io/whielyrose/mortgage-tracker-actual-sync:latest
```

The `--network mortgage-tracker_default` flag lets the sync container
reach the mortgage tracker API container by name.

---

## What it does each night

1. Connects to your Actual Budget server
2. Downloads your budget file
3. Reads every on-budget account balance
4. Totals them up
5. Posts a single offset log entry to the mortgage tracker API dated today
6. If an auto-sync entry already exists for today, it updates it rather than duplicating

The entry appears in the mortgage tracker's **Daily Log** as:
- Account: `All on-budget accounts (auto-sync)`
- Balance: total of all on-budget accounts
- Note: timestamp and account count

---

## Checking the logs

```bash
# See the last sync output
docker logs mortgage-tracker-actual-sync

# Watch the cron scheduler
docker logs mortgage-tracker-cron
```

---

## Adjusting the schedule

The cron schedule is set in `docker-compose.yml` under the `cron` service labels:

```yaml
ofelia.job-run.actual-sync.schedule: "0 50 23 * * *"
```

Format: `seconds minutes hours day-of-month month day-of-week`

Common alternatives:
- `"0 0 0 * * *"` — midnight exactly
- `"0 55 23 * * *"` — 11:55pm
- `"0 0 8 * * *"` — 8am instead
