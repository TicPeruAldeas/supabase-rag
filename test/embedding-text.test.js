const { test } = require("node:test");
const assert = require("node:assert");

const { buildFlowEmbeddingInput } = require("../embedding-text");

test("buildFlowEmbeddingInput: incluye contexto completo de la fila", () => {
  assert.strictEqual(
    buildFlowEmbeddingInput({
      category: "Proteccion infantil",
      subtopic: "Grooming",
      question: "Mi hijo chatea con amigos mayores",
      answer: "Orientar sobre riesgos con desconocidos y redes de apoyo.",
    }),
    [
      "Categoria: Proteccion infantil",
      "Subtema: Grooming",
      "Pregunta: Mi hijo chatea con amigos mayores",
      "Respuesta: Orientar sobre riesgos con desconocidos y redes de apoyo.",
    ].join("\n")
  );
});
