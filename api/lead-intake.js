// api/lead-intake.js
import nodemailer from "nodemailer";
import fetch from "node-fetch";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Only POST allowed" });

  const data = req.body;

  try {
    // 1️⃣ Send email
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const emailHtml = `
      <h2>🧦 Custom Sock Order</h2>
      <ul>
        <li><b>Name:</b> ${data.contact_name}</li>
        <li><b>Organization:</b> ${data.organization}</li>
        <li><b>Email:</b> ${data.email}</li>
        <li><b>Phone:</b> ${data.phone || "Not provided"}</li>
        <li><b>Sock Type:</b> ${data.sock_type}</li>
        <li><b>Quantity:</b> ${data.quantity}</li>
        <li><b>Sizes:</b> ${data.sizes}</li>
        <li><b>Due Date:</b> ${data.due_date}</li>
        <li><b>Colors Allowed:</b> ${data.colors_allowed}</li>
        <li><b>Colors Requested:</b> ${data.colors_requested?.join(", ")}</li>
        <li><b>Brand HEX:</b> ${data.brand_hex?.join(", ")}</li>
        <li><b>Artwork:</b> ${data.artwork || "No artwork uploaded"}</li>
        <li><b>Notes:</b> ${data.notes || "—"}</li>
      </ul>
    `;

    await transporter.sendMail({
      from: '"Spirit Sox" <no-reply@spiritsoxusa.com>',
      to: ["orders@spiritsoxusa.com", "kateryna@spiritsoxusa.com"],
      subject: `New Sock Inquiry — ${data.organization}`,
      html: emailHtml,
    });

    // 2️⃣ Send copy to HubSpot via Form API (no token)
    const HUBSPOT_PORTAL_ID = "48488925";
    const HUBSPOT_FORM_ID = "7c3af433-cb69-4c11-a1ec-be8cb1cb8338";

    const hsResponse = await fetch(
      `https://api.hsforms.com/submissions/v3/integration/submit/${HUBSPOT_PORTAL_ID}/${HUBSPOT_FORM_ID}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: [
            { name: "email", value: data.email },
            { name: "firstname", value: data.contact_name },
            { name: "company", value: data.organization },
            { name: "phone", value: data.phone || "" },
            { name: "sock_type", value: data.sock_type },
            { name: "quantity_needed", value: data.quantity },
            { name: "brand_color_hex_codes", value: data.brand_hex?.join(", ") },
            { name: "date_needed_by__if_applicable_", value: data.due_date },
            { name: "notes", value: data.notes || "" },
          ],
          context: { pageName: "Spirit Sox ChatGPT Integration" },
        }),
      }
    );

    const hsData = await hsResponse.json();

    return res.status(200).json({
      ok: true,
      email_sent: true,
      hubspot_status: hsData.status || "submitted",
    });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
