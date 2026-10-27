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

test("contactos estrictos: activos en XT y PE", () => {
  assert.strictEqual(usesStrictContact("XT"), true);
  for (const cc of ["CO", "BR"]) assert.strictEqual(usesStrictContact(cc), false);
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

test("sin contactOnly (CO, BR) el respaldo del guardarraíl no cambia", () => {
  const r = guardGroundedContactInfo("WhatsApp del Ministerio…", ABUSO, ORG, "CO", BLOQUEADO);
  assert.match(r, /no bañes/);
  assert.match(r, /Datos de contacto: Línea de atención/);
});

test("XT y PE usan el formato de viñetas; CO y BR no", () => {
  assert.strictEqual(usesRichFormat("XT"), true);
  for (const cc of ["CO", "BR"]) assert.strictEqual(usesRichFormat(cc), false);
});

test("la directiva de formato se anexa a XT y PE", () => {
  assert.match(langDirective("XT"), /FORMATO DE RESPUESTA PARA WHATSAPP/);
  assert.strictEqual(langDirective("CO"), "");
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

test("XT usa sus textos fijos en español aunque le escriban en portugués", () => {
  assert.match(strings("XT", "Olá").smallTalk("Org"), /^¡Hola! 😊 Soy el agente Perú Multipaís/);
  assert.match(strings("XT", "Olá").welcome("Ana"), /^¡Gracias, Ana! 😊/);
  assert.match(strings("XT", "Olá").consentText("Ana"), /^¡Hola, Ana! 👋 Bienvenido\/a/);
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

test("ningún país responde en el idioma de cada mensaje; BR sigue fijo en portugués", () => {
  for (const cc of ["XT", "PE", "CO", "BR"]) assert.strictEqual(usesAutoLanguage(cc), false);
  assert.doesNotMatch(langDirective("XT"), /MISMO idioma del ÚLTIMO mensaje/);
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
  assert.match(welcome, /^¡Gracias, Ana! 😊 Cuéntame qué necesitas\. Puedo orientarte sobre:\n\n• \*Documentación y situación migratoria:\* papeles/);
  assert.match(welcome, /• \*Acceso a derechos:\* salud, colegio, trabajo, banco, vivienda\n\nEscríbelo con tus propias palabras, sin preocuparte por cómo lo digas 💙$/);
  assert.doesNotMatch(welcome, /servicios|La organización/);
  assert.match(strings("XT").welcome(null), /^¡Gracias! 😊/);
  assert.match(strings("XT").smallTalk("Aldeas Infantiles SOS Perú"), /^¡Hola! 😊 Soy el agente Perú Multipaís de Aldeas Infantiles SOS\..*\n• \*Protección de niñas, niños y adolescentes:\* violencia, abuso, pensión de alimentos\n/s);
  assert.doesNotMatch(strings("XT", "Olá").welcome("Ana"), /A organização/);
});

test("CO y BR conservan sus textos originales aunque se les pase un menú", () => {
  for (const cc of ["CO", "BR"]) {
    assert.strictEqual(strings(cc).welcome("Ana", "• X"), strings(cc).welcome("Ana"));
    assert.strictEqual(strings(cc).smallTalk("Org", "• X"), strings(cc).smallTalk("Org"));
  }
  assert.match(strings("CO").consentText("Ana"), /programas y servicios/);
});

test("XT y PE vuelven a explicar cuando la persona no entendió; CO y BR no", () => {
  const { usesReexplain, isConfusionMessage, confusionLevel } = require("../rag-service");
  assert.strictEqual(usesReexplain("XT"), true);
  for (const cc of ["CO", "BR"]) assert.strictEqual(usesReexplain(cc), false);
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

test("XT y PE piden lenguaje claro", () => {
  assert.match(langDirective("XT"), /LENGUAJE CLARO/);
  for (const cc of ["CO", "BR"]) assert.doesNotMatch(langDirective(cc), /LENGUAJE CLARO/);
});

test("XT y PE: respuestas cortas y claras; CO y BR sin cambios", () => {
  assert.match(langDirective("XT"), /RESPUESTA CORTA Y CLARA/);
  assert.match(langDirective("XT"), /Máximo 50 palabras/);
  for (const cc of ["CO", "BR"]) assert.doesNotMatch(langDirective(cc), /RESPUESTA CORTA/);
});

test("XT y PE usan Haiku 5.5 sin pensamiento para el reranker; CO y BR siguen con el modelo principal", () => {
  const { rerankModelParams } = require("../rag-service");
  assert.deepStrictEqual(rerankModelParams("XT"), { model: "claude-haiku-5-5", thinking: { type: "disabled" } });
  for (const cc of ["CO", "BR"]) {
    assert.deepStrictEqual(rerankModelParams(cc), { model: "claude-sonnet-4-6", temperature: 0 });
  }
});

test("XT se salta el reranker si el 1.º tema le saca ventaja clara al 2.º; PE, CO y BR no cambian", async () => {
  const { canSkipRerank } = require("../rag-service");
  assert.strictEqual(canSkipRerank([{ similarity: 0.61 }, { similarity: 0.40 }]), true);
  assert.strictEqual(canSkipRerank([{ similarity: 0.60 }, { similarity: 0.58 }]), false);
});

test("PE: mismas funciones que XT, con los temas de su matriz", () => {
  const { usesReexplain, rerankModelParams } = require("../rag-service");
  assert.strictEqual(usesStrictContact("PE"), true);
  assert.strictEqual(usesRichFormat("PE"), true);
  assert.strictEqual(usesReexplain("PE"), true);
  assert.deepStrictEqual(rerankModelParams("PE"), rerankModelParams("XT"));
  assert.strictEqual(langDirective("PE"), langDirective("XT"));
  assert.match(strings("PE").consentText("Ana"), /^¡Hola, Ana! 👋 Bienvenido\/a 😊\. Soy el agente Perú Multipaís de Aldeas Infantiles SOS\./);
  const welcome = strings("PE").welcome("Ana");
  assert.match(welcome, /• \*Documentación y situación migratoria:\* papeles, carné de extranjería, multas, trámites de tus hijos/);
  assert.match(welcome, /• \*Acceso a derechos:\* salud, colegio, trabajo, discapacidad, alimentación/);
  assert.match(strings("PE").smallTalk("Org"), /separación familiar, crianza/);
  assert.doesNotMatch(welcome, /banco, vivienda/); // temas de XT, no de PE
});
