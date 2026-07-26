// Rykker email text — shared by the preview (scripts/rykker.js) and the sender
// (worker/src/index.js), so the mail a customer actually receives is rebuilt from
// whichever invoices survive the holds rather than from the preview's snapshot.
// Keep this file pure: no process.env, no I/O — the Worker bundles it too.

const nbsp = s => (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

function dk(x) {
  const n = x < 0; x = Math.abs(x);
  const [i, f] = x.toFixed(2).split(".");
  return (n ? "-" : "") + i.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + f;
}

// service address for the email — from the invoice line ("Vinduespudsning af <adresse>"),
// falling back to the contact name (Sands names most customers by their address).
function svcAddr(iv, cname) {
  let s = String((iv && iv.lineDescription) || "").replace(/ /g, " ").trim();
  s = s.replace(/^vinduespudsning\s*(inde\s+af|udvendig\s+af|udv\.?\s*af|af)?\s*/i, "");
  s = s.split(/[:;]/)[0].replace(/\s+/g, " ").trim();
  if (!s) s = nbsp(cname || "");
  return s;
}

// Days a customer gets before the next step. Must match GAP in rykker.js — it's both the
// gap between rykkere and the notice period stated on the Rykker 3 inkassovarsel.
const GAP_DAYS = 10;

function ddmmyyyy(d) {
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

// Graduated reminder email. Each step states only the *next* consequence (god inkassoskik:
// proportional escalation), and Rykker 3 doubles as the inkassovarsel with a concrete,
// send-date-based deadline — so it must be rebuilt at send time (see planSend), not left as
// the up-to-a-week-old preview. CTA points at Billy's own blue "Vis rykker og fakturaer"
// button (Billy escapes HTML in the body, so we can't render our own). Single line breaks.
// `items` are the invoices this reminder covers: {invoiceNo, lineDescription, balance}.
function buildEmail(step, items, cname, flatFee) {
  const total = items.reduce((s, iv) => s + iv.balance, 0);
  const rest = total + (flatFee || 0);
  const title = step === 0 ? "Betalingspåmindelse" : `Rykker ${step}`;
  const one = items.length === 1;
  const cta = `Tryk på den blå knap "Vis rykker og fakturaer" nederst i mailen for at se ${one ? "fakturaen" : "fakturaerne"} og betale.`;
  const closing = `Har du allerede betalt, kan du se bort fra beskeden. Hvis noget ikke stemmer, kan du svare direkte på denne mail.`;

  // the one escalating consequence line for this step
  let consequence;
  if (step === 0) consequence = `Betaler du inden ${GAP_DAYS} dage, undgår du et rykkergebyr.`;
  else if (step === 1) consequence = `Betaler du ikke, sender vi endnu en rykker med et nyt gebyr.`;
  else if (step === 2) consequence = `Betaler du ikke, sender vi en sidste rykker, hvorefter sagen kan gå til inkasso.`;
  else {
    const dl = new Date(); dl.setDate(dl.getDate() + GAP_DAYS);   // send date + notice period
    consequence = `Er beløbet ikke betalt senest den ${ddmmyyyy(dl)}, overdrager vi sagen til inkasso, hvilket kan medføre yderligere omkostninger for dig.`;
  }
  // the fee sentence, folded into the opening; "endnu et" from the second fee onward
  const feeLine = flatFee > 0
    ? `Vi har derfor tilføjet ${step >= 2 ? "endnu " : ""}et rykkergebyr på ${flatFee} kr.` : "";
  const message = step === 0
    ? "Venlig påmindelse om manglende betaling – se fakturaoversigt herunder."
    : `Rykker ${step}${flatFee > 0 ? ` – rykkergebyr ${flatFee} kr tilføjet` : ""}. Se fakturaoversigt herunder.`;

  if (one) {
    const iv = items[0], addr = svcAddr(iv, cname);
    let open;
    if (step === 0) open = `Betalingsfristen på faktura ${iv.invoiceNo} for vinduespudsning på ${addr} er overskredet, og vi kan endnu ikke se din betaling. Det kan selvfølgelig være en forglemmelse.`;
    else if (step === 3) open = `Dette er sidste rykker på faktura ${iv.invoiceNo} for vinduespudsning på ${addr}. Vi har tilføjet et rykkergebyr på ${flatFee} kr.`;
    else open = `Vi mangler fortsat betaling på faktura ${iv.invoiceNo} for vinduespudsning på ${addr}. ${feeLine}`;
    return { subject: `${title}: Faktura ${iv.invoiceNo} på ${dk(rest)} kr.`, body: `Hej,\n${open}\n${cta}\n${consequence}\n${closing}`, message, total };
  }

  const list = items.map(iv => `• Faktura ${iv.invoiceNo} – ${svcAddr(iv, cname)} – ${dk(iv.balance)} kr.`).join("\n");
  let intro;
  if (step === 0) intro = `Vi kan endnu ikke se din betaling for følgende fakturaer for vinduespudsning:`;
  else if (step === 3) intro = `Dette er sidste rykker for følgende fakturaer for vinduespudsning. Vi har tilføjet et rykkergebyr på ${flatFee} kr.`;
  else intro = `Vi mangler fortsat betaling for følgende fakturaer for vinduespudsning. ${feeLine}`;
  return { subject: `${title}: ${items.length} fakturaer på ${dk(rest)} kr.`, body: `Hej,\n${intro}\n${list}\n${cta}\n${consequence}\n${closing}`, message, total };
}

module.exports = { dk, nbsp, svcAddr, buildEmail };
