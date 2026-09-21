// Columna "Datos" del Excel: información COMPLEMENTARIA de un flow (teléfonos,
// centrales, sedes, direcciones, horarios, correos, webs, canales). La columna
// "Respuesta" es la información PRINCIPAL.
//
// knowledge_flows no tiene columna propia para esto y el RPC de búsqueda solo
// devuelve `answer`, así que los Datos viajan DENTRO de `answer`, al final, bajo
// una sección etiquetada. Con eso: el retrieval los trae, el guardrail de
// contactos los reconoce como fuente legítima (no los bloquea), y los prompts
// los usan solo cuando el usuario los pide o cuando son útiles por contexto.
const DATOS_HEADER = "DATOS DE CONTACTO:";
const MARK = `\n${DATOS_HEADER}\n`;

// Respuesta + Datos → texto a guardar en `answer`. Sin Datos, devuelve la
// Respuesta tal cual (byte a byte), así los flows sin Datos no cambian.
function mergeDatos(respuesta, datos) {
  const r = String(respuesta || "").trim();
  const d = String(datos || "").trim();
  if (!d) return r;
  return `${r}\n${MARK}${d}`;
}

// `answer` guardado → { respuesta, datos }. Si no hay sección, datos = "".
function splitDatos(answer) {
  const text = String(answer || "");
  const i = text.indexOf(MARK);
  if (i < 0) return { respuesta: text.trim(), datos: "" };
  return {
    respuesta: text.slice(0, i).trim(),
    datos: text.slice(i + MARK.length).trim(),
  };
}

module.exports = { DATOS_HEADER, mergeDatos, splitDatos };
