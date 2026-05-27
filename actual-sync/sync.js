#!/usr/bin/env node
/**
 * actual-sync — nightly sync from Actual Budget to Mortgage Tracker
 *
 * Reads all on-budget account balances from Actual Budget,
 * totals them up, and posts a dated offset balance entry
 * to the mortgage tracker API.
 */

const actualAPI = require('@actual-app/api');
const fs = require('fs');
const path = require('path');

// ── Config from environment ──────────────────────────────────────────────────
const ACTUAL_SERVER_URL      = process.env.ACTUAL_SERVER_URL;
const ACTUAL_SERVER_PASSWORD = process.env.ACTUAL_SERVER_PASSWORD;
const ACTUAL_SYNC_ID         = process.env.ACTUAL_SYNC_ID;
const ACTUAL_FILE_PASSWORD   = process.env.ACTUAL_FILE_PASSWORD || null;
const MORTGAGE_API_URL       = process.env.MORTGAGE_API_URL; // e.g. http://mortgage-tracker-api:8000
const CACHE_DIR              = process.env.ACTUAL_CACHE_DIR || '/tmp/actual-cache';
const DRY_RUN                = process.env.DRY_RUN === 'true';

function validateConfig() {
  const required = { ACTUAL_SERVER_URL, ACTUAL_SERVER_PASSWORD, ACTUAL_SYNC_ID, MORTGAGE_API_URL };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`❌ Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function fmtMoney(cents) {
  return (cents / 100).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
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

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Actual Budget → Mortgage Tracker Sync');
  console.log(`  ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' })} (Adelaide time)`);
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
    console.error('❌ No on-budget accounts found. Check your Actual Budget setup.');
    await actualAPI.shutdown();
    process.exit(1);
  }

  console.log(`\n  Found ${onBudget.length} on-budget account(s):\n`);
  let totalCents = 0;

  for (const account of onBudget) {
    // Get balance via transactions sum
    const transactions = await actualAPI.getTransactions(account.id);
    const balanceCents = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
    totalCents += balanceCents;
    const indicator = balanceCents >= 0 ? '✓' : '⚠';
    console.log(`  ${indicator}  ${account.name.padEnd(35)} ${fmtMoney(balanceCents)}`);
  }

  const totalDollars = totalCents / 100;
  console.log(`\n  ${'TOTAL OFFSET'.padEnd(35)} ${fmtMoney(totalCents)}`);

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
    console.error(`   Is the mortgage tracker running at ${MORTGAGE_API_URL}?`);
    process.exit(1);
  }

  // ── 4. Build new log entry ────────────────────────────────────────────────
  const today = todayString();
  const log = mortgageData.log || [];

  // Check if we already have an auto-sync entry for today — update rather than duplicate
  const existingIdx = log.findIndex(e =>
    e.type === 'offset' &&
    e.date === today &&
    e.account === 'All on-budget accounts (auto-sync)'
  );

  const newEntry = {
    id: existingIdx >= 0 ? log[existingIdx].id : Date.now(),
    type: 'offset',
    date: today,
    account: 'All on-budget accounts (auto-sync)',
    balance: totalDollars,
    note: `Auto-synced from Actual Budget — ${onBudget.length} accounts — ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' })}`
  };

  if (existingIdx >= 0) {
    console.log(`\n♻  Updating existing entry for today (${today})`);
    log[existingIdx] = newEntry;
  } else {
    console.log(`\n➕ Adding new offset log entry for ${today}`);
    log.unshift(newEntry);
  }

  // ── 5. Post back to mortgage tracker ─────────────────────────────────────
  if (DRY_RUN) {
    console.log('\n⚠  DRY RUN — would have posted:');
    console.log(JSON.stringify(newEntry, null, 2));
  } else {
    console.log('\n📤 Posting to mortgage tracker...');
    await postToMortgageTracker({
      settings: mortgageData.settings,
      log,
      reconcile: mortgageData.reconcile || [],
      propValueLog: mortgageData.propValueLog || []
    });
    console.log('✓ Mortgage tracker updated successfully');
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  Sync complete ✓');
  console.log(`  Total offset logged: ${fmtMoney(totalCents)}`);
  console.log('═══════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\n❌ Sync failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
