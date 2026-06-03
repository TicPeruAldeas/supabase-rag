require("dotenv").config({ quiet: true });

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai").default;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function main() {
  const countryCode = process.argv[2];
  const question = process.argv.slice(3).join(" ").trim();

  if (!countryCode || !question) {
    console.log('Uso: node test-query.js PE "tu pregunta"');
    process.exit(1);
  }

  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: question,
  });

  const { data, error } = await supabase.rpc("match_flows_by_country", {
    query_embedding: embeddingResponse.data[0].embedding,
    filter_country: countryCode,
    match_count: 5,
    min_similarity: 0.0,
  });

  if (error) {
    console.error("Error buscando en Supabase:", error);
    process.exit(1);
  }

  console.log("\n=== RESULTADOS EXCEL ===\n");

  (data || []).forEach((item, index) => {
    console.log(`Resultado ${index + 1}`);
    console.log(`Flow: ${item.flow_id}`);
    console.log(`Tipo: ${item.flow_type}`);
    console.log(`Similitud: ${item.similarity}`);
    console.log(`Pregunta: ${item.question}`);
    console.log(`Respuesta: ${item.answer}`);
    console.log("\n-----------------------------\n");
  });
}

main().catch((err) => {
  console.error("Error general:", err.message || err);
  process.exit(1);
});
