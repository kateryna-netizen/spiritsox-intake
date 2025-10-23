// /api/lead-intake.js — CommonJS, Node 18+ on Vercel
const fetch = require("node-fetch");            // (kept for future use; not required for email-only)
const nodemailer = require("nodemailer");

// --- Helpers -----------------------------------------------------------------

// Map short keys (name, org, style, qty, colors, hex, due) and old keys
// (contact_name, organization, sock_type, quantity, colors_requested, brand_hex, due_date) to one shape.
function normalize(d = {}) {
  const style = d.sock_type ?? d.style ?? "";
  const colorsAllowed =
    d.colors_allowed ??
    d.colorsAllowed ??
    ((style || "").toLowerCase() === "dress" ? 6 : 5);

  return {
    contact_name:    d.contact_name ?? d.name ?? "",
    organization:    d.organization ?? d.org ?? "",
    email:           d.email ?? "",
    phone:           d.phone ?? "",
    sock_type:       style,
    quantity:        d.quantity ?? d.qty ?? "",
    sizes:           d.sizes ?? "",
    due_date:        d.due_date ?? d.due ?? "",
    colors_allowed:  colorsAllowed,
    colors_requested:d.colors_requested ?? d.colors ?? [],
    brand_hex:       d.brand_hex ?? d.hex ?? [],
    artwork:         d.artwork ?? "",
    // these two are ignored in your flow but kept for completeness
    shipping_address:d.shipping_address ?? "",
    rush:            d.rush ?? false,
    notes:           d.notes ?? ""
  };
}

// Build a clean subject line & HTML email
function buildEmail(data) {
  const isRush = Boolean(data.rush);
  const parts = [
    isRush ? "RUSH" : "New",
    "Spirit Sox Inquiry",
    data.sock_type ? `(${data.sock_type})` : "",
    data.quantity ? `x${data.quantity}` : "",
    data.due_date ? `→ due ${data.due_date}` : ""
  ].filter(Boolean);
  const subject = parts.join(" ");

  const row = (label, value) => `
    <tr>
      <th align="left" style="padding:8px;border-bottom:1px solid #eee">${label}</th>
      <td style="padding:8px;border-bottom:1px solid #eee">
        ${Array.isArray(value) ? value.join(", ") : (value ?? "")}
      </td>
    </tr>`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:680px">
      <h2 style="margin:0 0 12px;color:#0B8F3E">Spirit Sox — Inquiry</h2>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        ${row("Contact name", data.contact_name)}
        ${row("Organization", data.organization)}
        ${row("Email", data.email)}
        ${row("Phone", data.phone)}
        ${row("Sock type", data.sock_type)}
        ${row("Quantity", data.quantity)}
        ${row("Sizes", data.sizes)}
        ${row("Due date", data.due_date)}
        ${row("Colors (allowed/requested)", `${data.colors_allowed} / ${(data.colors_requested||[]).join(", ")}`)}
        ${row("Brand HEX", (data.brand_hex||[]).join(", "))}
        ${row("Artwork / Brand guide", data.artwork)}
        ${row("Notes", data.notes)}
      </table>
      <p style="color:#888;margin-top:16px">JSON snapshot:</p>
      <pre style="background:#f7f7f7;padding:12px;border-radius:6px;white-space:pre-wrap">${safeJSONStringify(data)}</pre>
    </div>
  `;

  return { subject, html };
}

function safeJSONStringify(obj) {
  try { return JSON.stringify(obj, null, 2); }
  catch { return "[unserializable payload]"; }
}

// Nodemailer transporter from env
function makeTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error("SMTP env vars missing (SMTP_HOST, SMTP_USER, SMTP_PASS).");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: false,
    auth: { user, pass }
  });
}

// --- Handler -----------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Only POST allowed");
  }

  // Parse body safely (Vercel usually gives an object; guard against strings)
  const raw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const data = normalize(raw);

  // Basic validation (do not fail the request, just mark reasons)
  const missing = [];
  if (!data.contact_name) missing.push("name");
  if (!data.email || !/.+@.+\..+/.test(String(data.email))) missing.push("valid email");
  if (!data.sock_type) missing.push("sock type");
  if (!data.quantity || isNaN(Number(data.quantity))) missing.push("quantity");

  // Prepare email
  const { subject, html } = buildEmail(data);

  // Collect recipients
  const toRaw  = process.env.MAIL_TO || "";
  const toList = toRaw.split(",").map(s => s.trim()).filter(Boolean);

  let mailed = false;
  let mailError = null;

  try {
    if (toList.length === 0) throw new Error("MAIL_TO is empty");
    const transporter = makeTransport();
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: toList,
      subject,
      html
    });
    mailed = true;
  } catch (e) {
    // Log for Vercel; still return 200 so GPT Action succeeds
    console.error("Email error:", e);
    mailError = String(e && e.message ? e.message : e);
  }

  // Final response — keep 200 for GPT, include debug flags
  return res.status(200).json({
    ok: true,
    mailed,
    missing_required: missing,
    error: mailError || undefined
  });
};
