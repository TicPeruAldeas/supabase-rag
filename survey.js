// Encuesta de satisfacción al despedirse (por ahora solo Brasil).
//
// Flujo: cuando la persona se despide ("obrigado", "tchau"), el agente pregunta
// si la conversación fue buena, con dos botones. "Foi boa" → agradece y se
// despide. "Pode melhorar" → pide un comentario corto; lo que escriba se guarda
// como comentario y el agente se despide. Si en vez de un comentario escribe
// una consulta, se responde normalmente.
//
// El estado pendiente vive en memoria (se pierde en un redeploy, sin otro
// efecto: los botones se reconocen por su id aunque no haya estado).

const SURVEY_COUNTRIES = new Set(["BR"]);
const SURVEY_GOOD_ID = "survey_good";
const SURVEY_IMPROVE_ID = "survey_improve";
const SURVEY_TTL_MS = 30 * 60 * 1000;

function usesSurvey(countryCode) {
  return SURVEY_COUNTRIES.has(String(countryCode || "").toUpperCase());
}

// Respuesta escrita en vez de tocar un botón ("foi boa", "pode melhorar").
const GOOD_REGEX = /^\s*(foi\s+)?(boa|bom|[oó]tima|[oó]timo|excelente|muito\s+boa|gostei|sim|👍)[\s!.]*$/i;
const IMPROVE_REGEX = /^\s*(pode\s+melhorar|melhorar|n[aã]o\s+gostei|ruim|regular|mais\s+ou\s+menos)[\s!.]*$/i;

function classifyRating(buttonId, text) {
  if (buttonId === SURVEY_GOOD_ID) return "good";
  if (buttonId === SURVEY_IMPROVE_ID) return "improve";
  const t = String(text || "");
  if (GOOD_REGEX.test(t)) return "good";
  if (IMPROVE_REGEX.test(t)) return "improve";
  return null;
}

// ¿El texto parece una consulta nueva y no un comentario? Pregunta explícita o
// inicio típico de consulta en portugués/español.
const QUESTION_START = /^\s*(como|onde|qual|quais|quando|quanto|quem|o\s+que|por\s*que|posso|pode|preciso|quero\s+saber|gostaria\s+de\s+saber|tem\s+como|existe|d[oó]nde|c[oó]mo|cu[aá]l|qu[eé]|puedo|necesito)\b/i;

function looksLikeQuery(text) {
  const t = String(text || "").trim();
  return t.includes("?") || QUESTION_START.test(t);
}

function createSurveyStore(ttlMs = SURVEY_TTL_MS, now = () => Date.now()) {
  const pending = new Map(); // `${país}:${usuario}` → { stage: "rating" | "comment", ts }
  return {
    set(key, stage) { pending.set(key, { stage, ts: now() }); },
    get(key) {
      const hit = pending.get(key);
      if (!hit) return null;
      if (now() - hit.ts > ttlMs) { pending.delete(key); return null; }
      return hit.stage;
    },
    clear(key) { pending.delete(key); },
  };
}

module.exports = {
  SURVEY_GOOD_ID,
  SURVEY_IMPROVE_ID,
  usesSurvey,
  classifyRating,
  looksLikeQuery,
  createSurveyStore,
};
