// Despedida por inactividad: temporizador por conversación.
const { test } = require("node:test");
const assert = require("node:assert");
const { createInactivityTimers } = require("../inactivity");

const wait = (ms) => new Promise(r => setTimeout(r, ms));

test("si la persona no vuelve a escribir, la despedida se envía una sola vez", async () => {
  const sent = [];
  const timers = createInactivityTimers(30, (key, ctx) => sent.push([key, ctx.from]));
  timers.schedule("PE:51999", { from: "51999" });
  await wait(80);
  assert.deepStrictEqual(sent, [["PE:51999", "51999"]]);
  assert.strictEqual(timers.pending(), 0);
});

test("un mensaje nuevo cancela la despedida pendiente", async () => {
  const sent = [];
  const timers = createInactivityTimers(30, (key) => sent.push(key));
  timers.schedule("PE:51999", {});
  timers.cancel("PE:51999");
  await wait(80);
  assert.deepStrictEqual(sent, []);
});

test("cada respuesta reinicia la cuenta (no se acumulan despedidas)", async () => {
  const sent = [];
  const timers = createInactivityTimers(300, (key) => sent.push(key));
  timers.schedule("PE:51999", {});
  await wait(150);
  timers.schedule("PE:51999", {});
  await wait(220); // ya pasaron 370 ms desde la primera: no debe haber corrido
  assert.deepStrictEqual(sent, []);
  await wait(250);
  assert.deepStrictEqual(sent, ["PE:51999"]);
});

test("un error al enviar no rompe el proceso", async () => {
  const timers = createInactivityTimers(10, () => { throw new Error("Meta caído"); });
  timers.schedule("PE:51999", {});
  await wait(40);
  assert.strictEqual(timers.pending(), 0);
});
