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
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
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

    // Offset total for this day — check for auto-sync total first
    let totalOffset;
    const autoSyncForDay = offsetLogs
      .filter(e => e.account === 'All on-budget accounts (auto-sync)' && e.date <= dateStr)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (autoSyncForDay.length) {
      totalOffset = parseFloat(autoSyncForDay[0].balance) || 0;
    } else {
      const latestPerAccount = {};
      (settings.offsets || []).forEach(o => { latestPerAccount[o.name] = o.balance; });
      offsetLogs.forEach(e => {
        if (e.date <= dateStr && e.account !== 'All on-budget accounts (auto-sync)')
          latestPerAccount[e.account] = parseFloat(e.balance) || 0;
      });
      totalOffset = Object.values(latestPerAccount).reduce((a, b) => a + b, 0);
    }
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

  // ── 1. Load mortgage tracker data FIRST (need fundingData config) ─────────
  console.log('\n📊 Loading mortgage tracker data...');
  let mortgageData;
  try {
    mortgageData = await loadCurrentMortgageData();
    console.log('✓ Mortgage tracker data loaded');
  } catch (e) {
    throw new Error(`Could not reach mortgage tracker API: ${e.message}`);
  }

  // ── 2. Connect to Actual Budget (single connection for everything) ────────
  console.log(`\n📡 Connecting to Actual Budget at ${ACTUAL_SERVER_URL}...`);
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  await actualAPI.init({ serverURL: ACTUAL_SERVER_URL, password: ACTUAL_SERVER_PASSWORD, dataDir: CACHE_DIR });
  await actualAPI.downloadBudget(ACTUAL_SYNC_ID, { password: ACTUAL_FILE_PASSWORD });
  console.log('✓ Connected and budget downloaded');

  // ── 3. Read all on-budget accounts ────────────────────────────────────────
  console.log('\n🏦 Reading on-budget accounts...');
  const accounts = await actualAPI.getAccounts();
  const onBudget = accounts.filter(a => !a.offbudget && !a.closed);

  if (!onBudget.length) {
    await actualAPI.shutdown();
    throw new Error('No on-budget accounts found.');
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

  // ── 4. Funding analysis (same connection) ─────────────────────────────────
  // "Needed" per category = the goal Actual computes for the target month from
  // schedules/templates — the figure shown when hovering the balance column.
  if (mortgageData.fundingData?.group && mortgageData.fundingData?.targetMonth) {
    const groupName   = mortgageData.fundingData.group;
    const targetMonth = mortgageData.fundingData.targetMonth; // YYYY-MM
    try {
      const categoryGroups = await actualAPI.getCategoryGroups();
      const group = categoryGroups.find(g =>
        g.name.toLowerCase() === groupName.toLowerCase() && !g.hidden
      );

      if (!group) {
        console.log(`\n⚠  Funding group "${groupName}" not found in Actual Budget`);
        console.log(`   Available groups: ${categoryGroups.filter(g=>!g.hidden).map(g=>g.name).join(', ')}`);
      } else {
        console.log(`\n💰 Analysing funding for "${group.name}" — target ${targetMonth}`);

        const targetBudget = await actualAPI.getBudgetMonth(targetMonth);
        const targetGroup  = targetBudget?.categoryGroups?.find(cg => cg.id === group.id);
        const targetCats   = targetGroup?.categories || [];

        if (!targetCats.length) {
          console.log(`  ⚠  No categories found in group for ${targetMonth}`);
        }

        // ── READ-ONLY template evaluator ────────────────────────────────────
        // Actual only stores the computed goal AFTER you apply templates (a write
        // we must never do). So we evaluate the templates ourselves, read-only:
        //   - simple template  → monthly amount
        //   - schedule template → schedule amount × occurrences in target month
        const runQuery = actualAPI.runQuery || actualAPI.aqlQuery;

        // Pull goal_def for every category in the group (the template definition)
        let goalDefs = {};
        try {
          const gd = await runQuery(actualAPI.q('categories').filter({ 'group.id': group.id }).select(['id','name','goal_def']));
          (gd?.data || []).forEach(c => { goalDefs[c.id] = c.goal_def; });
        } catch(e){ console.warn('  goal_def read failed:', e.message); }

        // Pull all schedules (read-only) and index by lowercased name
        let schedulesByName = {};
        try {
          const allSchedules = await actualAPI.getSchedules();
          (allSchedules || []).forEach(s => {
            if (s.name) schedulesByName[s.name.toLowerCase()] = s;
          });
        } catch(e){ console.warn('  schedules read failed:', e.message); }

        // Count how many times a schedule occurs within a given YYYY-MM
        // Parse a YYYY-MM-DD (or ISO) string to a LOCAL date at noon, so the
        // time-of-day can never push an occurrence over a month boundary.
        function parseLocalNoon(str){
          const m = String(str).slice(0,10).split('-').map(Number);
          return new Date(m[0], m[1]-1, m[2], 12, 0, 0, 0);
        }

        function occurrencesInMonth(schedule, ymStr){
          const [yr, mo] = ymStr.split('-').map(Number);
          const monthStart = new Date(yr, mo - 1, 1, 12, 0, 0, 0);
          const monthEnd   = new Date(yr, mo, 0, 12, 0, 0, 0);
          const dateCfg = schedule._date || schedule.date;
          if (!dateCfg) return 0;
          if (typeof dateCfg === 'string') {
            const d = parseLocalNoon(dateCfg);
            return (d >= monthStart && d <= monthEnd) ? 1 : 0;
          }
          const freq     = dateCfg.frequency || 'monthly';
          const interval = dateCfg.interval || 1;
          // Anchor on the schedule's next_date (Actual keeps this accurate to the
          // real payment cadence). Fall back to the configured start only if there
          // is no next_date. Stepping from a stale `start` can drift off the true
          // payment dates and miscount months that contain an extra payment.
          const anchorStr = schedule.next_date || dateCfg.start || dateCfg.startDate;
          if (!anchorStr) return 0;
          let cursor = parseLocalNoon(anchorStr);
          let iter = 0;
          // Walk backwards to at/just-before the month start
          while (cursor >= monthStart && iter < 6000) { cursor = stepDate(cursor, freq, -interval); iter++; }
          // Step forward into the month
          iter = 0;
          while (cursor < monthStart && iter < 6000) { cursor = stepDate(cursor, freq, interval); iter++; }
          let count = 0; iter = 0;
          while (cursor <= monthEnd && iter < 400) {
            if (cursor >= monthStart) count++;
            cursor = stepDate(cursor, freq, interval);
            iter++;
          }
          return count;
        }

        function stepDate(d, freq, interval){
          const n = new Date(d);
          if (freq === 'daily')   n.setDate(n.getDate() + interval);
          else if (freq === 'weekly')  n.setDate(n.getDate() + 7 * interval);
          else if (freq === 'monthly') n.setMonth(n.getMonth() + interval);
          else if (freq === 'yearly')  n.setFullYear(n.getFullYear() + interval);
          else n.setMonth(n.getMonth() + interval);
          return n;
        }

        // Find the next occurrence date on/after a given month start.
        // Uses the schedule's configured start and steps forward (the original,
        // verified behaviour for catch-up calculations). Dates are normalized to
        // local noon to avoid timezone month-boundary slips.
        function nextOccurrenceOnOrAfter(schedule, ymStr){
          const [yr, mo] = ymStr.split('-').map(Number);
          const monthStart = new Date(yr, mo - 1, 1, 12, 0, 0, 0);
          const dateCfg = schedule._date || schedule.date;
          if (!dateCfg) return null;
          if (typeof dateCfg === 'string') {
            const d = parseLocalNoon(dateCfg);
            return d >= monthStart ? d : null;
          }
          const freq     = dateCfg.frequency || 'monthly';
          const interval = dateCfg.interval || 1;
          const startStr = dateCfg.start || dateCfg.startDate;
          if (!startStr) return null;
          let cursor = parseLocalNoon(startStr);
          let iter = 0;
          while (cursor < monthStart && iter < 6000) { cursor = stepDate(cursor, freq, interval); iter++; }
          return cursor;
        }

        // Whole months from a month-start (YYYY-MM) to a target date, inclusive of
        // the due month. e.g. due this month → 1; due next month → 2.
        function monthsUntil(ymStr, dueDate){
          const [yr, mo] = ymStr.split('-').map(Number);
          const months = (dueDate.getFullYear() - yr) * 12 + (dueDate.getMonth() - (mo - 1));
          return Math.max(1, months + 1);
        }

        function cycleMonths(schedule){
          const dateCfg = schedule._date || schedule.date;
          if (!dateCfg || typeof dateCfg === 'string') return 1;
          const freq     = dateCfg.frequency || 'monthly';
          const interval = dateCfg.interval || 1;
          if (freq === 'daily')   return (interval) / 30;
          if (freq === 'weekly')  return (interval * 7) / 30;
          if (freq === 'monthly') return interval;
          if (freq === 'yearly')  return interval * 12;
          return interval;
        }

        // Evaluate one category's template(s) → needed dollars for the target month,
        // matching Actual's schedule-template logic: for a future-dated bill, set
        // aside amount ÷ (months until it's due) so it's fully funded in time.
        function evalNeeded(cat){
          const catId = cat.id;
          // Carryover already saved in this category before this month's budgeting
          const carryover = ((cat.balance || 0) - (cat.budgeted || 0)) / 100;
          const raw = goalDefs[catId];
          if (!raw) return { needed: 0, source: 'none' };
          let defs;
          try { defs = JSON.parse(raw); } catch(e){ return { needed: 0, source: 'none' }; }
          if (!Array.isArray(defs) || !defs.length) return { needed: 0, source: 'none' };

          let total = 0, sawSomething = false;
          for (const def of defs) {
            if (def.type === 'simple' && def.monthly != null) {
              total += Number(def.monthly);
              sawSomething = true;
            } else if (def.type === 'schedule' && def.name) {
              const sch = schedulesByName[def.name.toLowerCase()];
              if (sch) {
                const amt = Math.abs(sch._amount != null ? sch._amount : (sch.amount || 0)) / 100;
                const cyc = cycleMonths(sch);
                let adj = 1;
                if (def.adjustment && def.adjustmentType === 'percent') adj = 1 + Number(def.adjustment)/100;
                if (def.full === true) {
                  total += amt * adj * occurrencesInMonth(sch, targetMonth);
                } else if (cyc <= 1.0001) {
                  // Sub-monthly / monthly bills land in full each period
                  total += amt * adj * occurrencesInMonth(sch, targetMonth);
                } else {
                  // Recurring multi-month bill (yearly/quarterly). Match what Actual
                  // wants budgeted THIS month to keep the category on track ("go green"):
                  //   • If the next payout is still in the future, catch up: spread the
                  //     amount still needed (target − already-saved) over the months left
                  //     until it's due.
                  //   • If the bill is due now or the cycle has just renewed (already
                  //     fully saved), fall back to the steady contribution amount ÷ cycle.
                  const steady = (amt * adj) / cyc;
                  const due = nextOccurrenceOnOrAfter(sch, targetMonth);
                  // months from the target month to the due month (0 = due this month)
                  let need = steady;
                  if (due) {
                    const [tY, tM] = targetMonth.split('-').map(Number);
                    const monthsToDue = (due.getFullYear() - tY) * 12 + (due.getMonth() - (tM - 1));
                    if (monthsToDue >= 0) {
                      const remainingToSave = Math.max(0, amt * adj - Math.max(0, carryover));
                      const catchUp = remainingToSave / (monthsToDue + 1);
                      // Use catch-up while saving toward a future/imminent bill; once
                      // it's covered (catchUp would be ~0), use the steady rate so the
                      // renewed cycle keeps contributing.
                      need = catchUp > 0.009 ? catchUp : steady;
                    }
                  }
                  total += need;
                }
                sawSomething = true;
              }
            } else if (def.type === 'by' && def.amount != null && def.month) {
              // "Save $amount by YYYY-MM" — spread the remaining amount evenly
              // across the months from the target month up to the due month.
              // If annual, the goal repeats yearly: roll the due date forward
              // until it's on/after the target month.
              let [dueY, dueM] = def.month.split('-').map(Number);
              const [tY, tM] = targetMonth.split('-').map(Number);
              if (def.annual) {
                while (dueY * 12 + (dueM - 1) < tY * 12 + (tM - 1)) dueY += 1;
              }
              const monthsToGo = Math.max(1, (dueY * 12 + (dueM - 1)) - (tY * 12 + (tM - 1)) + 1);
              const remainingToSave = Math.max(0, Number(def.amount) - Math.max(0, carryover));
              total += remainingToSave / monthsToGo;
              sawSomething = true;
            } else if (def.monthly != null) {
              total += Number(def.monthly);
              sawSomething = true;
            } else if (def.amount != null) {
              total += Number(def.amount);
              sawSomething = true;
            }
          }
          return { needed: Math.round(total * 100) / 100, source: sawSomething ? 'template' : 'none' };
        }

        const categories = [];



        let totalNeeded = 0, totalFunded = 0;

        for (const cat of targetCats) {
          if (cat.hidden) continue;
          const funded  = (cat.budgeted || 0) / 100;
          const balance = (cat.balance  || 0) / 100;

          // Read-only: compute needed from the category's template(s)
          const { needed, source } = evalNeeded(cat);

          const remaining = Math.max(0, needed - funded);
          totalNeeded += needed;
          totalFunded += funded;   // real dollars budgeted this month (not capped at needed)
          categories.push({
            name: cat.name,
            needed:    Math.round(needed*100)/100,
            funded:    Math.round(funded*100)/100,
            remaining: Math.round(remaining*100)/100,
            balance:   Math.round(balance*100)/100,
            source
          });
          const flag = needed === 0 ? '·' : remaining < 0.01 ? '✓' : '○';
          console.log(`  ${flag}  ${cat.name.padEnd(30)} needed ${fmtMoney(needed).padStart(11)}  funded ${fmtMoney(funded).padStart(11)}  remaining ${fmtMoney(remaining).padStart(11)}  balance ${fmtMoney(balance).padStart(11)}  [${source}]`);
        }

        const noGoalCount = categories.filter(c => c.source === 'none').length;
        if (noGoalCount > 0) {
          console.log(`\n  ⚠  ${noGoalCount} categor${noGoalCount===1?'y has':'ies have'} no template/schedule set — needed treated as $0`);
        }

        const totalRemaining = Math.max(0, totalNeeded - totalFunded);
        console.log(`\n  TOTAL — needed ${fmtMoney(totalNeeded)}, funded ${fmtMoney(totalFunded)}, remaining ${fmtMoney(totalRemaining)}`);

        mortgageData.fundingData.breakdown = {
          group: group.name,
          targetMonth,
          categories,
          totalNeeded:    Math.round(totalNeeded*100)/100,
          totalFunded:    Math.round(totalFunded*100)/100,
          totalRemaining: Math.round(totalRemaining*100)/100,
          syncedAt: localNow + ' (' + TZ + ')'
        };
      }
    } catch(e) {
      console.warn('\n⚠  Funding analysis failed:', e.message);
    }
  }

  // ── 5. Close Actual connection (everything read) ──────────────────────────
  await actualAPI.shutdown();
  console.log('\n✓ Actual Budget connection closed');

  const log = mortgageData.log || [];

  // ── 6. Update offset balance log entry ────────────────────────────────────
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

  // ── 7. Monthly interest charge (last day of month, or catch-up on 1st) ────
  let interestEntry = null;
  let targetMonthIC = null;

  if (isLastDayOfMonth(today)) {
    targetMonthIC = today.slice(0, 7);
    console.log(`\n📅 Last day of month detected (${today})`);
  } else if (isFirstDayOfMonth(today)) {
    const prev = prevMonthStr(today);
    if (!interestChargeAlreadyExists(log, prev)) {
      targetMonthIC = prev;
      console.log(`\n📅 First day of month — no interest charge found for ${prev} — calculating catch-up`);
    } else {
      console.log(`\n📅 First day of month — ${prev} interest already posted ✓`);
    }
  }

  if (targetMonthIC) {
    const existingChargeIdx = log.findIndex(e =>
      e.type === 'interest-charge' && e.date.startsWith(targetMonthIC) &&
      e.note && e.note.includes('auto-calculated')
    );
    if (existingChargeIdx >= 0) {
      log.splice(existingChargeIdx, 1);
      console.log(`   Removed previous auto-calculated charge for ${targetMonthIC}`);
    }

    const tempData = { ...mortgageData, log };
    const estimatedInterest = calcMonthInterest(targetMonthIC, tempData);
    const [icYear, icMonth] = targetMonthIC.split('-').map(Number);
    const lastDay = lastDayOfMonth(icYear, icMonth);
    const chargeDateStr = `${targetMonthIC}-${String(lastDay).padStart(2,'0')}`;
    const monthLabel = new Date(icYear, icMonth - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

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
  }

  // ── 8. Single POST with everything ─────────────────────────────────────────
  if (DRY_RUN) {
    console.log('\n⚠  DRY RUN — would have posted:');
    console.log('  Offset entry:', JSON.stringify(offsetEntry, null, 2));
    if (interestEntry) console.log('  Interest entry:', JSON.stringify(interestEntry, null, 2));
    if (mortgageData.fundingData?.breakdown) console.log('  Funding breakdown: totalRemaining', mortgageData.fundingData.breakdown.totalRemaining);
  } else {
    console.log('\n📤 Posting to mortgage tracker...');
    await postToMortgageTracker({
      settings:     mortgageData.settings,
      log,
      reconcile:    mortgageData.reconcile || [],
      propValueLog: mortgageData.propValueLog || [],
      fundingData:  mortgageData.fundingData || null
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
  if (mortgageData.fundingData?.breakdown) console.log(`  Funding remaining:  ${fmtMoney(mortgageData.fundingData.breakdown.totalRemaining)}`);
  console.log('═══════════════════════════════════════════\n');
}

// ── HTTP server + nightly scheduler ─────────────────────────────────────────
// The container stays alive and runs the sync on demand (POST /run) or on its
// built-in nightly schedule. A mutex prevents overlapping runs.
const http = require('http');

const PORT          = Number(process.env.SYNC_PORT || 8090);
const NIGHTLY_HHMM  = process.env.SYNC_NIGHTLY_TIME || '23:50'; // local TZ HH:MM, '' to disable

let isRunning = false;
let lastRun   = null;   // { startedAt, finishedAt, ok, error }

async function runSync(trigger) {
  if (isRunning) {
    console.log(`\n⏳ Sync already in progress — ignoring ${trigger} trigger`);
    return { started: false, reason: 'already-running' };
  }
  isRunning = true;
  const startedAt = nowInTZ();
  console.log(`\n▶  Sync triggered by: ${trigger}`);
  try {
    // Clear stale Actual cache each run (entrypoint used to do this)
    try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch (_) {}
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}

    await main();
    lastRun = { startedAt, finishedAt: nowInTZ(), ok: true, error: null };
    return { started: true, ok: true };
  } catch (err) {
    console.error('\n❌ Sync failed:', err.message);
    console.error(err.stack);
    lastRun = { startedAt, finishedAt: nowInTZ(), ok: false, error: err.message };
    return { started: true, ok: false, error: err.message };
  } finally {
    isRunning = false;
  }
}

// Simple HTTP API
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'POST' && url === '/run') {
    if (isRunning) {
      res.writeHead(409);
      res.end(JSON.stringify({ ok: false, status: 'already-running' }));
      return;
    }
    // Kick off the sync but respond quickly; the browser is refreshed via
    // the existing /api/notify SSE path when the sync finishes.
    res.writeHead(202);
    res.end(JSON.stringify({ ok: true, status: 'started' }));
    runSync('button');
    return;
  }

  if (req.method === 'GET' && url === '/status') {
    res.writeHead(200);
    res.end(JSON.stringify({ running: isRunning, lastRun }));
    return;
  }

  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'actual-sync', running: isRunning }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, () => {
  console.log('═══════════════════════════════════════════');
  console.log('  actual-sync service started');
  console.log(`  Listening on :${PORT}`);
  console.log(`  Nightly run: ${NIGHTLY_HHMM || '(disabled)'} ${TZ}`);
  console.log('═══════════════════════════════════════════');
});

// Built-in nightly scheduler — checks every 30s whether we've crossed the
// configured HH:MM in the local timezone, runs once per day.
let lastScheduledDate = null;
if (NIGHTLY_HHMM) {
  setInterval(() => {
    const localDate = todayStringInTZ(); // YYYY-MM-DD
    const hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date());
    if (hhmm === NIGHTLY_HHMM && lastScheduledDate !== localDate) {
      lastScheduledDate = localDate;
      runSync('nightly-schedule');
    }
  }, 30 * 1000);
}

// Optionally run once on startup if RUN_ON_START=true
if (process.env.RUN_ON_START === 'true') {
  runSync('startup');
}
