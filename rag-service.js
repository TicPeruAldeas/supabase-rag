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

  return (data || []).reverse().map((item) => ({
    role: item.role,
    content: item.message,
  }));
}

async function saveConversationTurn({
  userId, countryCode, role, message, source = "api", metadata = {},
}) {
  const { error } = await supabase
    .from("conversations")
    .insert({ user_id: userId, country_code: countryCode, role, message, source, metadata });

  if (error) throw error;
}

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

async function searchFast(countryCode, question, limit = 3) {
  const keywords = question
    .split(/\s+/)
    .filter((w) => w.length > 4)
    .slice(0, 3);

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

async function askAI(userId, countryCode, question) {
  const totalStart = Date.now();

  // 1. SMALL TALK
  if (SMALL_TALK_REGEX.test(question.trim())) {
    return {
      response: "¡Hola! ¿En qué puedo ayudarte hoy?",
      metadata: {
        search_type: "small_talk",
        total_ms: Date.now() - totalStart,
        search_ms: 0, semantic_ms: 0, llm_ms: 0, history_used: 0,
      },
    };
  }

  // 2. CACHE
  const cached = getCached(countryCode, question);
  if (cached) {
    return {
      response: cached,
      metadata: {
        search_type: "cache",
        total_ms: Date.now() - totalStart,
        search_ms: 0, semantic_ms: 0, llm_ms: 0, history_used: 0,
      },
    };
  }

  // 3. HISTORIAL + BÚSQUEDA HÍBRIDA EN PARALELO
  const searchStart = Date.now();

  const [history, semanticData, fastData] = await Promise.all([
    getRecentHistory(userId, countryCode, 4),
    searchSemantic(countryCode, question, 5),
    searchFast(countryCode, question, 3),
  ]);

  const searchMs = Date.now() - searchStart;

  // 4. FUSIONAR Y DEDUPLICAR
  const allResults = mergeResults(semanticData, fastData);

  if (allResults.length === 0) {
    return {
      response: "No tengo esa información exacta, ¿puedes ser más específico?",
      metadata: {
        search_type: "no_results",
        total_ms: Date.now() - totalStart,
        search_ms: searchMs, semantic_ms: searchMs, llm_ms: 0,
        history_used: history.length,
      },
    };
  }

  const context = allResults
    .map((item, i) => `Fuente ${i + 1}${item.source_name ? ` (${item.source_name})` : ""}:\n${item.chunk_text}`)
    .join("\n\n");

  // 5. LLM
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

  const llmMs = Date.now() - llmStart;
  const finalResponse = response.output_text || "No tengo esa información exacta, ¿puedes ser más específico?";

  // 6. CACHE — solo respuestas útiles
  if (!finalResponse.includes("No tengo esa información")) {
    setCached(countryCode, question, finalResponse);
  }

  return {
    response: finalResponse,
    metadata: {
      search_type: "hybrid",
      chunks_used: allResults.length,
      semantic_chunks: semanticData.length,
      fast_chunks: fastData.length,
      total_ms: Date.now() - totalStart,
      search_ms: searchMs,
      llm_ms: llmMs,
      history_used: history.length,
    },
  };
}

module.exports = { askAI, saveConversationTurn };