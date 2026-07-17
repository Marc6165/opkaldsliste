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

// Minimal reminder email — just enough to make them click Billy's pay button.
// Amount lives in the subject; single line breaks. Billy renders the pay button below.
// `items` are the invoices this reminder actually covers: {invoiceNo, lineDescription, balance}.
function buildEmail(step, items, cname, flatFee) {
  const total = items.reduce((s, iv) => s + iv.balance, 0);
  const rest = total + (flatFee || 0);
  const title = step === 0 ? "Betalingspåmindelse" : `Rykker ${step}`;
  const gebyr = flatFee > 0 ? ` Der er tilføjet et rykkergebyr på ${flatFee} kr.` : "";
  const inkasso = step >= 3 ? ` Betaler du ikke, sender vi sagen til inkasso.` : "";
  const help = `Har du allerede betalt, kan du se bort fra beskeden. Hvis noget ikke stemmer, kan du svare direkte på mailen eller ringe til os på 22 33 04 82.`;
  const message = step === 0
    ? "Venlig påmindelse om manglende betaling – se fakturaoversigt herunder."
    : `Rykker ${step}${flatFee > 0 ? ` – rykkergebyr ${flatFee} kr tilføjet` : ""}. Se fakturaoversigt herunder.`;

  if (items.length === 1) {
    const iv = items[0], addr = svcAddr(iv, cname);
    const open = step === 0
      ? `Betalingsfristen på faktura ${iv.invoiceNo} for vinduespudsning på ${addr} er overskredet, og vi kan endnu ikke se din betaling. Det kan selvfølgelig være en forglemmelse.`
      : `Vi mangler fortsat betaling på faktura ${iv.invoiceNo} for vinduespudsning på ${addr}.${gebyr}${inkasso}`;
    return { subject: `${title}: Faktura ${iv.invoiceNo} på ${dk(rest)} kr.`, body: `Hej,\n${open}\n${help}`, message, total };
  }

  const list = items.map(iv => `• Faktura ${iv.invoiceNo} – ${svcAddr(iv, cname)} – ${dk(iv.balance)} kr.`).join("\n");
  const open = step === 0
    ? `Vi kan endnu ikke se din betaling for følgende fakturaer for vinduespudsning:`
    : `Vi mangler fortsat betaling for følgende fakturaer for vinduespudsning:${gebyr}${inkasso}`;
  return { subject: `${title}: ${items.length} fakturaer på ${dk(rest)} kr.`, body: `Hej,\n${open}\n${list}\n${help}`, message, total };
}

module.exports = { dk, nbsp, svcAddr, buildEmail };
