function cleanPart(label, value) {
  const text = String(value ?? "").trim();
  return text ? `${label}: ${text}` : null;
}

function buildFlowEmbeddingInput({ category, subtopic, question, answer }) {
  return [
    cleanPart("Categoria", category),
    cleanPart("Subtema", subtopic),
    cleanPart("Pregunta", question),
    cleanPart("Respuesta", answer),
  ].filter(Boolean).join("\n");
}

module.exports = { buildFlowEmbeddingInput };
