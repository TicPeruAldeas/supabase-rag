const cache = new Map();

function getCacheKey(country, question) {
  return `${country}:${question.toLowerCase().trim()}`;
}

function getFromCache(country, question) {
  const key = getCacheKey(country, question);
  return cache.get(key);
}

function saveToCache(country, question, response) {
  const key = getCacheKey(country, question);
  cache.set(key, {
    response,
    timestamp: Date.now(),
  });
}

// opcional: limpiar cache viejo (ej: 10 min)
function cleanCache() {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > 10 * 60 * 1000) {
      cache.delete(key);
    }
  }
}

setInterval(cleanCache, 5 * 60 * 1000);

module.exports = {
  getFromCache,
  saveToCache,
};