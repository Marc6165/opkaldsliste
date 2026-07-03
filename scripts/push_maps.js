// Push phone->contact and email->contact maps to the Worker so SMS/email replies auto-match.
// Non-fatal: logs and exits 0 on any problem so it never breaks the build.
const ORG = process.env.BILLY_ORG_ID, TOKEN = process.env.BILLY_TOKEN;
const WURL = process.env.WORKER_URL, SEC = process.env.APP_SECRET;
if (!ORG || !TOKEN || !WURL || !SEC) { console.log("push_maps: missing env, skipping"); process.exit(0); }

async function api(path) {
  const r = await fetch("https://api.billysbilling.com" + path, { headers: { "X-Access-Token": TOKEN } });
  if (!r.ok) throw new Error("Billy " + r.status); return r.json();
}
async function pages(path, key) {
  let out = [], p = 1;
  while (p <= 20) {
    let r; try { r = await api(path + `&page=${p}`); } catch (e) { break; }
    const b = r[key] || []; out = out.concat(b);
    const pc = (r.meta && r.meta.paging && r.meta.paging.pageCount) || 1;
    if (!b.length || pc <= p) break; p++;
  }
  return out;
}
(async () => {
  const contacts = await pages(`/v2/contacts?organizationId=${ORG}&pageSize=1000`, "contacts");
  const phonemap = {}, emailmap = {};
  for (const c of contacts) { const d = String(c.phone || "").replace(/\D/g, ""); if (d.length === 8) phonemap[d] = c.id; }
  // emailmap: only for customers with open invoices (those who could get an email rykker + reply)
  const open = await pages(`/v2/invoices?organizationId=${ORG}&pageSize=1000&state%5B%5D=approved&isPaid=false&sortProperty=entryDate&sortDirection=DESC`, "invoices");
  const cids = [...new Set(open.map(i => i.contactId))];
  const pool = 8;
  for (let i = 0; i < cids.length; i += pool) {
    await Promise.all(cids.slice(i, i + pool).map(async cid => {
      try {
        const r = await api(`/v2/contactPersons?contactId=${cid}`);
        for (const p of (r.contactPersons || [])) if (p.email) emailmap[String(p.email).toLowerCase()] = cid;
      } catch (e) {}
    }));
  }
  const r = await fetch(WURL + "/maps", {
    method: "POST", headers: { "Authorization": "Bearer " + SEC, "Content-Type": "application/json" },
    body: JSON.stringify({ phonemap, emailmap }),
  });
  console.log(`push_maps: HTTP ${r.status} · ${Object.keys(phonemap).length} phones · ${Object.keys(emailmap).length} emails`);
})().catch(e => { console.log("push_maps failed (non-fatal):", e.message); process.exit(0); });
