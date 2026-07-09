require("dotenv").config({ quiet: true });

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai").default;
const Anthropic = require("@anthropic-ai/sdk");
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");
const { buildFlowEmbeddingInput } = require("./embedding-text");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Mismo modelo que la ingesta en vivo (server.js processStepsInBackground)
// para que los resúmenes de pasos sean consistentes entre ambas rutas.
const CLAUDE_MODEL = "claude-sonnet-4-6";

const COUNTRY_CODE = process.argv[2] || "PE";
const FILE_PATH = process.argv[3] || "./Plantilla_Nueva.xlsx";

// ── Parsear pasos de una celda ────────────────────────────────
function parseSteps(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const steps = [];
  let currentStep = null;

  for (const line of lines) {
    const match = line.match(/^(\d+)\.\s+(.+)/);
    if (match) {
      if (currentStep) steps.push(currentStep);
      currentStep = { number: parseInt(match[1]), text: match[2] };
    } else if (currentStep) {
      currentStep.text += " " + line;
    }
  }
  if (currentStep) steps.push(currentStep);
  return steps;
}

// ── Generar resumen corto de un paso con IA ───────────────────
async function generateStepSummary(stepText, stepNumber, totalSteps) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 100,
    system: "Resume el siguiente paso en máximo 2 líneas cortas y claras en español. Sin markdown.",
    messages: [{
      role: "user",
      content: `Paso ${stepNumber} de ${totalSteps}:\n${stepText}`,
    }],
  });
  return response.content[0].text.trim();
}

// ── Generar embedding ─────────────────────────────────────────
async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return response.data[0].embedding;
}

// ── Procesar una fila del Excel ───────────────────────────────
async function processRow(row) {
  const flowId = row["ID"]?.toString().trim();
  const question = row["Pregunta del usuario"]?.toString().trim();
  const answer = row["Respuesta"]?.toString().trim();
  const flowType = row["Tipo de respuesta"]?.toString().trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // quita tildes
  const category = row["Categoría"]?.toString().trim();
  const subtopic = row["Subtema"]?.toString().trim();

  if (!flowId || !question || !answer) {
    console.log(`⚠️  Fila incompleta, saltando: ${flowId}`);
    return;
  }

  console.log(`\n📋 Procesando: ${flowId} [${flowType}]`);

  // 1. Generar embedding del contenido completo del flow
  const embeddingInput = buildFlowEmbeddingInput({ category, subtopic, question, answer });
  const embedding = await generateEmbedding(embeddingInput);

  // 2. Upsert en knowledge_flows
  const { error: flowError } = await supabase
    .from("knowledge_flows")
    .upsert({
      flow_id: flowId,
      category,
      subtopic: subtopic,
      question,
      answer,
      flow_type: flowType,
      country_code: COUNTRY_CODE,
      embedding,
      source_name: "excel",
      updated_at: new Date().toISOString(),
    }, { onConflict: "flow_id,country_code" });

  if (flowError) {
    console.error(`❌ Error guardando flow ${flowId}:`, flowError.message);
    return;
  }

  console.log(`✅ Flow guardado: ${flowId}`);

  // 3. Si es paso_a_paso, procesar pasos
  if (flowType === "paso a paso" || flowType === "paso_a_paso") {
    const steps = parseSteps(answer);

    if (steps.length === 0) {
      console.log(`⚠️  No se encontraron pasos numerados en: ${flowId}`);
      return;
    }

    console.log(`   📝 ${steps.length} pasos encontrados`);

    // Eliminar pasos anteriores de este flow
    await supabase
      .from("knowledge_steps")
      .delete()
      .eq("flow_id", flowId)
      .eq("country_code", COUNTRY_CODE);

    // Insertar pasos nuevos con resumen IA
    for (const step of steps) {
      const summary = await generateStepSummary(step.text, step.number, steps.length);

      const { error: stepError } = await supabase
        .from("knowledge_steps")
        .upsert({
          flow_id: flowId,
          step_number: step.number,
          step_summary: summary,
          step_detail: step.text,
          country_code: COUNTRY_CODE,
          source_name: "excel",
          updated_at: new Date().toISOString(),
        }, { onConflict: "flow_id,country_code,step_number" });

      if (stepError) {
        console.error(`❌ Error guardando paso ${step.number}:`, stepError.message);
      } else {
        console.log(`   ✅ Paso ${step.number}: ${summary.slice(0, 60)}...`);
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 Ingestando Excel: ${FILE_PATH}`);
  console.log(`🌍 País: ${COUNTRY_CODE}\n`);

  const workbook = XLSX.readFile(path.resolve(FILE_PATH));
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet);

  console.log(`📊 ${rows.length} filas encontradas\n`);

  // Regenera el mapa flow_id → URL de fuente (columna "LINK: FUENTE"/"Enlace")
  // que usa el bot para citar la fuente. Se escribe siempre para no
  // desincronizarse; si el Excel no trae esa columna, queda un objeto vacío.
  const sourceLinks = {};
  for (const row of rows) {
    const id = row["ID"]?.toString().trim();
    const url = (row["LINK: FUENTE"] ?? row["Enlace"] ?? "").toString().trim();
    if (id && url) sourceLinks[id] = url;
  }
  fs.writeFileSync(
    path.resolve(__dirname, "source-links.json"),
    JSON.stringify(sourceLinks, null, 2) + "\n",
    "utf8"
  );
  console.log(`🔗 source-links.json actualizado: ${Object.keys(sourceLinks).length} fuentes\n`);

  for (const row of rows) {
    await processRow(row);
    // Pequeña pausa para no saturar la API de OpenAI
    await new Promise(r => setTimeout(r, 500));
  }

  console.log("\n✅ Ingestión completada");
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
