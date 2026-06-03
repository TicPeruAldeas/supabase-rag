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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function main() {
  const countryCode = process.argv[2];
  const question = process.argv.slice(3).join(" ").trim();

  if (!countryCode || !question) {
    console.log('Uso: node ask-ai.js PE "tu pregunta"');
    process.exit(1);
  }

  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: question,
  });

  const { data, error } = await supabase.rpc("match_flows_by_country", {
    query_embedding: embeddingResponse.data[0].embedding,
    filter_country: countryCode,
    match_count: 1,
    min_similarity: 0.45,
  });

  if (error) {
    console.error("Error en busqueda:", error);
    process.exit(1);
  }

  const flow = Array.isArray(data) ? data[0] : null;
  if (!flow) {
    console.log("No tengo esa informacion exacta para este pais.");
    process.exit(0);
  }

  console.log(flow.answer || "No tengo esa informacion exacta para este pais.");
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
