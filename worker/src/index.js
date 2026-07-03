/**
 * Rykker backend (Cloudflare Worker). Holds the Billy token, sends approved rykkere,
 * stores holds/disputes in KV, and auto-holds on inbound SMS / Gmail replies.
 *
 * Bindings (wrangler.toml / dashboard):
 *   KV namespace:  RYKKER            (holds, phonemap, inbox)
 *   Vars:          BILLY_ORG_ID, TEST_CONTACT (optional), APP_ORIGIN
 *   Secrets:       BILLY_TOKEN, APP_SECRET, SMS_WEBHOOK_TOKEN
 */
const j = (o, s = 200, cors) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function getHolds(env) { return (await env.RYKKER.get("holds", "json")) || {}; }
async function putHolds(env, h) { await env.RYKKER.put("holds", JSON.stringify(h)); }

async function hold(env, contactId, reason, meta) {
  const h = await getHolds(env);
  h[contactId] = { reason: reason || "manual", ts: Date.now(), ...(meta || {}) };
  await putHolds(env, h); return h;
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

    // --- everything else needs the app secret ---
    if ((req.headers.get("Authorization") || "") !== "Bearer " + env.APP_SECRET)
      return j({ error: "unauthorized" }, 401, cors);

    if (path === "/state") {
      const holds = await getHolds(env);
      const inbox = (await env.RYKKER.get("inbox", "json")) || [];
      return j({ holds, inbox: inbox.slice(0, 50) }, 200, cors);
    }
    if (path === "/hold" && req.method === "POST") {
      const { contactId, reason } = await req.json();
      return j({ ok: true, holds: await hold(env, contactId, reason || "manual") }, 200, cors);
    }
    if (path === "/release" && req.method === "POST") {
      const { contactId } = await req.json();
      const h = await getHolds(env); delete h[contactId]; await putHolds(env, h);
      return j({ ok: true, holds: h }, 200, cors);
    }
    // keep phone->contact map fresh (posted by the app so SMS replies can be matched)
    if (path === "/phonemap" && req.method === "POST") {
      const { map } = await req.json();
      await env.RYKKER.put("phonemap", JSON.stringify(map || {}));
      return j({ ok: true, n: Object.keys(map || {}).length }, 200, cors);
    }
    // --- send approved rykkere via Billy (skips held; test=true routes to TEST_CONTACT) ---
    if (path === "/send" && req.method === "POST") {
      const { items } = await req.json();
      const holds = await getHolds(env);
      const liveEnabled = env.LIVE === "1";      // master switch — off until validated
      const results = [];
      for (const it of items || []) {
        if (holds[it.contactId]) { results.push({ contactId: it.contactId, skipped: "held" }); continue; }
        // safety: while LIVE is off, only the test contact may receive anything
        if (!liveEnabled && it.contactId !== env.TEST_CONTACT) { results.push({ contactId: it.contactId, skipped: "live-off" }); continue; }
        const payload = {
          organizationId: env.BILLY_ORG_ID,
          contactId: it.contactId,
          ...(it.contactPersonId ? { contactPersonId: it.contactPersonId } : {}),
          flatFee: it.flatFee || 0, percentageFee: 0, feeCurrencyId: "DKK",
          sendEmail: it.sendEmail !== false,
          emailSubject: it.subject, emailBody: it.body, message: it.body,
          associations: (it.invoiceIds || []).map((id) => ({ invoiceId: id })),
        };
        try {
          const r = await fetch("https://api.billysbilling.com/v2/invoiceReminders", {
            method: "POST",
            headers: { "X-Access-Token": env.BILLY_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ invoiceReminder: payload }),
          });
          results.push({ contactId: it.contactId, status: r.status, ok: r.ok, mode: liveEnabled ? "live" : "test" });
          if (r.ok) {
            const log = (await env.RYKKER.get("sent", "json")) || [];
            log.unshift({ contactId: it.contactId, step: it.step, fee: it.flatFee || 0, ts: Date.now() });
            await env.RYKKER.put("sent", JSON.stringify(log.slice(0, 1000)));
          }
        } catch (e) { results.push({ contactId: it.contactId, error: String(e).slice(0, 120) }); }
      }
      return j({ results }, 200, cors);
    }
    return j({ error: "not found" }, 404, cors);
  },
};
