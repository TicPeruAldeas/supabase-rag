// Agente de PRUEBA (XT): formato de viñetas, textos propios y menú de temas.
// Verifica también que PE, CO y BR quedan exactamente como estaban.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "dummy";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";

const { test } = require("node:test");
const assert = require("node:assert");

const { usesRichFormat, usesAutoLanguage, langDirective, strings } = require("../lang");
const { usesStrictContact, datosContainAllTokens, guardGroundedContactInfo } = require("../rag-service");
const { mergeDatos } = require("../datos-text");

// Fila de abuso sexual: sus Datos mencionan "salud", pero no un ministerio.
const ABUSO = mergeDatos(
  "Lo primero: lo que sientes ahora es difícil. Si el hecho es reciente, no bañes a tu hija.",
  "Línea de atención de violencia: 000 · Establecimiento de salud de referencia: Av. Ejemplo 654, (00) 000-0009"
);
const ORG = "Aldeas Infantiles SOS Perú";
const BLOQUEADO = { kind: "institution", token: "Ministerio" };

test("contactos estrictos: activos solo en XT por ahora", () => {
  assert.strictEqual(usesStrictContact("XT"), true);
  for (const cc of ["PE", "CO", "BR"]) assert.strictEqual(usesStrictContact(cc), false);
});

test("la búsqueda estricta exige TODAS las palabras en los Datos", () => {
  assert.strictEqual(datosContainAllTokens(ABUSO, ["ministerio", "salud"]), false); // caso 4
  assert.strictEqual(datosContainAllTokens(ABUSO, ["salud"]), true);
  assert.strictEqual(datosContainAllTokens(ABUSO, ["violencia", "línea"]), true); // sin importar tildes
  assert.strictEqual(datosContainAllTokens("Respuesta sin datos", ["salud"]), false);
});

test("pedido de contacto bloqueado en XT: nunca muestra la respuesta principal", () => {
  const porPalabra = guardGroundedContactInfo("WhatsApp del Ministerio…", ABUSO, ORG, "XT", BLOQUEADO, { contactOnly: true, keywordMatch: true });
  assert.strictEqual(porPalabra, strings("XT").contactNotFound(ORG));

  const porTema = guardGroundedContactInfo("WhatsApp del Ministerio…", ABUSO, ORG, "XT", BLOQUEADO, { contactOnly: true });
  assert.match(porTema, /^Estos son los datos de contacto que tengo sobre este tema:/);
  assert.doesNotMatch(porTema, /no bañes/);
});

test("sin contactOnly (PE, CO, BR) el respaldo del guardarraíl no cambia", () => {
  const r = guardGroundedContactInfo("WhatsApp del Ministerio…", ABUSO, ORG, "PE", BLOQUEADO);
  assert.match(r, /no bañes/);
  assert.match(r, /Datos de contacto: Línea de atención/);
});

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

test("solo XT responde en el idioma de cada mensaje; BR sigue fijo en portugués", () => {
  assert.strictEqual(usesAutoLanguage("XT"), true);
  for (const cc of ["PE", "CO", "BR"]) assert.strictEqual(usesAutoLanguage(cc), false);
  assert.match(langDirective("XT"), /MISMO idioma del ÚLTIMO mensaje/);
  assert.match(langDirective("BR"), /SEMPRE em português/);
  assert.doesNotMatch(langDirective("BR"), /MISMO idioma del ÚLTIMO mensaje/);
});

test("XT se presenta como agente Perú Multipaís, sin hablar de programas y servicios", () => {
  const card = strings("XT").consentText("Ana");
  assert.match(card, /^¡Hola, Ana! 👋 Bienvenido\/a 😊\. Soy el agente Perú Multipaís de Aldeas Infantiles SOS\./);
  assert.match(card, /sin importar tu situación migratoria/);
  assert.match(strings("XT").consentText(null), /^¡Hola! 👋 Bienvenido\/a/);
  assert.doesNotMatch(card, /programas y servicios/);
});

test("la bienvenida y el saludo de XT muestran los temas con ejemplos", () => {
  const welcome = strings("XT").welcome("Ana");
  assert.match(welcome, /^¡Gracias, Ana! 😊 Cuéntame qué necesitas\. Puedo orientarte sobre:\n\n• \*Documentación:\* papeles/);
  assert.match(welcome, /• \*La organización:\* qué hacemos y cómo pedir apoyo\n\nEscríbelo con tus propias palabras, sin preocuparte por cómo lo digas 💙$/);
  assert.doesNotMatch(welcome, /servicios/);
  assert.match(strings("XT").welcome(null), /^¡Gracias! 😊/);
  assert.match(strings("XT").smallTalk("Aldeas Infantiles SOS Perú"), /^¡Hola! 😊 Soy el agente Perú Multipaís de Aldeas Infantiles SOS\..*\n• \*Tus derechos:\* salud, educación, trabajo\n/s);
});

test("PE, CO y BR conservan sus textos originales aunque se les pase un menú", () => {
  for (const cc of ["PE", "CO", "BR"]) {
    assert.strictEqual(strings(cc).welcome("Ana", "• X"), strings(cc).welcome("Ana"));
    assert.strictEqual(strings(cc).smallTalk("Org", "• X"), strings(cc).smallTalk("Org"));
  }
  assert.match(strings("PE").consentText("Ana"), /programas y servicios/);
});
