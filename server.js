require("dotenv").config({ quiet: true });

const express = require("express");
const { askAI, saveConversationTurn } = require("./rag-service");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
// ── Endpoint para Make / ingestión de filas ───────────────────
app.post("/ingest-row", async (req, res) => {
  const INGEST_SECRET = process.env.INGEST_SECRET;

  // Validar token secreto
  const authHeader = req.headers["authorization"];
  if (!authHeader || authHeader !== `Bearer ${INGEST_SECRET}`) {
    return res.status(401).json({ error: "No autorizado" });
  }

  try {
    const { ID, Categoria, Subtema, Pregunta, Respuesta, Tipo } = req.body;

    if (!ID || !Pregunta || !Respuesta || !Tipo) {
      return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    const flowType = Tipo.toString().trim().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // Generar embedding
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: Pregunta,
    });
    const embedding = embeddingResponse.data[0].embedding;

    // Upsert en knowledge_flows
    const { error: flowError } = await supabase
      .from("knowledge_flows")
      .upsert({
        flow_id: ID,
        category: Categoria || null,
        subtopic: Subtema || null,
        question: Pregunta,
        answer: Respuesta,
        flow_type: flowType,
        country_code: "PE",
        embedding,
        source_name: "google_sheets",
        updated_at: new Date().toISOString(),
      }, { onConflict: "flow_id" });

    if (flowError) throw new Error(flowError.message);

    // Si es paso a paso, procesar pasos
    if (flowType === "paso a paso" || flowType === "paso_a_paso") {
      const lines = Respuesta.split("\n").map(l => l.trim()).filter(Boolean);
      const steps = [];
      let currentStep = null;

      for (const line of lines) {
        const match = line.match(/^(\d+)\.\s+(.+)/);
        if (match) {
          if (currentStep) steps.push(currentStep);
          currentStep = { number: parseInt(match[1]), text: match[2] };
        } else if (currentStep) {
          currentStep.text += " " + line;
        }
      }
      if (currentStep) steps.push(currentStep);

      if (steps.length > 0) {
        // Eliminar pasos anteriores
        await supabase.from("knowledge_steps").delete().eq("flow_id", ID);

        // Insertar pasos nuevos con resumen IA
        for (const step of steps) {
          const summaryResponse = await openai.responses.create({
            model: "gpt-4o-mini",
            max_output_tokens: 60,
            input: [
              { role: "system", content: "Resume el siguiente paso en máximo 2 líneas cortas y claras en español. Sin markdown." },
              { role: "user", content: `Paso ${step.number} de ${steps.length}:\n${step.text}` }
            ]
          });

          await supabase.from("knowledge_steps").insert({
            flow_id: ID,
            step_number: step.number,
            step_summary: summaryResponse.output_text.trim(),
            step_detail: step.text,
            country_code: "PE",
            source_name: "google_sheets",
            updated_at: new Date().toISOString(),
          });
        }
      }
    }

    console.log(`✅ Fila ingestada desde Make: ${ID} [${flowType}]`);
    res.json({ success: true, flow_id: ID, flow_type: flowType });

  } catch (err) {
    console.error("❌ Error en /ingest-row:", err.message);
    res.status(500).json({ error: err.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`📱 Phone Number ID: ${WHATSAPP_PHONE_NUMBER_ID}`);
});