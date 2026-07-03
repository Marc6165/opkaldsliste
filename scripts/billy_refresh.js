#!/usr/bin/env node
/* Weekly refresh: pull overdue+unpaid invoices (older than 2 months) from Billy,
   rebuild the encrypted call list, write ../index.html. All secrets come from env. */
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const { buildRykker } = require('./rykker');

const TOKEN    = process.env.BILLY_TOKEN;
const ORG      = process.env.BILLY_ORG_ID;
const PASSWORD = process.env.UNLOCK_PASSWORD;
const MOBILEPAY= process.env.MOBILEPAY || '22330482';
const MONTHS   = parseInt(process.env.AGE_MONTHS || '2', 10);
const ITER     = 600000;
if (!TOKEN || !ORG || !PASSWORD) { console.error('Missing BILLY_TOKEN / BILLY_ORG_ID / UNLOCK_PASSWORD'); process.exit(1); }

const round2 = x => Math.round(x * 100) / 100;
const nbsp = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
function dk(x){ const neg = x < 0; x = Math.abs(x); const [i,f] = x.toFixed(2).split('.');
  return (neg?'-':'') + i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + f; }
function d2(iso){ const [y,m,d] = iso.split('-'); return { disp:`${d}.${m}.${y}`, date:new Date(+y,+m-1,+d) }; }
const digits = p => (p || '').replace(/\D/g, '');
const phoneDisp = p => { const d = digits(p); return d.length===8 ? `${d.slice(0,2)} ${d.slice(2,4)} ${d.slice(4,6)} ${d.slice(6,8)}` : (p||'').trim(); };
const phoneTel  = p => { const d = digits(p); return d.length===8 ? '+45'+d : (d?'+'+d:''); };
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const escAttr = s => esc(s).replace(/"/g,'&quot;');

const PHONE_SVG = '<svg viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.4 0 .8-.2 1l-2.3 2.2z"/></svg>';
const SMS_SVG   = '<svg viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v9c0 1.1-.9 2-2 2H8l-4 4V6c0-1.1.9-2 2-2zm3 5v2h2V9H7zm4 0v2h2V9h-2zm4 0v2h2V9h-2z"/></svg>';

function smsBody(name, items, total){
  const intro = name ? `Hej ${name}\n\n` : 'Hej\n\n';
  const n = items.length;
  const head = n===1 ? 'Du har en ubetalt regning hos Sands Vinduespudsning:'
                     : `Du har ${n} ubetalte regninger hos Sands Vinduespudsning:`;
  const rows = items.map(i => { const { disp:ds } = d2(i.dueDate);
    const partial = round2(i.balance) < round2(i.grossAmount) - 0.01;
    return `- Faktura ${i.invoiceNo}: ${dk(i.balance)} kr${partial?' (restbeløb)':''} (forfaldt ${ds})`; });
  const nos = items.map(i => i.invoiceNo).join(', ');
  const tail = `\n\nI alt ${dk(total)} kr inkl. moms.\n\nBetal via MobilePay til ${MOBILEPAY}. `
    + `HUSK at skrive fakturanummer ${nos} i kommentarfeltet, så vi kan se hvad betalingen dækker.\n\n`
    + `Har du allerede betalt, så se venligst bort fra denne besked.\n\nMange tak\nSands Vinduespudsning`;
  return intro + head + '\n' + rows.join('\n') + tail;
}

async function main(){
  const url = `https://api.billysbilling.com/v2/invoices?organizationId=${ORG}`
    + `&include=invoice.contact&pageSize=1000&state%5B%5D=approved&isOverdue=true&isPaid=false`
    + `&sortDirection=DESC&sortProperty=entryDate`;
  const res = await fetch(url, { headers: { 'X-Access-Token': TOKEN } });
  if (!res.ok) throw new Error('Billy API HTTP ' + res.status);
  const data = await res.json();
  if (!Array.isArray(data.invoices)) throw new Error('Unexpected Billy response');
  const contacts = {}; (data.contacts || []).forEach(c => contacts[c.id] = c);

  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cut = new Date(today0); cut.setMonth(cut.getMonth() - MONTHS);
  const cutISO = cut.toISOString().slice(0,10);
  // this-year-only: entryDate on/after Jan 1 of the current year (override with FROM_DATE=YYYY-MM-DD)
  const fromDate = process.env.FROM_DATE || `${today0.getFullYear()}-01-01`;
  const inv = data.invoices.filter(i => i.entryDate >= fromDate && i.entryDate < cutISO);

  const byC = {};
  inv.forEach(i => { (byC[i.contactId] = byC[i.contactId] || []).push(i); });
  const custs = Object.entries(byC).map(([cid, items]) => {
    items.sort((a,b) => a.dueDate < b.dueDate ? -1 : 1);
    const bal  = items.reduce((s,i) => s + i.balance, 0);
    const days = Math.max(...items.map(i => Math.round((today0 - d2(i.dueDate).date) / 86400000)));
    return { contact: contacts[cid] || {}, items, bal, days };
  });
  custs.sort((a,b) => (b.bal - a.bal) || (b.days - a.days));

  const cards = custs.map((c, k) => {
    const idx = k + 1, ct = c.contact;
    const lines = c.items.map(i => {
      const { disp:es } = d2(i.entryDate); const { disp:ds, date:dd } = d2(i.dueDate);
      const od = Math.round((today0 - dd) / 86400000);
      const partial = round2(i.balance) < round2(i.grossAmount) - 0.01;
      const fee     = round2(i.balance) > round2(i.grossAmount) + 0.01;
      let banner = '';
      if (partial) banner = `<div class="banner part"><span class="ic">⚠️</span><span>Opkræv KUN ${dk(i.balance)} kr &mdash; kunden har allerede betalt ${dk(i.grossAmount - i.balance)} kr af ${dk(i.grossAmount)} kr.</span></div>`;
      else if (fee) banner = `<div class="banner fee"><span class="ic">ℹ️</span><span>Beløbet indeholder et rykkergebyr på ${dk(i.balance - i.grossAmount)} kr.</span></div>`;
      return `<li class="line"><div class="lrow"><span class="fak">#${i.invoiceNo}</span>`
        + `<span class="lamt">${dk(i.balance)} kr</span></div>`
        + `<div class="ldesc">${esc(nbsp(i.lineDescription))}</div>`
        + `<div class="lmeta">Faktura ${es} &middot; forfaldt ${ds} &middot; ${od} dage siden</div>${banner}</li>`;
    }).join('');
    const disp = phoneDisp(ct.phone), tel = phoneTel(ct.phone);
    const nm = nbsp(ct.name) || '(ukendt kunde)';
    let actions;
    if (disp) {
      const msgAttr = escAttr(smsBody(nbsp(ct.name), c.items, c.bal)).replace(/\n/g, '&#10;');
      actions = `<div class="actions">`
        + `<a class="act call" href="tel:${tel}">${PHONE_SVG}<span class="cn"><small>Ring op</small>${disp}</span></a>`
        + `<button type="button" class="act sms" data-phone="${tel}" data-disp="${disp}" data-name="${escAttr(nbsp(ct.name))}" data-msg="${msgAttr}">${SMS_SVG}<span class="cn"><small>Send</small>SMS</span></button>`
        + `</div>`;
    } else { actions = '<div class="nocall">⚠️ Intet telefonnummer i Billy</div>'; }
    const loc = [nbsp(ct.zipcodeText), nbsp(ct.cityText)].filter(Boolean).join(' ');
    const plural = c.items.length === 1 ? '1 faktura' : `${c.items.length} fakturaer`;
    return `<article class="card" data-bal="${c.bal.toFixed(2)}" id="c${idx}">`
      + `<div class="top"><div class="rank">${idx}</div>`
      + `<div class="who"><h2>${esc(nm)}</h2><div class="loc">${loc ? esc(loc)+' &middot; ' : ''}${plural}</div></div>`
      + `<div class="pricebox"><div class="amt">${dk(c.bal)} <span class="cur">kr</span></div><div class="sub">inkl. moms</div></div></div>`
      + `${actions}<ul class="lines">${lines}</ul>`
      + `<button class="done" aria-pressed="false"><span class="chk"></span><span class="txt"></span></button></article>`;
  }).join('');

  const grandBal = custs.reduce((s,c) => s + c.bal, 0);
  const stamp = `${String(today0.getDate()).padStart(2,'0')}.${String(today0.getMonth()+1).padStart(2,'0')}.${today0.getFullYear()}`;

  // rykker preview (read-only; never blocks the call list if it fails)
  let rk = { rykkerHTML: '', rykkerSummary: {} };
  try { rk = await buildRykker(); console.log(`rykker preview: ${rk.rykkerSummary.due} due, map ${rk.rykkerSummary.mapSize}`); }
  catch (e) { console.error('rykker preview skipped:', e.message); }

  const payload = JSON.stringify({ cardsHTML: cards, nCust: custs.length, nInv: inv.length, grandBal: dk(grandBal), stamp,
                                   rykkerHTML: rk.rykkerHTML, rykkerSummary: rk.rykkerSummary, rykkerItems: rk.rykkerItems || [],
                                   workerUrl: process.env.WORKER_URL || '', appSecret: process.env.APP_SECRET || '' });

  // encrypt (AES-256-GCM, PBKDF2-SHA256) — WebCrypto compatible
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(PASSWORD, salt, ITER, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const blob = Buffer.concat([c.update(Buffer.from(payload,'utf8')), c.final(), c.getAuthTag()]);

  let html = fs.readFileSync(path.join(__dirname, '_secure_template.html'), 'utf8');
  html = html.replace('__SALT__', salt.toString('base64'))
             .replace('__IV__', iv.toString('base64'))
             .replace('__CT__', blob.toString('base64'))
             .replace('__ITER__', String(ITER));
  fs.writeFileSync(path.join(__dirname, '..', 'index.html'), html);
  console.log(`OK: ${custs.length} customers, ${inv.length} invoices (older than ${MONTHS} months), ${dk(grandBal)} kr → index.html`);
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
