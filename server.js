require("dotenv").config({ quiet: true });

const express = require("express");
const { askAI, saveConversationTurn } = require("./rag-service");

const app = express();
app.use(express.json());

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

    // 1. Guarda mensaje del usuario en segundo plano
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
      console.error("Error guardando mensaje user:", err.message);
    });

    // 2. Responde
    const result = await askAI(user_id, countryCode, question);

    res.json({
      response: result.response,
      debug: {
        total_ms: result.metadata?.total_ms || 0,
        search_type: result.metadata?.search_type || null,
        history_used: result.metadata?.history_used || 0,
        search_ms: result.metadata?.search_ms || 0,
        semantic_ms: result.metadata?.semantic_ms || 0,
        llm_ms: result.metadata?.llm_ms || 0,
      },
    });

    // 3. Guarda respuesta del assistant en segundo plano
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
      console.error("Error guardando mensaje assistant:", err.message);
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});

app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "mi_token_seguro";

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message) {
      const from = message.from;
      const text = message.text?.body;

      console.log("Mensaje recibido:", text);

      // llamar a tu API IA
      const response = await fetch("https://TU-API/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: text,
          country_code: "PE",
          user_id: from,
        }),
      });

      const data = await response.json();

      await sendWhatsAppMessage(from, data.response);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.sendStatus(500);
  }
});
async function sendWhatsAppMessage(to, message) {
  await fetch(`https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    }),
  });
}