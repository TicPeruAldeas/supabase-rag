// Variables mínimas para cargar rag-service sin conexión real.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "dummy";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";

const { test } = require("node:test");
const assert = require("node:assert");
const { canSkipRerank } = require("../rag-service");

const c = (...sims) => sims.map((similarity, i) => ({ flow_id: `F${i}`, similarity }));

test("canSkipRerank: un solo candidato no necesita reranker", () => {
  assert.strictEqual(canSkipRerank(c(0.4)), true);
});

test("canSkipRerank: similitud alta (>= 0.72) no necesita reranker", () => {
  assert.strictEqual(canSkipRerank(c(0.76, 0.74)), true);
});

test("canSkipRerank: ventaja clara sobre el 2.º (>= 0.10) no necesita reranker", () => {
  assert.strictEqual(canSkipRerank(c(0.61, 0.40)), true);
  assert.strictEqual(canSkipRerank(c(0.648, 0.489)), true);
});

test("canSkipRerank: candidatos empatados o cercanos sí pasan por el reranker", () => {
  assert.strictEqual(canSkipRerank(c(0.373, 0.373)), false); // caso real: "¿qué hacen ustedes?"
  assert.strictEqual(canSkipRerank(c(0.694, 0.671)), false);
  assert.strictEqual(canSkipRerank(c(0.583, 0.517)), false);
});
