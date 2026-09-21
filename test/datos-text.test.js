// Pruebas del helper de la columna "Datos" (puras, sin red).
const { test } = require("node:test");
const assert = require("node:assert");
const { mergeDatos, splitDatos, DATOS_HEADER } = require("../datos-text");

test("mergeDatos: sin Datos devuelve la Respuesta tal cual", () => {
  assert.strictEqual(mergeDatos("Texto principal.", ""), "Texto principal.");
  assert.strictEqual(mergeDatos("Texto principal.", null), "Texto principal.");
});

test("mergeDatos: con Datos añade la sección etiquetada al final", () => {
  const out = mergeDatos("Texto principal.", "Central: (01) 12349 · Av. España 734");
  assert.ok(out.startsWith("Texto principal."));
  assert.ok(out.includes(DATOS_HEADER));
  assert.ok(out.endsWith("Central: (01) 12349 · Av. España 734"));
});

test("splitDatos: separa Respuesta y Datos de un answer guardado (ida y vuelta)", () => {
  const merged = mergeDatos("Puedes acudir a Migraciones.", "Central: (01) 12349");
  const { respuesta, datos } = splitDatos(merged);
  assert.strictEqual(respuesta, "Puedes acudir a Migraciones.");
  assert.strictEqual(datos, "Central: (01) 12349");
});

test("splitDatos: un answer sin sección devuelve datos vacío y la respuesta intacta", () => {
  const { respuesta, datos } = splitDatos("Solo respuesta, sin contactos.");
  assert.strictEqual(respuesta, "Solo respuesta, sin contactos.");
  assert.strictEqual(datos, "");
});
