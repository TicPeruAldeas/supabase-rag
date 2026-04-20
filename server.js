require("dotenv").config({ quiet: true });

const express = require("express");
const { askAI, saveConversationTurn } = require("./rag-service");

const app = express();
app.use(express.json());

const ALLOWED_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

async function sendWhatsAppMessage(to, message) {
  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body: message,
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

app.get("/webhook", (req, res) => {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken) {
    console.log("Webhook verificado correctamente");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];
    const metadata = value?.metadata;

    if (!message) {
      return res.sendStatus(200);
    }

    const incomingPhoneNumberId = metadata?.phone_number_id;
    const from = message.from;
    const text = message.text?.body;

    // 🔒 SOLO TEST NUMBER
    if (incomingPhoneNumberId !== ALLOWED_PHONE_NUMBER_ID) {
      console.log("IGNORADO: no es test number ->", incomingPhoneNumberId);
      return res.sendStatus(200);
    }

    if (!text) {
      return res.sendStatus(200);
    }

    console.log("Mensaje recibido TEST:", from, text);

    // Guardado no bloqueante
    saveConversationTurn({
      userId: from,
      countryCode: "PE",
      role: "user",
      message: text,
      source: "whatsapp_test",
      metadata: {
        event: "incoming_whatsapp_message",
        wa_message_id: message.id || null,
        phone_number_id: incomingPhoneNumberId,
      },
    }).catch((err) => {
      console.error("Error guardando user:", err.message);
    });

    const result = await askAI(from, "PE", text);

    await sendWhatsAppMessage(from, result.response);

    saveConversationTurn({
      userId: from,
      countryCode: "PE",
      role: "assistant",
      message: result.response,
      source: "whatsapp_test",
      metadata: {
        event: "outgoing_whatsapp_message",
        phone_number_id: incomingPhoneNumberId,
        ...(result.metadata || {}),
      },
    }).catch((err) => {
      console.error("Error guardando assistant:", err.message);
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error("Error en webhook:", err.message);
    return res.sendStatus(500);
  }
});

app.post("/ask", async (req, res) => {
  try {
    const { question, country_code, user_id, source } = req.body;

    if (!question) {
      return res.status(400).json({ error: "Falta question" });
    }

    if (!user_id) {
      return res.status(400).json({ error: "Falta user_id" });
    }

    const countryCode = country_code || "PE";
    const inputSource = source || "api";

    saveConversationTurn({
      userId: user_id,
      countryCode,
      role: "user",
      message: question,
      source: inputSource,
      metadata: {
        event: "incoming_message",
      },
    }).catch((err) => {
      console.error("Error guardando user:", err.message);
    });

    const result = await askAI(user_id, countryCode, question);

    res.json({
      response: result.response,
      debug: result.metadata || {},
    });

    saveConversationTurn({
      userId: user_id,
      countryCode,
      role: "assistant",
      message: result.response,
      source: inputSource,
      metadata: {
        event: "assistant_response",
        ...(result.metadata || {}),
      },
    }).catch((err) => {
      console.error("Error guardando assistant:", err.message);
    });
  } catch (err) {
    console.error("Error en /ask:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
  console.log("Solo se procesará test number:", ALLOWED_PHONE_NUMBER_ID);
});