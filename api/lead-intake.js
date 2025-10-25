// api/lead-intake.js  (CommonJS)
// Accepts JSON or multipart/form-data, emails the team (SendGrid SMTP), and forwards to HubSpot Form API.
// Env (Vercel → Settings → Environment Variables):
//   SMTP_HOST=smtp.sendgrid.net
//   SMTP_PORT=587
//   SMTP_USER=apikey
//   SMTP_PASS=<SENDGRID_API_KEY>
//   MAIL_FROM="Spirit Sox Bot" <spiritsoxbot@gmail.com>
//   MAIL_TO= kateryna@spiritsoxusa.com
//   HS_PORTAL_ID=48488925
//   HS_FORM_ID=7c3af433-cb69-4c11-a1ec-be8cb1cb8338

const nodemailer = require("nodemailer");
const Busboy = require("busboy");

// ---------- small helpers ----------
const asArray = (v) =>
  Array.isArray(v) ? v : typeof v === "string" ? v.split(",").map(s => s.trim()).filter(Boolean) : [];

const escapeHtml = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const row = (k, v) => `
  <tr>
    <th align="left" style="padding:8px;border-bottom:1px solid #eee">${k}</th>
    <td style="padding:8px;border-bottom:1px solid #eee">${Array.isArray(v) ? v.join(", ") : (v ?? "")}</td>
  </tr>`;

const buildHtml = (d) => `
  <div style="font-family:Arial,sans-serif;max-width:760px">
    <h2 style="margin:0 0 12px">Spirit Sox — New Inquiry</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      ${row("Contact name", d.contact_name)}
      ${row("Organization", d.organization)}
      ${row("Email", d.email)}
      ${row("Phone", d.phone)}
      ${row("Sock type", d.sock_type)}
      ${row("Quantity", d.quantity)}
      ${row("Sizes", d.sizes)}
      ${row("Due date", d.due_date)}
      ${row("Thread colors allowed / requested", `${d.colors_allowed} / ${(d.colors_requested || []).join(", ")}`)}
      ${row("Brand HEX", d.brand_hex)}
      ${row("Artwork/Logo link", d.artwork)}
      ${row("Notes", d.notes)}
    </table>
    <p style="color:#888;margin:12px 0 6px">JSON snapshot:</p>
    <pre style="background:#f7f7f7;padding:12px;border-radius:6px;white-space:pre-wrap">${escapeHtml(JSON.stringify(d, null, 2))}</pre>
  </div>`;

// normalize input keys; also auto-set colors_allowed (Dress→6, others→5)
const normalize = (raw = {}) => {
  const style = raw.sock_type ?? raw.style ?? "";
  const colorsAllowed =
    raw.colors_allowed ??
    (String(style).toLowerCase() === "dress" ? 6 : 5);

  return {
    contact_name: raw.contact_name ?? raw.name ?? "",
    organization: raw.organization ?? raw.org ?? "",
    email: raw.email ?? "",
    phone: raw.phone ?? "",
    sock_type: style,
    quantity: raw.quantity ?? raw.qty ?? "",
    sizes: raw.sizes ?? "",
    due_date: raw.due_date ?? raw.due ?? "",
    colors_allowed: colorsAllowed,
    colors_requested: asArray(raw.colors_requested ?? raw.colors),
    brand_hex: asArray(raw.brand_hex ?? raw.hex),
    artwork: raw.artwork ?? "",
    notes: raw.notes ?? ""
  };
};

const parseMultipart = (req) =>
  new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const fields = {};
    const files = []; // { fieldname, filename, mime, buffer }

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

// ---------- HubSpot forwarding via Form API (no token) ----------
async function forwardToHubSpotForm(data) {
  try {
    const portalId = process.env.HS_PORTAL_ID;
    const formId = process.env.HS_FORM_ID;
    if (!portalId || !formId) return { skipped: true, reason: "HS_PORTAL_ID/HS_FORM_ID not set" };

    // If a property name is not present on the form, HubSpot will ignore it (safe).
    const fields = [
      { name: "email",     value: data.email || "" },
      { name: "firstname", value: data.contact_name || "" },
      { name: "company",   value: data.organization || "" },
      { name: "phone",     value: data.phone || "" },

      // Common custom names your form may already use (ignore if absent)
      { name: "sock_type",                       value: data.sock_type || "" },
      { name: "quantity_needed",                 value: data.quantity != null ? String(data.quantity) : "" },
      { name: "sizes",                           value: data.sizes || "" },
      { name: "date_needed_by__if_applicable_",  value: data.due_date || "" },
      { name: "brand_color_hex_codes",           value: (data.brand_hex || []).join(", ") },
      { name: "notes",                           value: data.notes || "" },
      { name: "logo_upload",                     value: data.artwork || "" } // if you store a URL
    ].filter(f => (typeof f.value === "string" ? f.value.trim() !== "" : f.value !== ""));

    const body = {
      fields,
      context: { pageName: "Spirit Sox – Chat Assistant" }
    };

    const resp = await fetch(
      `https://api.hsforms.com/submissions/v3/integration/submit/${portalId}/${formId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    const text = await resp.text();
    console.log("[HubSpot] status:", resp.status, text.slice(0, 200));
    return { status: resp.status };
  } catch (err) {
    console.error("[HubSpot] error:", err);
    return { error: String(err && err.message) || String(err) };
  }
}

// ---------- main handler ----------
module.exports = async (req, res) => {
  // CORS preflight (optional)
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const ct = (req.headers["content-type"] || "").toLowerCase();
    let data = {};
    let attachments = [];

    if (ct.includes("multipart/form-data")) {
      const { fields, files } = await parseMultipart(req);

      // fix CSV -> arrays for certain fields
      if (fields.colors_requested) fields.colors_requested = asArray(fields.colors_requested);
      if (fields.brand_hex) fields.brand_hex = asArray(fields.brand_hex);

      data = normalize(fields);

      // add files to email attachments
      attachments = (files || []).map(f => ({
        filename: f.filename || f.fieldname || "file",
        content: f.buffer,
        contentType: f.mime || "application/octet-stream"
      }));
    } else {
      const raw = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      data = normalize(raw);

      // optional: support data URL logo encoded in JSON
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

    // ----- validate mail env -----
    const toList = (process.env.MAIL_TO || "").split(",").map(s => s.trim()).filter(Boolean);
    const fromAddr = process.env.MAIL_FROM || '"Spirit Sox Bot" <spiritsoxbot@gmail.com>';
    if (!fromAddr || !toList.length) {
      return res.status(500).json({ ok: false, error: "MAIL_FROM or MAIL_TO not configured" });
    }

    const host = process.env.SMTP_HOST || "smtp.sendgrid.net";
    const user = process.env.SMTP_USER || "apikey";
    const pass = process.env.SMTP_PASS;
    if (!pass) {
      return res.status(500).json({ ok: false, error: "SMTP_PASS (SendGrid API Key) missing" });
    }

    // ----- send email via SendGrid SMTP -----
    const port = Number(process.env.SMTP_PORT || 587);
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // TLS only on 465
      auth: { user, pass },
    });

    await transporter.sendMail({
      from: fromAddr,                    // must be verified in SendGrid
      to: toList,
      replyTo: data.email || undefined,  // helpful: reply goes to customer email
      subject: `Spirit Sox Inquiry — ${data.organization || "Unknown org"} (${data.sock_type || "Style?"} x${data.quantity || "?"})`,
      html: buildHtml(data),
      attachments: attachments.length ? attachments : undefined,
    });

    // ----- forward to HubSpot form (optional; fields ignored if not on form) -----
    const hubspot = await forwardToHubSpotForm(data);

    return res.status(200).json({
      ok: true,
      mailed: true,
      attachments: attachments.length,
      hubspot
    });
  } catch (err) {
    console.error("lead-intake error:", err);
    return res.status(500).json({ ok: false, error: String(err && err.message) || String(err) });
  }
};
