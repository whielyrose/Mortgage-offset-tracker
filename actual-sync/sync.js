#!/usr/bin/env node
/**
 * actual-sync — nightly sync from Actual Budget to Mortgage Tracker
 *
 * Every night:
 *   1. Reads all on-budget account balances from Actual Budget
 *   2. Posts total as a dated offset balance log entry
 *
 * On the last day of the month (or first day if last day was missed):
 *   3. Calculates estimated monthly interest using daily accrual
 *   4. Posts an interest-charge log entry that increases the outstanding balance
 */

const actualAPI = require('@actual-app/api');
const fs = require('fs');

const ACTUAL_SERVER_URL      = process.env.ACTUAL_SERVER_URL;
const ACTUAL_SERVER_PASSWORD = process.env.ACTUAL_SERVER_PASSWORD;
const ACTUAL_SYNC_ID         = process.env.ACTUAL_SYNC_ID;
const ACTUAL_FILE_PASSWORD   = process.env.ACTUAL_FILE_PASSWORD || null;
const MORTGAGE_API_URL       = process.env.MORTGAGE_API_URL;
const CACHE_DIR              = process.env.ACTUAL_CACHE_DIR || '/tmp/actual-cache';
const DRY_RUN                = process.env.DRY_RUN === 'true';
const TZ                     = process.env.TZ || 'Australia/Brisbane';

function validateConfig() {
  const required = { ACTUAL_SERVER_URL, ACTUAL_SERVER_PASSWORD, ACTUAL_SYNC_ID, MORTGAGE_API_URL };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`❌ Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ── Timezone-safe date helpers ───────────────────────────────────────────────
function nowInTZ() {
  return new Date().toLocaleString('en-AU', { timeZone: TZ });
}

function todayStringInTZ() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function getLocalDateParts(dateStr) {
  // dateStr = YYYY-MM-DD
  const [y, m, d] = dateStr.split('-').map(Number);
  return { year: y, month: m, day: d }; // month is 1-based
}

function lastDayOfMonth(year, month) {
  // month is 1-based
  return new Date(year, month, 0).getDate();
}

function isLastDayOfMonth(dateStr) {
  const { year, month, day } = getLocalDateParts(dateStr);
  return day === lastDayOfMonth(year, month);
}

function isFirstDayOfMonth(dateStr) {
  return getLocalDateParts(dateStr).day === 1;
}

function prevMonthStr(dateStr) {
  const { year, month } = getLocalDateParts(dateStr);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;
  return `${prevYear}-${String(prevMonth).padStart(2,'0')}`;
}

function fmtMoney(n) {
  return n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
}

async function loadCurrentMortgageData() {
  const resp = await fetch(`${MORTGAGE_API_URL}/api/data`);
  if (!resp.ok) throw new Error(`Mortgage API GET failed: ${resp.status}`);
  return await resp.json();
}

async function postToMortgageTracker(data) {
  const resp = await fetch(`${MORTGAGE_API_URL}/api/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!resp.ok) throw new Error(`Mortgage API POST failed: ${resp.status}`);
  return await resp.json();
}

// ── Monthly interest calculation ─────────────────────────────────────────────
// Mirrors calcMonthEstimate in the frontend, runs server-side
function calcMonthInterest(monthStr, mortgageData) {
  const settings   = mortgageData.settings || {};
  const logEntries = mortgageData.log || [];
  const rate       = getEffectiveRate(logEntries, settings) / 100;
  const dailyRate  = rate / 365;

  const [yearNum, monthNum0] = monthStr.split('-').map(Number);
  const monthNum = monthNum0 - 1; // 0-indexed for Date
  const daysInMonth = new Date(yearNum, monthNum + 1, 0).getDate();

  // Get offset log entries sorted ascending
  const offsetLogs = logEntries
    .filter(e => e.type === 'offset')
    .sort((a, b) => a.date.localeCompare(b.date));

  // Get rate changes
  const rateLogs = logEntries
    .filter(e => e.type === 'rate')
    .sort((a, b) => a.date.localeCompare(b.date));

  // Get payments that affect balance, before this month
  const monthStart = `${yearNum}-${String(monthNum + 1).padStart(2,'0')}-01`;
  let runningBalance = parseFloat(settings.balance) || 0;
  const paymentLogs = logEntries
    .filter(e => (e.type === 'repayment' || e.type === 'extra' || e.type === 'interest-charge') && e.date < monthStart)
    .sort((a, b) => a.date.localeCompare(b.date));
  paymentLogs.forEach(p => {
    const amt = parseFloat(p.amount || 0);
    if (p.type === 'repayment' || p.type === 'extra') runningBalance = Math.max(0, runningBalance - amt);
    else if (p.type === 'interest-charge') runningBalance = runningBalance + amt;
  });

  let totalInterest = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${yearNum}-${String(monthNum+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

    // Apply any payments on this day
    logEntries
      .filter(e => e.date === dateStr && (e.type === 'repayment' || e.type === 'extra' || e.type === 'interest-charge'))
      .forEach(p => {
        const amt = parseFloat(p.amount || 0);
        if (p.type === 'repayment' || p.type === 'extra') runningBalance = Math.max(0, runningBalance - amt);
        else if (p.type === 'interest-charge') runningBalance = runningBalance + amt;
      });

    // Effective rate on this day
    let dayRate = rate;
    rateLogs.forEach(r => { if (r.date <= dateStr) dayRate = parseFloat(r.rate) / 100; });

    // Offset total for this day
    const latestPerAccount = {};
    (settings.offsets || []).forEach(o => { latestPerAccount[o.name] = o.balance; });
    offsetLogs.forEach(e => {
      if (e.date <= dateStr) latestPerAccount[e.account] = parseFloat(e.balance) || 0;
    });
    const totalOffset = Object.values(latestPerAccount).reduce((a, b) => a + b, 0);
    const effBal = Math.max(0, runningBalance - totalOffset);
    totalInterest += effBal * (dayRate / 365);
  }

  return Math.round(totalInterest * 100) / 100;
}

function getEffectiveRate(logEntries, settings) {
  const rateLogs = (logEntries || [])
    .filter(e => e.type === 'rate')
    .sort((a, b) => b.date.localeCompare(a.date));
  return rateLogs.length ? parseFloat(rateLogs[0].rate) || settings.rate : settings.rate;
}

function interestChargeAlreadyExists(log, monthStr) {
  return log.some(e =>
    e.type === 'interest-charge' &&
    e.date.startsWith(monthStr) &&
    e.note && e.note.includes('auto-calculated')
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const localNow  = nowInTZ();
  const localDate = todayStringInTZ();

  console.log('═══════════════════════════════════════════');
  console.log('  Actual Budget → Mortgage Tracker Sync');
  console.log(`  ${localNow} (${TZ})`);
  console.log(`  Logging date: ${localDate}`);
  console.log('═══════════════════════════════════════════');

  validateConfig();
  if (DRY_RUN) console.log('⚠  DRY RUN — no data will be written\n');

  // ── 1. Connect to Actual Budget ───────────────────────────────────────────
  console.log(`\n📡 Connecting to Actual Budget at ${ACTUAL_SERVER_URL}...`);
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  await actualAPI.init({ serverURL: ACTUAL_SERVER_URL, password: ACTUAL_SERVER_PASSWORD, dataDir: CACHE_DIR });
  await actualAPI.downloadBudget(ACTUAL_SYNC_ID, { password: ACTUAL_FILE_PASSWORD });
  console.log('✓ Connected and budget downloaded');

  // ── 2. Read all on-budget accounts ───────────────────────────────────────
  console.log('\n🏦 Reading on-budget accounts...');
  const accounts = await actualAPI.getAccounts();
  const onBudget = accounts.filter(a => !a.offbudget && !a.closed);

  if (!onBudget.length) {
    console.error('❌ No on-budget accounts found.');
    await actualAPI.shutdown();
    process.exit(1);
  }

  console.log(`\n  Found ${onBudget.length} on-budget account(s):\n`);
  let totalCents = 0;
  for (const account of onBudget) {
    const transactions = await actualAPI.getTransactions(account.id);
    const balanceCents = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
    totalCents += balanceCents;
    console.log(`  ${balanceCents >= 0 ? '✓' : '⚠'}  ${account.name.padEnd(35)} ${fmtMoney(balanceCents/100)}`);
  }

  const totalDollars = totalCents / 100;
  console.log(`\n  ${'TOTAL OFFSET'.padEnd(35)} ${fmtMoney(totalDollars)}`);

  await actualAPI.shutdown();
  console.log('\n✓ Actual Budget connection closed');

  // ── 3. Load current mortgage tracker data ────────────────────────────────
  console.log('\n📊 Loading mortgage tracker data...');
  let mortgageData;
  try {
    mortgageData = await loadCurrentMortgageData();
    console.log('✓ Mortgage tracker data loaded');
  } catch (e) {
    console.error(`❌ Could not reach mortgage tracker API: ${e.message}`);
    process.exit(1);
  }

  const log = mortgageData.log || [];

  // ── 4. Update offset balance log entry ───────────────────────────────────
  const today = localDate;
  const existingIdx = log.findIndex(e =>
    e.type === 'offset' && e.date === today &&
    e.account === 'All on-budget accounts (auto-sync)'
  );

  const offsetEntry = {
    id: existingIdx >= 0 ? log[existingIdx].id : Date.now(),
    type: 'offset', date: today,
    account: 'All on-budget accounts (auto-sync)',
    balance: totalDollars,
    note: `Auto-synced from Actual Budget — ${onBudget.length} accounts — ${localNow} (${TZ})`
  };

  if (existingIdx >= 0) {
    console.log(`\n♻  Updating existing offset entry for today (${today})`);
    log[existingIdx] = offsetEntry;
  } else {
    console.log(`\n➕ Adding new offset log entry for ${today}`);
    log.unshift(offsetEntry);
  }

  // ── 5. Monthly interest charge (last day of month, or catch-up on 1st) ───
  let interestEntry = null;
  let targetMonth   = null;

  if (isLastDayOfMonth(today)) {
    targetMonth = today.slice(0, 7); // YYYY-MM
    console.log(`\n📅 Last day of month detected (${today})`);
  } else if (isFirstDayOfMonth(today)) {
    const prev = prevMonthStr(today);
    if (!interestChargeAlreadyExists(log, prev)) {
      targetMonth = prev;
      console.log(`\n📅 First day of month — checking if last month's interest was posted...`);
      console.log(`   No interest charge found for ${prev} — calculating catch-up`);
    } else {
      console.log(`\n📅 First day of month — ${prevMonthStr(today)} interest already posted ✓`);
    }
  }

  if (targetMonth) {
    // Remove any existing auto-calculated charge for this month (recalculate fresh)
    const existingChargeIdx = log.findIndex(e =>
      e.type === 'interest-charge' && e.date.startsWith(targetMonth) &&
      e.note && e.note.includes('auto-calculated')
    );
    if (existingChargeIdx >= 0) {
      log.splice(existingChargeIdx, 1);
      console.log(`   Removed previous auto-calculated charge for ${targetMonth}`);
    }

    // Calculate interest for the target month
    // First make sure today's offset is reflected in the data for the calculation
    const tempData = { ...mortgageData, log };
    const estimatedInterest = calcMonthInterest(targetMonth, tempData);
    const { year, month } = getLocalDateParts(targetMonth + '-01');
    const chargeDay = lastDayOfMonth(year, month - 1 === 0 ? 12 : month);
    // Wait — month here is 1-based already from the YYYY-MM string
    const lastDay = lastDayOfMonth(year, month);
    const chargeDateStr = `${targetMonth}-${String(lastDay).padStart(2,'0')}`;
    const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

    interestEntry = {
      id: Date.now() + 2,
      type: 'interest-charge',
      date: chargeDateStr,
      amount: estimatedInterest,
      note: `auto-calculated interest for ${monthLabel} — ${lastDay} days — ${fmtMoney(estimatedInterest)}`
    };

    log.unshift(interestEntry);
    console.log(`\n💰 Interest charge posted for ${monthLabel}:`);
    console.log(`   Date:   ${chargeDateStr}`);
    console.log(`   Amount: ${fmtMoney(estimatedInterest)}`);
    console.log(`   Note:   auto-calculated — reconcile against your statement to adjust`);
  }

  // ── 6. Post back to mortgage tracker ─────────────────────────────────────
  if (DRY_RUN) {
    console.log('\n⚠  DRY RUN — would have posted:');
    console.log('  Offset entry:', JSON.stringify(offsetEntry, null, 2));
    if (interestEntry) console.log('  Interest entry:', JSON.stringify(interestEntry, null, 2));
  } else {
    console.log('\n📤 Posting to mortgage tracker...');
    await postToMortgageTracker({
      settings: mortgageData.settings,
      log,
      reconcile: mortgageData.reconcile || [],
      propValueLog: mortgageData.propValueLog || []
    });
    console.log('✓ Mortgage tracker updated successfully');

    // Notify any open browser tabs to refresh immediately
    try{
      const notifyResp = await fetch(`${MORTGAGE_API_URL}/api/notify`, { method: 'POST' });
      const notifyData = await notifyResp.json();
      console.log(`✓ Browser notification sent (${notifyData.clients} tab${notifyData.clients!==1?'s':''} connected)`);
    }catch(e){
      console.warn('  Browser notification failed (no tabs open or API unreachable)');
    }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  Sync complete ✓');
  console.log(`  Total offset logged: ${fmtMoney(totalDollars)}`);
  if (interestEntry) console.log(`  Interest charged:   ${fmtMoney(interestEntry.amount)}`);
  console.log('═══════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\n❌ Sync failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
