// Rykker preview engine (READ-ONLY) + reconciliation brain, ported from the validated Python.
// Produces the "Rykkere" tab HTML for the app. Sends nothing, changes nothing in Billy.
const ORG = process.env.BILLY_ORG_ID;
const TOKEN = process.env.BILLY_TOKEN;
const BANK_ACCOUNT = process.env.BANK_ACCOUNT_ID || "19BAWJlST0C2wW4nASsalg"; // Frørup Andelskasse
const GAP = 10, GRACE = 7;

async function api(path){
  const r = await fetch("https://api.billysbilling.com"+path, {headers:{"X-Access-Token":TOKEN}});
  if(!r.ok) throw new Error("Billy "+r.status+" "+path.slice(0,60));
  return r.json();
}
async function pages(path, key, maxPages=12){
  let out=[], p=1;
  while(p<=maxPages){
    let r; try{ r=await api(path+`&page=${p}`); }catch(e){ break; }
    const b=r[key]||[]; out=out.concat(b);
    const pc=(r.meta&&r.meta.paging&&r.meta.paging.pageCount)||1;
    if(b.length===0 || pc<=p) break;
    p++;
  }
  return out;
}
const round2 = x => Math.round(x*100)/100;
const nbsp = s => (s||"").replace(/ /g," ").replace(/\s+/g," ").trim();
function dk(x){ const n=x<0; x=Math.abs(x); const [i,f]=x.toFixed(2).split(".");
  return (n?"-":"")+i.replace(/\B(?=(\d{3})+(?!\d))/g,".")+","+f; }
const esc = s => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
function toDate(s){ if(!s) return null; const [y,m,d]=s.slice(0,10).split("-"); return new Date(+y,+m-1,+d); }
const dayDiff = (a,b)=>Math.round((a-b)/86400000);
function phone(p){ const x=(p||"").replace(/\D/g,""); return x.length===8?`${x.slice(0,2)} ${x.slice(2,4)} ${x.slice(4,6)} ${x.slice(6,8)}`:(p||"").trim(); }

// --- learn payer -> customer from Billy's own reconciliation notes ---
async function learnMap(){
  const posts = await pages(`/v2/postings?accountId=${BANK_ACCOUNT}&pageSize=500&sortProperty=entryDate&sortDirection=DESC`,"postings",6);
  const lines = await pages(`/v2/bankLines?accountId=${BANK_ACCOUNT}&pageSize=400&sortProperty=entryDate&sortDirection=DESC`,"bankLines",6);
  const payerAt = {};                       // "amt|date" -> [descriptions]
  for(const x of lines){ if(x.side==="debit"){ const k=round2(x.amount)+"|"+x.entryDate; (payerAt[k]=payerAt[k]||[]).push((x.description||"").trim()); } }
  const rx=/[Bb]etalt af (.+?) for faktura(?:er)? ([\d,\s]+)/;
  const reconciled=new Set();               // "amt|date" already applied
  const learn={};                           // payer -> {customer: count}
  for(const p of posts){
    const m=(p.text||"").match(rx); if(!m) continue;
    const k=round2(p.amount)+"|"+p.entryDate; reconciled.add(k);
    for(const d of (payerAt[k]||[])){
      const pn=d.replace(/^MobilePay /,"").trim().toLowerCase();
      if(!pn || /^(overførsel|overførelse|indbetaling|kortbetaling)$/.test(pn)) continue;
      (learn[pn]=learn[pn]||{}); learn[pn][m[1].trim()]=(learn[pn][m[1].trim()]||0)+1;
    }
  }
  const name2cust={};
  for(const pn in learn){ const cs=Object.keys(learn[pn]); if(cs.length===1) name2cust[pn]=cs[0]; }
  return { name2cust, reconciled, lines, mapSize:Object.keys(name2cust).length };
}

// --- flag open invoices that actually look already paid (exclude from dunning) ---
function reconExclude(invs, contacts, brain){
  const excluded=new Set(); const flagged=[];
  const unmatched=brain.lines.filter(x=>x.side==="debit" && !brain.reconciled.has(round2(x.amount)+"|"+x.entryDate));
  const byAmt={}; for(const iv of invs){ (byAmt[round2(iv.balance)]=byAmt[round2(iv.balance)]||[]).push(iv);
                                          (byAmt[round2(iv.grossAmount)]=byAmt[round2(iv.grossAmount)]||[]).push(iv); }
  for(const x of unmatched){
    const desc=x.description||""; let hit=null, why=null;
    for(const iv of invs){ const re=new RegExp("(?<!\\d)"+iv.invoiceNo+"(?!\\d)"); if(re.test(desc)){ hit=iv; why="fakturanr i betaling"; break; } }
    if(!hit){ const pn=desc.replace(/^MobilePay /,"").trim().toLowerCase(); const cust=brain.name2cust[pn];
      if(cust){ for(const iv of (byAmt[round2(x.amount)]||[])){ if(nbsp((contacts[iv.contactId]||{}).name)===nbsp(cust)){ hit=iv; why=`kendt betaler → ${cust}`; break; } } } }
    if(hit && !excluded.has(hit.invoiceNo)){ excluded.add(hit.invoiceNo); flagged.push({iv:hit,c:contacts[hit.contactId]||{},x,why}); }
  }
  return { excluded, flagged };
}

const STEPS=["Påmindelse","Rykker 1","Rykker 2","Rykker 3","Klar til inkasso"];

async function computeDue(){
  const now=new Date(); const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const yearStart=`${today.getFullYear()}-01-01`;
  const res=await api(`/v2/invoices?organizationId=${ORG}&include=invoice.contact&pageSize=1000&state%5B%5D=approved&isPaid=false&sortDirection=DESC&sortProperty=entryDate`);
  const contacts={}; (res.contacts||[]).forEach(c=>contacts[c.id]=c);
  let invs=(res.invoices||[]).filter(iv=>(iv.entryDate||"")>=yearStart);

  let brain={name2cust:{},reconciled:new Set(),lines:[],mapSize:0}, exc={excluded:new Set(),flagged:[]};
  try{ brain=await learnMap(); exc=reconExclude(invs, contacts, brain); }catch(e){ /* recon optional; never blocks preview */ }

  const rems=await pages(`/v2/invoiceReminders?organizationId=${ORG}&pageSize=1000`,"invoiceReminders");
  const remByC={}; rems.forEach(r=>{ (remByC[r.contactId]=remByC[r.contactId]||[]).push(r); });

  const overdue=invs.filter(iv=>{ const dd=toDate(iv.dueDate); return dd && dd<today && !exc.excluded.has(iv.invoiceNo); });
  const byC={}; overdue.forEach(iv=>{ (byC[iv.contactId]=byC[iv.contactId]||[]).push(iv); });

  const buckets=[[],[],[],[],[]]; let waiting=0;
  for(const cid in byC){
    const items=byC[cid], c=contacts[cid]||{};
    const cycleStart=items.reduce((m,iv)=>{ const d=toDate(iv.dueDate); return (!m||d<m)?d:m; }, null);
    const cyc=(remByC[cid]||[]).filter(r=>toDate(r.createdTime)>=cycleStart);
    const nFee=cyc.filter(r=>(r.flatFee||0)>0).length;
    const last=cyc.reduce((m,r)=>{ const d=toDate(r.createdTime); return (!m||d>m)?d:m; }, null);
    let nxt; if(cyc.length===0) nxt=0; else if(nFee===0) nxt=1; else if(nFee===1) nxt=2; else if(nFee===2) nxt=3; else nxt=4;
    const daysOver=dayDiff(today,cycleStart);
    const rec={ cid, name:nbsp(c.name)||"(ukendt)", phone:phone(c.phone), n:items.length,
                total:items.reduce((s,iv)=>s+iv.balance,0), days:daysOver, last,
                invs:items.map(iv=>iv.invoiceNo), contactPersonId:c.attContactPersonId||null };
    if(nxt===0){ if(daysOver>=GRACE) buckets[0].push(rec); else waiting++; }
    else if(last && dayDiff(today,last)<GAP) waiting++;
    else buckets[nxt].push(rec);
  }
  buckets.forEach(b=>b.sort((a,b)=>b.total-a.total));
  const feeTotal = 50*(buckets[1].length+buckets[2].length+buckets[3].length);
  const dueCount = buckets.reduce((s,b)=>s+b.length,0);
  const stamp = `${String(today.getDate()).padStart(2,"0")}.${String(today.getMonth()+1).padStart(2,"0")}.${today.getFullYear()}`;
  return { buckets, contacts, waiting, exc, brain, feeTotal, dueCount, stamp, today, STEPS };
}

async function buildRykker(){
  const { buckets, waiting, exc, brain, feeTotal, dueCount, stamp } = await computeDue();
  // ---- render tab HTML ----
  let html = `<div class="ry-note">📋 Forhåndsvisning pr. ${stamp} — <b>der sendes intet</b>. Kun kunder med gæld fra i år, mindst ${GRACE} dage forfalden.</div>`;
  html += `<div class="ry-sum">`;
  const feeLbl=(s)=> (s>=1&&s<=3)?` · 50 kr`:(s===4?` · manuel`:``);
  for(let s=0;s<5;s++){ html+=`<div class="ry-chip s${s}"><span class="k">${STEPS[s]}${feeLbl(s)}</span><span class="v">${buckets[s].length}</span></div>`; }
  html += `</div><div class="ry-meta">${dueCount} kunder klar i dag · ${dk(feeTotal)} kr i gebyrer hvis alt godkendes · ${waiting} venter (under ${GAP} dage)`;
  if(exc.flagged.length) html+=` · <span class="ry-paid">${exc.flagged.length} muligvis betalt (udeladt)</span>`;
  html += `</div>`;
  for(let s=0;s<5;s++){
    const B=buckets[s]; if(!B.length) continue;
    html+=`<div class="ry-sec"><div class="ry-h s${s}">${STEPS[s]}${s===4?" — overgiv manuelt til inkasso":""} <span class="ry-n">${B.length}</span></div>`;
    for(const r of B){
      const last=r.last?`${String(r.last.getDate()).padStart(2,"0")}.${String(r.last.getMonth()+1).padStart(2,"0")}`:"aldrig";
      html+=`<div class="ry-row"><div class="ry-who"><span class="ry-name">${esc(r.name)}</span>`
          +`<span class="ry-sub">${r.phone?esc(r.phone)+" · ":""}${r.n} fakt · ${r.days} dage · sidst: ${last}</span></div>`
          +`<div class="ry-amt">${dk(r.total)} kr</div></div>`;
    }
    html+=`</div>`;
  }
  if(exc.flagged.length){
    html+=`<div class="ry-sec"><div class="ry-h paid">Muligvis betalt — tjek i Billy <span class="ry-n">${exc.flagged.length}</span></div>`;
    for(const f of exc.flagged){ html+=`<div class="ry-row"><div class="ry-who"><span class="ry-name">${esc(nbsp(f.c.name))}</span>`
      +`<span class="ry-sub">#${f.iv.invoiceNo} · ${esc(f.why)} · ${f.x.entryDate}</span></div><div class="ry-amt">${dk(f.iv.balance)} kr</div></div>`; }
    html+=`</div>`;
  }
  return { rykkerHTML: html, rykkerSummary: { due:dueCount, fee:feeTotal, mapSize:brain.mapSize, flagged:exc.flagged.length } };
}
module.exports = { buildRykker, computeDue, STEPS };
