require("dotenv").config({ quiet: true });

const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",        // embeddings (text-embedding-3-small)
  "ANTHROPIC_API_KEY",     // LLM (Claude)
  "WHATSAPP_VERIFY_TOKEN",
  "INGEST_SECRET",
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Variables de entorno faltantes: ${missing.join(", ")}`);
  process.exit(1);
}

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai").default;
const Anthropic = require("@anthropic-ai/sdk");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const express = require("express");
const { askAI, saveConversationTurn } = require("./rag-service");

const CLAUDE_MODEL = "claude-sonnet-4-6";

// App Secret de la app de Meta — valida la firma X-Hub-Signature-256 del webhook.
// .trim(): Railway suele dejar un salto de línea/espacio al pegar el valor, lo
// que rompe el HMAC. Lo limpiamos para evitar firmas inválidas con tráfico real.
const META_APP_SECRET = (process.env.META_APP_SECRET || "").trim() || undefined;
if (!META_APP_SECRET) {
  console.warn("⚠️  META_APP_SECRET no configurado — el webhook NO verificará la firma de Meta (riesgo de mensajes falsos).");
}

const app = express();
// Guardamos el cuerpo crudo para poder verificar el HMAC de Meta byte a byte.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// ── Verificación de firma del webhook de Meta ─────────────────
// Meta firma cada POST con HMAC-SHA256(appSecret, rawBody). Si la firma no
// coincide, el mensaje no proviene de Meta y se rechaza.
function verifyMetaSignature(req) {
  if (!META_APP_SECRET) return true; // sin secret configurado no se puede validar (warning al arranque)
  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !req.rawBody) {
    console.warn(`🔏 Firma ausente: header=${Boolean(signature)} rawBody=${Boolean(req.rawBody)}`);
    return false;
  }

  const expected = "sha256=" + crypto
    .createHmac("sha256", META_APP_SECRET)
    .update(req.rawBody)
    .digest("hex");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  const ok = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

  if (!ok) {
    // Diagnóstico sin filtrar el secret: si rawBodyLen != contentLength → body
    // alterado; si secretLen != 32 → valor mal pegado (debe ser 32 hex).
    console.warn(
      `🔏 Firma inválida — recibida=${signature.slice(0, 16)}… esperada=${expected.slice(0, 16)}… ` +
      `rawBodyLen=${req.rawBody.length} contentLength=${req.headers["content-length"]} secretLen=${META_APP_SECRET.length}`
    );
  }
  return ok;
}

// ── Mapa multi-país: phoneNumberId → { countryCode, phoneNumberId, token }
// Formato nuevo: WHATSAPP_PHONE_NUMBER_ID_PE + WHATSAPP_TOKEN_PE (por cada país)
// Formato legacy: WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_TOKEN (se asume PE)
const COUNTRY_MAP = {};

for (const [key, value] of Object.entries(process.env)) {
  const match = key.match(/^WHATSAPP_PHONE_NUMBER_ID_([A-Z]{2})$/);
  if (match && value) {
    const cc = match[1];
    const token = process.env[`WHATSAPP_TOKEN_${cc}`];
    if (token) {
      COUNTRY_MAP[value] = { countryCode: cc, phoneNumberId: value, token };
    } else {
      console.warn(`⚠️  WHATSAPP_TOKEN_${cc} no configurado — se ignorará ${cc}`);
    }
  }
}

// Compatibilidad con formato de un solo país
if (Object.keys(COUNTRY_MAP).length === 0 &&
    process.env.WHATSAPP_PHONE_NUMBER_ID &&
    process.env.WHATSAPP_TOKEN) {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  COUNTRY_MAP[id] = { countryCode: "PE", phoneNumberId: id, token: process.env.WHATSAPP_TOKEN };
  console.warn("⚠️  Formato legacy detectado. Migra a WHATSAPP_PHONE_NUMBER_ID_XX / WHATSAPP_TOKEN_XX");
}

if (Object.keys(COUNTRY_MAP).length === 0) {
  console.error("❌ No hay países configurados. Define WHATSAPP_PHONE_NUMBER_ID_XX y WHATSAPP_TOKEN_XX para cada país.");
  process.exit(1);
}

const configuredCountries = [...new Set(Object.values(COUNTRY_MAP).map(c => c.countryCode))];
console.log(`🌎 Países configurados: ${configuredCountries.join(", ")}`);

const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ASK_SECRET = process.env.ASK_SECRET || process.env.INGEST_SECRET;

// ── Dedup de reintentos de Meta ───────────────────────────────
// Meta reenvía el mismo mensaje si el webhook tarda en responder. Recordamos
// los wa_message_id recientes para no procesar (ni responder) dos veces.
const seenMessageIds = new Map(); // wa_message_id → timestamp
const MESSAGE_DEDUP_TTL_MS = 5 * 60 * 1000;

function alreadyProcessed(messageId) {
  if (!messageId) return false;
  const now = Date.now();

  if (seenMessageIds.size > 1000) {
    for (const [id, ts] of seenMessageIds) {
      if (now - ts > MESSAGE_DEDUP_TTL_MS) seenMessageIds.delete(id);
    }
  }

  const seen = seenMessageIds.get(messageId);
  if (seen && now - seen < MESSAGE_DEDUP_TTL_MS) return true;

  seenMessageIds.set(messageId, now);
  return false;
}

function hasBearerSecret(req, secret) {
  const authHeader = req.headers["authorization"];
  const apiKey = req.headers["x-api-key"];
  return authHeader === `Bearer ${secret}` || apiKey === secret;
}

// ── Enviar mensaje por WhatsApp (usa credenciales del país) ───
async function sendWhatsAppMessage(to, message, phoneNumberId, token) {
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
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

// ── Procesar pasos "paso a paso" en background ────────────────
// Se ejecuta fuera del ciclo request/response de /ingest-row para no exceder
// el timeout del webhook (Make): cada paso requiere una llamada a Claude.
// Los resúmenes se generan en paralelo para minimizar la latencia total.
async function processStepsInBackground(flowId, answer, countryCode) {
  const lines = answer.split("\n").map((l) => l.trim()).filter(Boolean);
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
  if (steps.length === 0) return;

  await supabase
    .from("knowledge_steps")
    .delete()
    .eq("flow_id", flowId)
    .eq("country_code", countryCode);

  await Promise.all(steps.map(async (step) => {
    const summaryResponse = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 100,
      system: "Resume el siguiente paso en máximo 2 líneas cortas y claras en español. Sin markdown.",
      messages: [{
        role: "user",
        content: `Paso ${step.number} de ${steps.length}:\n${step.text}`,
      }],
    });

    await supabase.from("knowledge_steps").upsert({
      flow_id: flowId,
      step_number: step.number,
      step_summary: summaryResponse.content[0].text.trim(),
      step_detail: step.text,
      country_code: countryCode,
      source_name: "google_sheets",
      updated_at: new Date().toISOString(),
    }, { onConflict: "flow_id,country_code,step_number" });
  }));

  console.log(`✅ ${steps.length} pasos procesados en background [${flowId}]`);
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
  // Rechaza cualquier POST que no esté firmado por Meta con el App Secret.
  if (!verifyMetaSignature(req)) {
    console.warn("⚠️  Firma de Meta inválida o ausente — webhook rechazado");
    return res.sendStatus(403);
  }

  res.sendStatus(200); // Siempre primero — evita reintento de Meta

  // Hoisted para poder enviar un fallback al usuario si algo falla más abajo.
  let from = null;
  let phoneNumberId = null;
  let token = null;

  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    const metadata = value?.metadata;

    if (!message) return;

    const incomingPhoneNumberId = metadata?.phone_number_id;
    const countryConfig = COUNTRY_MAP[incomingPhoneNumberId];

    if (!countryConfig) {
      console.log(`⏭️  Ignorando — número no configurado: ${incomingPhoneNumberId}`);
      return;
    }

    const { countryCode } = countryConfig;
    ({ phoneNumberId, token } = countryConfig);
    from = message.from;
    const text = message.text?.body;

    if (!text) return;

    // Ignora reintentos de Meta del mismo mensaje
    if (alreadyProcessed(message.id)) {
      console.log(`⏭️  Mensaje duplicado ignorado: ${message.id}`);
      return;
    }

    console.log(`📩 [${countryCode}] ${from}: ${text}`);

    saveConversationTurn({
      userId: from,
      countryCode,
      role: "user",
      message: text,
      source: "whatsapp",
      metadata: {
        event: "incoming_whatsapp_message",
        wa_message_id: message.id || null,
        phone_number_id: incomingPhoneNumberId,
      },
    }).catch((err) => console.error("Error guardando user:", err.message));

    const result = await askAI(from, countryCode, text, {
      source: "whatsapp",
      waMessageId: message.id || null,
      phoneNumberId: incomingPhoneNumberId,
    });

    await sendWhatsAppMessage(from, result.response, phoneNumberId, token);
    console.log(`✅ [${countryCode}] ${from} → ${result.metadata?.search_type} ${result.metadata?.total_ms}ms`);

    saveConversationTurn({
      userId: from,
      countryCode,
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

    // Si ya identificamos al usuario y su país, avisarle en vez de dejarlo sin respuesta.
    if (from && phoneNumberId && token) {
      try {
        await sendWhatsAppMessage(
          from,
          "Disculpa, estamos teniendo un problema técnico en este momento. Por favor intenta de nuevo en unos minutos.",
          phoneNumberId,
          token
        );
      } catch (sendErr) {
        console.error("❌ Error enviando fallback:", sendErr.message);
      }
    }
  }
});

// ── Endpoint REST para testing / ChatFuel ─────────────────────
app.post("/ask", async (req, res) => {
  if (!hasBearerSecret(req, ASK_SECRET)) {
    return res.status(401).json({ error: "No autorizado" });
  }

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

    const result = await askAI(user_id, countryCode, question, {
      source: inputSource,
    });

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

  const authHeader = req.headers["authorization"];
  if (!authHeader || authHeader !== `Bearer ${INGEST_SECRET}`) {
    return res.status(401).json({ error: "No autorizado" });
  }

  try {
    const { ID, Categoria, Subtema, Pregunta, Respuesta, Tipo, country_code } = req.body;

    if (!ID || !Pregunta || !Respuesta || !Tipo) {
      return res.status(400).json({ error: "Faltan campos obligatorios: ID, Pregunta, Respuesta, Tipo" });
    }

    const rowCountryCode = country_code || "PE";
    const flowType = Tipo.toString().trim().toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "");

    // Generar embedding con OpenAI (Anthropic no tiene API de embeddings)
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
        country_code: rowCountryCode,
        embedding,
        source_name: "google_sheets",
        updated_at: new Date().toISOString(),
      }, { onConflict: "flow_id,country_code" });

    if (flowError) throw new Error(flowError.message);

    console.log(`✅ Fila ingestada: ${ID} [${flowType}] [${rowCountryCode}]`);
    res.json({ success: true, flow_id: ID, flow_type: flowType, country_code: rowCountryCode });

    // Los pasos requieren una llamada a Claude por cada uno: se procesan en
    // background para que la respuesta a Make no dependa de ello (evita timeout).
    if (flowType === "paso a paso" || flowType === "paso_a_paso") {
      processStepsInBackground(ID, Respuesta, rowCountryCode).catch((err) =>
        console.error(`❌ Error procesando pasos en background [${ID}]:`, err.message)
      );
    }

  } catch (err) {
    console.error("❌ Error en /ingest-row:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});
