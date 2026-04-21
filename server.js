require("dotenv").config({ quiet: true });

const express = require("express");
const { askAI, saveConversationTurn } = require("./rag-service");

const app = express();
app.use(express.json());

const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

async function sendWhatsAppMessage(to, message) {
  const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

// ── Verificación Meta ─────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ── Mensajes entrantes ────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Siempre primero — evita reintento de Meta

  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    const metadata = value?.metadata;

    if (!message) return;

    const incomingPhoneNumberId = metadata?.phone_number_id;

    // 🔒 Solo procesa mensajes del número configurado
    if (incomingPhoneNumberId !== WHATSAPP_PHONE_NUMBER_ID) {
      console.log(`⏭️  Ignorando - número no autorizado: ${incomingPhoneNumberId}`);
      return;
    }

    const from = message.from;
    const text = message.text?.body;

    if (!text) return;

    console.log(`📩 [PE] ${from}: ${text}`);

    // Guardar mensaje usuario
    saveConversationTurn({
      userId: from,
      countryCode: "PE",
      role: "user",
      message: text,
      source: "whatsapp",
      metadata: {
        event: "incoming_whatsapp_message",
        wa_message_id: message.id || null,
        phone_number_id: incomingPhoneNumberId,
      },
    }).catch((err) => console.error("Error guardando user:", err.message));

    // RAG
    const result = await askAI(from, "PE", text);

    // Enviar respuesta
    await sendWhatsAppMessage(from, result.response);
    console.log(`✅ [PE] ${from} → ${result.metadata?.search_type} ${result.metadata?.total_ms}ms`);

    // Guardar respuesta asistente
    saveConversationTurn({
      userId: from,
      countryCode: "PE",
      role: "assistant",
      message: result.response,
      source: "whatsapp",
      metadata: {
        event: "outgoing_whatsapp_message",
        phone_number_id: incomingPhoneNumberId,
        ...(result.metadata || {}),
      },
    }).catch((err) => console.error("Error guardando assistant:", err.message));

  } catch (err) {
    console.error("❌ Error en webhook:", err.message);
  }
});

// ── Endpoint REST para testing / ChatFuel ─────────────────────
app.post("/ask", async (req, res) => {
  try {
    const { question, country_code, user_id, source } = req.body;

    if (!question) return res.status(400).json({ error: "Falta question" });
    if (!user_id) return res.status(400).json({ error: "Falta user_id" });

    const countryCode = country_code || "PE";
    const inputSource = source || "api";

    saveConversationTurn({
      userId: user_id, countryCode, role: "user",
      message: question, source: inputSource,
      metadata: { event: "incoming_message" },
    }).catch((err) => console.error("Error guardando user:", err.message));

    const result = await askAI(user_id, countryCode, question);

    res.json({ response: result.response, debug: result.metadata || {} });

    saveConversationTurn({
      userId: user_id, countryCode, role: "assistant",
      message: result.response, source: inputSource,
      metadata: { event: "assistant_response", ...(result.metadata || {}) },
    }).catch((err) => console.error("Error guardando assistant:", err.message));

  } catch (err) {
    console.error("Error en /ask:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`📱 Phone Number ID: ${WHATSAPP_PHONE_NUMBER_ID}`);
});