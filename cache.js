const cache = new Map();

function normalize(text) {
  return String(text || "").trim().toLowerCase();
}

function getCacheKey(countryCode, question) {
  return `${countryCode}:${normalize(question)}`;
}

function getCached(countryCode, question) {
  const item = cache.get(getCacheKey(countryCode, question));
  if (!item) return null;

  const ageMs = Date.now() - item.createdAt;
  const ttlMs = 10 * 60 * 1000; // 10 minutos

  if (ageMs > ttlMs) {
    cache.delete(getCacheKey(countryCode, question));
    return null;
  }

  return item.value;
}

function setCached(countryCode, question, value) {
  cache.set(getCacheKey(countryCode, question), {
    value,
    createdAt: Date.now(),
  });
}

module.exports = {
  getCached,
  setCached,
};