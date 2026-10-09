// Agente de PRUEBA (XT): formato de viñetas, textos propios y menú de temas.
// Verifica también que PE, CO y BR quedan exactamente como estaban.
const { test } = require("node:test");
const assert = require("node:assert");

const { usesRichFormat, langDirective, strings } = require("../lang");

test("solo XT usa el formato de viñetas", () => {
  assert.strictEqual(usesRichFormat("XT"), true);
  for (const cc of ["PE", "CO", "BR"]) assert.strictEqual(usesRichFormat(cc), false);
});

test("la directiva de formato solo se anexa a XT", () => {
  assert.match(langDirective("XT"), /FORMATO DE RESPUESTA PARA WHATSAPP/);
  assert.strictEqual(langDirective("PE"), "");
  assert.strictEqual(langDirective("CO"), "");
  assert.doesNotMatch(langDirective("BR"), /FORMATO DE RESPUESTA/);
});

test("XT se presenta como agente Perú Multipaís, sin hablar de programas y servicios", () => {
  const card = strings("XT").consentText("Ana");
  assert.match(card, /^Hola Ana, soy el agente Perú Multipaís de Aldeas Infantiles SOS\./);
  assert.doesNotMatch(card, /programas y servicios/);
});

test("la bienvenida y el saludo de XT listan los temas recibidos", () => {
  const topics = "• Documentación\n• Acceso a derechos";
  assert.match(strings("XT").welcome("Ana", topics), /estos temas:\n\n• Documentación\n• Acceso a derechos\n\n/);
  assert.match(strings("XT").smallTalk("Aldeas Infantiles SOS Perú", topics), /• Acceso a derechos/);
  // Sin temas cargados, igual saluda sin dejar la lista vacía.
  assert.doesNotMatch(strings("XT").welcome("Ana", ""), /estos temas/);
});

test("PE, CO y BR conservan sus textos originales aunque se les pase un menú", () => {
  for (const cc of ["PE", "CO", "BR"]) {
    assert.strictEqual(strings(cc).welcome("Ana", "• X"), strings(cc).welcome("Ana"));
    assert.strictEqual(strings(cc).smallTalk("Org", "• X"), strings(cc).smallTalk("Org"));
  }
  assert.match(strings("PE").consentText("Ana"), /programas y servicios/);
});
