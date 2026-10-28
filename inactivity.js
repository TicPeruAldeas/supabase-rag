// Temporizadores de inactividad por conversación: si la persona no vuelve a
// escribir en `delayMs`, se ejecuta `onExpire(key, payload)` una sola vez. Cada mensaje
// nuevo cancela el temporizador pendiente. Viven en memoria: un redeploy los
// descarta (en el peor caso, esa persona no recibe la despedida).
function createInactivityTimers(delayMs, onExpire) {
  const timers = new Map();

  function cancel(key) {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.delete(key);
  }

  function schedule(key, payload) {
    cancel(key);
    const t = setTimeout(() => {
      timers.delete(key);
      Promise.resolve()
        .then(() => onExpire(key, payload))
        .catch(err => console.error(`⚠️  Despedida por inactividad [${key}]:`, err.message));
    }, delayMs);
    if (t.unref) t.unref();
    timers.set(key, t);
  }

  return { schedule, cancel, pending: () => timers.size };
}

module.exports = { createInactivityTimers };
