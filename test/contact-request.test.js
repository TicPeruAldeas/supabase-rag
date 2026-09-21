// Pruebas de la ruta de consultas de contacto (columna "Datos"). Puras, sin red.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "dummy";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";

const { test } = require("node:test");
const assert = require("node:assert");
const { isContactRequest, contactSearchTokens } = require("../rag-service");

test("isContactRequest: detecta pedidos explícitos de teléfono, sede, dirección, correo, horario", () => {
  for (const msg of [
    "¿Cuál es el teléfono de Migraciones?",
    "dame el número de la Defensoría",
    "¿dónde queda la sede central?",
    "¿tienen correo electrónico?",
    "¿cuál es la dirección de la oficina?",
    "¿en qué horario atienden?",
    "¿a quién llamo si necesito ayuda?",
    "¿cómo me puedo comunicar con ellos?",
  ]) {
    assert.strictEqual(isContactRequest(msg), true, `"${msg}" debería ser consulta de contacto`);
  }
});

test("isContactRequest: no marca preguntas normales de contenido", () => {
  for (const msg of [
    "¿Cómo hago el trámite para regularizar mi situación?",
    "Mi hijo nació en el Perú, ¿es peruano?",
    "¿Qué pasa si no tengo documentos en regla?",
    "hola",
  ]) {
    assert.strictEqual(isContactRequest(msg), false, `"${msg}" no debería ser consulta de contacto`);
  }
});

test("contactSearchTokens: conserva la institución y descarta conectores y palabras de contacto", () => {
  const tokens = contactSearchTokens("¿Cuál es el teléfono de Migraciones?");
  assert.deepStrictEqual(tokens, ["migraciones"]);
  const t2 = contactSearchTokens("dame el número de la Defensoría del Pueblo");
  assert.ok(t2.includes("defensoría") && t2.includes("pueblo"), JSON.stringify(t2));
  assert.ok(!t2.includes("número") && !t2.includes("dame"));
});
