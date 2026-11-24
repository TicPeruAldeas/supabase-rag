// Agente de Brasil (BR): "Maria", en portugués, con las mismas funciones que PE
// (Producto 3). Colombia (CO) no cambia.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "dummy";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";

const { test } = require("node:test");
const assert = require("node:assert");

const { langDirective, strings } = require("../lang");
const { isContactRequest, usesStrictContact, usesReexplain } = require("../rag-service");

test("BR se presenta como Maria y pide aceptar la política de privacidad con el botón Aceito", () => {
  const s = strings("BR");
  assert.match(s.consentText("Ana"), /^Olá, Ana, que bom ter você aqui! Sou a Maria, assistente virtual da Aldeias Infantis SOS - Brasil. 🧸/);
  assert.match(s.consentText(), /^Olá, que bom ter você aqui!/);
  assert.match(s.consentText("Ana"), /Você aceita a Política de Privacidade da Aldeias Infantis SOS\?/);
  assert.match(s.consentText("Ana"), /https:\/\/www\.aldeiasinfantis\.org\.br\/privacidade-e-seguranca$/);
  assert.strictEqual(s.consentButtonTitle(), "Aceito");
});

test("BR: bienvenida con las 3 categorías y despedida de Maria", () => {
  const s = strings("BR");
  const welcome = s.welcome("Ana");
  assert.match(welcome, /^Obrigada! Posso te ajudar com estes temas:/);
  for (const cat of ["Regularização e Documentação", "Proteção Infantil e Familiar", "Acesso a Direitos e Serviços"]) {
    assert.ok(welcome.includes(`*${cat}:*`), cat);
  }
  assert.match(welcome, /Qual a sua pergunta\?$/);
  const adeus = "A Aldeias Infantis SOS e a Maria agradecem pelo contato. Quando precisar de algo, é só chamar! Até breve! 👋";
  assert.strictEqual(s.closing(), adeus);
  assert.strictEqual(s.inactivityFarewell(), adeus);
  assert.match(s.inactivityFarewellSteps(), /\*próximo\*/);
  assert.match(s.contactNotFound("Org"), /^Não tenho esse contato/);
});

test("BR: el idioma va al final del prompt, después del formato", () => {
  const d = langDirective("BR");
  assert.ok(d.indexOf("FORMATO DE RESPUESTA") < d.indexOf("SEMPRE em português"));
  assert.match(d, /"Passo 1 de 3:"/);
});

test("CO: igual que el agente de prueba, en español, sin textos de Maria", () => {
  const s = strings("CO");
  assert.doesNotMatch(langDirective("CO"), /português/);
  assert.doesNotMatch(s.consentText("Ana"), /Maria/);
  assert.strictEqual(s.consentButtonTitle(), "Continuar");
  for (const cat of ["Regularización y documentación", "Protección infantil y familiar", "Acceso a derechos", "Empleabilidad y permanencia"]) {
    assert.ok(s.welcome("Ana").includes(`*${cat}:*`), cat);
  }
  assert.match(s.fallbackNoExcel(), /no tengo información por ahora/);
  assert.doesNotMatch(s.fallbackNoExcel("Aldeas Infantiles SOS Colombia"), /canales oficiales/);
  assert.match(s.inactivityFarewell(), /^Parece que ya no estás por aquí/);
});

test("pedidos de contacto en portugués solo cuentan en BR", () => {
  for (const t of ["Qual é o telefone do Conselho Tutelar?", "Me passa o contato da Defensoria", "Onde fica o CRAS?"]) {
    assert.strictEqual(isContactRequest(t, "BR"), true, t);
  }
  assert.strictEqual(isContactRequest("Qual o endereço?", "PE"), false);
  assert.strictEqual(isContactRequest("Meu filho pode estudar no Brasil?", "BR"), false);
});

test("BR: respuestas cortas como el agente de prueba (40 palabras; 65 por paso)", () => {
  assert.ok(langDirective("BR").includes('Máximo 40 palabras en total. Si presentas un paso ("Paso X de N"), hasta 65 palabras.'));
  assert.ok(langDirective("PE").includes("Máximo 50 palabras en total."));
});

test("BR: el saludo en medio de la conversación también dice Aldeias Infantis SOS - Brasil", () => {
  assert.match(strings("BR").smallTalk(), /^Olá! Sou a Maria, assistente virtual da Aldeias Infantis SOS - Brasil\. 🧸/);
});
