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
const { buildEmail } = shared;

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
  // nothing held (or an old page that never shipped `lines`): keep the previewed text
  if (lines.length === all.length || !it.lines)
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

    // --- everything else needs the app secret ---
    if ((req.headers.get("Authorization") || "") !== "Bearer " + env.APP_SECRET)
      return j({ error: "unauthorized" }, 401, cors);

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
                 sent: (await env.RYKKER.get("sent", "json")) || [] }, 200, cors);
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
      const liveEnabled = env.LIVE === "1";      // master switch — off until validated
      const results = [];
      for (const it of items || []) {
        if (holds[it.contactId]) { results.push({ contactId: it.contactId, skipped: "held" }); continue; }
        // safety: while LIVE is off, only the test contact may receive anything
        if (!liveEnabled && it.contactId !== env.TEST_CONTACT) { results.push({ contactId: it.contactId, skipped: "live-off" }); continue; }

        const plan = planSend(it, invHolds);
        if (!plan) { results.push({ contactId: it.contactId, skipped: "held" }); continue; }
        const { invoiceIds, subject, body, message } = plan;

        const payload = {
          organizationId: env.BILLY_ORG_ID,
          contactId: it.contactId,
          ...(it.contactPersonId ? { contactPersonId: it.contactPersonId } : {}),
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
          results.push({ contactId: it.contactId, status: r.status, ok: r.ok, sent: invoiceIds.length, mode: liveEnabled ? "live" : "test" });
          if (r.ok) {
            // The invoiceIds here are the whole point: this log is the system of record for
            // per-invoice cadence, since Billy will never hand these back to us on read.
            const log = (await env.RYKKER.get("sent", "json")) || [];
            log.unshift({ contactId: it.contactId, invoiceIds, step: it.step, fee: it.flatFee || 0, ts: Date.now() });
            await env.RYKKER.put("sent", JSON.stringify(log.slice(0, 1000)));
          }
        } catch (e) { results.push({ contactId: it.contactId, error: String(e).slice(0, 120) }); }
      }
      return j({ results }, 200, cors);
    }

    return j({ error: "not found" }, 404, cors);
  },
};
