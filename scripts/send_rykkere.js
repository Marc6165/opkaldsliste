// Rykker SENDER. DRY-RUN by default — builds the exact Billy payloads and logs them.
// Only performs real sends when run with SEND=CONFIRM (and never for held/disputed contacts).
//   node scripts/send_rykkere.js            -> dry run (safe, sends nothing)
//   SEND=CONFIRM node scripts/send_rykkere.js  -> live send (charges fees, emails customers)
const { computeDue } = require('./rykker');
const fs = require('fs'), path = require('path');

const ORG = process.env.BILLY_ORG_ID, TOKEN = process.env.BILLY_TOKEN;
const MOBILEPAY = process.env.MOBILEPAY || '22330482';
const LIVE = process.env.SEND === 'CONFIRM';
const ONLY_STEP = process.env.ONLY_STEP ? parseInt(process.env.ONLY_STEP,10) : null;   // e.g. 0 = only påmindelser
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT,10) : Infinity;            // safety cap per run
const TEST_CONTACT = process.env.TEST_CONTACT || null;   // send everything to this one contactId instead (validation)

// hold / dispute store (contactIds that must never be dunned automatically)
function loadHolds(){
  try { return new Set(JSON.parse(fs.readFileSync(path.join(__dirname,'..','holds.json'),'utf8')).held||[]); }
  catch(e){ return new Set(); }
}

const dk = x => (x<0?'-':'')+Math.abs(x).toFixed(2).replace('.',',').replace(/\B(?=(\d{3})+(?!\d))/g,'.');

// per-step email/message text (Billy attaches the customer's overdue invoices as a PDF)
function texts(step, rec){
  const link = 'betalingslinket i denne mail'; // Billy inserts the invoice/payment link
  const base = `Betal nemt via ${link} eller på MobilePay til ${MOBILEPAY} (husk fakturanummer i kommentaren).`;
  if (step === 0) return {
    subject: 'Venlig påmindelse om betaling – Sands Vinduespudsning',
    body: `Hej,\n\nVi kan se, at der står ${dk(rec.total)} kr til betaling på din konto hos Sands Vinduespudsning (se vedhæftede).\n${base}\n\nHar du allerede betalt, så se venligst bort fra denne besked.\n\nMange tak\nSands Vinduespudsning`,
  };
  const n = step; // 1..3
  return {
    subject: `Rykker ${n} for manglende betaling – Sands Vinduespudsning`,
    body: `Hej,\n\nVi mangler fortsat betaling på i alt ${dk(rec.total)} kr (se vedhæftede rykker). Der er tilskrevet et rykkergebyr på 50 kr.\n${base}\n\nBetal venligst hurtigst muligt for at undgå yderligere gebyrer${n>=3?' og overgivelse til inkasso':''}.\nHar du allerede betalt, så se bort fra denne besked.\n\nMvh Sands Vinduespudsning`,
  };
}

async function billyPost(payload){
  const r = await fetch('https://api.billysbilling.com/v2/invoiceReminders', {
    method:'POST', headers:{'X-Access-Token':TOKEN,'Content-Type':'application/json'},
    body: JSON.stringify({ invoiceReminder: payload }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('Billy '+r.status+': '+t.slice(0,200));
  return JSON.parse(t);
}

(async () => {
  if (!ORG || !TOKEN) { console.error('missing BILLY_ORG_ID / BILLY_TOKEN'); process.exit(1); }
  const holds = loadHolds();
  const D = await computeDue();
  console.log(`\n${LIVE ? '🔴 LIVE SEND' : '🟢 DRY RUN (sends nothing)'} — ${D.stamp}   holds: ${holds.size}\n`);

  const plan = [];
  for (let step = 0; step <= 3; step++) {
    if (ONLY_STEP !== null && step !== ONLY_STEP) continue;
    for (const rec of D.buckets[step]) {
      if (holds.has(rec.cid)) { console.log(`  ⏸  HOLD/dispute — skip ${rec.name}`); continue; }
      plan.push({ step, rec });
    }
  }
  const toDo = plan.slice(0, LIMIT);
  let fee = 0, sent = 0, failed = 0;
  for (const { step, rec } of toDo) {
    const t = texts(step, rec);
    const flatFee = step >= 1 ? 50 : 0; fee += flatFee;
    const payload = {
      organizationId: ORG,
      contactId: TEST_CONTACT || rec.cid,
      flatFee, percentageFee: 0, feeCurrencyId: 'DKK', sendEmail: true,
      emailSubject: t.subject, emailBody: t.body, message: t.body,
      ...(rec.contactPersonId ? { contactPersonId: rec.contactPersonId } : {}),
    };
    const label = `${D.STEPS[step]}  ${rec.name}  (${dk(rec.total)} kr, fakt ${rec.invs.join(',')})  gebyr ${flatFee} kr`;
    if (!LIVE) { console.log('  WOULD SEND →', label); continue; }
    try { await billyPost(payload); sent++; console.log('  ✅ SENDT →', label); }
    catch (e) { failed++; console.log('  ❌ FEJL  →', label, '\n       ', e.message); }
  }
  console.log(`\n${LIVE ? 'Sendt' : 'Ville sende'}: ${toDo.length} rykkere · ${fee} kr i gebyrer` +
              (LIVE ? ` · ok ${sent}, fejl ${failed}` : '') + `${plan.length>toDo.length?` · (${plan.length-toDo.length} tilbage over LIMIT)`:''}`);
  if (!LIVE) console.log('DRY RUN — intet er sendt eller ændret i Billy. Kør med SEND=CONFIRM for at sende rigtigt.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
