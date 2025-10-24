// /api/lead-intake.js
// Full endpoint: JSON + multipart, email via Nodemailer, HubSpot Form submission.
// Works on Vercel Serverless.
// ----------------------------------------------------------

const nodemailer = require("nodemailer");
const Busboy = require("busboy");

// -------------------- Small helpers --------------------

/** Escape HTML for safe <pre> blocks in the email */
const escapeHtml = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Join array values for display */
const join = (v) => (Array.isArray(v) ? v.filter(Boolean).join(", ") : (v ?? ""));

/** Convert "a, b, c" => ["a","b","c"] */
const csvToArray = (s) =>
  Array.isArray(s)
    ? s
    : typeof s === "string"
    ? s.split(",").map((x) => x.trim()).filter(Boolean)
    : [];

/** Build a friendly email subject */
const buildSubject = (data) => {
  const parts = [
    "Spirit Sox Inquiry",
    data.sock_type ? `(${data.sock_type})` : "",
    data.quantity ? `x${data.quantity}` : "",
    data.due_date ? `→ due ${data.due_date}` : "",
  ].filter(Boolean);
  return parts.join(" ");
};

/** Build one HTML table row */
const row = (k, v) => `
  <tr>
    <th align="left" style="padding:8px;border-bottom:1px solid #eee">${k}</th>
    <td style="padding:8px;border-bottom:1px solid #eee">${Array.isArray(v) ? join(v) : (v ?? "")}</td>
  </tr>`;

/** Build the HTML body for the team email */
const buildHtml = (data) => `
  <div style="font-family:Arial,sans-serif;max-width:720px">
    <h2 style="margin:0 0 12px">Spirit Sox — New Inquiry</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      ${row("Contact name", data.contact_name)}
      ${row("Organization", data.organization)}
      ${row("Email", data.email)}
      ${row("Phone", data.phone)}
      ${row("Sock style", data.sock_type)}
      ${row("Quantity", data.quantity)}
      ${row("Sizes", data.sizes)}
      ${row("Due date", data.due_date)}
      ${row("Colors (allowed / requested)", `${data.colors_allowed} / ${join(data.colors_requested)}`)}
      ${row("Brand HEX", join(data.brand_hex))}
      ${row("Artwork / Brand guide link", data.artwork)}
      ${row("Notes", data.notes)}
    </table>
    <p style="color:#888;margin-top:16px">JSON snapshot:</p>
    <pre style="background:#f7f7f7;padding:12px;border-radius:6px;white-space:pre-wrap">${escapeHtml(
      JSON.stringify(data, null, 2)
    )}</pre>
  </div>`;

/** Normalize incoming fields (handles different caller variants) */
const normalize = (d = {}) => {
  // Style can arrive under different keys (sock_type / style)
  const style = d.sock_type ?? d.style ?? "";

  // Automatically set colors_allowed: 6 for Dress, 5 otherwise
  const colorsAllowed =
    d.colors_allowed ??
    d.colorsAllowed ??
    (String(style).toLowerCase() === "dress" ? 6 : 5);

  // Convert comma-separated into arrays where needed
  const colorsRequested = Array.isArray(d.colors_requested)
    ? d.colors_requested
    : csvToArray(d.colors_requested ?? d.colors);
  const brandHex = Array.isArray(d.brand_hex)
    ? d.brand_hex
    : csvToArray(d.brand_hex ?? d.hex);

  return {
    contact_name: d.contact_name ?? d.name ?? "",
    organization: d.organization ?? d.org ?? "",
    email: d.email ?? "",
    phone: d.phone ?? "",
    sock_type: style,
    quantity: d.quantity ?? d.qty ?? "",
    sizes: d.sizes ?? "",
    due_date: d.due_date ?? d.due ?? "",
    colors_allowed: colorsAllowed,
    colors_requested: colorsRequested,
    brand_hex: brandHex,
    artwork: d.artwork ?? "",
    notes: d.notes ?? "",
  };
};

/** Parse multipart/form-data into { fields, files[] } using Busboy */
const parseMultipart = (req) =>
  new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const fields = {};
    const files = []; // each: { fieldname, filename, mime, buffer }

    busboy.on("file", (fieldname, file, filename, encoding, mimetype) => {
      const chunks = [];
      file.on("data", (d) => chunks.push(d));
      file.on("end", () => {
        files.push({
          fieldname,
          filename: filename && filename.filename ? filename.filename : filename,
          mime: mimetype,
          buffer: Buffer.concat(chunks),
        });
      });
    });

    busboy.on("field", (name, val) => {
      fields[name] = val;
    });

    busboy.on("error", reject);
    busboy.on("finish", () => resolve({ fields, files }));

    req.pipe(busboy);
  });

// -------------------- HubSpot forwarding --------------------

/**
 * Submit to HubSpot Form Submissions API so it appears in the same form
 * as your website. Uses env HS_PORTAL_ID and HS_FORM_ID.
 */
async function submitToHubSpotForm(data) {
  try {
    if (process.env.HS_ENABLE !== "true") return { skipped: true, reason: "HS_ENABLE is not true" };

    const portalId = process.env.HS_PORTAL_ID;
    const formId = process.env.HS_FORM_ID;
    if (!portalId || !formId) return { skipped: true, reason: "Missing HS_PORTAL_ID or HS_FORM_ID" };

    // Map local fields -> HubSpot form internal names
    // TODO: make sure your HubSpot form has these properties with matching internal names.
    const mapped = [
      { name: "email",       value: data.email || "" },
      { name: "firstname",   value: data.contact_name || "" },
      { name: "company",     value: data.organization || "" },

      // Custom fields — change to your HubSpot internal names
      { name: "sock_type__c",  value: data.sock_type || "" },
      { name: "quantity__c",   value: data.quantity != null ? String(data.quantity) : "" },
      { name: "sizes__c",      value: data.sizes || "" },
      { name: "due_date__c",   value: data.due_date || "" },
      { name: "colors__c",     value: Array.isArray(data.colors_requested) ? data.colors_requested.join(", ") : (data.colors_requested || "") },
      { name: "brand_hex__c",  value: Array.isArray(data.brand_hex) ? data.brand_hex.join(", ") : (data.brand_hex || "") },
      { name: "artwork__c",    value: data.artwork || "" },
      { name: "notes__c",      value: data.notes || "" },

      // Optional: hidden field in the HS form to tag the source
      { name: "source",        value: "ChatGPT" }
    ];

    // Keep non-empty values only
    const fields = mapped.filter((f) =>
      typeof f.value === "string" ? f.value.trim() !== "" : f.value !== ""
    );

    const body = {
      fields,
      context: {
        pageUri: "https://www.spiritsoxusa.com/submission-form/",
        pageName: "Spirit Sox – Custom Sock Inquiry",
      },
      // If your HubSpot form requires GDPR consent, uncomment and customize:
      // legal_consent_options: {
      //   consent: {
      //     consentToProcess: true,
      //     text: "I agree to allow Spirit Sox USA to store and process my personal data.",
      //     communications: []
      //   }
      // }
    };

    const resp = await fetch(
      `https://api.hsforms.com/submissions/v3/integration/submit/${portalId}/${formId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    const text = await resp.text(); // HubSpot responds with text
    console.log("[HubSpot] status:", resp.status, text.slice(0, 200));
    return { status: resp.status, body: text };
  } catch (err) {
    console.error("[HubSpot] error:", err);
    return { error: String(err && err.message) || String(err) };
  }
}

// -------------------- Main handler --------------------

module.exports = async (req, res) => {
  // Simple CORS (optional)
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).send("Only POST allowed");
  }

  try {
    const ct = (req.headers["content-type"] || "").toLowerCase();
    let data = {};
    let attachments = [];

    if (ct.includes("multipart/form-data")) {
      // Multipart path: accept text + files
      const { fields, files } = await parseMultipart(req);

      // Normalize CSVish inputs for arrays
      if (fields.colors_requested) fields.colors_requested = csvToArray(fields.colors_requested);
      if (fields.brand_hex) fields.brand_hex = csvToArray(fields.brand_hex);

      data = normalize(fields);

      // Collect file attachments (logo, brand_guide, etc)
      attachments = (files || [])
        .filter((f) => f && f.buffer && f.buffer.length)
        .map((f) => ({
          filename: f.filename || f.fieldname || "file",
          content: f.buffer,
          contentType: f.mime || "application/octet-stream",
        }));
    } else {
      // JSON path
      const raw =
        typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      data = normalize(raw);

      // Optional: support data URLs (base64) if ever passed
      if (raw.logo_data_url && typeof raw.logo_data_url === "string") {
        const m = raw.logo_data_url.match(/^data:(.+?);base64,(.+)$/);
        if (m) {
          attachments.push({
            filename: "logo",
            content: Buffer.from(m[2], "base64"),
            contentType: m[1],
          });
        }
      }
    }

    // ---------- Validate required env ----------
    const toList = (process.env.MAIL_TO || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!toList.length) {
      return res.status(500).json({ ok: false, error: "MAIL_TO is empty" });
    }
    const from = process.env.MAIL_FROM;
    if (!from) {
      return res.status(500).json({ ok: false, error: "MAIL_FROM is empty" });
    }
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(500).json({
        ok: false,
        error: "SMTP env vars missing (SMTP_HOST, SMTP_USER, SMTP_PASS)",
      });
    }

    // ---------- Create mail transporter ----------
    const port = Number(process.env.SMTP_PORT || 587);
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465, // use TLS when port is 465
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    // ---------- Send team email ----------
    await transporter.sendMail({
      from,
      to: toList,
      subject: buildSubject(data),
      html: buildHtml(data),
      attachments: attachments.length ? attachments : undefined,
    });

    // ---------- Forward to HubSpot form (optional, controlled by HS_ENABLE) ----------
    const hubspot = await submitToHubSpotForm(data);

    // ---------- Respond to caller ----------
    return res.status(200).json({
      ok: true,
      attachments: attachments.length,
      hubspot,
    });
  } catch (err) {
    console.error("Lead-intake error:", err);
    return res
      .status(500)
      .json({ ok: false, error: String(err && err.message) || String(err) });
  }
};
