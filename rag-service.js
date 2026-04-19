require("dotenv").config({ quiet: true });

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai").default;
const { getFromCache, saveToCache } = require("./cache");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function askAI(countryCode, question) {
  try {
    // 🔥 1. CACHE PRIMERO
    const cached = getFromCache(countryCode, question);

    if (cached) {
      console.log("⚡ CACHE HIT");
      return cached.response;
    }

    console.log("🧠 CACHE MISS");

    let context = "";

    // ⚡ búsqueda rápida
    const { data: fastData } = await supabase
      .from("knowledge_chunks")
      .select("chunk_text")
      .ilike("chunk_text", `%${question}%`)
      .eq("country_code", countryCode)
      .limit(2);

    if (fastData && fastData.length > 0) {
      context = fastData.map(x => x.chunk_text).join("\n\n");
    } else {
      // 🧠 embeddings
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: question,
      });

      const queryEmbedding = embeddingResponse.data[0].embedding;

      const { data: vectorData } = await supabase.rpc(
        "match_knowledge_by_country",
        {
          query_embedding: queryEmbedding,
          filter_country: countryCode,
          match_count: 2,
        }
      );

      if (!vectorData || vectorData.length === 0) {
        return "No tengo esa información exacta para este país.";
      }

      context = vectorData.map(x => x.chunk_text).join("\n\n");
    }

    // 🤖 IA
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      max_output_tokens: 120,
      input: [
        {
          role: "system",
          content: "Responde claro, breve y sin inventar.",
        },
        {
          role: "user",
          content: `País: ${countryCode}\n\n${context}\n\nPregunta: ${question}`,
        },
      ],
    });

    const finalResponse = response.output_text || "No tengo información.";

    // 💾 GUARDAR CACHE
    saveToCache(countryCode, question, finalResponse);

    return finalResponse;
  } catch (err) {
    console.error(err);
    throw err;
  }
}

module.exports = { askAI };