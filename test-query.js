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
  const question = process.argv[2];

  if (!question) {
    console.log('Uso: node test-query.js "tu pregunta"');
    process.exit(1);
  }

  // 1. Crear embedding de la pregunta
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: question,
  });

  const queryEmbedding = embeddingResponse.data[0].embedding;

  // 2. Buscar chunks similares en Supabase
  const { data, error } = await supabase.rpc("match_knowledge", {
    query_embedding: queryEmbedding,
    match_count: 5,
  });

  if (error) {
    console.error("Error buscando en Supabase:", error);
    process.exit(1);
  }

  console.log("\n=== RESULTADOS ===\n");

  data.forEach((item, index) => {
    console.log(`Resultado ${index + 1}`);
    console.log(`Fuente: ${item.source_name}`);
    console.log(`Similitud: ${item.similarity}`);
    console.log(item.chunk_text);
    console.log("\n-----------------------------\n");
  });
}

main().catch((err) => {
  console.error("Error general:", err);
  process.exit(1);
});