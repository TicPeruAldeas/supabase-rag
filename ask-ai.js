require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  const countryCode = process.argv[2];
  const question = process.argv.slice(3).join(" ");

  if (!countryCode || !question) {
    console.log('Uso: node ask-ai.js PE "tu pregunta"');
    process.exit(1);
  }

  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: question,
  });

  const queryEmbedding = embeddingResponse.data[0].embedding;

  const { data, error } = await supabase.rpc("match_knowledge_by_country", {
    query_embedding: queryEmbedding,
    filter_country: countryCode,
    match_count: 4,
  });

  if (error) {
    console.error("Error en búsqueda:", error);
    process.exit(1);
  }

  const context = data
    .map((item, i) => `Fuente ${i + 1}:\n${item.chunk_text}`)
    .join("\n\n");

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

Si no hay información específica del país, responde:
"No tengo esa información exacta para este país."

No inventes.
Responde claro y profesional.
`,
      },
      {
        role: "user",
        content: `
País: ${countryCode}

Contexto:
${context}

Pregunta:
${question}
        `,
      },
    ],
  });

  console.log("\n=== RESPUESTA IA ===\n");
  console.log(response.output_text);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});