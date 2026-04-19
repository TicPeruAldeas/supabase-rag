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