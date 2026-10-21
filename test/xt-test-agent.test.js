// Agente de PRUEBA (XT): formato de viñetas, textos propios y menú de temas.
// Verifica también que PE, CO y BR quedan exactamente como estaban.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "dummy";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";

const { test } = require("node:test");
const assert = require("node:assert");

const { usesRichFormat, usesAutoLanguage, looksPortuguese, langDirective, strings } = require("../lang");
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

test("detecta portugués sin confundirlo con español", () => {
  for (const pt of ["Olá", "oi", "Obrigado!", "Qual é o telefone?", "Meu filho não tem documentos", "Como faço para regularizar?", "bom dia"]) {
    assert.strictEqual(looksPortuguese(pt), true, pt);
  }
  for (const es of ["Hola", "Gracias", "¿Cuál es el teléfono?", "Mi hijo no tiene documentos", "¿Cómo hago para arreglar mis papeles?", "buenos días", "", null]) {
    assert.strictEqual(looksPortuguese(es), false, String(es));
  }
});

test("XT usa los textos fijos en portugués cuando le escriben en portugués", () => {
  assert.match(strings("XT", "Olá").smallTalk("Org"), /^Olá! 😊 Sou o agente Peru Multipaís/);
  assert.match(strings("XT", "Olá").welcome("Ana"), /^Obrigado\/a, Ana! 😊 Me conte o que você precisa/);
  assert.match(strings("XT", "Olá").consentText("Ana"), /^Olá, Ana! 👋 Seja bem-vindo\/a/);
  assert.match(strings("XT", "Qual é o WhatsApp?").contactNotFound("Org"), /^Não tenho esse contato por aqui/);
  assert.match(strings("XT", "Não sei").fallbackNoExcel("Org"), /^Obrigado por compartilhar/);
  // En español (o sin texto) XT mantiene sus textos de siempre.
  assert.match(strings("XT", "Hola").smallTalk("Org"), /^¡Hola! 😊 Soy el agente Perú Multipaís/);
  assert.match(strings("XT").welcome("Ana"), /^¡Gracias, Ana! 😊/);
});

test("PE, CO y BR ignoran el texto del mensaje al elegir los textos fijos", () => {
  for (const cc of ["PE", "CO", "BR"]) {
    assert.deepStrictEqual(
      Object.keys(strings(cc, "Olá, obrigado")).sort(),
      Object.keys(strings(cc)).sort()
    );
    assert.strictEqual(strings(cc, "Olá, obrigado").welcome("Ana"), strings(cc).welcome("Ana"));
  }
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

test("XT vuelve a explicar cuando la persona no entendió; PE, CO y BR no", () => {
  const { usesReexplain, isConfusionMessage, confusionLevel } = require("../rag-service");
  assert.strictEqual(usesReexplain("XT"), true);
  for (const cc of ["PE", "CO", "BR"]) assert.strictEqual(usesReexplain(cc), false);
  for (const t of ["no entendí", "No entiendo", "no me quedó claro", "explícame mejor", "¿qué significa eso?", "más simple porfa", "no comprendo nada", "Não entendi", "explica melhor"]) {
    assert.strictEqual(isConfusionMessage(t), true, t);
  }
  for (const t of ["¿Cómo pido refugio?", "sí", "gracias", "entendí, gracias", "Mi hijo no entiende las clases porque llegó de Venezuela y le cuesta mucho adaptarse"]) {
    assert.strictEqual(isConfusionMessage(t), false, t);
  }
  const h = [
    { role: "user", content: "¿Cómo regularizo?" }, { role: "assistant", content: "…" },
    { role: "user", content: "no entendí" }, { role: "assistant", content: "…" },
  ];
  assert.strictEqual(confusionLevel(h), 2);
  assert.strictEqual(confusionLevel(h.slice(0, 2)), 1);
});

test("solo XT pide lenguaje claro", () => {
  assert.match(langDirective("XT"), /LENGUAJE CLARO/);
  for (const cc of ["PE", "CO", "BR"]) assert.doesNotMatch(langDirective(cc), /LENGUAJE CLARO/);
});
