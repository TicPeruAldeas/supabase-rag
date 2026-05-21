require("dotenv").config({ quiet: true });

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai").default;
const Anthropic = require("@anthropic-ai/sdk");
const { getCached, setCached } = require("./cache");

if (!process.env.SUPABASE_URL) throw new Error("Falta SUPABASE_URL");
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");
if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");
if (!process.env.ANTHROPIC_API_KEY) throw new Error("Falta ANTHROPIC_API_KEY");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Langfuse (opcional) ───────────────────────────────────────
let langfuse = null;
if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
  const { Langfuse } = require("langfuse");
  langfuse = new Langfuse({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_HOST || "https://cloud.langfuse.com",
  });
  console.log("📊 Langfuse conectado");
} else {
  console.log("ℹ️  Langfuse no configurado (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY)");
}

// ── Noop observation — evita optional chaining y garantiza .end() ──
// Cuando Langfuse no está configurado, todos los métodos son no-ops.
// Cuando sí está configurado, se usan los objetos reales del SDK.
const NOOP = {
  span:       () => NOOP,
  generation: () => NOOP,
  end:        () => {},
  update:     () => {},
};

function mkTrace(options) {
  if (!langfuse) return NOOP;
  return langfuse.trace(options);
}

const CLAUDE_MODEL = "claude-sonnet-4-6";

const COUNTRY_ORGS = {
  PE: "Aldeas Infantiles SOS Perú",
  CO: "Aldeas Infantiles SOS Colombia",
  MX: "Aldeas Infantiles SOS México",
  BO: "Aldeas Infantiles SOS Bolivia",
  EC: "Aldeas Infantiles SOS Ecuador",
  CL: "Aldeas Infantiles SOS Chile",
  AR: "Aldeas Infantiles SOS Argentina",
  PY: "Aldeas Infantiles SOS Paraguay",
  UY: "Aldeas Infantiles SOS Uruguay",
};

// ── System prompt estático (compartido entre países) ──────────
// Supera los 2048 tokens requeridos por claude-sonnet-4-6 para activar
// prompt caching. Bloque 1 (cacheado) + Bloque 2 dinámico por país.
const STATIC_SYSTEM_PROMPT = `\
ASISTENTE VIRTUAL DE ALDEAS INFANTILES SOS — INSTRUCCIONES Y CONTEXTO INSTITUCIONAL

════════════════════════════════════════
QUIÉN ERES Y QUÉ HACES
════════════════════════════════════════

Eres el asistente virtual oficial de Aldeas Infantiles SOS para atención digital. Tu misión es proporcionar información precisa, empática y útil sobre los servicios, programas y procedimientos de la organización en el país correspondiente. No eres un chatbot genérico: eres el primer punto de contacto digital de una organización que trabaja con niños, niñas, adolescentes y familias en situación vulnerable, por lo que la precisión, la empatía y la responsabilidad son fundamentales en cada respuesta.

════════════════════════════════════════
ALDEAS INFANTILES SOS — CONTEXTO INSTITUCIONAL
════════════════════════════════════════

HISTORIA E IDENTIDAD
Aldeas Infantiles SOS es una organización internacional no gubernamental e independiente de bienestar infantil, fundada en 1949 en Imst, Austria, por Hermann Gmeiner. Gmeiner fue un joven pedagogo austriaco que, tras la Segunda Guerra Mundial, creó el primer hogar SOS para huérfanos de guerra. Su modelo —pequeños hogares familiares con madres SOS permanentes— demostró ser tan efectivo que se replicó en todo el mundo.

Hoy, más de 75 años después, Aldeas Infantiles SOS opera en más de 136 países y territorios en todos los continentes, apoyando a más de un millón de niños, niñas, adolescentes y jóvenes cada año. La organización tiene su sede internacional en Innsbruck, Austria, y tiene estatus consultivo ante organismos de Naciones Unidas.

En América Latina, Aldeas Infantiles SOS inició sus operaciones en la década de 1960 y hoy está presente en más de 20 países de la región, donde apoya a decenas de miles de niños, familias y jóvenes en situación de vulnerabilidad.

MISIÓN
"Construimos familias para niños y niñas que necesitan apoyo, los ayudamos a dar forma a su propio futuro y participamos en el desarrollo de sus comunidades."

VISIÓN
"Toda niña y todo niño pertenecen a una familia y crecen con amor, respeto y seguridad."

VALORES INSTITUCIONALES
Los cuatro valores que guían cada acción de la organización son:

Valentía: Actuamos con audacia y determinación, sin conformarnos con menos de lo que los niños y las familias merecen. Cuestionamos el statu quo, innovamos y asumimos riesgos calculados para mejorar vidas. La valentía significa hablar cuando vemos algo incorrecto y defender el interés superior del niño incluso cuando es difícil.

Compromiso: Nos comprometemos con cada niño, niña, adolescente y familia durante el tiempo que sea necesario para garantizar su bienestar y desarrollo. No abandonamos a quienes apoyamos. Nuestro compromiso es de largo plazo.

Confianza: Construimos relaciones genuinas de confianza con los niños, las familias, los donantes, los socios y las comunidades. La transparencia, la integridad y la honestidad son la base de todo lo que hacemos.

Responsabilidad: Somos responsables de nuestras acciones y resultados ante los niños, las familias y quienes nos apoyan económicamente. Medimos nuestro impacto, aprendemos de los errores y mejoramos continuamente.

════════════════════════════════════════
PROGRAMAS Y SERVICIOS
════════════════════════════════════════

1. CUIDADO FAMILIAR ALTERNATIVO — ALDEAS SOS
Es el programa emblemático y fundacional de la organización. Proporciona un hogar permanente, seguro y amoroso a niños y niñas que no pueden vivir con sus familias de origen, ya sea por abandono, orfandad, maltrato, negligencia u otras circunstancias que los colocan en situación de desprotección.

Cómo funciona:
Los niños viven en hogares familiares dentro de una aldea SOS, bajo el cuidado permanente de madres o padres SOS profesionales seleccionados, formados y acompañados por la organización. Cada hogar es una familia donde conviven hermanos biológicos o sociales, preservando el vínculo fraternal. Las aldeas cuentan con áreas comunes, espacios educativos, recreativos y de salud. El cuidado es integral y se extiende hasta que el joven alcanza la autonomía plena.

Ingreso al programa:
Los niños ingresan generalmente a través de derivaciones del Poder Judicial, el Ministerio de la Mujer u organismos de protección del Estado. No se aceptan ingresos directos de particulares sin resolución judicial o administrativa correspondiente.

2. FORTALECIMIENTO FAMILIAR
Programa preventivo diseñado para apoyar a familias en situación de vulnerabilidad y evitar la separación de niños de su entorno familiar. Es una de las líneas de trabajo de mayor crecimiento en la organización.

Servicios:
- Acompañamiento psicosocial individualizado a padres, madres y cuidadores.
- Talleres en crianza positiva, desarrollo infantil temprano, gestión emocional y resolución de conflictos.
- Apoyo en el acceso a servicios estatales: salud, educación, documentación, beneficios sociales.
- Asistencia económica de emergencia temporal en casos críticos (según criterios del programa).
- Derivación y articulación con redes comunitarias e institucionales.
- Seguimiento periódico por equipos multidisciplinarios de trabajadores sociales, psicólogos y educadores.

Perfil de familias beneficiarias:
- Familias con hijos menores de 18 años en riesgo de pérdida del cuidado parental.
- Familias en pobreza o extrema pobreza con capacidad de cuidado rescatable.
- Familias identificadas y seleccionadas mediante evaluación técnica del equipo.

3. ACOGIMIENTO FAMILIAR
Programa que identifica, selecciona, capacita y acompaña a familias de la comunidad para que acojan temporalmente a niños que no pueden estar con sus familias de origen, mientras se trabaja en la reintegración o se determina una solución permanente.

Incluye: reclutamiento y selección rigurosa de familias, capacitación previa en derechos del niño y crianza positiva, acompañamiento continuo durante el acogimiento, seguimiento del bienestar del niño, y coordinación con autoridades judiciales o administrativas.

4. PROGRAMAS DE JÓVENES — DESARROLLO JUVENIL Y TRANSICIÓN A LA VIDA ADULTA
Acompaña a adolescentes y jóvenes (generalmente entre 15 y 25 años) en la construcción de su autonomía e inserción en la vida adulta.

Componentes:
- Acompañamiento personalizado en la construcción del proyecto de vida.
- Apoyo académico para culminación de educación secundaria.
- Orientación y apoyo para acceso a educación superior o técnica (becas, institutos).
- Orientación vocacional y psicológica individual.
- Talleres de habilidades para la vida: comunicación, finanzas personales, ciudadanía, empleabilidad.
- Apoyo en búsqueda de primer empleo o desarrollo de emprendimientos.
- Mentoring con profesionales voluntarios del sector privado.
- Vivienda de transición para jóvenes sin red familiar (en sedes que disponen de esta facilidad).

Beneficiarios: jóvenes egresados del programa de Cuidado Familiar Alternativo, derivados por el Estado, y jóvenes de la comunidad en situación de vulnerabilidad.

5. EDUCACIÓN
Aldeas Infantiles SOS gestiona o co-gestiona centros educativos en muchas de sus sedes: educación inicial, primaria y secundaria; programas de refuerzo escolar y tutorías; actividades extracurriculares de deporte, arte y cultura; formación técnica en algunas sedes; y acceso de niños de la comunidad aledaña.

6. SALUD
Los niños, niñas y jóvenes bajo el cuidado de la organización acceden a: atención médica y odontológica periódica; apoyo en salud mental (psicología y psiquiatría cuando se requiere); programas de educación en salud, higiene y nutrición; acompañamiento en situaciones de enfermedad crónica o discapacidad; y coordinación con el sistema de salud público.

7. RESPUESTA EN EMERGENCIAS Y DESASTRES
Ante terremotos, inundaciones, pandemias u otras crisis, se activan protocolos de respuesta humanitaria: evaluación rápida de necesidades, distribución de alimentos y artículos de primera necesidad, espacios amigables para niños en zonas de emergencia, apoyo psicosocial post-crisis y coordinación con autoridades y otras organizaciones humanitarias.

════════════════════════════════════════
PROCEDIMIENTOS DE ACCESO A SERVICIOS
════════════════════════════════════════

PROCESO GENERAL DE ATENCIÓN
1. Contacto inicial con la organización (presencial, telefónico, digital).
2. Evaluación preliminar de la consulta por el equipo de atención.
3. Evaluación técnica por trabajador social o psicólogo.
4. Diagnóstico y elaboración del plan de intervención personalizado.
5. Incorporación al programa según disponibilidad y criterios técnicos.
6. Seguimiento periódico y ajuste del plan según evolución del caso.

QUIÉN PUEDE ACCEDER
- Niños, niñas y adolescentes sin cuidado parental o en riesgo de perderlo.
- Familias en situación de vulnerabilidad con hijos menores de edad.
- Jóvenes egresados de cuidado alternativo (hasta aproximadamente 25 años).
- Entidades del Estado y organizaciones que deriven casos con documentación.

DOCUMENTOS FRECUENTEMENTE REQUERIDOS
- Documento de identidad del niño o niña (DNI, partida de nacimiento o equivalente según país).
- Documentos de identidad de padres, madres o cuidadores.
- Documentos judiciales o administrativos en casos de cuidado alternativo.
- Informe social previo si existe.
- Certificados médicos o psicológicos cuando aplica.

VOLUNTARIADO Y DONACIONES
- Donaciones: La organización acepta donaciones individuales mensuales o únicas, donaciones corporativas y legados testamentarios. Los donantes pueden elegir apoyar un programa específico o apadrinar a un niño.
- Voluntariado: Se aceptan voluntarios según necesidades de cada sede. Los interesados deben contactar con la oficina nacional o local. Todos los voluntarios pasan por selección y capacitación obligatoria.
- Alianzas empresariales: Existen programas de responsabilidad social corporativa y alianzas estratégicas con el sector privado.

════════════════════════════════════════
PROTECCIÓN DE LA NIÑEZ
════════════════════════════════════════

La protección integral de los niños, niñas y adolescentes es la prioridad absoluta e innegociable de Aldeas Infantiles SOS.

Principios irrenunciables:
- Interés superior del niño: Toda decisión institucional considera como primer criterio el mayor beneficio para el niño o niña.
- No discriminación: Los servicios se brindan sin distinción de origen étnico, religión, género, discapacidad u otra condición.
- Confidencialidad absoluta: No se comparte ni divulga información personal de los beneficiarios bajo ninguna circunstancia.
- Voz y participación: Se escucha y considera la opinión de los niños en decisiones que les afectan, según su edad y madurez.
- Transparencia: La organización publica memorias anuales y rinde cuentas públicamente sobre el uso de los recursos.

════════════════════════════════════════
PAUTAS DE RESPUESTA PARA ESTE ASISTENTE
════════════════════════════════════════

1. Basa todas las respuestas en el contexto recuperado de la base de conocimiento de la organización en este país. No inventes datos, fechas, nombres, montos ni cifras que no estén en el contexto.
2. Si el contexto no cubre la pregunta del usuario, responde: "No tengo esa información exacta. ¿Puedes contarme más o contactar directamente con la organización?"
3. Mantén siempre un tono empático, cálido y profesional.
4. Nunca compartas información personal de beneficiarios, donantes, trabajadores o voluntarios.
5. Responde siempre en español, adaptando el registro al país del usuario.
6. Máximo 4 líneas por respuesta. Sin formato markdown, sin asteriscos, sin viñetas.
7. Cuando el usuario necesite atención personalizada (derivaciones, denuncias, casos urgentes), remítelo a los canales oficiales de la organización en su país.
8. Si detectas una situación de urgencia o riesgo para un niño, indica claramente que debe contactar con las autoridades locales de protección infantil y con la sede de la organización de forma inmediata.`;

const SMALL_TALK_REGEX = /^(hola|buenos|buenas|hi|hey|gracias|ok|okay|sí|si|no|perfecto|genial|entendido|como estas|buen dia|buenas tardes|buenas noches|👍|😊)[\s!?.]*$/i;

// ── Helper: genera embedding e instrumenta su propio span ─────
// parent puede ser un trace o un span — ambos soportan .span() en Langfuse
async function embedText(text, parent) {
  const span = parent.span({
    name: "openai-embedding",
    input: text.substring(0, 200),
    metadata: { model: "text-embedding-3-small" },
  });
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  span.end({
    output: { tokens: response.usage.total_tokens, dimensions: response.data[0].embedding.length },
  });
  return response.data[0].embedding;
}

// ── Detectar intención (flujo paso a paso) ────────────────────
// parent = span del paso-a-paso activo
async function detectIntent(userMessage, parent) {
  const gen = parent.generation({
    name: "claude-detect-intent",
    model: CLAUDE_MODEL,
    input: userMessage,
    modelParameters: { maxTokens: 16 },
  });

  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16,
    system: [
      {
        type: "text",
        text: `Clasifica el mensaje en una de estas intenciones:
- "mas_detalle": quiere más información sobre lo explicado
- "siguiente": quiere continuar al siguiente paso
- "terminar": agradece, entendió, se despide
- "otro": pregunta algo completamente diferente
Responde SOLO con una palabra: mas_detalle, siguiente, terminar, otro`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
  });

  const intent = msg.content[0].text.trim().toLowerCase();
  gen.end({
    output: intent,
    usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens },
    metadata: {
      cache_read_tokens: msg.usage.cache_read_input_tokens ?? 0,
      cache_creation_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    },
  });
  return intent;
}

// ── Estado conversacional ─────────────────────────────────────
async function getActiveState(userId, countryCode) {
  const { data } = await supabase
    .from("conversation_state")
    .select("*")
    .eq("user_id", userId)
    .eq("country_code", countryCode)
    .eq("status", "active")
    .single();
  return data || null;
}

async function upsertState(userId, countryCode, flowId, flowType, currentStep, totalSteps, status = "active") {
  await supabase
    .from("conversation_state")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("country_code", countryCode)
    .eq("status", "active");

  if (status === "cancelled") return;

  await supabase.from("conversation_state").insert({
    user_id: userId,
    country_code: countryCode,
    flow_id: flowId,
    flow_type: flowType,
    current_step: currentStep,
    total_steps: totalSteps,
    status,
    updated_at: new Date().toISOString(),
  });
}

async function updateStep(stateId, currentStep, status = "active") {
  await supabase
    .from("conversation_state")
    .update({ current_step: currentStep, status, updated_at: new Date().toISOString() })
    .eq("id", stateId);
}

// ── Historial reciente ────────────────────────────────────────
// limit = 10 → últimos 5 mensajes del usuario + sus 5 respuestas (5 pares completos)
async function getRecentHistory(userId, countryCode, limit = 10) {
  const { data, error } = await supabase
    .from("conversations")
    .select("role, message, created_at")
    .eq("user_id", userId)
    .eq("country_code", countryCode)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const messages = (data || []).reverse().map(item => ({ role: item.role, content: item.message }));

  // La API de Claude requiere que los mensajes alternen user/assistant.
  // Si por algún desfase el primer mensaje fuera del asistente, lo descartamos.
  const firstUser = messages.findIndex(m => m.role === "user");
  return firstUser > 0 ? messages.slice(firstUser) : messages;
}

// ── Guardar turno ─────────────────────────────────────────────
async function saveConversationTurn({ userId, countryCode, role, message, source = "api", metadata = {} }) {
  const { error } = await supabase
    .from("conversations")
    .insert({ user_id: userId, country_code: countryCode, role, message, source, metadata });
  if (error) throw error;
}

// ── Buscar flow (Excel) — crea sus propios spans hijos ────────
// parent = trace raíz
async function searchFlow(countryCode, question, parent) {
  const span = parent.span({ name: "search-flows", input: question });

  // Span hijo: embedding de OpenAI
  const queryEmbedding = await embedText(question, span);

  // Span hijo: RPC en Supabase
  const dbSpan = span.span({ name: "supabase-match-flows", input: { country: countryCode } });
  const { data, error } = await supabase.rpc("match_flows_by_country", {
    query_embedding: queryEmbedding,
    filter_country: countryCode,
    match_count: 1,
    min_similarity: 0.50,
  });

  if (error) {
    dbSpan.end({ output: { error: error.message } });
    span.end({ output: null });
    throw error;
  }

  const result = data?.[0] || null;
  dbSpan.end({ output: result ? { flow_id: result.flow_id, similarity: result.similarity } : null });
  span.end({ output: result ? { flow_id: result.flow_id, flow_type: result.flow_type, similarity: result.similarity } : null });
  return result;
}

// ── Búsqueda semántica (PDF) — crea sus propios spans hijos ──
// parent = span de "search-hybrid"
async function searchSemantic(countryCode, question, matchCount = 5, parent) {
  const span = parent.span({ name: "search-semantic", input: question });

  // Span hijo: embedding de OpenAI
  const queryEmbedding = await embedText(question, span);

  // Span hijo: RPC en Supabase
  const dbSpan = span.span({ name: "supabase-match-knowledge", input: { country: countryCode, matchCount } });
  const { data, error } = await supabase.rpc("match_knowledge_by_country", {
    query_embedding: queryEmbedding,
    filter_country: countryCode,
    match_count: matchCount,
  });

  if (error) {
    dbSpan.end({ output: { error: error.message } });
    span.end({ output: [] });
    throw error;
  }

  const results = (data || []).filter(item => item.similarity >= 0.45);
  dbSpan.end({ output: { count: results.length } });
  span.end({ output: { count: results.length } });
  return results;
}

// ── Búsqueda keyword — crea su propio span hijo ───────────────
// parent = span de "search-hybrid"
async function searchFast(countryCode, question, limit = 3, parent) {
  const keywords = question.split(/\s+/).filter(w => w.length > 4).slice(0, 3);
  if (keywords.length === 0) return [];
  const keyword = keywords.sort((a, b) => b.length - a.length)[0];

  const span = parent.span({ name: "search-keyword", input: { keyword, country: countryCode } });
  const { data, error } = await supabase
    .from("knowledge_chunks")
    .select("chunk_text, source_name")
    .ilike("chunk_text", `%${keyword}%`)
    .eq("country_code", countryCode)
    .limit(limit);

  const results = error ? [] : (data || []);
  span.end({ output: { count: results.length, keyword } });
  return results;
}

function mergeResults(semanticResults, fastResults) {
  const seen = new Set();
  const merged = [];
  for (const item of [...semanticResults, ...fastResults]) {
    const key = item.chunk_text?.slice(0, 80);
    if (key && !seen.has(key)) { seen.add(key); merged.push(item); }
  }
  return merged.slice(0, 6);
}

// ── Manejar PASO A PASO — agrupa intent + lógica bajo un span ─
async function handlePasoAPaso(userId, countryCode, question, state, parent) {
  const span = parent.span({
    name: "handle-paso-a-paso",
    input: { step: state.current_step, total: state.total_steps, flow_id: state.flow_id },
  });

  // La generación de Claude queda como hijo del span paso-a-paso
  const intent = await detectIntent(question, span);
  console.log(`🎯 Intent: ${intent} (paso ${state.current_step}/${state.total_steps})`);

  let result;

  if (intent === "terminar") {
    await updateStep(state.id, state.current_step, "completed");
    result = { response: "¡Entendido! Si necesitas más ayuda, con gusto te orientamos.", metadata: { flow_type: "paso_a_paso" } };

  } else if (intent === "otro") {
    await updateStep(state.id, state.current_step, "cancelled");
    result = null;

  } else if (intent === "mas_detalle") {
    const { data: stepData } = await supabase
      .from("knowledge_steps")
      .select("step_detail, step_number")
      .eq("flow_id", state.flow_id)
      .eq("step_number", state.current_step)
      .single();

    result = stepData
      ? {
          response: `Detalle del paso ${state.current_step}:\n\n${stepData.step_detail}\n\n¿Quieres continuar con el paso ${state.current_step + 1 <= state.total_steps ? state.current_step + 1 : "siguiente"}?`,
          metadata: { flow_type: "paso_a_paso" },
        }
      : { response: "No tengo más detalle sobre este paso. ¿Quieres continuar con el siguiente?", metadata: { flow_type: "paso_a_paso" } };

  } else {
    // siguiente
    const nextStep = state.current_step + 1;
    if (nextStep > state.total_steps) {
      await updateStep(state.id, state.current_step, "completed");
      result = { response: "✅ Hemos terminado todos los pasos. ¿Hay algo más en lo que pueda ayudarte?", metadata: { flow_type: "paso_a_paso" } };
    } else {
      const { data: nextStepData } = await supabase
        .from("knowledge_steps")
        .select("step_summary, step_number")
        .eq("flow_id", state.flow_id)
        .eq("step_number", nextStep)
        .single();

      if (!nextStepData) {
        await updateStep(state.id, state.current_step, "completed");
        result = { response: "✅ Eso es todo. ¿Necesitas ayuda con algo más?", metadata: { flow_type: "paso_a_paso" } };
      } else {
        await updateStep(state.id, nextStep);
        const isLastStep = nextStep >= state.total_steps;
        result = {
          response: `Paso ${nextStep} de ${state.total_steps}:\n\n${nextStepData.step_summary}\n\n${isLastStep ? "Este es el último paso. ¿Quieres más detalle o ya tienes todo claro?" : `¿Quieres más detalle, continuar al paso ${nextStep + 1}, o ya tienes todo claro?`}`,
          metadata: { flow_type: "paso_a_paso", step: nextStep },
        };
      }
    }
  }

  span.end({ output: result?.response ?? null });
  return result;
}

// ── LLM-as-a-Judge: evalúa calidad de respuesta RAG en background
// Criterios: relevancia, fidelidad, utilidad (cada uno entre 0.0 y 1.0)
// Usa claude-haiku-4-5 para minimizar costo del paso de evaluación.
// Se llama fire-and-forget — no bloquea el envío del mensaje a WhatsApp.
async function evaluateResponse(trace, question, context, response) {
  if (!langfuse) return;

  const EVAL_MODEL = "claude-haiku-4-5";

  try {
    const msg = await anthropic.messages.create({
      model: EVAL_MODEL,
      max_tokens: 80,
      system: "Eres un evaluador de calidad de respuestas de chatbots. Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional ni explicaciones.",
      messages: [
        {
          role: "user",
          content: `Evalúa la respuesta del asistente con un score de 0.0 a 1.0 en cada criterio.

PREGUNTA DEL USUARIO:
${question}

CONTEXTO RECUPERADO DE LA BASE DE CONOCIMIENTO:
${context.substring(0, 2000)}

RESPUESTA DEL ASISTENTE:
${response}

CRITERIOS DE EVALUACIÓN:
- relevancia: ¿La respuesta aborda directamente la pregunta? (0.0 = completamente irrelevante, 1.0 = perfectamente relevante)
- fidelidad: ¿La respuesta se basa solo en el contexto sin inventar datos? (0.0 = inventa datos, 1.0 = completamente fiel al contexto)
- utilidad: ¿La respuesta resuelve la necesidad del usuario de forma clara? (0.0 = inútil, 1.0 = muy útil)

Responde SOLO con el JSON. Ejemplo exacto: {"relevancia": 0.9, "fidelidad": 0.8, "utilidad": 0.7}`,
        },
      ],
    });

    const raw = (msg.content[0]?.text ?? "").trim();
    const match = raw.match(/\{[^}]+\}/);
    if (!match) {
      console.warn("LLM-Judge: JSON no encontrado en respuesta:", raw.substring(0, 120));
      return;
    }

    const scores = JSON.parse(match[0]);
    const criteria = ["relevancia", "fidelidad", "utilidad"];

    for (const name of criteria) {
      const rawValue = scores[name];
      if (typeof rawValue !== "number" || isNaN(rawValue)) {
        console.warn(`LLM-Judge: score inválido para "${name}":`, rawValue);
        continue;
      }
      const value = Math.max(0, Math.min(1, rawValue));

      await langfuse.score({
        traceId: trace.id,
        name,
        value,
        dataType: "NUMERIC",
        comment: `LLM-as-Judge (${EVAL_MODEL})`,
      });
    }

    const r = scores.relevancia?.toFixed(2) ?? "?";
    const f = scores.fidelidad?.toFixed(2) ?? "?";
    const u = scores.utilidad?.toFixed(2) ?? "?";
    console.log(`🧑‍⚖️ LLM-Judge: relevancia=${r} fidelidad=${f} utilidad=${u}`);

    await langfuse.flushAsync();
  } catch (err) {
    console.error("Error LLM-Judge:", err.message);
  }
}

// ── Core RAG ──────────────────────────────────────────────────
async function askAI(userId, countryCode, question) {
  const totalStart = Date.now();
  const orgName = COUNTRY_ORGS[countryCode] || `Aldeas Infantiles SOS (${countryCode})`;

  // mkTrace devuelve NOOP si Langfuse no está configurado,
  // así todos los .span() / .generation() / .end() siempre se llaman sin optional chaining
  const trace = mkTrace({
    name: "rag-query",
    userId,
    sessionId: userId,   // agrupa todas las trazas del mismo número en Langfuse Sessions
    metadata: { countryCode, orgName },
    input: question,
  });

  try {
    // 1. SMALL TALK — sin observations (no hay llamadas externas)
    if (SMALL_TALK_REGEX.test(question.trim())) {
      const response = `¡Hola! Soy el asistente virtual de ${orgName}. ¿En qué puedo ayudarte hoy?`;
      trace.update({ output: response, metadata: { search_type: "small_talk" } });
      return { response, metadata: { search_type: "small_talk", total_ms: Date.now() - totalStart } };
    }

    // 2. ¿Flujo activo? (paso a paso)
    const activeState = await getActiveState(userId, countryCode);
    if (activeState && (activeState.flow_type === "paso a paso" || activeState.flow_type === "paso_a_paso")) {
      console.log(`🔄 Flujo activo: ${activeState.flow_id} [${activeState.flow_type}]`);
      // handlePasoAPaso crea su propio span hijo del trace
      const result = await handlePasoAPaso(userId, countryCode, question, activeState, trace);
      if (result) {
        trace.update({ output: result.response, metadata: result.metadata });
        return result;
      }
      // intent === "otro": continúa al flujo normal de búsqueda
    }

    // 3. CACHE — sin observations
    const cached = getCached(countryCode, question);
    if (cached) {
      trace.update({ output: cached, metadata: { search_type: "cache" } });
      return { response: cached, metadata: { search_type: "cache", total_ms: Date.now() - totalStart } };
    }

    // 4. BUSCAR EN knowledge_flows (Excel)
    // searchFlow crea: span("search-flows") > span("openai-embedding") + span("supabase-match-flows")
    const flow = await searchFlow(countryCode, question, trace);

    if (flow) {
      console.log(`📋 Flow: ${flow.flow_id} [${flow.flow_type}] sim: ${flow.similarity?.toFixed(3)}`);
      const normalizedType = flow.flow_type?.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

      if (normalizedType === "informativa") {
        setCached(countryCode, question, flow.answer);
        trace.update({ output: flow.answer, metadata: { search_type: "flow_informativa", flow_id: flow.flow_id } });
        return { response: flow.answer, metadata: { search_type: "flow_informativa", flow_id: flow.flow_id, total_ms: Date.now() - totalStart } };
      }

      if (normalizedType === "seleccion") {
        trace.update({ output: flow.answer, metadata: { search_type: "flow_seleccion", flow_id: flow.flow_id } });
        return { response: flow.answer, metadata: { search_type: "flow_seleccion", flow_id: flow.flow_id, total_ms: Date.now() - totalStart } };
      }

      if (normalizedType === "paso a paso" || normalizedType === "paso_a_paso") {
        const { data: steps } = await supabase
          .from("knowledge_steps")
          .select("step_number, step_summary")
          .eq("flow_id", flow.flow_id)
          .order("step_number", { ascending: true });

        if (!steps || steps.length === 0) {
          trace.update({ output: flow.answer, metadata: { search_type: "flow_paso_a_paso" } });
          return { response: flow.answer, metadata: { search_type: "flow_paso_a_paso" } };
        }

        await upsertState(userId, countryCode, flow.flow_id, "paso a paso", 1, steps.length);
        const response = `Voy a guiarte paso a paso (${steps.length} pasos en total).\n\nPaso 1 de ${steps.length}:\n\n${steps[0].step_summary}\n\n¿Quieres más detalle sobre este paso, continuar al paso 2, o ya tienes todo claro?`;
        trace.update({ output: response, metadata: { search_type: "flow_paso_a_paso", flow_id: flow.flow_id } });
        return { response, metadata: { search_type: "flow_paso_a_paso", flow_id: flow.flow_id, total_steps: steps.length } };
      }
    }

    // 5. FALLBACK — búsqueda híbrida + Claude
    // hybridSpan agrupa semántica, keyword y la generación de Claude
    const hybridSpan = trace.span({ name: "search-hybrid", input: question });

    const [history, semanticData, fastData] = await Promise.all([
      getRecentHistory(userId, countryCode, 10),  // 5 pares user/assistant
      // searchSemantic crea: span("search-semantic") > span("openai-embedding") + span("supabase-match-knowledge")
      searchSemantic(countryCode, question, 5, hybridSpan),
      // searchFast crea: span("search-keyword")
      searchFast(countryCode, question, 3, hybridSpan),
    ]);

    const allResults = mergeResults(semanticData, fastData);

    if (allResults.length === 0) {
      hybridSpan.end({ output: { count: 0 } });
      const response = "No tengo esa información exacta. ¿Puedes contarme más sobre lo que necesitas?";
      trace.update({ output: response, metadata: { search_type: "no_results" } });
      return { response, metadata: { search_type: "no_results", total_ms: Date.now() - totalStart } };
    }

    hybridSpan.end({ output: { semantic: semanticData.length, keyword: fastData.length, merged: allResults.length } });

    const context = allResults
      .map((item, i) => `Fuente ${i + 1}${item.source_name ? ` (${item.source_name})` : ""}:\n${item.chunk_text}`)
      .join("\n\n");

    // El contexto recuperado va en el mensaje del usuario para que varíe por pregunta
    const userContent = `Contexto:\n${context}\n\nPregunta: ${question}`.trim();
    const messages = [...history, { role: "user", content: userContent }];

    const llmStart = Date.now();

    // generation("claude-rag-response") es hijo directo del trace (no de hybridSpan)
    const gen = trace.generation({
      name: "claude-rag-response",
      model: CLAUDE_MODEL,
      input: messages,
      modelParameters: { maxTokens: 300 },
    });

    // Streaming: mejor manejo de conexiones HTTP en producción; evita timeouts en respuestas largas.
    // WhatsApp no soporta mensajes parciales, así que stream.finalMessage() espera el texto completo.
    // El ahorro real de latencia viene del prompt caching en el bloque estático (Bloque 1).
    //
    // Sistema en dos bloques:
    //   Bloque 1 — STATIC_SYSTEM_PROMPT (≥2048 tokens, cache_control): cached en Anthropic
    //              Idéntico para todos los países → una sola entrada en caché compartida
    //   Bloque 2 — Nombre de organización + país (dinámico, sin cache_control): siempre fresco
    const stream = anthropic.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      system: [
        {
          type: "text",
          text: STATIC_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },  // Bloque 1: cacheado
        },
        {
          type: "text",
          text: `Organización activa: ${orgName}. País: ${countryCode}. Responde según el contexto de esta organización en este país.`,
          // Bloque 2: dinámico, sin cache_control
        },
      ],
      messages,
    });
    const claudeResponse = await stream.finalMessage();

    const finalResponse = claudeResponse.content[0]?.text || "No tengo esa información exacta, ¿puedes ser más específico?";

    const cacheRead = claudeResponse.usage.cache_read_input_tokens ?? 0;
    const cacheCreation = claudeResponse.usage.cache_creation_input_tokens ?? 0;
    if (cacheRead > 0) {
      console.log(`💾 Cache hit RAG [${countryCode}]: ${cacheRead} tokens (~${Math.round(cacheRead * 0.9)} ahorrados)`);
    }

    gen.end({
      output: finalResponse,
      usage: { input: claudeResponse.usage.input_tokens, output: claudeResponse.usage.output_tokens },
      metadata: {
        cache_read_tokens: cacheRead,
        cache_creation_tokens: cacheCreation,
      },
    });

    // Fire-and-forget: evaluación LLM-as-Judge en background.
    // No se awaita — la respuesta se envía a WhatsApp mientras Claude evalúa.
    evaluateResponse(trace, question, context, finalResponse);

    if (!finalResponse.includes("No tengo esa información")) {
      setCached(countryCode, question, finalResponse);
    }

    trace.update({ output: finalResponse, metadata: { search_type: "hybrid" } });
    return {
      response: finalResponse,
      metadata: { search_type: "hybrid", total_ms: Date.now() - totalStart, llm_ms: Date.now() - llmStart },
    };

  } finally {
    // flushAsync siempre se ejecuta, incluso si hay un error, para no perder observations
    langfuse?.flushAsync().catch(() => {});
  }
}

module.exports = { askAI, saveConversationTurn };
