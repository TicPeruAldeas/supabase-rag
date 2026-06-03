const cache = new Map();

const TTL_MS = 10 * 60 * 1000; // 10 minutos
const MAX_ENTRIES = 5000;       // tope de seguridad para no crecer sin límite

function normalize(text) {
  return String(text || "").trim().toLowerCase();
}

// La clave incluye userId: las respuestas se generan con el historial del
// usuario (puede contener su nombre/ciudad), por lo que NUNCA deben servirse
// a otro usuario aunque la pregunta sea idéntica.
function getCacheKey(countryCode, userId, question) {
  return `${countryCode}:${userId}:${normalize(question)}`;
}

function sweepExpired(now) {
  for (const [key, item] of cache) {
    if (now - item.createdAt > TTL_MS) cache.delete(key);
  }
}

function getCached(countryCode, userId, question) {
  const key = getCacheKey(countryCode, userId, question);
  const item = cache.get(key);
  if (!item) return null;

  if (Date.now() - item.createdAt > TTL_MS) {
    cache.delete(key);
    return null;
  }

  return item.value;
}

function setCached(countryCode, userId, question, value) {
  // Barrido perezoso para evitar crecimiento ilimitado de memoria.
  if (cache.size >= MAX_ENTRIES) {
    const now = Date.now();
    sweepExpired(now);
    // Si tras el barrido sigue lleno, descarta la entrada más antigua.
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  cache.set(getCacheKey(countryCode, userId, question), {
    value,
    createdAt: Date.now(),
  });
}

module.exports = {
  getCached,
  setCached,
};
