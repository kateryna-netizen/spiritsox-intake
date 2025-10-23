// /api/lead-intake.js  — обычный Node serverless handler (без TypeScript)
const fetch = require("node-fetch");
const nodemailer = require("nodemailer");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Only POST allowed");
    return;
  }

  // Vercel парсит JSON сам, но на всякий случай:
  const data = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

  // 1) HTML-письмо
  const html = `
    <div style="font-family:Arial,sans-serif">
      <h2>New Spirit Sox Inquiry</h2>
      <table cellpadding="6" cellspacing="0" border="1">
        ${Object.entries(data).map(([k, v]) =>
          `<tr><th align="left">${k}</th><td>${Array.isArray(v) ? v.join(", ") : String(v ?? "")}</td></tr>`
        ).join("")}
      </table>
    </div>
  `;

  // 2) Отправка письма (SMTP или SendGrid SMTP)
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      to: process.env.MAIL_TO,
      from: process.env.MAIL_FROM,
      subject: "New Spirit Sox Inquiry",
      html,
    });
  } catch (e) {
    console.error("Email error:", e);
    // не падаем — письмо вторично, главное отдать 200 GPT
  }

  // 3) Отправка в HubSpot (опционально — если заданы переменные)
  try {
    if (process.env.HUBSPOT_TOKEN && process.env.HS_PORTAL_ID && process.env.HS_FORM_GUID) {
      const formUrl = `https://api.hsforms.com/submissions/v3/integration/secure/submit/${process.env.HS_PORTAL_ID}/${process.env.HS_FORM_GUID}`;
      await fetch(formUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.HUBSPOT_TOKEN}`,
        },
        body: JSON.stringify({
          fields: [
            { name: "email", value: data.email || "" },
            { name: "firstname", value: (data.contact_name || "").split(" ")[0] || "" },
            { name: "lastname", value: (data.contact_name || "").split(" ").slice(1).join(" ") || "" },
            { name: "company", value: data.organization || "" },
            { name: "phone", value: data.phone || "" },
            { name: "message", value: JSON.stringify(data, null, 2) }
          ],
          context: {
            pageUri: "https://www.spiritsoxusa.com/submission-form/",
            pageName: "Get Free Mockups"
          }
        }),
      });
    }
  } catch (e) {
    console.error("HubSpot error:", e);
  }

  res.status(200).json({ ok: true });
};
