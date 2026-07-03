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
  const phonemap = {}, emailmap = {}, namemap = {};
  for (const c of contacts) {
    const d = String(c.phone || "").replace(/\D/g, ""); if (d.length === 8) phonemap[d] = c.id;
    namemap[c.id] = (c.name || "").replace(/ /g, " ").trim();
  }
  // emailmap: for ALL customers (any can go overdue later)
  const cids = contacts.filter(c => c.isCustomer !== false).map(c => c.id);
  const personsOf = async cid => {
    for (let t = 0; t < 4; t++) {
      try { const r = await api(`/v2/contactPersons?contactId=${cid}`); return r.contactPersons || []; }
      catch (e) { await new Promise(r => setTimeout(r, 300 * (t + 1))); }
    }
    return null; // failed after retries
  };
  const pool = 5; let failed = 0;
  for (let i = 0; i < cids.length; i += pool) {
    await Promise.all(cids.slice(i, i + pool).map(async cid => {
      const ps = await personsOf(cid);
      if (ps === null) { failed++; return; }
      for (const p of ps) if (p.email) emailmap[String(p.email).toLowerCase()] = cid;
    }));
  }
  if (failed) console.log(`push_maps: ${failed} contact-person lookups failed after retries`);
  const r = await fetch(WURL + "/maps", {
    method: "POST", headers: { "Authorization": "Bearer " + SEC, "Content-Type": "application/json" },
    body: JSON.stringify({ phonemap, emailmap, namemap }),
  });
  console.log(`push_maps: HTTP ${r.status} · ${Object.keys(phonemap).length} phones · ${Object.keys(emailmap).length} emails · ${Object.keys(namemap).length} names`);
})().catch(e => { console.log("push_maps failed (non-fatal):", e.message); process.exit(0); });
