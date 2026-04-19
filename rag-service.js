require("dotenv").config({ quiet: true });

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai").default;

if (!process.env.SUPABASE_URL) {
  throw new Error("Falta SUPABASE_URL");
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");
}

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Falta OPENAI_API_KEY");
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function askAI(countryCode, question) {
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: question,
  });

  const queryEmbedding = embeddingResponse.data[0].embedding;

  const { data, error } = await supabase.rpc("match_knowledge_by_country", {
    query_embedding: queryEmbedding,
    filter_country: countryCode,
    match_count: 3,
  });

  if (error) {
    throw new Error(`Error en búsqueda: ${error.message}`);
  }

  const results = Array.isArray(data) ? data : [];

  const context = results
    .map((item, i) => `Fuente ${i + 1}:\n${item.chunk_text}`)
    .join("\n\n");

  if (!context) {
    return "No tengo esa información exacta para este país.";
  }

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: `
Eres un asistente empresarial.

IMPORTANTE:
Responde SOLO con información del país indicado.
Si el contexto contiene información de otros países, IGNÓRALA.

País actual: ${countryCode}

Si no hay información específica del país, responde exactamente:
"No tengo esa información exacta para este país."

No inventes.
Responde claro, breve y profesional.
Máximo 3 líneas.
        `.trim(),
      },
      {
        role: "user",
        content: `
País: ${countryCode}

Contexto:
${context}

Pregunta:
${question}
        `.trim(),
      },
    ],
  });

  return response.output_text || "No tengo esa información exacta para este país.";
}

module.exports = { askAI };