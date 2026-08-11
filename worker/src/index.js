/**
 * Rykker backend (Cloudflare Worker). Holds the Billy token, sends approved rykkere,
 * stores holds/disputes in KV, and auto-holds on inbound SMS / Gmail replies.
 *
 * Bindings (wrangler.toml / dashboard):
 *   KV namespace:  RYKKER            (holds, phonemap, inbox)
 *   Vars:          BILLY_ORG_ID, TEST_CONTACT (optional), APP_ORIGIN
 *   Secrets:       BILLY_TOKEN, APP_SECRET, SMS_WEBHOOK_TOKEN
 */
import shared from "../../scripts/email.js";
const { buildEmail, GAP_DAYS } = shared;
const COOLDOWN_MS = GAP_DAYS * 86400000;   // an invoice can't be reminded again within this

const j = (o, s = 200, cors) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function getHolds(env) { return (await env.RYKKER.get("holds", "json")) || {}; }
async function putHolds(env, h) { await env.RYKKER.put("holds", JSON.stringify(h)); }

// Invoice-level holds, keyed by Billy invoiceId. Separate from contact holds because a
// customer can owe on several invoices and only one of them may be disputed or paid —
// pausing the whole customer would silence the rest too.
async function getInvHolds(env) { return (await env.RYKKER.get("invholds", "json")) || {}; }
async function putInvHolds(env, h) { await env.RYKKER.put("invholds", JSON.stringify(h)); }

async function hold(env, contactId, reason, meta) {
  const h = await getHolds(env);
  h[contactId] = { reason: reason || "manual", ts: Date.now(), ...(meta || {}) };
  await putHolds(env, h); return h;
}

// Work out what a reminder actually covers once invoice holds are applied, and rebuild the
// mail if that changed the set — the previewed subject/body were written before the hold
// existed, and the app's copy of them can be a week old. Returns null if nothing is left.
// Pure, so the outgoing mail can be tested without sending it.
export function planSend(it, invHolds) {
  const all = it.lines || (it.invoiceIds || []).map((id) => ({ id }));
  const lines = all.filter((l) => !invHolds[l.id]);
  if (!lines.length) return null;
  const invoiceIds = lines.map((l) => l.id);
  // Rebuild the mail fresh whenever we have the invoice lines: it reflects any held
  // invoices AND recomputes the Rykker 3 inkassovarsel deadline from the actual send date,
  // not the up-to-a-week-old weekly preview (a stale deadline could give under 10 days'
  // notice). Only an old cached page that never shipped `lines` falls back to previewed text.
  if (!it.lines)
    return { invoiceIds, subject: it.subject, body: it.body, message: it.message };
  const em = buildEmail(it.step, lines, it.cname || it.name, it.flatFee || 0);
  return { invoiceIds, subject: em.subject, body: em.body, message: em.message };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname;
    const cors = {
      "Access-Control-Allow-Origin": env.APP_ORIGIN || "*",
      "Access-Control-Allow-Headers": "Authorization,Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    // --- inbound SMS reply (GatewayAPI webhook) -> auto-hold. Authed by ?token= ---
    if (path === "/sms-inbound" && req.method === "POST") {
      if (url.searchParams.get("token") !== env.SMS_WEBHOOK_TOKEN) return j({ error: "bad token" }, 401, cors);
      const body = await req.json().catch(() => ({}));
      const msisdn = String(body.msisdn || body.sender || "").replace(/\D/g, "").slice(-8);
      const text = body.message || body.text || "";
      const phonemap = (await env.RYKKER.get("phonemap", "json")) || {};
      const contactId = phonemap[msisdn];
      const inbox = (await env.RYKKER.get("inbox", "json")) || [];
      inbox.unshift({ ch: "sms", msisdn, text, contactId: contactId || null, ts: Date.now() });
      await env.RYKKER.put("inbox", JSON.stringify(inbox.slice(0, 200)));
      if (contactId) await hold(env, contactId, "sms-svar", { text, channel: "sms" });
      return j({ ok: true, matched: !!contactId }, 200, cors);
    }

    // --- inbound EMAIL reply (Gmail Apps Script webhook) -> auto-hold. Authed by ?token= ---
    if (path === "/email-inbound" && req.method === "POST") {
      if (url.searchParams.get("token") !== env.EMAIL_WEBHOOK_TOKEN) return j({ error: "bad token" }, 401, cors);
      const b = await req.json().catch(() => ({}));
      const from = String(b.from || "");
      const email = (from.match(/[\w.+-]+@[\w.-]+/) || [""])[0].toLowerCase();
      const emailmap = (await env.RYKKER.get("emailmap", "json")) || {};
      const contactId = emailmap[email];
      const inbox = (await env.RYKKER.get("inbox", "json")) || [];
      inbox.unshift({ ch: "email", from, email, subject: b.subject || "", text: (b.text || "").slice(0, 500), contactId: contactId || null, ts: Date.now() });
      await env.RYKKER.put("inbox", JSON.stringify(inbox.slice(0, 200)));
      if (contactId) await hold(env, contactId, "email-svar", { text: (b.text || "").slice(0, 300), from });
      return j({ ok: true, matched: !!contactId }, 200, cors);
    }

    // --- serve the app itself (public: the payload is client-side encrypted, same as
    //     it was on GitHub Pages). Lets us publish without depending on the Pages deploy,
    //     which jams. no-cache so a fresh publish is picked up on the next load. ---
    if ((path === "/" || path === "/app" || path === "/index.html") && req.method === "GET") {
      const html = await env.RYKKER.get("apphtml");
      if (!html) return new Response("Endnu ikke publiceret.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }

    // --- everything else needs the app secret ---
    if ((req.headers.get("Authorization") || "") !== "Bearer " + env.APP_SECRET)
      return j({ error: "unauthorized" }, 401, cors);

    // publish a freshly built index.html (posted by the refresh Action). Body = raw HTML.
    if (path === "/publish" && req.method === "POST") {
      const html = await req.text();
      if (!html || html.length < 1000) return j({ error: "empty or too small" }, 400, cors);
      await env.RYKKER.put("apphtml", html);
      await env.RYKKER.put("pubts", String(Date.now()));   // publish marker the app polls after "Opdater fra Billy"
      return j({ ok: true, bytes: html.length }, 200, cors);
    }

    // trigger a fresh Billy rebuild from the app's "Opdater fra Billy" button: dispatch the
    // GitHub Actions workflow, which reruns billy_refresh.js and re-POSTs the rebuilt index.html
    // to /publish (bumping pubts). The app then polls /state's pubts and reloads once it changes.
    // Needs GH_DISPATCH_TOKEN (a token with actions:write on the repo) — set via
    // `wrangler secret put GH_DISPATCH_TOKEN`.
    if (path === "/refresh" && req.method === "POST") {
      if (!env.GH_DISPATCH_TOKEN) return j({ error: "no-gh-token" }, 500, cors);
      const repo = env.GH_REPO || "Marc6165/opkaldsliste";
      const wf = env.GH_WORKFLOW || "refresh.yml";
      const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${wf}/dispatches`, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + env.GH_DISPATCH_TOKEN,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "sands-rykker",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: env.GH_BRANCH || "main" }),
      });
      if (r.status === 204) return j({ ok: true }, 200, cors);   // GitHub returns 204 on success
      const t = await r.text().catch(() => "");
      return j({ ok: false, status: r.status, error: t.slice(0, 200) }, 502, cors);
    }

    if (path === "/state") {
      const holds = await getHolds(env);
      const inbox = (await env.RYKKER.get("inbox", "json")) || [];
      const names = (await env.RYKKER.get("namemap", "json")) || {};
      const heldOut = {};
      for (const cid in holds) heldOut[cid] = { ...holds[cid], name: names[cid] || null };
      const inboxOut = inbox.slice(0, 50).map(x => ({ ...x, name: x.contactId ? (names[x.contactId] || null) : null }));
      // `sent` is the per-invoice dunning history the weekly refresh reads back to work
      // out each invoice's step — Billy cannot tell us which invoice a reminder was for.
      return j({ holds: heldOut, invHolds: await getInvHolds(env), inbox: inboxOut,
                 sent: (await env.RYKKER.get("sent", "json")) || [],
                 pubts: Number(await env.RYKKER.get("pubts")) || 0 }, 200, cors);
    }
    if (path === "/hold" && req.method === "POST") {
      const { contactId, invoiceId, invoiceNo, name, reason } = await req.json();
      if (invoiceId) {
        const h = await getInvHolds(env);
        h[invoiceId] = { reason: reason || "manual", ts: Date.now(), contactId: contactId || null,
                         invoiceNo: invoiceNo || null, name: name || null };
        await putInvHolds(env, h);
        return j({ ok: true, invHolds: h }, 200, cors);
      }
      return j({ ok: true, holds: await hold(env, contactId, reason || "manual") }, 200, cors);
    }
    if (path === "/release" && req.method === "POST") {
      const { contactId, invoiceId } = await req.json();
      if (invoiceId) {
        const h = await getInvHolds(env); delete h[invoiceId]; await putInvHolds(env, h);
        return j({ ok: true, invHolds: h }, 200, cors);
      }
      const h = await getHolds(env); delete h[contactId]; await putHolds(env, h);
      return j({ ok: true, holds: h }, 200, cors);
    }
    // sync phone->contact and email->contact maps (posted by the daily Action) for reply matching
    if (path === "/maps" && req.method === "POST") {
      const { phonemap, emailmap, namemap } = await req.json();
      if (phonemap) await env.RYKKER.put("phonemap", JSON.stringify(phonemap));
      if (emailmap) await env.RYKKER.put("emailmap", JSON.stringify(emailmap));
      if (namemap) await env.RYKKER.put("namemap", JSON.stringify(namemap));
      return j({ ok: true, phones: Object.keys(phonemap || {}).length, emails: Object.keys(emailmap || {}).length }, 200, cors);
    }
    // --- send approved rykkere via Billy (skips held; test=true routes to TEST_CONTACT) ---
    if (path === "/send" && req.method === "POST") {
      const { items } = await req.json();
      const holds = await getHolds(env);
      const invHolds = await getInvHolds(env);
      // an invoice reminded within the last GAP_DAYS must not be reminded again — a second
      // reminder is a second email and a second 50 kr fee. Build that set once from the log.
      const sentLog = (await env.RYKKER.get("sent", "json")) || [];
      const now = Date.now();
      const recentInv = {};
      for (const s of sentLog) if (now - s.ts < COOLDOWN_MS) for (const id of (s.invoiceIds || [])) recentInv[id] = true;
      const liveEnabled = env.LIVE === "1";      // master switch — off until validated
      const results = [];
      for (const it of items || []) {
        // The app builds each item with the contact id under `cid` (see rykker.js). Read
        // that; `it.contactId` is only for hand-crafted test payloads. Getting this wrong
        // is invisible until send time — the contact id then arrives at Billy as undefined
        // ("contactId: This is a required field."), which is exactly what happened.
        const contactId = it.cid || it.contactId;
        if (holds[contactId]) { results.push({ contactId, skipped: "held" }); continue; }
        // safety: while LIVE is off, only the test contact may receive anything
        if (!liveEnabled && contactId !== env.TEST_CONTACT) { results.push({ contactId, skipped: "live-off" }); continue; }

        // exclude held invoices AND ones still inside their cooldown; planSend rebuilds the
        // mail from whatever survives, so a stale tab that re-fires can't double-send.
        const all = it.lines || (it.invoiceIds || []).map((id) => ({ id }));
        const blocked = {};
        for (const l of all) if (invHolds[l.id] || recentInv[l.id]) blocked[l.id] = true;
        const plan = planSend(it, blocked);
        if (!plan) {
          results.push({ contactId, skipped: all.some((l) => recentInv[l.id]) ? "allerede-sendt" : "held" });
          continue;
        }
        const { invoiceIds, subject, body, message } = plan;

        // Billy 422s a reminder without a contactPersonId ("required field") and won't use a
        // non-primary contact person. The page supplies one, but it can be stale, empty, or
        // point at a deleted person — so resolve live from Billy and PREFER that (the live
        // primary is always valid), falling back to the page's value only if the lookup
        // finds nothing. This makes the Worker authoritative on the recipient, immune to a
        // stale tab. Genuinely no address -> skip cleanly instead of firing a doomed request.
        let contactPersonId;
        try {
          const ps = ((await (await fetch(`https://api.billysbilling.com/v2/contactPersons?contactId=${contactId}`,
            { headers: { "X-Access-Token": env.BILLY_TOKEN } })).json()).contactPersons || []).filter(p => p.email);
          if (ps.length) contactPersonId = (ps.find(p => p.isPrimary) || ps[0]).id;
        } catch (e) {}
        contactPersonId = contactPersonId || it.contactPersonId;
        if (!contactPersonId) { results.push({ contactId, skipped: "no-recipient" }); continue; }

        const payload = {
          organizationId: env.BILLY_ORG_ID,
          contactId,
          contactPersonId,
          flatFee: it.flatFee || 0, percentageFee: 0, feeCurrencyId: "DKK",
          sendEmail: it.sendEmail !== false,
          emailSubject: subject, emailBody: body, message: message || body,
          associations: invoiceIds.map((id) => ({ invoiceId: id })),
        };
        try {
          const r = await fetch("https://api.billysbilling.com/v2/invoiceReminders", {
            method: "POST",
            headers: { "X-Access-Token": env.BILLY_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ invoiceReminder: payload }),
          });
          // surface Billy's reason on failure — the specific validation field if there is
          // one ("contactPersonId: This is a required field."), not the generic wrapper.
          let billyError;
          if (!r.ok) {
            const t = await r.clone().text().catch(() => "");
            try {
              const e = JSON.parse(t), attrs = [];
              for (const rec in (e.validationErrors || {})) {
                const a = e.validationErrors[rec] && e.validationErrors[rec].attributes;
                if (a) for (const f in a) attrs.push(`${f}: ${a[f]}`);
              }
              billyError = attrs.length ? attrs.join("; ") : (e.errorMessage || (t || "").slice(0, 160));
            } catch { billyError = (t || "").slice(0, 160); }
          }
          results.push({ contactId, status: r.status, ok: r.ok, sent: invoiceIds.length, mode: liveEnabled ? "live" : "test", ...(billyError ? { billyError } : {}) });
          if (r.ok) {
            // The invoiceIds here are the whole point: this log is the system of record for
            // per-invoice cadence, since Billy will never hand these back to us on read.
            const log = (await env.RYKKER.get("sent", "json")) || [];
            log.unshift({ contactId, invoiceIds, step: it.step, fee: it.flatFee || 0, ts: Date.now() });
            await env.RYKKER.put("sent", JSON.stringify(log.slice(0, 1000)));
          }
        } catch (e) { results.push({ contactId, error: String(e).slice(0, 120) }); }
      }
      return j({ results }, 200, cors);
    }

    return j({ error: "not found" }, 404, cors);
  },
};
