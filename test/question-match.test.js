// Pregunta casi idéntica a la de una fila de la matriz: se elige esa fila,
// aunque otra tenga más similitud semántica.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "dummy";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";

const { test } = require("node:test");
const assert = require("node:assert");
const { findQuestionMatch, chooseBestFlowCandidate } = require("../rag-service");

// Candidatos reales de BR para "Como faço para solicitar refúgio?" (24/11/2026).
const REFUGIO = [
  { flow_id: "BR-CT001-S003-001", flow_type: "informativa", similarity: 0.746, question: "Posso solicitar refúgio no Brasil? " },
  { flow_id: "BR-CT001-S003-002", flow_type: "paso a paso", similarity: 0.720, question: "Como faço para solicitar refúgio?" },
  { flow_id: "BR-CT001-S006-002", flow_type: "informativa", similarity: 0.660, question: "Posso me tornar brasileiro sendo refugiado?" },
];

test("BR: «Como faço para solicitar refúgio?» elige la guía paso a paso", async () => {
  const flow = await chooseBestFlowCandidate("BR", "Como faço para solicitar refúgio?", REFUGIO);
  assert.strictEqual(flow.flow_id, "BR-CT001-S003-002");
  assert.strictEqual(flow.question_match, true);
});

test("sin tildes, sin signos y con la pregunta reescrita también coincide", async () => {
  assert.strictEqual(findQuestionMatch(["como faco para solicitar refugio"], REFUGIO).flow_id, "BR-CT001-S003-002");
  assert.strictEqual(findQuestionMatch(["Como faço para solicitar refúgio no Brasil?"], REFUGIO).flow_id, "BR-CT001-S003-002");
  const flow = await chooseBestFlowCandidate("BR", "Como faço para solicitar refúgio no Brasil?", REFUGIO, { originalQuestion: "como faço pra pedir refugio" });
  assert.strictEqual(flow.flow_id, "BR-CT001-S003-002");
});

test("si la persona no escribió la pregunta de una fila, no se fuerza nada", () => {
  assert.strictEqual(findQuestionMatch(["refúgio"], REFUGIO), null);
  assert.strictEqual(findQuestionMatch(["quero pedir refúgio, o que faço?"], REFUGIO), null);
  assert.strictEqual(findQuestionMatch(["Posso solicitar refúgio e trabalhar no Brasil com meus filhos pequenos?"], REFUGIO), null);
});

test("la pregunta exacta de la fila informativa sigue eligiendo la informativa", () => {
  assert.strictEqual(findQuestionMatch(["Posso solicitar refúgio no Brasil?"], REFUGIO).flow_id, "BR-CT001-S003-001");
});
