// server.js
import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import path from "path";
import crypto from "crypto";
import fs from "fs";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_CALLBACK_URL,
  EMAIL_USER,
  EMAIL_PASS,
} = process.env;

// 📩 Email Setup (Custom SMTP)
const transporter = nodemailer.createTransport({
  host: "mail.cidalitravel.com",
  port: 465,
  secure: true,
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});


// 🔑 Get Access Token
async function getAccessToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString("base64");
  const response = await axios.get(
    "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return response.data.access_token;
}

// Temporary in-memory token store
const ebookTokens = {}; // token -> { file, expiresAt }

// 🟢 STK Push
app.post("/api/mpesa/stkpush", async (req, res) => {
  const { phone, amount, email } = req.body;
  try {
    const token = await getAccessToken();
    console.log("access token", token);
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString("base64");

    // 🧾 Send email on STK initiation
    await transporter.sendMail({
      from: `"CIDALI BookStore" <${EMAIL_USER}>`,
      to: "info@cidalitravel.com",
      cc: "zekele.enterprise@gmail.com",
      subject: "STK Push Initiated",
      html: `
        <h2>STK Push Initiated</h2>
        <p>Phone: ${phone}</p>
        <p>Amount: Ksh ${amount}</p>
        ${email ? `<p>Buyer Email: ${email}</p>` : ""}
        <p>Status: Payment initiation in progress</p>
        <br/>
        <p>— CIDALI BookStore</p>
      `,
    });
    console.log("📧 Initiation email sent to admin");

    // 🔑 Trigger STK push
    const response = await axios.post(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: MPESA_CALLBACK_URL,
        AccountReference: "CIDALI Books",
        TransactionDesc: "Book Purchase",
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json(response.data);
  } catch (err) {
    console.error("STK Push error:", err.response?.data || err.message);
    res.status(500).json({ error: "STK push failed", details: err.message });
  }
});


// ✅ Callback (M-PESA or test simulation)
app.post("/api/mpesa/callback", async (req, res) => {
  try {
    const data = req.body;
    console.log("Callback received:", data);

    let phone, amount, email;

    if (data.Body?.stkCallback?.CallbackMetadata) {
      const items = data.Body.stkCallback.CallbackMetadata.Item;
      amount = items.find((i) => i.Name === "Amount")?.Value;
      phone = items.find((i) => i.Name === "PhoneNumber")?.Value;
    } else {
      phone = data.phone;
      amount = data.amount;
      email = data.email;
    }

    if (!phone) return res.status(400).json({ error: "No phone in callback" });

    // Generate secure token (valid for 30 minutes)
    const token = crypto.randomBytes(16).toString("hex");
    const expiresAt = Date.now() + 30 * 60 * 1000; // 30 mins expiry
    const file = "Born_Too_Soon.pdf";

    ebookTokens[token] = { file, expiresAt };
    const ebookViewLink = `http://localhost:5000/api/view/${file}?token=${token}`;

    // Send email to admin and CC
    await transporter.sendMail({
      from: `"CIDALI BookStore" <${EMAIL_USER}>`,
      to: "info@cidalitravel.com",
      cc: "zekele.enterprise@gmail.com",
      subject: "New Book Purchase Received",
      html: `
        <h2>New Purchase Notification</h2>
        <p>Phone: ${phone}</p>
        <p>Amount Paid: Ksh ${amount}</p>
        ${email ? `<p>Buyer Email: ${email}</p>` : ""}
        ${ebookViewLink ? `<p>eBook Link (buyer only): <a href="${ebookViewLink}" target="_blank">📘 Read Born Too Soon</a></p>` : ""}
        <br/>
        <p>— CIDALI BookStore</p>
      `,
    });

    console.log(`✅ Admin notification email sent successfully`);

    // Only send eBook link to buyer if email exists
    if (email) {
      await transporter.sendMail({
        from: `"CIDALI BookStore" <${EMAIL_USER}>`,
        to: email,
        subject: "Your eBook Purchase Confirmation",
        html: `
          <h2>Payment Successful!</h2>
          <p>Thank you for your purchase. You can now view your eBook below (valid for 30 minutes):</p>
          <p><a href="${ebookViewLink}" target="_blank">📘 Read Born Too Soon</a></p>
          <p>This link will expire automatically for your security.</p>
          <br/>
          <p>— CIDALI BookStore</p>
        `,
      });
      console.log(`✅ Email sent successfully to buyer: ${email}`);
    }

    res.json({
      success: true,
      message: "Payment processed successfully.",
      ebookLink: ebookViewLink,
    });
  } catch (err) {
    console.error("Callback error:", err.message);
    res.status(500).json({ error: "Callback failed", details: err.message });
  }
});



// 🧱 Serve PDF securely (view-only)
app.get("/api/secure-pdf/:filename", (req, res) => {
  const { filename } = req.params;
  const { token } = req.query;

  const entry = ebookTokens[token];
  if (!entry) return res.status(403).send("Invalid or missing token");
  if (Date.now() > entry.expiresAt) {
    delete ebookTokens[token];
    return res.status(403).send("Token expired");
  }
  if (entry.file !== filename) return res.status(403).send("Token mismatch");

  const filePath = path.join(process.cwd(), "public", filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("File not found");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=" + filename);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

app.get("/api/view/:filename", (req, res) => {
  const { filename } = req.params;
  const { token } = req.query;

  // Validate token before serving viewer
  const entry = ebookTokens[token];
  if (!entry || entry.file !== filename || Date.now() > entry.expiresAt) {
    return res.status(403).send("Invalid or expired token.");
  }

  // Serve the secure HTML viewer
  const viewerPath = path.join(process.cwd(), "public", "viewer.html");
  res.sendFile(viewerPath);
});

// 🟢 Delivery Payment
app.post("/api/mpesa/delivery", async (req, res) => {
  const { phone, transactionCode, address, amount } = req.body;

  if (!phone || !transactionCode || !address || !amount) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const token = await getAccessToken();
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString("base64");

    // 🧾 Send email on delivery STK initiation
    await transporter.sendMail({
      from: `"CIDALI BookStore" <${EMAIL_USER}>`,
      to: "info@cidalitravel.com",
      cc: "zekele.enterprise@gmail.com",
      subject: "Delivery Payment STK Initiated",
      html: `
        <h2>Delivery STK Push Initiated</h2>
        <p>Phone: ${phone}</p>
        <p>Amount: Ksh ${amount}</p>
        <p>Delivery Address: ${address}</p>
        <p>Status: Payment initiation in progress</p>
        <br/>
        <p>— CIDALI BookStore</p>
      `,
    });
    console.log("📧 Delivery initiation email sent to admin");

    const response = await axios.post(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: MPESA_CALLBACK_URL,
        AccountReference: "CIDALI Books Delivery",
        TransactionDesc: `Delivery Fee for ${address}`,
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log("Delivery STK Push response:", response.data);
    res.json(response.data);
  } catch (err) {
    console.error("Delivery STK Push error:", err.response?.data || err.message);
    res.status(500).json({ error: "Delivery STK push failed", details: err.message });
  }
});




// 🏠 Root route
app.get("/", (req, res) => res.send("✅ CIDALI BookStore backend running"));

// 🚀 Start server
const PORT = 5000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
