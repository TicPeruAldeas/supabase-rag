// Pruebas del parser del módulo de comprensión (parseAnalysis). Sin red:
// valida cómo se interpreta y normaliza el JSON que devuelve el modelo.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "dummy";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";

const { test } = require("node:test");
const assert = require("node:assert");

const { parseAnalysis } = require("../rag-service");

test("parseAnalysis: interpreta un seguimiento con pregunta reescrita", () => {
  const raw = '{"intent":"followup","standalone_query":"¿Cómo sería el apoyo de Aldeas para una familia migrante?","topic_changed":false,"location":null,"confidence":0.9}';
  const a = parseAnalysis(raw, "y que tal seria");
  assert.deepStrictEqual(a, {
    intent: "followup",
    standalone_query: "¿Cómo sería el apoyo de Aldeas para una familia migrante?",
    topic_changed: false,
    location: null,
    confidence: 0.9,
  });
});

test("parseAnalysis: tolera texto alrededor del JSON y normaliza la intención", () => {
  const raw = 'Claro:\n{"intent":"New_Topic","standalone_query":"¿Qué documentos necesito?","topic_changed":true,"confidence":"0.8"}\n';
  const a = parseAnalysis(raw, "qué documentos necesito");
  assert.strictEqual(a.intent, "new_topic");
  assert.strictEqual(a.topic_changed, true);
  assert.strictEqual(a.confidence, 0.8);
  assert.strictEqual(a.location, null);
});

test("parseAnalysis: extrae la ubicación en location_answer", () => {
  const raw = '{"intent":"location_answer","standalone_query":"Apoyo para familia migrante en Lima","topic_changed":false,"location":"Lima","confidence":0.95}';
  const a = parseAnalysis(raw, "estoy en Lima");
  assert.strictEqual(a.intent, "location_answer");
  assert.strictEqual(a.location, "Lima");
});

test("parseAnalysis: sin standalone_query usa el mensaje original", () => {
  const a = parseAnalysis('{"intent":"closing","topic_changed":false}', "gracias");
  assert.strictEqual(a.intent, "closing");
  assert.strictEqual(a.standalone_query, "gracias");
  assert.strictEqual(a.confidence, null);
});

test("parseAnalysis: acota confidence a [0,1]", () => {
  assert.strictEqual(parseAnalysis('{"intent":"vague","confidence":7}', "ayuda").confidence, 1);
  assert.strictEqual(parseAnalysis('{"intent":"vague","confidence":-2}', "ayuda").confidence, 0);
});

test("parseAnalysis: devuelve null ante intención desconocida, JSON inválido o vacío", () => {
  assert.strictEqual(parseAnalysis('{"intent":"banana"}', "x"), null);
  assert.strictEqual(parseAnalysis('{"intent": followup}', "x"), null);
  assert.strictEqual(parseAnalysis("", "x"), null);
  assert.strictEqual(parseAnalysis("sin json", "x"), null);
});
