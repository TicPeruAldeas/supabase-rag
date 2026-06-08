// Pruebas unitarias de los guardrails puros de rag-service.js.
// No hacen red: solo validan las funciones de texto. Definimos env dummy
// antes de requerir el módulo (los clientes se construyen pero no llaman a la API).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "dummy";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";

const { test } = require("node:test");
const assert = require("node:assert");

const {
  hasUnsupportedContactInfo,
  sanitizeUserFacingResponse,
  isContinuationMessage,
} = require("../rag-service");

test("hasUnsupportedContactInfo: detecta teléfono ausente en la fuente", () => {
  assert.strictEqual(
    hasUnsupportedContactInfo("Llama al 999888777 para más info.", "Acércate a la sede."),
    true
  );
});

test("hasUnsupportedContactInfo: acepta teléfono presente en la fuente (con formato distinto)", () => {
  assert.strictEqual(
    hasUnsupportedContactInfo("Marca 999 888 777.", "Teléfono: 999888777"),
    false
  );
});

test("hasUnsupportedContactInfo: detecta correo inventado", () => {
  assert.strictEqual(
    hasUnsupportedContactInfo("Escribe a hola@aldeas.org", "Contáctanos por los canales oficiales."),
    true
  );
});

test("hasUnsupportedContactInfo: detecta URL inventada", () => {
  assert.strictEqual(
    hasUnsupportedContactInfo("Visita https://aldeas.org/ayuda", "Acude a la oficina nacional."),
    true
  );
});

test("hasUnsupportedContactInfo: detecta institución no presente en la fuente", () => {
  assert.strictEqual(
    hasUnsupportedContactInfo("Acude a la comisaría más cercana.", "Te orientamos sobre el trámite."),
    true
  );
});

test("hasUnsupportedContactInfo: respuesta sin contactos es válida", () => {
  assert.strictEqual(
    hasUnsupportedContactInfo("Con gusto te oriento sobre el proceso.", "Te orientamos sobre el proceso."),
    false
  );
});

test("hasUnsupportedContactInfo: detecta número corto inventado", () => {
  assert.strictEqual(
    hasUnsupportedContactInfo("Llama a la línea 1810.", "Acércate a la sede más cercana."),
    true
  );
});

test("sanitizeUserFacingResponse: elimina 'según la información disponible'", () => {
  assert.strictEqual(
    sanitizeUserFacingResponse("Según la información disponible, puedes acercarte a la sede."),
    "puedes acercarte a la sede."
  );
});

test("sanitizeUserFacingResponse: elimina menciones a 'el Excel'", () => {
  assert.strictEqual(
    sanitizeUserFacingResponse("La respuesta está en el Excel claramente."),
    "La respuesta está claramente."
  );
});

test("sanitizeUserFacingResponse: deja intacto un texto limpio", () => {
  const texto = "Con gusto te oriento sobre el trámite.";
  assert.strictEqual(sanitizeUserFacingResponse(texto), texto);
});

test("isContinuationMessage: reconoce confirmaciones de continuación", () => {
  for (const msg of ["sí", "si", "siguiente", "continúa", "ok", "👍"]) {
    assert.strictEqual(isContinuationMessage(msg), true, `"${msg}" debería ser continuación`);
  }
});

test("isContinuationMessage: reconoce afirmaciones con cortesía encadenada", () => {
  for (const msg of ["Si porfavor", "sí por favor", "ya dale", "claro continúa", "ok gracias"]) {
    assert.strictEqual(isContinuationMessage(msg), true, `"${msg}" debería ser continuación`);
  }
});

test("isContinuationMessage: no confunde saludos ni preguntas nuevas", () => {
  for (const msg of ["hola", "necesito ayuda con migración", "¿dónde queda la sede?", "si claro que no aplica"]) {
    assert.strictEqual(isContinuationMessage(msg), false, `"${msg}" no debería ser continuación`);
  }
});
