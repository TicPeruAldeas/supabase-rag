require("dotenv").config({ quiet: true });

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai").default;
const { getCached, setCached } = require("./cache");

if (!process.env.SUPABASE_URL) throw new Error("Falta SUPABASE_URL");
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");
if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SMALL_TALK_REGEX = /^(hola|buenos|buenas|hi|hey|gracias|ok|okay|sí|si|no|perfecto|genial|entendido|👍|😊)[\s!?.]*$/i;

// ── Detectar intención del usuario en flujo activo ────────────
async function detectIntent(userMessage) {
  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    max_output_tokens: 18,
    input: [
      {
        role: "system",
        content: `Clasifica el mensaje del usuario en una de estas intenciones:
- "mas_detalle": quiere más información sobre lo que se explicó
- "siguiente": quiere continuar al siguiente paso o ver más opciones
- "terminar": agradece, dice que ya entendió, se despide o no necesita más ayuda
- "otro": pregunta algo completamente diferente

Responde SOLO con una de estas palabras exactas: mas_detalle, siguiente, terminar, otro`
      },
      { role: "user", content: userMessage }
    ]
  });
  return response.output_text.trim().toLowerCase();
}

// ── Obtener estado activo del usuario ─────────────────────────
async function getActiveState(userId, countryCode) {
  const { data, error } = await supabase
    .from("conversation_state")
    .select("*")
    .eq("user_id", userId)
    .eq("country_code", countryCode)
    .eq("status", "active")
    .single();

  if (error || !data) return null;
  return data;
}

// ── Guardar/actualizar estado ─────────────────────────────────
async function upsertState(userId, countryCode, flowId, flowType, currentStep, totalSteps, status = "active") {
  // Cancelar cualquier estado activo previo
  await supabase
    .from("conversation_state")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("country_code", countryCode)
    .eq("status", "active");

  if (status === "cancelled") return;

  const { error } = await supabase
    .from("conversation_state")
    .insert({
      user_id: userId,
      country_code: countryCode,
      flow_id: flowId,
      flow_type: flowType,
      current_step: currentStep,
      total_steps: totalSteps,
      status,
      updated_at: new Date().toISOString(),
    });

  if (error) console.error("Error guardando estado:", error.message);
}

// ── Actualizar paso actual ────────────────────────────────────
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
  return (data || []).reverse().map(item => ({
    role: item.role,
    content: item.message,
  }));
}

// ── Guardar turno ─────────────────────────────────────────────
async function saveConversationTurn({ userId, countryCode, role, message, source = "api", metadata = {} }) {
  const { error } = await supabase
    .from("conversations")
    .insert({ user_id: userId, country_code: countryCode, role, message, source, metadata });
  if (error) throw error;
}

// ── Buscar flow más relevante ─────────────────────────────────
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
    min_similarity: 0.35,
  });

  if (error) throw error;
  return data?.[0] || null;
}

// ── Búsqueda semántica en knowledge_chunks (PDFs) ─────────────
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
    if (key && !seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }
  return merged.slice(0, 6);
}

// ── Manejar flujo PASO A PASO ─────────────────────────────────
async function handlePasoAPaso(userId, countryCode, question, state) {
  const intent = await detectIntent(question);
  console.log(`🎯 Intent detectado: ${intent} (paso ${state.current_step}/${state.total_steps})`);

  if (intent === "terminar") {
    await updateStep(state.id, state.current_step, "completed");
    return {
      response: "¡Entendido! Si necesitas más ayuda en el futuro, con gusto te orientamos. 😊",
      metadata: { flow_type: "paso_a_paso", intent: "terminar" }
    };
  }

  if (intent === "otro") {
    await updateStep(state.id, state.current_step, "cancelled");
    return null; // Continuar con RAG normal
  }

  if (intent === "mas_detalle") {
    // Enviar detalle completo del paso actual
    const { data: stepData } = await supabase
      .from("knowledge_steps")
      .select("step_detail, step_number")
      .eq("flow_id", state.flow_id)
      .eq("step_number", state.current_step)
      .single();

    if (!stepData) {
      return {
        response: "No tengo más detalle sobre este paso. ¿Quieres continuar con el siguiente?",
        metadata: { flow_type: "paso_a_paso", intent: "mas_detalle" }
      };
    }

    return {
      response: `📌 Detalle del paso ${state.current_step}:\n\n${stepData.step_detail}\n\n¿Quieres continuar con el paso ${state.current_step + 1 <= state.total_steps ? state.current_step + 1 : "siguiente"}?`,
      metadata: { flow_type: "paso_a_paso", intent: "mas_detalle" }
    };
  }

  // intent === "siguiente" — avanzar al siguiente paso
  const nextStep = state.current_step + 1;

  if (nextStep > state.total_steps) {
    await updateStep(state.id, state.current_step, "completed");
    return {
      response: "✅ Hemos terminado todos los pasos. ¿Hay algo más en lo que pueda ayudarte?",
      metadata: { flow_type: "paso_a_paso", intent: "completado" }
    };
  }

  const { data: nextStepData } = await supabase
    .from("knowledge_steps")
    .select("step_summary, step_number")
    .eq("flow_id", state.flow_id)
    .eq("step_number", nextStep)
    .single();

  if (!nextStepData) {
    await updateStep(state.id, state.current_step, "completed");
    return {
      response: "✅ Eso es todo. ¿Necesitas ayuda con algo más?",
      metadata: { flow_type: "paso_a_paso" }
    };
  }

  await updateStep(state.id, nextStep);

  return {
    response: `Paso ${nextStep} de ${state.total_steps}:\n\n${nextStepData.step_summary}\n\n¿Quieres más detalle, continuar al paso ${nextStep + 1 <= state.total_steps ? nextStep + 1 : "siguiente"}, o ya tienes todo claro?`,
    metadata: { flow_type: "paso_a_paso", step: nextStep }
  };
}

// ── Manejar flujo SELECCIÓN ───────────────────────────────────
async function handleSeleccion(flow) {
  return {
    response: flow.answer,
    metadata: { flow_type: "seleccion", flow_id: flow.flow_id }
  };
}

// ── Core RAG ──────────────────────────────────────────────────
async function askAI(userId, countryCode, question) {
  const totalStart = Date.now();

  // 1. SMALL TALK
  if (SMALL_TALK_REGEX.test(question.trim())) {
    return {
      response: "¡Hola! ¿En qué puedo ayudarte hoy?",
      metadata: { search_type: "small_talk", total_ms: Date.now() - totalStart }
    };
  }

  // 2. ¿Hay un flujo activo para este usuario?
  const activeState = await getActiveState(userId, countryCode);

  if (activeState) {
    console.log(`🔄 Usuario en flujo activo: ${activeState.flow_id} [${activeState.flow_type}]`);

    if (activeState.flow_type === "paso a paso" || activeState.flow_type === "paso_a_paso") {
      const result = await handlePasoAPaso(userId, countryCode, question, activeState);
      if (result) return result; // null = pregunta diferente, continuar con RAG
    }
  }

  // 3. CACHE
  const cached = getCached(countryCode, question);
  if (cached) {
    return {
      response: cached,
      metadata: { search_type: "cache", total_ms: Date.now() - totalStart }
    };
  }

  // 4. BUSCAR EN knowledge_flows (Excel)
  const searchStart = Date.now();
  const flow = await searchFlow(countryCode, question);

  if (flow) {
    console.log(`📋 Flow encontrado: ${flow.flow_id} [${flow.flow_type}] similarity: ${flow.similarity?.toFixed(3)}`);

    const normalizedType = flow.flow_type?.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // INFORMATIVA
    if (normalizedType === "informativa") {
      setCached(countryCode, question, flow.answer);
      return {
        response: flow.answer,
        metadata: { search_type: "flow_informativa", flow_id: flow.flow_id, total_ms: Date.now() - totalStart }
      };
    }

    // SELECCIÓN
    if (normalizedType === "seleccion") {
      return await handleSeleccion(flow);
    }

    // PASO A PASO
    if (normalizedType === "paso a paso" || normalizedType === "paso_a_paso") {
      // Obtener total de pasos
      const { data: steps } = await supabase
        .from("knowledge_steps")
        .select("step_number, step_summary")
        .eq("flow_id", flow.flow_id)
        .order("step_number", { ascending: true });

      if (!steps || steps.length === 0) {
        return {
          response: flow.answer,
          metadata: { search_type: "flow_paso_a_paso", flow_id: flow.flow_id }
        };
      }

      // Guardar estado
      await upsertState(userId, countryCode, flow.flow_id, "paso a paso", 1, steps.length);

      const firstStep = steps[0];
      return {
        response: `Voy a guiarte paso a paso (${steps.length} pasos en total).\n\nPaso 1 de ${steps.length}:\n\n${firstStep.step_summary}\n\n¿Quieres más detalle sobre este paso, continuar al paso 2, o ya tienes todo claro?`,
        metadata: { search_type: "flow_paso_a_paso", flow_id: flow.flow_id, total_steps: steps.length }
      };
    }
  }

  // 5. FALLBACK — buscar en knowledge_chunks (PDFs)
  const [history, semanticData, fastData] = await Promise.all([
    getRecentHistory(userId, countryCode, 4),
    searchSemantic(countryCode, question, 5),
    searchFast(countryCode, question, 3),
  ]);

  const allResults = mergeResults(semanticData, fastData);

  if (allResults.length === 0) {
    return {
      response: "No tengo esa información exacta. ¿Puedes ser más específico o contarme más sobre lo que necesitas?",
      metadata: { search_type: "no_results", total_ms: Date.now() - totalStart }
    };
  }

  const context = allResults
    .map((item, i) => `Fuente ${i + 1}${item.source_name ? ` (${item.source_name})` : ""}:\n${item.chunk_text}`)
    .join("\n\n");

  const llmStart = Date.now();
  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    max_output_tokens: 180,
    input: [
      {
        role: "system",
        content: `
Eres el asistente virtual de Aldeas Infantiles SOS Perú.
Cuando la pregunta sea vaga o corta, infiere que se refiere a la organización y sus programas.
Responde con la información más completa y útil que encuentres en el contexto.
Si hay varias ubicaciones, programas o datos relevantes, menciónalos todos.
Si el contexto no tiene información suficiente, di: "No tengo esa información exacta, ¿puedes ser más específico?"
No inventes datos. Máximo 4 líneas. Sin markdown. Sin asteriscos.
        `.trim(),
      },
      ...history,
      {
        role: "user",
        content: `País: ${countryCode}\n\nContexto:\n${context}\n\nPregunta: ${question}`.trim(),
      },
    ],
  });

  const finalResponse = response.output_text || "No tengo esa información exacta, ¿puedes ser más específico?";

  if (!finalResponse.includes("No tengo esa información")) {
    setCached(countryCode, question, finalResponse);
  }

  return {
    response: finalResponse,
    metadata: {
      search_type: "hybrid",
      total_ms: Date.now() - totalStart,
      llm_ms: Date.now() - llmStart,
    }
  };
}

module.exports = { askAI, saveConversationTurn };