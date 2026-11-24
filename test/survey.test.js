// Encuesta de satisfacción al despedirse (solo Brasil).
const { test } = require("node:test");
const assert = require("node:assert");
const { usesSurvey, classifyRating, looksLikeQuery, createSurveyStore, SURVEY_GOOD_ID, SURVEY_IMPROVE_ID } = require("../survey");
const { strings } = require("../lang");

test("la encuesta solo está activa en BR", () => {
  assert.strictEqual(usesSurvey("BR"), true);
  for (const cc of ["PE", "CO", "XT"]) assert.strictEqual(usesSurvey(cc), false);
});

test("reconoce la calificación por botón o por texto", () => {
  assert.strictEqual(classifyRating(SURVEY_GOOD_ID, null), "good");
  assert.strictEqual(classifyRating(SURVEY_IMPROVE_ID, null), "improve");
  for (const t of ["Foi boa", "boa!", "ótima", "gostei", "👍"]) assert.strictEqual(classifyRating(null, t), "good", t);
  for (const t of ["Pode melhorar", "ruim", "não gostei"]) assert.strictEqual(classifyRating(null, t), "improve", t);
  assert.strictEqual(classifyRating(null, "quero saber sobre refúgio"), null);
});

test("distingue una consulta nueva de un comentario", () => {
  for (const t of ["Como faço para solicitar refúgio?", "quero saber sobre a escola", "Onde fica a Polícia Federal", "posso trabalhar sem documentos"]) {
    assert.strictEqual(looksLikeQuery(t), true, t);
  }
  for (const t of ["As respostas foram muito longas", "faltou informação sobre saúde", "demorou para responder"]) {
    assert.strictEqual(looksLikeQuery(t), false, t);
  }
});

test("el estado pendiente vence a los 30 minutos", () => {
  let t = 0;
  const store = createSurveyStore(30 * 60 * 1000, () => t);
  store.set("BR:1", "comment");
  assert.strictEqual(store.get("BR:1"), "comment");
  t = 31 * 60 * 1000;
  assert.strictEqual(store.get("BR:1"), null);
});

test("BR: textos de la encuesta en portugués y botones de hasta 20 caracteres", () => {
  const s = strings("BR");
  assert.match(s.surveyQuestion(), /foi boa ou pode melhorar\?$/);
  for (const title of [s.surveyGoodTitle(), s.surveyImproveTitle()]) assert.ok([...title].length <= 20, title);
  assert.match(s.surveyAskComment(), /O que podemos melhorar\?/);
  assert.match(s.surveyThanksGood(), /A Aldeias Infantis SOS e a Maria agradecem pelo contato/);
  assert.match(s.surveyThanksComment(), /A Aldeias Infantis SOS e a Maria agradecem pelo contato/);
});

test("BR: la despedida automática lleva la encuesta; al calificar después solo agradece", () => {
  const s = strings("BR");
  assert.match(s.surveyInactivityFarewell(), /^A Aldeias Infantis SOS e a Maria agradecem pelo contato/);
  assert.match(s.surveyInactivityFarewell(), /nossa conversa foi boa ou pode melhorar\?$/);
  assert.doesNotMatch(s.surveyThanksGoodLate(), /agradecem pelo contato/);
  assert.doesNotMatch(s.surveyThanksCommentLate(), /agradecem pelo contato/);
});

test("la encuesta recuerda si vino con la despedida automática", () => {
  let t = 0;
  const store = createSurveyStore(30 * 60 * 1000, () => t);
  store.set("BR:1", "rating");
  assert.strictEqual(store.isLate("BR:1"), false);
  store.set("BR:2", "rating", true);
  assert.strictEqual(store.isLate("BR:2"), true);
  assert.strictEqual(store.isLate("BR:3"), true); // sin estado (vencido o tras reinicio)
});
