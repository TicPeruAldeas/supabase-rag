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

// ── Langfuse (opcional) ───────────────────────────────────────
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

// ── Noop observation — evita optional chaining y garantiza .end() ──
// Cuando Langfuse no está configurado, todos los métodos son no-ops.
// Cuando sí está configurado, se usan los objetos reales del SDK.
const NOOP = {
  span:       () => NOOP,
  generation: () => NOOP,
  end:        () => {},
  update:     () => {},
};

function mkTrace(options) {
  if (!langfuse) return NOOP;
  return langfuse.trace(options);
}

const CLAUDE_MODEL = "claude-sonnet-4-6";

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

// ── Helper: genera embedding e instrumenta su propio span ─────
// parent puede ser un trace o un span — ambos soportan .span() en Langfuse
async function embedText(text, parent) {
  const span = parent.span({
    name: "openai-embedding",
    input: text.substring(0, 200),
    metadata: { model: "text-embedding-3-small" },
  });
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  span.end({
    output: { tokens: response.usage.total_tokens, dimensions: response.data[0].embedding.length },
  });
  return response.data[0].embedding;
}

// ── Detectar intención (flujo paso a paso) ────────────────────
// parent = span del paso-a-paso activo
async function detectIntent(userMessage, parent) {
  const gen = parent.generation({
    name: "claude-detect-intent",
    model: CLAUDE_MODEL,
    input: userMessage,
    modelParameters: { maxTokens: 16 },
  });

  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16,
    system: [
      {
        type: "text",
        text: `Clasifica el mensaje en una de estas intenciones:
- "mas_detalle": quiere más información sobre lo explicado
- "siguiente": quiere continuar al siguiente paso
- "terminar": agradece, entendió, se despide
- "otro": pregunta algo completamente diferente
Responde SOLO con una palabra: mas_detalle, siguiente, terminar, otro`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
  });

  const intent = msg.content[0].text.trim().toLowerCase();
  gen.end({
    output: intent,
    usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens },
    metadata: {
      cache_read_tokens: msg.usage.cache_read_input_tokens ?? 0,
      cache_creation_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    },
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

// ── Buscar flow (Excel) — crea sus propios spans hijos ────────
// parent = trace raíz
async function searchFlow(countryCode, question, parent) {
  const span = parent.span({ name: "search-flows", input: question });

  // Span hijo: embedding de OpenAI
  const queryEmbedding = await embedText(question, span);

  // Span hijo: RPC en Supabase
  const dbSpan = span.span({ name: "supabase-match-flows", input: { country: countryCode } });
  const { data, error } = await supabase.rpc("match_flows_by_country", {
    query_embedding: queryEmbedding,
    filter_country: countryCode,
    match_count: 1,
    min_similarity: 0.50,
  });

  if (error) {
    dbSpan.end({ output: { error: error.message } });
    span.end({ output: null });
    throw error;
  }

  const result = data?.[0] || null;
  dbSpan.end({ output: result ? { flow_id: result.flow_id, similarity: result.similarity } : null });
  span.end({ output: result ? { flow_id: result.flow_id, flow_type: result.flow_type, similarity: result.similarity } : null });
  return result;
}

// ── Búsqueda semántica (PDF) — crea sus propios spans hijos ──
// parent = span de "search-hybrid"
async function searchSemantic(countryCode, question, matchCount = 5, parent) {
  const span = parent.span({ name: "search-semantic", input: question });

  // Span hijo: embedding de OpenAI
  const queryEmbedding = await embedText(question, span);

  // Span hijo: RPC en Supabase
  const dbSpan = span.span({ name: "supabase-match-knowledge", input: { country: countryCode, matchCount } });
  const { data, error } = await supabase.rpc("match_knowledge_by_country", {
    query_embedding: queryEmbedding,
    filter_country: countryCode,
    match_count: matchCount,
  });

  if (error) {
    dbSpan.end({ output: { error: error.message } });
    span.end({ output: [] });
    throw error;
  }

  const results = (data || []).filter(item => item.similarity >= 0.45);
  dbSpan.end({ output: { count: results.length } });
  span.end({ output: { count: results.length } });
  return results;
}

// ── Búsqueda keyword — crea su propio span hijo ───────────────
// parent = span de "search-hybrid"
async function searchFast(countryCode, question, limit = 3, parent) {
  const keywords = question.split(/\s+/).filter(w => w.length > 4).slice(0, 3);
  if (keywords.length === 0) return [];
  const keyword = keywords.sort((a, b) => b.length - a.length)[0];

  const span = parent.span({ name: "search-keyword", input: { keyword, country: countryCode } });
  const { data, error } = await supabase
    .from("knowledge_chunks")
    .select("chunk_text, source_name")
    .ilike("chunk_text", `%${keyword}%`)
    .eq("country_code", countryCode)
    .limit(limit);

  const results = error ? [] : (data || []);
  span.end({ output: { count: results.length, keyword } });
  return results;
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

// ── Manejar PASO A PASO — agrupa intent + lógica bajo un span ─
async function handlePasoAPaso(userId, countryCode, question, state, parent) {
  const span = parent.span({
    name: "handle-paso-a-paso",
    input: { step: state.current_step, total: state.total_steps, flow_id: state.flow_id },
  });

  // La generación de Claude queda como hijo del span paso-a-paso
  const intent = await detectIntent(question, span);
  console.log(`🎯 Intent: ${intent} (paso ${state.current_step}/${state.total_steps})`);

  let result;

  if (intent === "terminar") {
    await updateStep(state.id, state.current_step, "completed");
    result = { response: "¡Entendido! Si necesitas más ayuda, con gusto te orientamos.", metadata: { flow_type: "paso_a_paso" } };

  } else if (intent === "otro") {
    await updateStep(state.id, state.current_step, "cancelled");
    result = null;

  } else if (intent === "mas_detalle") {
    const { data: stepData } = await supabase
      .from("knowledge_steps")
      .select("step_detail, step_number")
      .eq("flow_id", state.flow_id)
      .eq("step_number", state.current_step)
      .single();

    result = stepData
      ? {
          response: `Detalle del paso ${state.current_step}:\n\n${stepData.step_detail}\n\n¿Quieres continuar con el paso ${state.current_step + 1 <= state.total_steps ? state.current_step + 1 : "siguiente"}?`,
          metadata: { flow_type: "paso_a_paso" },
        }
      : { response: "No tengo más detalle sobre este paso. ¿Quieres continuar con el siguiente?", metadata: { flow_type: "paso_a_paso" } };

  } else {
    // siguiente
    const nextStep = state.current_step + 1;
    if (nextStep > state.total_steps) {
      await updateStep(state.id, state.current_step, "completed");
      result = { response: "✅ Hemos terminado todos los pasos. ¿Hay algo más en lo que pueda ayudarte?", metadata: { flow_type: "paso_a_paso" } };
    } else {
      const { data: nextStepData } = await supabase
        .from("knowledge_steps")
        .select("step_summary, step_number")
        .eq("flow_id", state.flow_id)
        .eq("step_number", nextStep)
        .single();

      if (!nextStepData) {
        await updateStep(state.id, state.current_step, "completed");
        result = { response: "✅ Eso es todo. ¿Necesitas ayuda con algo más?", metadata: { flow_type: "paso_a_paso" } };
      } else {
        await updateStep(state.id, nextStep);
        const isLastStep = nextStep >= state.total_steps;
        result = {
          response: `Paso ${nextStep} de ${state.total_steps}:\n\n${nextStepData.step_summary}\n\n${isLastStep ? "Este es el último paso. ¿Quieres más detalle o ya tienes todo claro?" : `¿Quieres más detalle, continuar al paso ${nextStep + 1}, o ya tienes todo claro?`}`,
          metadata: { flow_type: "paso_a_paso", step: nextStep },
        };
      }
    }
  }

  span.end({ output: result?.response ?? null });
  return result;
}

// ── Core RAG ──────────────────────────────────────────────────
async function askAI(userId, countryCode, question) {
  const totalStart = Date.now();
  const orgName = COUNTRY_ORGS[countryCode] || `Aldeas Infantiles SOS (${countryCode})`;

  // mkTrace devuelve NOOP si Langfuse no está configurado,
  // así todos los .span() / .generation() / .end() siempre se llaman sin optional chaining
  const trace = mkTrace({
    name: "rag-query",
    userId,
    metadata: { countryCode, orgName },
    input: question,
  });

  try {
    // 1. SMALL TALK — sin observations (no hay llamadas externas)
    if (SMALL_TALK_REGEX.test(question.trim())) {
      const response = `¡Hola! Soy el asistente virtual de ${orgName}. ¿En qué puedo ayudarte hoy?`;
      trace.update({ output: response, metadata: { search_type: "small_talk" } });
      return { response, metadata: { search_type: "small_talk", total_ms: Date.now() - totalStart } };
    }

    // 2. ¿Flujo activo? (paso a paso)
    const activeState = await getActiveState(userId, countryCode);
    if (activeState && (activeState.flow_type === "paso a paso" || activeState.flow_type === "paso_a_paso")) {
      console.log(`🔄 Flujo activo: ${activeState.flow_id} [${activeState.flow_type}]`);
      // handlePasoAPaso crea su propio span hijo del trace
      const result = await handlePasoAPaso(userId, countryCode, question, activeState, trace);
      if (result) {
        trace.update({ output: result.response, metadata: result.metadata });
        return result;
      }
      // intent === "otro": continúa al flujo normal de búsqueda
    }

    // 3. CACHE — sin observations
    const cached = getCached(countryCode, question);
    if (cached) {
      trace.update({ output: cached, metadata: { search_type: "cache" } });
      return { response: cached, metadata: { search_type: "cache", total_ms: Date.now() - totalStart } };
    }

    // 4. BUSCAR EN knowledge_flows (Excel)
    // searchFlow crea: span("search-flows") > span("openai-embedding") + span("supabase-match-flows")
    const flow = await searchFlow(countryCode, question, trace);

    if (flow) {
      console.log(`📋 Flow: ${flow.flow_id} [${flow.flow_type}] sim: ${flow.similarity?.toFixed(3)}`);
      const normalizedType = flow.flow_type?.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

      if (normalizedType === "informativa") {
        setCached(countryCode, question, flow.answer);
        trace.update({ output: flow.answer, metadata: { search_type: "flow_informativa", flow_id: flow.flow_id } });
        return { response: flow.answer, metadata: { search_type: "flow_informativa", flow_id: flow.flow_id, total_ms: Date.now() - totalStart } };
      }

      if (normalizedType === "seleccion") {
        trace.update({ output: flow.answer, metadata: { search_type: "flow_seleccion", flow_id: flow.flow_id } });
        return { response: flow.answer, metadata: { search_type: "flow_seleccion", flow_id: flow.flow_id, total_ms: Date.now() - totalStart } };
      }

      if (normalizedType === "paso a paso" || normalizedType === "paso_a_paso") {
        const { data: steps } = await supabase
          .from("knowledge_steps")
          .select("step_number, step_summary")
          .eq("flow_id", flow.flow_id)
          .order("step_number", { ascending: true });

        if (!steps || steps.length === 0) {
          trace.update({ output: flow.answer, metadata: { search_type: "flow_paso_a_paso" } });
          return { response: flow.answer, metadata: { search_type: "flow_paso_a_paso" } };
        }

        await upsertState(userId, countryCode, flow.flow_id, "paso a paso", 1, steps.length);
        const response = `Voy a guiarte paso a paso (${steps.length} pasos en total).\n\nPaso 1 de ${steps.length}:\n\n${steps[0].step_summary}\n\n¿Quieres más detalle sobre este paso, continuar al paso 2, o ya tienes todo claro?`;
        trace.update({ output: response, metadata: { search_type: "flow_paso_a_paso", flow_id: flow.flow_id } });
        return { response, metadata: { search_type: "flow_paso_a_paso", flow_id: flow.flow_id, total_steps: steps.length } };
      }
    }

    // 5. FALLBACK — búsqueda híbrida + Claude
    // hybridSpan agrupa semántica, keyword y la generación de Claude
    const hybridSpan = trace.span({ name: "search-hybrid", input: question });

    const [history, semanticData, fastData] = await Promise.all([
      getRecentHistory(userId, countryCode, 4),
      // searchSemantic crea: span("search-semantic") > span("openai-embedding") + span("supabase-match-knowledge")
      searchSemantic(countryCode, question, 5, hybridSpan),
      // searchFast crea: span("search-keyword")
      searchFast(countryCode, question, 3, hybridSpan),
    ]);

    const allResults = mergeResults(semanticData, fastData);

    if (allResults.length === 0) {
      hybridSpan.end({ output: { count: 0 } });
      const response = "No tengo esa información exacta. ¿Puedes contarme más sobre lo que necesitas?";
      trace.update({ output: response, metadata: { search_type: "no_results" } });
      return { response, metadata: { search_type: "no_results", total_ms: Date.now() - totalStart } };
    }

    hybridSpan.end({ output: { semantic: semanticData.length, keyword: fastData.length, merged: allResults.length } });

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

    // generation("claude-rag-response") es hijo directo del trace (no de hybridSpan)
    const gen = trace.generation({
      name: "claude-rag-response",
      model: CLAUDE_MODEL,
      input: messages,
      modelParameters: { maxTokens: 300 },
    });

    const claudeResponse = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    });

    const finalResponse = claudeResponse.content[0]?.text || "No tengo esa información exacta, ¿puedes ser más específico?";

    const cacheRead = claudeResponse.usage.cache_read_input_tokens ?? 0;
    const cacheCreation = claudeResponse.usage.cache_creation_input_tokens ?? 0;
    if (cacheRead > 0) {
      console.log(`💾 Cache hit RAG [${countryCode}]: ${cacheRead} tokens (~${Math.round(cacheRead * 0.9)} ahorrados)`);
    }

    gen.end({
      output: finalResponse,
      usage: { input: claudeResponse.usage.input_tokens, output: claudeResponse.usage.output_tokens },
      metadata: {
        cache_read_tokens: cacheRead,
        cache_creation_tokens: cacheCreation,
      },
    });

    if (!finalResponse.includes("No tengo esa información")) {
      setCached(countryCode, question, finalResponse);
    }

    trace.update({ output: finalResponse, metadata: { search_type: "hybrid" } });
    return {
      response: finalResponse,
      metadata: { search_type: "hybrid", total_ms: Date.now() - totalStart, llm_ms: Date.now() - llmStart },
    };

  } finally {
    // flushAsync siempre se ejecuta, incluso si hay un error, para no perder observations
    langfuse?.flushAsync().catch(() => {});
  }
}

module.exports = { askAI, saveConversationTurn };
