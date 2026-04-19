require("dotenv").config({ quiet: true });

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai").default;

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

async function getRecentHistory(userId, countryCode, limit = 6) {
  const { data, error } = await supabase
    .from("conversations")
    .select("role, message, created_at")
    .eq("user_id", userId)
    .eq("country_code", countryCode)
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

async function saveConversationTurn(userId, countryCode, role, message) {
  const { error } = await supabase
    .from("conversations")
    .insert({
      user_id: userId,
      country_code: countryCode,
      role,
      message,
    });

  if (error) throw error;
}

async function askAI(userId, countryCode, question) {
  let context = "";

  const { data: fastData } = await supabase
    .from("knowledge_chunks")
    .select("chunk_text, source_name")
    .ilike("chunk_text", `%${question}%`)
    .eq("country_code", countryCode)
    .limit(2);

  if (fastData && fastData.length > 0) {
    context = fastData
      .map((item, i) => `Fuente ${i + 1} (${item.source_name}):\n${item.chunk_text}`)
      .join("\n\n");
  } else {
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: question,
    });

    const queryEmbedding = embeddingResponse.data[0].embedding;

    const { data: vectorData, error } = await supabase.rpc(
      "match_knowledge_by_country",
      {
        query_embedding: queryEmbedding,
        filter_country: countryCode,
        match_count: 2,
      }
    );

    if (error) throw error;

    if (!vectorData || vectorData.length === 0) {
      return "No tengo esa información exacta para este país.";
    }

    context = vectorData
      .map((item, i) => `Fuente ${i + 1}:\n${item.chunk_text}`)
      .join("\n\n");
  }

  const history = await getRecentHistory(userId, countryCode, 6);

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    max_output_tokens: 120,
    input: [
      {
        role: "system",
        content: `
Eres un asistente empresarial.

IMPORTANTE:
Responde SOLO con información del país indicado.
No inventes.
Máximo 2 líneas.
Usa el historial reciente solo para entender mejor la pregunta actual.
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

  return response.output_text || "No tengo esa información.";
}

module.exports = {
  askAI,
  saveConversationTurn,
};