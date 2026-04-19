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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

  return (data || [])
    .reverse()
    .map((item) => ({
      role: item.role,
      content: item.message,
    }));
}

async function saveConversationTurn({
  userId,
  countryCode,
  role,
  message,
  source = "api",
  metadata = {},
}) {
  const { error } = await supabase
    .from("conversations")
    .insert({
      user_id: userId,
      country_code: countryCode,
      role,
      message,
      source,
      metadata,
    });

  if (error) throw error;
}

async function searchFast(countryCode, question) {
  const { data, error } = await supabase
    .from("knowledge_chunks")
    .select("chunk_text, source_name")
    .ilike("chunk_text", `%${question}%`)
    .eq("country_code", countryCode)
    .limit(2);

  if (error) throw error;
  return data || [];
}

async function searchSemantic(countryCode, question) {
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: question,
  });

  const queryEmbedding = embeddingResponse.data[0].embedding;

  const { data, error } = await supabase.rpc(
    "match_knowledge_by_country",
    {
      query_embedding: queryEmbedding,
      filter_country: countryCode,
      match_count: 2,
    }
  );

  if (error) throw error;
  return data || [];
}

async function askAI(userId, countryCode, question) {
  const totalStart = Date.now();

  // 1. CACHE
  const cached = getCached(countryCode, question);
  if (cached) {
    return {
      response: cached,
      metadata: {
        search_type: "cache",
        total_ms: Date.now() - totalStart,
        search_ms: 0,
        semantic_ms: 0,
        llm_ms: 0,
        history_used: 0,
      },
    };
  }

  // 2. HISTORIAL + BÚSQUEDA RÁPIDA EN PARALELO
  const searchStart = Date.now();

  const [history, fastData] = await Promise.all([
    getRecentHistory(userId, countryCode, 4),
    searchFast(countryCode, question),
  ]);

  let context = "";
  let searchType = "fast";
  let semanticMs = 0;

  if (fastData.length > 0) {
    context = fastData
      .map((item, i) => `Fuente ${i + 1} (${item.source_name}):\n${item.chunk_text}`)
      .join("\n\n");
  } else {
    searchType = "semantic";

    const semanticStart = Date.now();
    const vectorData = await searchSemantic(countryCode, question);
    semanticMs = Date.now() - semanticStart;

    if (!vectorData || vectorData.length === 0) {
      return {
        response: "No tengo esa información exacta para este país.",
        metadata: {
          search_type: searchType,
          total_ms: Date.now() - totalStart,
          search_ms: Date.now() - searchStart,
          semantic_ms: semanticMs,
          llm_ms: 0,
          history_used: history.length,
        },
      };
    }

    context = vectorData
      .map((item, i) => `Fuente ${i + 1}:\n${item.chunk_text}`)
      .join("\n\n");
  }

  const searchMs = Date.now() - searchStart;

  // 3. LLM
  const llmStart = Date.now();

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    max_output_tokens: 90,
    input: [
      {
        role: "system",
        content: `
Eres un asistente empresarial.
Responde SOLO con información del país indicado.
No inventes.
Máximo 2 líneas.
No uses markdown.
Usa el historial reciente solo si ayuda a resolver la pregunta actual.
        `.trim(),
      },
      ...history,
      {
        role: "user",
        content: `
País: ${countryCode}

Contexto:
${context}

Pregunta actual:
${question}
        `.trim(),
      },
    ],
  });

  const llmMs = Date.now() - llmStart;
  const finalResponse = response.output_text || "No tengo esa información.";

  // 4. GUARDAR EN CACHE
  setCached(countryCode, question, finalResponse);

  return {
    response: finalResponse,
    metadata: {
      search_type: searchType,
      total_ms: Date.now() - totalStart,
      search_ms: searchMs,
      semantic_ms: semanticMs,
      llm_ms: llmMs,
      history_used: history.length,
    },
  };
}

module.exports = {
  askAI,
  saveConversationTurn,
};