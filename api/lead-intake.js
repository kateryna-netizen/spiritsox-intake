// /api/lead-intake.js
// Supports JSON and multipart/form-data (logo/brand_guide attachments)

const nodemailer = require("nodemailer");
const Busboy = require("busboy");

// -------------------- Helpers --------------------

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const join = (v) => (Array.isArray(v) ? v.filter(Boolean).join(", ") : v ?? "");

const strToArr = (s) =>
  Array.isArray(s)
    ? s
    : typeof s === "string"
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

const buildSubject = (data) => {
  const parts = [
    "Spirit Sox Inquiry",
    data.sock_type ? `(${data.sock_type})` : "",
    data.quantity ? `x${data.quantity}` : "",
    data.due_date ? `→ due ${data.due_date}` : "",
  ].filter(Boolean);
  return parts.join(" ");
};

const row = (k, v) => `
  <tr>
    <th align="left" style="padding:8px;border-bottom:1px solid #eee">${k}</th>
    <td style="padding:8px;border-bottom:1px solid #eee">${Array.isArray(v) ? join(v) : (v ?? "")}</td>
  </tr>`;

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
      ${row("Colors (allowed/requested)", `${data.colors_allowed} / ${join(data.colors_requested)}`)}
      ${row("Brand HEX", join(data.brand_hex))}
      ${row("Artwork / Brand guide link", data.artwork)}
      ${row("Notes", data.notes)}
    </table>
    <p style="color:#888;margin-top:16px">JSON snapshot:</p>
    <pre style="background:#f7f7f7;padding:12px;border-radius:6px;white-space:pre-wrap">${escapeHtml(
      JSON.stringify(data, null, 2)
    )}</pre>
  </div>`;

// canonical normalize for text fields
const normalize = (d = {}) => {
  const style = d.sock_type ?? d.style ?? "";
  const colorsAllowed =
    d.colors_allowed ??
    d.colorsAllowed ??
    (String(style).toLowerCase() === "dress" ? 6 : 5);

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
    colors_requested: d.colors_requested ?? d.colors ?? [],
    brand_hex: d.brand_hex ?? d.hex ?? [],
    artwork: d.artwork ?? "",
    notes: d.notes ?? "",
  };
};

// Parse multipart with Busboy -> returns { fields, files[] }
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

// -------------------- Main handler --------------------

module.exports = async (req, res) => {
  // simple CORS
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
      // Parse files + fields
      const { fields, files } = await parseMultipart(req);

      // arrays из строк через запятую
      if (fields.colors_requested) fields.colors_requested = strToArr(fields.colors_requested);
      if (fields.brand_hex) fields.brand_hex = strToArr(fields.brand_hex);

      data = normalize(fields);

      // Attach files if present
      attachments = files
        .filter((f) => f && f.buffer && f.buffer.length)
        .map((f) => ({
          filename: f.filename || f.fieldname || "file",
          content: f.buffer,
          contentType: f.mime || "application/octet-stream",
        }));
    } else {
      // JSON path (Vercel обычно уже парсит)
      const raw =
        typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      data = normalize(raw);

      // поддержка dataURL (если когда-нибудь решите пробросить из GPT)
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

    // --- Validate env
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
      return res
        .status(500)
        .json({ ok: false, error: "SMTP env vars missing (SMTP_HOST, SMTP_USER, SMTP_PASS)" });
    }

    // Nodemailer
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    // Send
    await transporter.sendMail({
      from,
      to: toList,
      subject: buildSubject(data),
      html: buildHtml(data),
      attachments: attachments.length ? attachments : undefined,
    });

    return res.status(200).json({ ok: true, attachments: attachments.length });
  } catch (err) {
    console.error("Email error:", err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
};
