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
const { buildFlowEmbeddingInput } = require("./embedding-text");

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

// Edad máxima de un mensaje entrante. Mensajes más viejos (reentregas de Meta
// tras un redeploy) se descartan para no responder mensajes "fantasma".
const MAX_INBOUND_MESSAGE_AGE_MS = (Number(process.env.MAX_INBOUND_MESSAGE_AGE_SECONDS) || 180) * 1000;

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

// ── Enviar mensaje interactivo con botones (WhatsApp) ─────────
async function sendWhatsAppButton(to, bodyText, buttons, phoneNumberId, token) {
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
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: b })) },
      },
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

// ── Consentimiento (pantalla "Continuar" al iniciar conversación) ──
// Se pide al inicio de cada CONVERSACIÓN nueva: si el usuario no aceptó dentro
// de la ventana de sesión, se muestra la tarjeta con el botón Continuar y no se
// procesa la consulta hasta que acepte. El consentimiento se registra como un
// turno role="system" (invisible al historial/citas) con event=consent_accepted.
const CONSENT_SESSION_MS = (Number(process.env.CONSENT_SESSION_HOURS) || 24) * 60 * 60 * 1000;
const CONSENT_BUTTON_ID = "consent_continue";
const CONSENT_TEXT_REGEX = /^\s*(continuar|acepto|aceptar|s[ií][\s,]+acepto|de acuerdo|estoy de acuerdo)\b/i;

function isConsentAcceptance(buttonId, text) {
  return buttonId === CONSENT_BUTTON_ID || CONSENT_TEXT_REGEX.test(text || "");
}

function buildConsentText(userName) {
  const saludo = userName ? `Hola ${userName}` : "Hola";
  return `${saludo}, soy el asistente virtual de Aldeas Infantiles SOS. Estoy aquí para orientarte sobre nuestros programas y servicios. Recuerda que tus consultas son confidenciales y se tratan con los estándares de seguridad y privacidad de la organización.\n\nPor favor, presiona el botón "Continuar" para comenzar 👇`;
}

async function hasRecentConsent(userId, countryCode) {
  const cutoff = new Date(Date.now() - CONSENT_SESSION_MS).toISOString();
  // El consentimiento se detecta por el turno de aceptación del usuario
  // (event=consent_accept, role="user"). La tabla `conversations` de Aldeas
  // solo admite roles user/assistant (constraint conversations_role_check), por
  // eso NO se usa un turno role="system" como marcador.
  const { data, error } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .eq("country_code", countryCode)
    .contains("metadata", { event: "consent_accept" })
    .gte("created_at", cutoff)
    .limit(1);
  if (error) {
    // Ante un error de BD no bloqueamos al usuario (fail-open).
    console.error(`⚠️  hasRecentConsent [${userId}/${countryCode}]:`, error.message);
    return true;
  }
  return (data || []).length > 0;
}

async function sendConsentCard(to, userName, phoneNumberId, token) {
  await sendWhatsAppButton(
    to,
    buildConsentText(userName),
    [{ id: CONSENT_BUTTON_ID, title: "Continuar" }],
    phoneNumberId,
    token
  );
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

// ── Panel de administración (visor de conversaciones) ─────────
app.use("/admin", require("./admin")(supabase));

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

// ── Cola por usuario (serialización) ──────────────────────────
// Meta puede entregar varios mensajes del mismo usuario casi a la vez. Sin
// serializar, se procesan en paralelo y se pisan el conversation_state (un
// mensaje cancela el flujo mientras otro lo avanza). Encadenamos las tareas
// del mismo usuario para que se ejecuten en orden, una tras otra.
const userQueues = new Map(); // key (país:usuario) → promesa con la cola de tareas

function runSerialized(key, task) {
  const prev = userQueues.get(key) || Promise.resolve();
  // .catch en la tarea → la cola nunca queda en estado rechazado y la siguiente
  // tarea siempre arranca, haya fallado o no la anterior.
  const current = prev.then(() => task()).catch((err) =>
    console.error(`❌ Error en tarea serializada [${key}]:`, err.message)
  );
  userQueues.set(key, current);
  // Libera la entrada cuando esta tarea es la última de la cola (evita fuga de memoria).
  current.finally(() => {
    if (userQueues.get(key) === current) userQueues.delete(key);
  });
  return current;
}

// Procesa un mensaje entrante completo: guarda turno, consulta RAG, responde y
// guarda la respuesta. Los `await` de guardado mantienen el orden cronológico en
// la BD para que el historial del siguiente mensaje sea consistente.
async function handleIncomingMessage({ from, text, countryCode, phoneNumberId, token, messageId, incomingPhoneNumberId }) {
  try {
    console.log(`📩 [${countryCode}] ${from}: ${text}`);

    await saveConversationTurn({
      userId: from,
      countryCode,
      role: "user",
      message: text,
      source: "whatsapp",
      metadata: {
        event: "incoming_whatsapp_message",
        wa_message_id: messageId,
        phone_number_id: incomingPhoneNumberId,
      },
    }).catch((err) => console.error("Error guardando user:", err.message));

    const result = await askAI(from, countryCode, text, {
      source: "whatsapp",
      waMessageId: messageId,
      phoneNumberId: incomingPhoneNumberId,
    });

    await sendWhatsAppMessage(from, result.response, phoneNumberId, token);
    console.log(`✅ [${countryCode}] ${from} → ${result.metadata?.search_type} ${result.metadata?.total_ms}ms`);

    await saveConversationTurn({
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
    console.error("❌ Error procesando mensaje:", err.message);
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

// ── Gate de consentimiento + ruteo del mensaje ────────────────
// 1. Si el mensaje es la aceptación (botón Continuar o "acepto"): registra el
//    consentimiento y da la bienvenida.
// 2. Si no hay consentimiento vigente en la sesión: envía la tarjeta Continuar
//    y NO procesa la consulta todavía.
// 3. Si ya consintió: procesa el mensaje normalmente.
async function handleConsentGate({ from, text, buttonId, userName, countryCode, phoneNumberId, token, messageId, incomingPhoneNumberId }) {
  // Texto que representa lo que envió el usuario (un botón sin texto = "Continuar").
  const inbound = text || (buttonId ? "Continuar" : "");
  try {
    if (isConsentAcceptance(buttonId, text)) {
      // Guarda el "Continuar" del usuario: este turno (event=consent_accept) es
      // el que marca el consentimiento vigente (ver hasRecentConsent).
      await saveConversationTurn({
        userId: from, countryCode, role: "user", message: inbound, source: "whatsapp",
        metadata: { event: "consent_accept", wa_message_id: messageId, phone_number_id: incomingPhoneNumberId },
      }).catch((err) => console.error("Error guardando aceptación:", err.message));

      const saludo = userName ? `¡Gracias, ${userName}!` : "¡Gracias!";
      const welcome = `${saludo} Soy el asistente virtual de Aldeas Infantiles SOS. Cuéntame en qué puedo orientarte hoy —sobre nuestros programas, servicios o cómo acceder a ellos.`;
      await sendWhatsAppMessage(from, welcome, phoneNumberId, token);
      await saveConversationTurn({
        userId: from, countryCode, role: "assistant", message: welcome, source: "whatsapp",
        metadata: { event: "consent_welcome", phone_number_id: incomingPhoneNumberId },
      }).catch((err) => console.error("Error guardando bienvenida:", err.message));
      console.log(`✅ [${countryCode}] ${from} aceptó el consentimiento`);
      return;
    }

    if (!(await hasRecentConsent(from, countryCode))) {
      // Guarda el mensaje del usuario y la tarjeta para reflejar el hilo completo.
      if (inbound) {
        await saveConversationTurn({
          userId: from, countryCode, role: "user", message: inbound, source: "whatsapp",
          metadata: { event: "incoming_whatsapp_message", wa_message_id: messageId, phone_number_id: incomingPhoneNumberId },
        }).catch((err) => console.error("Error guardando entrante:", err.message));
      }
      const card = buildConsentText(userName);
      await sendConsentCard(from, userName, phoneNumberId, token);
      await saveConversationTurn({
        userId: from, countryCode, role: "assistant", message: card, source: "whatsapp",
        metadata: { event: "consent_prompt", phone_number_id: incomingPhoneNumberId },
      }).catch((err) => console.error("Error guardando tarjeta:", err.message));
      console.log(`📋 [${countryCode}] ${from} — tarjeta de consentimiento enviada`);
      return;
    }

    // Ya consintió: procesa solo si hay texto (handleIncomingMessage guarda los turnos).
    if (!text) return;
    await handleIncomingMessage({ from, text, countryCode, phoneNumberId, token, messageId, incomingPhoneNumberId });
  } catch (err) {
    console.error("❌ Error en gate de consentimiento:", err.message);
  }
}

// ── Mensajes entrantes ────────────────────────────────────────
app.post("/webhook", (req, res) => {
  // Rechaza cualquier POST que no esté firmado por Meta con el App Secret.
  if (!verifyMetaSignature(req)) {
    console.warn("⚠️  Firma de Meta inválida o ausente — webhook rechazado");
    return res.sendStatus(403);
  }

  res.sendStatus(200); // Siempre primero — evita reintento de Meta

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

  const { countryCode, phoneNumberId, token } = countryConfig;
  const from = message.from;
  const userName = value?.contacts?.[0]?.profile?.name || null;
  const text = message.text?.body;
  // Respuesta a un botón/lista interactiva (p. ej. el botón "Continuar").
  const buttonId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || null;

  if (!text && !buttonId) return;

  // Descarta mensajes viejos: tras un redeploy, el dedup en memoria se borra y
  // Meta puede reentregar webhooks pendientes de mensajes antiguos. El timestamp
  // (hora en que el usuario lo envió) permite ignorarlos para no responder
  // mensajes "fantasma" que el usuario percibe como no enviados.
  const messageAgeMs = Date.now() - Number(message.timestamp) * 1000;
  if (Number.isFinite(messageAgeMs) && messageAgeMs > MAX_INBOUND_MESSAGE_AGE_MS) {
    console.log(`⏭️  Mensaje viejo ignorado (${Math.round(messageAgeMs / 1000)}s): ${message.id}`);
    return;
  }

  // Ignora reintentos de Meta del mismo mensaje
  if (alreadyProcessed(message.id)) {
    console.log(`⏭️  Mensaje duplicado ignorado: ${message.id}`);
    return;
  }

  // Serializa por usuario: los mensajes del mismo número se procesan en orden.
  runSerialized(`${countryCode}:${from}`, () =>
    handleConsentGate({
      from,
      text,
      buttonId,
      userName,
      countryCode,
      phoneNumberId,
      token,
      messageId: message.id || null,
      incomingPhoneNumberId,
    })
  );
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
    const embeddingInput = buildFlowEmbeddingInput({
      category: Categoria,
      subtopic: Subtema,
      question: Pregunta,
      answer: Respuesta,
    });
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: embeddingInput,
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
