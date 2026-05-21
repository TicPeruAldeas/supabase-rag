require("dotenv").config({ quiet: true });

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai").default;
const Anthropic = require("@anthropic-ai/sdk");
const { getCached, setCached } = require("./cache");

if (!process.env.SUPABASE_URL) throw new Error("Falta SUPABASE_URL");
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");
if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");
if (!process.env.ANTHROPIC_API_KEY) throw new Error("Falta ANTHROPIC_API_KEY");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Langfuse es opcional — si no está configurado, las trazas se omiten silenciosamente
let langfuse = null;
if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
  const { Langfuse } = require("langfuse");
  langfuse = new Langfuse({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_HOST || "https://cloud.langfuse.com",
  });
  console.log("📊 Langfuse conectado");
} else {
  console.log("ℹ️  Langfuse no configurado (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY)");
}

// Modelo Claude para generación de texto
// Nota: claude-sonnet-4-6 es el sucesor de claude-sonnet-4-20250514
const CLAUDE_MODEL = "claude-sonnet-4-6";

// Nombre de la organización por país para el system prompt
const COUNTRY_ORGS = {
  PE: "Aldeas Infantiles SOS Perú",
  CO: "Aldeas Infantiles SOS Colombia",
  MX: "Aldeas Infantiles SOS México",
  BO: "Aldeas Infantiles SOS Bolivia",
  EC: "Aldeas Infantiles SOS Ecuador",
  CL: "Aldeas Infantiles SOS Chile",
  AR: "Aldeas Infantiles SOS Argentina",
  PY: "Aldeas Infantiles SOS Paraguay",
  UY: "Aldeas Infantiles SOS Uruguay",
};

const SMALL_TALK_REGEX = /^(hola|buenos|buenas|hi|hey|gracias|ok|okay|sí|si|no|perfecto|genial|entendido|como estas|buen dia|buenas tardes|buenas noches|👍|😊)[\s!?.]*$/i;

// ── Detectar intención del usuario en flujo activo ────────────
async function detectIntent(userMessage, trace) {
  const gen = trace?.generation({
    name: "detect-intent",
    model: CLAUDE_MODEL,
    input: userMessage,
  });

  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16,
    system: `Clasifica el mensaje en una de estas intenciones:
- "mas_detalle": quiere más información sobre lo explicado
- "siguiente": quiere continuar al siguiente paso
- "terminar": agradece, entendió, se despide
- "otro": pregunta algo completamente diferente
Responde SOLO con una palabra: mas_detalle, siguiente, terminar, otro`,
    messages: [{ role: "user", content: userMessage }],
  });

  const intent = msg.content[0].text.trim().toLowerCase();
  gen?.end({
    output: intent,
    usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens },
  });
  return intent;
}

// ── Estado conversacional ─────────────────────────────────────
async function getActiveState(userId, countryCode) {
  const { data } = await supabase
    .from("conversation_state")
    .select("*")
    .eq("user_id", userId)
    .eq("country_code", countryCode)
    .eq("status", "active")
    .single();
  return data || null;
}

async function upsertState(userId, countryCode, flowId, flowType, currentStep, totalSteps, status = "active") {
  await supabase
    .from("conversation_state")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("country_code", countryCode)
    .eq("status", "active");

  if (status === "cancelled") return;

  await supabase.from("conversation_state").insert({
    user_id: userId,
    country_code: countryCode,
    flow_id: flowId,
    flow_type: flowType,
    current_step: currentStep,
    total_steps: totalSteps,
    status,
    updated_at: new Date().toISOString(),
  });
}

async function updateStep(stateId, currentStep, status = "active") {
  await supabase
    .from("conversation_state")
    .update({ current_step: currentStep, status, updated_at: new Date().toISOString() })
    .eq("id", stateId);
}

// ── Historial reciente ────────────────────────────────────────
async function getRecentHistory(userId, countryCode, limit = 4) {
  const { data, error } = await supabase
    .from("conversations")
    .select("role, message, created_at")
    .eq("user_id", userId)
    .eq("country_code", countryCode)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).reverse().map(item => ({ role: item.role, content: item.message }));
}

// ── Guardar turno ─────────────────────────────────────────────
async function saveConversationTurn({ userId, countryCode, role, message, source = "api", metadata = {} }) {
  const { error } = await supabase
    .from("conversations")
    .insert({ user_id: userId, country_code: countryCode, role, message, source, metadata });
  if (error) throw error;
}

// ── Buscar flow (Excel) ───────────────────────────────────────
async function searchFlow(countryCode, question) {
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: question,
  });
  const queryEmbedding = embeddingResponse.data[0].embedding;

  const { data, error } = await supabase.rpc("match_flows_by_country", {
    query_embedding: queryEmbedding,
    filter_country: countryCode,
    match_count: 1,
    min_similarity: 0.50,
  });

  if (error) throw error;
  return data?.[0] || null;
}

// ── Búsqueda semántica (PDF) ──────────────────────────────────
async function searchSemantic(countryCode, question, matchCount = 5) {
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: question,
  });
  const queryEmbedding = embeddingResponse.data[0].embedding;

  const { data, error } = await supabase.rpc("match_knowledge_by_country", {
    query_embedding: queryEmbedding,
    filter_country: countryCode,
    match_count: matchCount,
  });

  if (error) throw error;
  return (data || []).filter(item => item.similarity >= 0.45);
}

// ── Búsqueda rápida keyword ───────────────────────────────────
async function searchFast(countryCode, question, limit = 3) {
  const keywords = question.split(/\s+/).filter(w => w.length > 4).slice(0, 3);
  if (keywords.length === 0) return [];
  const keyword = keywords.sort((a, b) => b.length - a.length)[0];

  const { data, error } = await supabase
    .from("knowledge_chunks")
    .select("chunk_text, source_name")
    .ilike("chunk_text", `%${keyword}%`)
    .eq("country_code", countryCode)
    .limit(limit);

  if (error) return [];
  return data || [];
}

function mergeResults(semanticResults, fastResults) {
  const seen = new Set();
  const merged = [];
  for (const item of [...semanticResults, ...fastResults]) {
    const key = item.chunk_text?.slice(0, 80);
    if (key && !seen.has(key)) { seen.add(key); merged.push(item); }
  }
  return merged.slice(0, 6);
}

// ── Manejar PASO A PASO ───────────────────────────────────────
async function handlePasoAPaso(userId, countryCode, question, state, trace) {
  const intent = await detectIntent(question, trace);
  console.log(`🎯 Intent: ${intent} (paso ${state.current_step}/${state.total_steps})`);

  if (intent === "terminar") {
    await updateStep(state.id, state.current_step, "completed");
    return { response: "¡Entendido! Si necesitas más ayuda, con gusto te orientamos.", metadata: { flow_type: "paso_a_paso" } };
  }

  if (intent === "otro") {
    await updateStep(state.id, state.current_step, "cancelled");
    return null;
  }

  if (intent === "mas_detalle") {
    const { data: stepData } = await supabase
      .from("knowledge_steps")
      .select("step_detail, step_number")
      .eq("flow_id", state.flow_id)
      .eq("step_number", state.current_step)
      .single();

    if (!stepData) return { response: "No tengo más detalle sobre este paso. ¿Quieres continuar con el siguiente?", metadata: { flow_type: "paso_a_paso" } };

    return {
      response: `Detalle del paso ${state.current_step}:\n\n${stepData.step_detail}\n\n¿Quieres continuar con el paso ${state.current_step + 1 <= state.total_steps ? state.current_step + 1 : "siguiente"}?`,
      metadata: { flow_type: "paso_a_paso" }
    };
  }

  // siguiente
  const nextStep = state.current_step + 1;
  if (nextStep > state.total_steps) {
    await updateStep(state.id, state.current_step, "completed");
    return { response: "✅ Hemos terminado todos los pasos. ¿Hay algo más en lo que pueda ayudarte?", metadata: { flow_type: "paso_a_paso" } };
  }

  const { data: nextStepData } = await supabase
    .from("knowledge_steps")
    .select("step_summary, step_number")
    .eq("flow_id", state.flow_id)
    .eq("step_number", nextStep)
    .single();

  if (!nextStepData) {
    await updateStep(state.id, state.current_step, "completed");
    return { response: "✅ Eso es todo. ¿Necesitas ayuda con algo más?", metadata: { flow_type: "paso_a_paso" } };
  }

  await updateStep(state.id, nextStep);
  const isLastStep = nextStep >= state.total_steps;
  return {
    response: `Paso ${nextStep} de ${state.total_steps}:\n\n${nextStepData.step_summary}\n\n${isLastStep ? "Este es el último paso. ¿Quieres más detalle o ya tienes todo claro?" : `¿Quieres más detalle, continuar al paso ${nextStep + 1}, o ya tienes todo claro?`}`,
    metadata: { flow_type: "paso_a_paso", step: nextStep }
  };
}

// ── Core RAG ──────────────────────────────────────────────────
async function askAI(userId, countryCode, question) {
  const totalStart = Date.now();
  const orgName = COUNTRY_ORGS[countryCode] || `Aldeas Infantiles SOS (${countryCode})`;

  const trace = langfuse?.trace({
    name: "rag-query",
    userId,
    metadata: { countryCode, orgName },
    input: question,
  });

  // 1. SMALL TALK
  if (SMALL_TALK_REGEX.test(question.trim())) {
    const response = `¡Hola! Soy el asistente virtual de ${orgName}. ¿En qué puedo ayudarte hoy?`;
    trace?.update({ output: response, metadata: { search_type: "small_talk" } });
    langfuse?.flushAsync().catch(() => {});
    return { response, metadata: { search_type: "small_talk", total_ms: Date.now() - totalStart } };
  }

  // 2. ¿Flujo activo?
  const activeState = await getActiveState(userId, countryCode);
  if (activeState) {
    console.log(`🔄 Flujo activo: ${activeState.flow_id} [${activeState.flow_type}]`);
    if (activeState.flow_type === "paso a paso" || activeState.flow_type === "paso_a_paso") {
      const result = await handlePasoAPaso(userId, countryCode, question, activeState, trace);
      if (result) {
        trace?.update({ output: result.response, metadata: result.metadata });
        langfuse?.flushAsync().catch(() => {});
        return result;
      }
    }
  }

  // 3. CACHE
  const cached = getCached(countryCode, question);
  if (cached) {
    trace?.update({ output: cached, metadata: { search_type: "cache" } });
    langfuse?.flushAsync().catch(() => {});
    return { response: cached, metadata: { search_type: "cache", total_ms: Date.now() - totalStart } };
  }

  // 4. BUSCAR EN knowledge_flows (Excel) — umbral 0.50
  const flowSpan = trace?.span({ name: "search-flows" });
  const flow = await searchFlow(countryCode, question);
  flowSpan?.end({ output: flow ? { flow_id: flow.flow_id, similarity: flow.similarity } : null });

  if (flow) {
    console.log(`📋 Flow: ${flow.flow_id} [${flow.flow_type}] sim: ${flow.similarity?.toFixed(3)}`);
    const normalizedType = flow.flow_type?.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

    if (normalizedType === "informativa") {
      setCached(countryCode, question, flow.answer);
      trace?.update({ output: flow.answer, metadata: { search_type: "flow_informativa" } });
      langfuse?.flushAsync().catch(() => {});
      return { response: flow.answer, metadata: { search_type: "flow_informativa", flow_id: flow.flow_id, total_ms: Date.now() - totalStart } };
    }

    if (normalizedType === "seleccion") {
      trace?.update({ output: flow.answer, metadata: { search_type: "flow_seleccion" } });
      langfuse?.flushAsync().catch(() => {});
      return { response: flow.answer, metadata: { search_type: "flow_seleccion", flow_id: flow.flow_id, total_ms: Date.now() - totalStart } };
    }

    if (normalizedType === "paso a paso" || normalizedType === "paso_a_paso") {
      const { data: steps } = await supabase
        .from("knowledge_steps")
        .select("step_number, step_summary")
        .eq("flow_id", flow.flow_id)
        .order("step_number", { ascending: true });

      if (!steps || steps.length === 0) {
        trace?.update({ output: flow.answer, metadata: { search_type: "flow_paso_a_paso" } });
        langfuse?.flushAsync().catch(() => {});
        return { response: flow.answer, metadata: { search_type: "flow_paso_a_paso" } };
      }

      await upsertState(userId, countryCode, flow.flow_id, "paso a paso", 1, steps.length);

      const response = `Voy a guiarte paso a paso (${steps.length} pasos en total).\n\nPaso 1 de ${steps.length}:\n\n${steps[0].step_summary}\n\n¿Quieres más detalle sobre este paso, continuar al paso 2, o ya tienes todo claro?`;
      trace?.update({ output: response, metadata: { search_type: "flow_paso_a_paso" } });
      langfuse?.flushAsync().catch(() => {});
      return {
        response,
        metadata: { search_type: "flow_paso_a_paso", flow_id: flow.flow_id, total_steps: steps.length }
      };
    }
  }

  // 5. FALLBACK — PDF (knowledge_chunks)
  const searchSpan = trace?.span({ name: "search-hybrid" });
  const [history, semanticData, fastData] = await Promise.all([
    getRecentHistory(userId, countryCode, 4),
    searchSemantic(countryCode, question, 5),
    searchFast(countryCode, question, 3),
  ]);
  const allResults = mergeResults(semanticData, fastData);
  searchSpan?.end({
    output: { semantic_count: semanticData.length, fast_count: fastData.length, merged_count: allResults.length },
  });

  if (allResults.length === 0) {
    const response = "No tengo esa información exacta. ¿Puedes contarme más sobre lo que necesitas?";
    trace?.update({ output: response, metadata: { search_type: "no_results" } });
    langfuse?.flushAsync().catch(() => {});
    return { response, metadata: { search_type: "no_results", total_ms: Date.now() - totalStart } };
  }

  const context = allResults
    .map((item, i) => `Fuente ${i + 1}${item.source_name ? ` (${item.source_name})` : ""}:\n${item.chunk_text}`)
    .join("\n\n");

  const systemPrompt = `Eres el asistente virtual de ${orgName}.
Cuando la pregunta sea vaga o corta, infiere que se refiere a la organización y sus programas.
Responde con la información más completa y útil que encuentres en el contexto.
Si hay varias ubicaciones, programas o datos relevantes, menciónalos todos.
Si el contexto no tiene información suficiente, di: "No tengo esa información exacta, ¿puedes ser más específico?"
No inventes datos. Máximo 4 líneas. Sin markdown. Sin asteriscos.`;

  const userContent = `País: ${countryCode}\n\nContexto:\n${context}\n\nPregunta: ${question}`.trim();
  const messages = [...history, { role: "user", content: userContent }];

  const llmStart = Date.now();
  const gen = trace?.generation({
    name: "claude-response",
    model: CLAUDE_MODEL,
    input: messages,
    modelParameters: { maxTokens: 300 },
  });

  const claudeResponse = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 300,
    system: systemPrompt,
    messages,
  });

  const finalResponse = claudeResponse.content[0]?.text || "No tengo esa información exacta, ¿puedes ser más específico?";

  gen?.end({
    output: finalResponse,
    usage: { input: claudeResponse.usage.input_tokens, output: claudeResponse.usage.output_tokens },
  });

  if (!finalResponse.includes("No tengo esa información")) {
    setCached(countryCode, question, finalResponse);
  }

  trace?.update({ output: finalResponse, metadata: { search_type: "hybrid" } });
  langfuse?.flushAsync().catch(() => {});

  return {
    response: finalResponse,
    metadata: { search_type: "hybrid", total_ms: Date.now() - totalStart, llm_ms: Date.now() - llmStart },
  };
}

module.exports = { askAI, saveConversationTurn };
