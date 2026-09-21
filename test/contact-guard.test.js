// Guardrail de contactos: normalización de URLs/números y reporte del token
// que dispara el bloqueo. Puras, sin red.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "dummy";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";

const { test } = require("node:test");
const assert = require("node:assert");
const { findUnsupportedContact, hasUnsupportedContactInfo } = require("../rag-service");

const SOURCE = "Puedes acudir a Encuentros SJM: www.encuentros-sjs.org · Defensoría del Pueblo: 0800-12345 · Quejas: apps2.defensoria.gob.pe/sidPublic";

test("URL con punto final de frase NO es contacto inventado", () => {
  assert.strictEqual(findUnsupportedContact("Escribe a www.encuentros-sjs.org.", SOURCE), null);
});

test("URL con https:// o sin www. se reconoce como la misma de la fuente", () => {
  assert.strictEqual(findUnsupportedContact("Entra a https://www.encuentros-sjs.org/", SOURCE), null);
  assert.strictEqual(findUnsupportedContact("Mira https://apps2.defensoria.gob.pe/sidPublic", SOURCE), null);
});

test("URL que no está en la fuente sí se bloquea y se reporta el token", () => {
  const found = findUnsupportedContact("Visita https://aldeas.org/ayuda", SOURCE);
  assert.ok(found && found.kind === "url", JSON.stringify(found));
});

test("referencias a pasos ('Paso 1 de 10', 'los 12 pasos') no cuentan como números inventados", () => {
  const src = "Reúne tus documentos y anota la fecha en que entraste.";
  assert.strictEqual(findUnsupportedContact("Paso 1 de 10:\nReúne tus documentos. ¿Quieres que te diga el paso 2?", src), null);
  assert.strictEqual(findUnsupportedContact("Este es el resumen de los 12 pasos. Paso 10: apela dentro del plazo.", src), null);
  // pero un número real que no está en la fuente sí se bloquea
  const found = findUnsupportedContact("Paso 1 de 10: llama al 12366.", src);
  assert.ok(found && found.kind === "number" && found.token === "12366", JSON.stringify(found));
});

test("teléfono presente con otro formato pasa; teléfono ajeno se bloquea", () => {
  assert.strictEqual(hasUnsupportedContactInfo("Llama al 0800 12345.", SOURCE), false);
  assert.strictEqual(hasUnsupportedContactInfo("Llama al 999888777.", SOURCE), true);
});
