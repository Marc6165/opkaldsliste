# Rykker backend — Cloudflare Worker setup (~10 min, free)

This Worker holds your Billy token, sends approved rykkere, stores holds/disputes, and
receives SMS/Gmail reply webhooks to auto-stop the flow. The app never sees the token.

## 1. Cloudflare account
Create a free account at https://dash.cloudflare.com/sign-up (no card needed for Workers free tier).

## 2. Tools
```bash
cd worker
npm install -g wrangler      # or use: npx wrangler ...
wrangler login               # opens the browser to authorise
```

## 3. Create the KV store
```bash
wrangler kv namespace create RYKKER
```
Copy the printed `id = "..."` into `wrangler.toml` (replace `REPLACE_WITH_KV_ID`).

## 4. Set the secrets
```bash
wrangler secret put BILLY_TOKEN          # paste your Billy API token
wrangler secret put APP_SECRET           # any long random string (the app will send this)
wrangler secret put SMS_WEBHOOK_TOKEN    # any long random string (for the SMS webhook URL)
```
Tip: generate randoms with `openssl rand -hex 24`.

## 5. Deploy
```bash
wrangler deploy
```
You'll get a URL like `https://sands-rykker.<your-subdomain>.workers.dev`.

## 6. Send me two things
- the **Worker URL**
- the **APP_SECRET** you chose

Then I wire the app's Approve/Hold buttons to it, and we do the **first live test — a single rykker to yourself** (via `TEST_CONTACT`) before any customer is touched.

---
SMS gateway (GatewayAPI) and Gmail reply-monitoring plug into this Worker afterwards
(`/sms-inbound` webhook + a scheduled Gmail poll) — separate steps once the core is live.
