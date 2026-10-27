// Navegación explícita dentro de un paso a paso: "todos los pasos", "paso N",
// y rescate del JSON del modelo cuando llega cortado. Puras, sin red.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "dummy";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";

const { test } = require("node:test");
const assert = require("node:assert");
const {
  isAllStepsRequest, parseRequestedStep, salvageStepJson, formatAllStepsFallback, isContinuationMessage,
} = require("../rag-service");

test("isAllStepsRequest: detecta pedidos de ver todos los pasos", () => {
  for (const msg of [
    "dame todos los pasos",
    "Dime todos los pasos",
    "mándame todo",
    "mandame todo por favor",
    "quiero ver todo el proceso",
    "dame el resumen completo",
    "todos",
    "me puedes dar todos los 12 pasos?",
    "manda tudo",
    "quero todos os passos",
  ]) {
    assert.strictEqual(isAllStepsRequest(msg), true, `"${msg}" debería pedir todos los pasos`);
  }
});

test("isAllStepsRequest: no se dispara con mensajes normales del flujo", () => {
  for (const msg of ["sí", "siguiente", "paso 3", "¿cuál es el teléfono de Migraciones?", "todos mis documentos están vencidos, ¿qué hago?"]) {
    assert.strictEqual(isAllStepsRequest(msg), false, `"${msg}" NO debería pedir todos los pasos`);
  }
});

test("parseRequestedStep: número explícito, ordinal, número suelto y último", () => {
  assert.strictEqual(parseRequestedStep("paso 3", 12), 3);
  assert.strictEqual(parseRequestedStep("más detalle del paso 5", 12), 5);
  assert.strictEqual(parseRequestedStep("Explícame el paso 10 por favor", 12), 10);
  assert.strictEqual(parseRequestedStep("el 7", 12), 7);
  assert.strictEqual(parseRequestedStep("7", 12), 7);
  assert.strictEqual(parseRequestedStep("explícame el tercero", 12), 3);
  assert.strictEqual(parseRequestedStep("dime el último paso", 12), 12);
  assert.strictEqual(parseRequestedStep("passo 2", 12), 2);
});

test("parseRequestedStep: fuera de rango o sin número → null", () => {
  assert.strictEqual(parseRequestedStep("paso 15", 12), null);
  assert.strictEqual(parseRequestedStep("0", 12), null);
  assert.strictEqual(parseRequestedStep("sí", 12), null);
  assert.strictEqual(parseRequestedStep("tengo 2 hijos, ¿qué hago?", 12), null);
  assert.strictEqual(parseRequestedStep("mi número es 987654321", 12), null);
});

test("'paso N' se atiende como navegación antes que como continuación", () => {
  // CONTINUATION_REGEX también acepta "paso N"; el orden de evaluación evita
  // que "paso 5" muestre el paso siguiente en vez del 5.
  assert.strictEqual(isContinuationMessage("paso 5"), true);
  assert.strictEqual(parseRequestedStep("paso 5", 12), 5);
});

test("salvageStepJson: JSON válido", () => {
  const r = salvageStepJson('{"accion":"siguiente","respuesta":"Paso 2 de 12:\\nHaz esto."}');
  assert.deepStrictEqual({ accion: r.accion, respuesta: r.respuesta }, { accion: "siguiente", respuesta: "Paso 2 de 12:\nHaz esto." });
});

test("salvageStepJson: JSON cortado por max_tokens → rescata el texto, nunca devuelve JSON crudo", () => {
  const raw = '{"accion":"todos","respuesta":"Paso 1 de 12: Guarda tu Tarjeta Andina.\\n\\nPaso 2 de 12: Elige la calidad migratoria y solicita el cambio antes de que venza tu permiso. Al aprobarte, recibes el Carné';
  const r = salvageStepJson(raw);
  assert.strictEqual(r.accion, "todos");
  assert.ok(r.salvaged);
  assert.ok(r.respuesta.startsWith("Paso 1 de 12: Guarda tu Tarjeta Andina."), r.respuesta);
  assert.ok(!r.respuesta.includes('"accion"'));
});

test("salvageStepJson: texto plano sin JSON se devuelve como detalle", () => {
  const r = salvageStepJson("Claro, el paso 2 consiste en...");
  assert.strictEqual(r.accion, "detalle");
  assert.strictEqual(r.respuesta, "Claro, el paso 2 consiste en...");
});

test("formatAllStepsFallback: lista enumerada, ordenada y resumida a una frase por paso", () => {
  const steps = [
    { step_number: 1, step_summary: "Reúne tus documentos de ingreso y los que hayas tenido en Perú, aunque estén vencidos. Anota las fechas clave: cuándo entraste." },
    { step_number: 2, step_summary: "Verifica si tu situación corresponde a refugio, no a un trámite migratorio común. Iniciar el procedimiento equivocado cuesta tiempo." },
    { step_number: 3, step_summary: "Identifica qué vía de regularización aplica a tu caso según cómo ingresaste al país (con o sin control migratorio, o con visa vencida) y qué documentos tienes hoy, porque cada vía pide requisitos y plazos distintos." },
  ];
  const out = formatAllStepsFallback(steps, "XT");
  const lines = out.split("\n");
  assert.ok(lines[0].includes("3 pasos"), lines[0]);
  assert.ok(lines.includes("1. Reúne tus documentos de ingreso y los que hayas tenido en Perú, aunque estén vencidos."), out);
  assert.ok(lines.includes("2. Verifica si tu situación corresponde a refugio, no a un trámite migratorio común."), out);
  const l3 = lines.find(l => l.startsWith("3. "));
  assert.ok(l3 && l3.length <= 115, l3);
  assert.ok(out.trim().endsWith("Dime el número del paso."), out);
});

test("formatAllStepsFallback con fases: un título por fase y numeración dentro de cada una", () => {
  const steps = [
    { step_number: 1, step_summary: "Pregunta cuántos días de multa tienes.", step_detail: "Fase 1 de 2 — Pagos. Pregunta cuántos días." },
    { step_number: 2, step_summary: "Paga la multa.", step_detail: "Paga la multa." },
    { step_number: 3, step_summary: "Entra a la Agencia Digital.", step_detail: "Fase 2 de 2 — Presenta tu solicitud. Entra." },
  ];
  const lines = formatAllStepsFallback(steps, "XT").split("\n");
  const i = lines.indexOf("*Fase 1 de 2: Pagos*");
  assert.ok(i > 0);
  assert.strictEqual(lines[i + 1], "1. Pregunta cuántos días de multa tienes.");
  assert.strictEqual(lines[i + 2], "2. Paga la multa.");
  const j = lines.indexOf("*Fase 2 de 2: Presenta tu solicitud*");
  assert.strictEqual(lines[j + 1], "1. Entra a la Agencia Digital.");
});
