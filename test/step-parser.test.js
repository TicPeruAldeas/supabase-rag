// Paso a paso: respuestas con fases cuya numeración reinicia en cada fase.
const { test } = require("node:test");
const assert = require("node:assert");
const { parseSteps } = require("../step-parser");

const MULTA = `FASE 1: PAGOS

1. Pregunta cuántos días de multa tienes.

2. Paga la multa.

3. Paga el costo del trámite.

FASE 2: PRESENTA TU SOLICITUD

Cuando tengas los dos pagos hechos, presenta tu solicitud lo antes posible.

1. Entra a la Agencia Digital de Migraciones.

2. Elige el trámite.

FASE 3: SEGUIMIENTO

1. Revisa cómo va tu trámite.

2. Revisa seguido tu Buzón Electrónico.`;

test("con fases: numera seguido y no pierde ningún paso", () => {
  const steps = parseSteps(MULTA);
  assert.deepStrictEqual(steps.map(s => s.number), [1, 2, 3, 4, 5, 6, 7]);
  assert.match(steps[6].text, /Buzón Electrónico/);
});

test("con fases: el título y la introducción de la fase van al inicio de su primer paso", () => {
  const steps = parseSteps(MULTA);
  assert.strictEqual(steps[0].text, "Fase 1 de 3 — Pagos. Pregunta cuántos días de multa tienes.");
  assert.strictEqual(steps[3].text, "Fase 2 de 3 — Presenta tu solicitud. Cuando tengas los dos pagos hechos, presenta tu solicitud lo antes posible. Entra a la Agencia Digital de Migraciones.");
  assert.strictEqual(steps[5].text, "Fase 3 de 3 — Seguimiento. Revisa cómo va tu trámite.");
  assert.strictEqual(steps[2].text, "Paga el costo del trámite."); // no arrastra el título de la fase siguiente
});

test("sin fases: el texto previo al paso 1 ya no se pierde", () => {
  const steps = parseSteps("El carné es gratis.\n1. Consigue tu certificado.\n2. Presenta tu solicitud.");
  assert.deepStrictEqual(steps, [
    { number: 1, text: "El carné es gratis. Consigue tu certificado." },
    { number: 2, text: "Presenta tu solicitud." },
  ]);
});

test("sin fases: una respuesta numerada normal queda igual que antes", () => {
  const steps = parseSteps("1. Reúne tus documentos.\nCopia del pasaporte.\n2. Paga la tasa.\n3. Presenta la solicitud.");
  assert.deepStrictEqual(steps, [
    { number: 1, text: "Reúne tus documentos. Copia del pasaporte." },
    { number: 2, text: "Paga la tasa." },
    { number: 3, text: "Presenta la solicitud." },
  ]);
});

test("sin pasos numerados devuelve una lista vacía", () => {
  assert.deepStrictEqual(parseSteps("Solo texto informativo."), []);
  assert.deepStrictEqual(parseSteps(""), []);
});
