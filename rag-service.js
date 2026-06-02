require("dotenv").config({ quiet: true });

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai").default;
const Anthropic = require("@anthropic-ai/sdk");
const { getCached, setCached } = require("./cache");

// ── Langfuse v5: @langfuse/tracing usa OTel internamente ─────
// Sin LangfuseSpanProcessor registrado los spans son no-ops — sin NOOP manual necesario.
const {
  startActiveObservation,
  propagateAttributes,
  setActiveTraceIO,
} = require("@langfuse/tracing");

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

// ── Langfuse v5 (opcional) ────────────────────────────────────
let langfuseClient = null;

if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  const { LangfuseSpanProcessor } = require("@langfuse/otel");
  const { LangfuseClient } = require("@langfuse/client");

  const sdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl: process.env.LANGFUSE_HOST || "https://cloud.langfuse.com",
        shouldExportSpan: () => true,
      }),
    ],
  });
  sdk.start();

  langfuseClient = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_HOST || "https://cloud.langfuse.com",
  });

  console.log("📊 Langfuse v5 conectado");
} else {
  console.log("ℹ️  Langfuse no configurado (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY)");
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
2. Si el contexto no cubre completamente la pregunta del usuario, comprende su intención y responde de forma cálida y empática: reconoce el tema que pregunta, indica que no tienes esa información específica en este momento, y recomienda contactar directamente con la organización. Nunca uses frases genéricas o robóticas como "no tengo esa información".
3. Mantén siempre un tono empático, cálido y profesional.
4. Nunca compartas información personal de beneficiarios, donantes, trabajadores o voluntarios.
5. Responde siempre en español, adaptando el registro al país del usuario.
6. Máximo 4 líneas por respuesta. Sin formato markdown, sin asteriscos, sin viñetas.
7. Cuando el usuario necesite atención personalizada (derivaciones, denuncias, casos urgentes), remítelo a los canales oficiales de la organización en su país.
8. Si detectas una situación de urgencia o riesgo para un niño, indica claramente que debe contactar con las autoridades locales de protección infantil y con la sede de la organización de forma inmediata.
9. USO DEL HISTORIAL DE CONVERSACIÓN: El historial previo sirve ÚNICAMENTE para recordar datos personales que el usuario ya compartió (nombre, ciudad, situación familiar) y mantener coherencia en el trato. Cada nueva pregunta del usuario debe evaluarse de forma independiente. El historial NO determina el tema de la nueva pregunta ni debe hacer que interpretes la nueva consulta como continuación del tema anterior.

════════════════════════════════════════
TEMAS DISPONIBLES Y BIENVENIDA
════════════════════════════════════════

Cuando el usuario salude o pida ayuda de forma genérica, menciona los temas sobre los que puedes orientar, por ejemplo:
- Documentos y regularización migratoria
- Alojamiento y vivienda temporal
- Apoyo para familias en situación de vulnerabilidad
- Acceso a servicios de salud y educación
- Empleo y emprendimiento
- Protección de niñas, niños y adolescentes

Invita al usuario a contarte su situación para poder orientarlo mejor. Nunca inventes información que no esté en la base de conocimiento.

════════════════════════════════════════
REGLAS GLOBALES DE GENERACIÓN
════════════════════════════════════════

REGLA A — NO INVENTAR SERVICIOS NI INSTITUCIONES
Solo menciona servicios, instituciones, trámites, beneficios o apoyos que estén explícitamente en el campo "Respuesta" del flow recuperado. No agregues empleo, salud, educación, vivienda, protección u otros si no aparecen en ese flow.
Si el flow recuperado no menciona explícitamente un servicio, NO lo incluyas en la respuesta aunque tengas conocimiento de él. No mezcles servicios de otros flows salvo que hayan sido recuperados como contexto relevante en la misma consulta.

REGLA B — NO ASUMIR INFORMACIÓN DEL USUARIO
No infieras datos que el usuario no haya mencionado: país de origen, ciudad, situación migratoria, documentos que tiene o no tiene, edad del niño, urgencia, composición familiar ni trámite específico. Si falta un dato clave, haz una pregunta breve y directa.

REGLA C — PREGUNTAR CIUDAD CUANDO EL FLOW LO INDIQUE
Si el flow menciona ubicación, ciudad, sede, opciones cercanas o necesidad de saber dónde está el usuario, pregunta en qué ciudad se encuentra antes de continuar. No omitas esta pregunta si es necesaria para orientar el caso.

REGLA D — RESPUESTAS BREVES PARA WHATSAPP
Una sola idea principal por mensaje. Terminar con una sola pregunta concreta cuando sea necesario continuar. Evitar bloques de texto largos.

REGLA E — EL FLOW ES LA FUENTE DE VERDAD
La respuesta final debe estar basada en el campo "Respuesta" del flow recuperado. No usar conocimiento externo para completar información. No agregar recomendaciones legales, migratorias, médicas o institucionales que no estén en el flow.`;

const SMALL_TALK_REGEX = /^(hola+s?|buenos\s+(d[ií]as|tardes|noches)|buenas?(\s+(d[ií]as|tardes|noches))?|buen\s+d[ií]a|hi+|hey+|gracias+|ok|okay|sí|si|no|perfecto|genial|entendido|c[oó]mo\s+est[aá]s?|👍|😊)[\s!?,.:]*$/i;

// Señales claras de continuación dentro de un flow paso a paso activo.
// Si el mensaje NO coincide, se evalúa si es una intención nueva (retrieval).
const CONTINUATION_REGEX = /^(sí|si|no|listo|ok|okay|ya|correcto|entendido|no\s+s[eé]|todav[ií]a\s+no|quiero\s+continuar|continuar|continúa|continua|siguiente|adelante|claro|dale|de\s+acuerdo|por\s+supuesto|a[ú]n\s+no|bien|perfecto|genial|👍|✅|☑)[.!,?\s]*$/i;

// Mensajes vagos que necesitan una pregunta de clarificación antes de buscar
const VAGUE_REGEX = /^(necesito(\s+(ayuda|apoyo|orientaci[oó]n|informaci[oó]n))?|tengo(\s+un)?\s+(problema|duda|consulta|pregunta)|me\s+(pueden?|podr[ií]a[ns]?)\s*ayudar|b[úu]sco\s+(ayuda|apoyo|informaci[oó]n|orientaci[oó]n)|ayuda(\s+por\s+favor)?|ay[úu]dame|orientaci[oó]n|quiero\s+(informaci[oó]n|saber|ayuda))[.!,?]*\s*$/i;

// ── Helper: genera embedding ──────────────────────────────────
// OTel context propagation convierte este span en hijo del observation activo
async function embedText(text) {
  return startActiveObservation("openai-embedding", async (obs) => {
    obs.update({ input: text.substring(0, 200) });
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    obs.update({
      output: { tokens: response.usage.total_tokens, dimensions: response.data[0].embedding.length },
    });
    return response.data[0].embedding;
  }, { asType: "embedding" });
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
// Reset por inactividad: si el último mensaje tiene más de 24 h, se ignora
// el historial anterior y se trata como conversación nueva (sin borrar BD).
const HISTORY_EXPIRY_MS    = 24 * 60 * 60 * 1000; // 24 horas
const ACTIVE_FLOW_TIMEOUT_MS = 30 * 60 * 1000;      // 30 minutos sin interacción cierra el flujo

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
  if (!data || data.length === 0) return [];

  // data[0] es el mensaje más reciente (orden DESC).
  // Si supera el tiempo de expiración, conversación nueva.
  const lastTs = new Date(data[0].created_at).getTime();
  if (Date.now() - lastTs > HISTORY_EXPIRY_MS) {
    console.log(`⏰ Historial expirado para ${userId} [${countryCode}] — conversación nueva`);
    return [];
  }

  const messages = data.reverse().map(item => ({ role: item.role, content: item.message }));

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

// ── Buscar flow (Excel) ───────────────────────────────────────
// OTel context propagation anida automáticamente embedText y supabase como hijos
async function searchFlow(countryCode, question) {
  return startActiveObservation("search-flows", async (obs) => {
    obs.update({ input: question });
    const queryEmbedding = await embedText(question);

    const result = await startActiveObservation("supabase-match-flows", async (dbObs) => {
      dbObs.update({ input: { country: countryCode } });
      const { data, error } = await supabase.rpc("match_flows_by_country", {
        query_embedding: queryEmbedding,
        filter_country: countryCode,
        match_count: 1,
        min_similarity: 0.45,
      });
      if (error) {
        dbObs.update({ output: { error: error.message } });
        throw error;
      }
      const res = data?.[0] || null;
      dbObs.update({ output: res ? { flow_id: res.flow_id, similarity: res.similarity } : null });
      return res;
    });

    obs.update({
      output: result
        ? { flow_id: result.flow_id, flow_type: result.flow_type, similarity: result.similarity }
        : null,
    });
    return result;
  });
}

// ── Búsqueda semántica (PDF) ──────────────────────────────────
async function searchSemantic(countryCode, question, matchCount = 5) {
  return startActiveObservation("search-semantic", async (obs) => {
    obs.update({ input: question });
    const queryEmbedding = await embedText(question);

    const results = await startActiveObservation("supabase-match-knowledge", async (dbObs) => {
      dbObs.update({ input: { country: countryCode, matchCount } });
      const { data, error } = await supabase.rpc("match_knowledge_by_country", {
        query_embedding: queryEmbedding,
        filter_country: countryCode,
        match_count: matchCount,
      });
      if (error) {
        dbObs.update({ output: { error: error.message } });
        return [];
      }
      const res = (data || []).filter(item => item.similarity >= 0.25);
      dbObs.update({ output: { count: res.length } });
      return res;
    });

    obs.update({ output: { count: results.length } });
    return results;
  });
}

// ── Búsqueda keyword ──────────────────────────────────────────
async function searchFast(countryCode, question, limit = 3) {
  const keywords = question.split(/\s+/).filter(w => w.length > 4).slice(0, 3);
  if (keywords.length === 0) return [];
  const keyword = keywords.sort((a, b) => b.length - a.length)[0];

  return startActiveObservation("search-keyword", async (obs) => {
    obs.update({ input: { keyword, country: countryCode } });
    const { data, error } = await supabase
      .from("knowledge_chunks")
      .select("chunk_text, source_name")
      .ilike("chunk_text", `%${keyword}%`)
      .eq("country_code", countryCode)
      .limit(limit);
    const results = error ? [] : (data || []);
    obs.update({ output: { count: results.length, keyword } });
    return results;
  });
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

// ── Presentar un paso individual con LLM ─────────────────────
// Reemplaza los strings hardcodeados de handlePasoAPaso con tono conversacional
async function presentStepWithLLM(stepContent, { isDetail, isLastStep, question, history, orgName, countryCode }) {
  return startActiveObservation("claude-step-response", async (obs) => {
    obs.update({ input: { isDetail, isLastStep } });

    const endInstruction = isLastStep
      ? "Este es el último punto. Al final pregunta de forma natural si necesita más detalle o ya tiene todo claro."
      : "Al final pregunta de forma natural si quiere más detalle, continuar con lo siguiente, o tiene alguna duda.";

    const task = isDetail
      ? `Explica el siguiente detalle de forma empática y clara:\n${stepContent}`
      : `Presenta el siguiente contenido de forma conversacional:\n${stepContent}`;

    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 250,
      system: [
        { type: "text", text: STATIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        {
          type: "text",
          text: `Organización: ${orgName}. País: ${countryCode}.
Eres un asistente empático que apoya a migrantes y familias vulnerables. Presenta la información de forma conversacional y natural, como un amigo que orienta. NO uses el formato "Paso X de Y" ni numeraciones. Integra el contenido fluidamente en la conversación.
REGLAS:
- No cambies ningún dato concreto (direcciones, teléfonos, requisitos, nombres de instituciones)
- No agregues información que no esté en el texto
- Tono empático, cálido y cercano
- ${endInstruction}`,
        },
      ],
      messages: [...history, { role: "user", content: task }],
    });

    const resp = msg.content[0]?.text || stepContent;
    obs.update({
      output: resp,
      model: CLAUDE_MODEL,
      usageDetails: {
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
        cache_read: msg.usage.cache_read_input_tokens ?? 0,
        cache_creation: msg.usage.cache_creation_input_tokens ?? 0,
      },
    });
    return resp;
  }, { asType: "generation" });
}

// ── Manejar PASO A PASO ───────────────────────────────────────
// La IA conoce TODOS los pasos del proceso, entiende la respuesta natural
// del usuario y decide qué presentar sin clasificadores rígidos.
async function handlePasoAPaso(userId, countryCode, question, state) {
  const orgName = COUNTRY_ORGS[countryCode] || `Aldeas Infantiles SOS (${countryCode})`;

  return startActiveObservation("handle-paso-a-paso", async (obs) => {
    obs.update({ input: { step: state.current_step, total: state.total_steps, flow_id: state.flow_id } });

    // Historial y pasos en paralelo
    const [history, stepsResult] = await Promise.all([
      getRecentHistory(userId, countryCode, 10),
      supabase
        .from("knowledge_steps")
        .select("step_number, step_summary, step_detail")
        .eq("flow_id", state.flow_id)
        .order("step_number", { ascending: true }),
    ]);

    const allSteps = stepsResult.data || [];
    const currentStep = allSteps.find(s => s.step_number === state.current_step);
    const nextStep = allSteps.find(s => s.step_number === state.current_step + 1);
    const isLastStep = state.current_step >= state.total_steps;

    if (!currentStep) {
      await updateStep(state.id, state.current_step, "completed");
      return { response: "¡Entendido! Si necesitas más ayuda, con gusto te orientamos.", metadata: { flow_type: "paso_a_paso" } };
    }

    // Resumen de todos los pasos + detalle completo solo del actual y el siguiente
    const stepsOverview = allSteps.map(s => `[${s.step_number}] ${s.step_summary}`).join("\n");
    const currentContent = currentStep.step_detail || currentStep.step_summary;
    const nextContent   = nextStep ? (nextStep.step_detail || nextStep.step_summary) : null;

    const systemContext = `Organización: ${orgName}. País: ${countryCode}.
Estás orientando al usuario en un proceso de ${state.total_steps} pasos por WhatsApp. Va en el paso ${state.current_step}.

RESUMEN DE TODOS LOS PASOS (para que conozcas el proceso completo):
${stepsOverview}

CONTENIDO DEL PASO ACTUAL (${state.current_step}) — fuente Excel:
${currentContent}

${nextContent ? `CONTENIDO DEL SIGUIENTE PASO (${state.current_step + 1}) — lo mostrarás solo si el usuario confirma:\n${nextContent}` : "ESTE ES EL ÚLTIMO PASO."}

RAZONAMIENTO ANTES DE RESPONDER:
0. REGLA DE AMBIGÜEDAD: Si el usuario responde con una frase corta o menciona un documento de forma aislada ("su partida de nacimiento", "DNI", "carné", "pasaporte", "certificado", etc.), NO asumir si lo tiene o si le falta. Antes de continuar, preguntar: "¿Me puedes decir si ese documento es el que ya tiene, o el que le están pidiendo y le falta?" u una pregunta equivalente. Esta regla aplica siempre que el mensaje sea ambiguo sobre posesión o ausencia de un documento.
1. Lee el último mensaje del usuario. ¿Aporta información nueva (un documento que ya tiene, país de origen, ciudad, etc.)?
2. ¿Esa información nueva cambia o contradice el supuesto del paso actual?
   - SÍ cambia → pide una aclaración concreta antes de avanzar (accion: "detalle")
   - NO cambia y el usuario confirma → avanza al siguiente paso (accion: "siguiente")
3. Si el usuario se despide o indica que ya resolvió su duda → accion: "finalizar"
4. Si pregunta algo completamente diferente → accion: "otro"
5. Si el contenido del paso menciona ciudad, sede o ubicación → pregunta la ciudad antes de avanzar

Responde ÚNICAMENTE con JSON válido (sin texto fuera del JSON):
{"accion": "siguiente|detalle|finalizar|otro", "respuesta": "..."}

REGLAS ESTRICTAS para el campo "respuesta":
- Máximo un paso por mensaje. No envíes varios pasos juntos
- El contenido viene del Excel; no inventes, no agregues servicios ni instituciones no mencionadas
- Al avanzar, reformula el siguiente paso de forma breve y natural (no copies literalmente si es muy largo, pero sin agregar información nueva)
- Termina con una pregunta concreta relacionada al contenido del paso — evita "¿Listo para continuar?" genérico; usa una pregunta específica del tema
- ${isLastStep ? 'Este es el último paso. Después cierra con: "¿Hay algo más en lo que pueda ayudarte?"' : "No menciones ni anticipes pasos posteriores al siguiente"}
- Tono empático y cercano para WhatsApp`;

    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 350,
      system: [
        { type: "text", text: STATIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: systemContext },
      ],
      messages: [...history, { role: "user", content: question }],
    });

    const raw = (msg.content[0]?.text ?? "").trim();
    let accion = "detalle";
    let respuesta = raw;

    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        accion = (parsed.accion ?? "detalle").toLowerCase().trim();
        respuesta = parsed.respuesta ?? raw;
      }
    } catch {
      // JSON parse fallido — mantener respuesta raw sin avanzar
    }

    console.log(`🎯 Acción paso-a-paso: ${accion} (${state.current_step}/${state.total_steps})`);

    obs.update({
      output: respuesta,
      model: CLAUDE_MODEL,
      usageDetails: {
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
        cache_read: msg.usage.cache_read_input_tokens ?? 0,
        cache_creation: msg.usage.cache_creation_input_tokens ?? 0,
      },
    });

    if (accion === "siguiente") {
      isLastStep
        ? await updateStep(state.id, state.current_step, "completed")
        : await updateStep(state.id, state.current_step + 1);
    } else if (accion === "finalizar") {
      await updateStep(state.id, state.current_step, "completed");
    } else if (accion === "otro") {
      await updateStep(state.id, state.current_step, "cancelled");
      return null;
    }
    // "detalle": sin cambio de estado

    return { response: respuesta, metadata: { flow_type: "paso_a_paso", step: state.current_step } };
  });
}

// ── LLM-as-a-Judge ────────────────────────────────────────────
// Criterios centrados en si el USUARIO quedó bien atendido,
// no en si el flow de BD fue un match perfecto.
// traceId capturado del rootObs mientras el trace estaba activo.
// Se llama fire-and-forget — no bloquea el envío del mensaje a WhatsApp.
async function evaluateResponse(traceId, question, context, response) {
  if (!langfuseClient || !traceId) return;

  const EVAL_MODEL = "claude-haiku-4-5";

  try {
    const msg = await anthropic.messages.create({
      model: EVAL_MODEL,
      max_tokens: 100,
      system: "Eres un evaluador de calidad de atención a usuarios vulnerables (migrantes y familias). Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional ni explicaciones.",
      messages: [
        {
          role: "user",
          content: `Evalúa la atención recibida por el usuario con un score de 0.0 a 1.0 en cada criterio.

PREGUNTA DEL USUARIO:
${question}

CONTEXTO RECUPERADO DE LA BASE DE CONOCIMIENTO:
${context.substring(0, 2000)}

RESPUESTA DEL ASISTENTE:
${response}

CRITERIOS DE EVALUACIÓN:
- fidelidad: ¿La respuesta es coherente y no contradice la información de la base de conocimiento? (0.0 = contradice o inventa datos, 1.0 = completamente coherente)
- relevancia: ¿La respuesta realmente ayuda al usuario con lo que preguntó, independientemente del flow que matcheó? (0.0 = no ayuda en nada, 1.0 = responde exactamente lo que necesitaba)
- utilidad: ¿El usuario obtiene valor real de esta respuesta para su situación como migrante o familia vulnerable? (0.0 = sin valor práctico, 1.0 = muy útil para su situación)
- precision_contexto: ¿El contexto encontrado en BD fue útil para generar la respuesta, aunque no sea una coincidencia exacta con la pregunta? (0.0 = contexto inútil o confuso, 1.0 = contexto muy útil)

Responde SOLO con el JSON. Ejemplo exacto: {"fidelidad": 0.9, "relevancia": 0.8, "utilidad": 0.7, "precision_contexto": 0.6}`,
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
    const criteria = ["fidelidad", "relevancia", "utilidad", "precision_contexto"];

    for (const name of criteria) {
      const rawValue = scores[name];
      if (typeof rawValue !== "number" || isNaN(rawValue)) {
        console.warn(`LLM-Judge: score inválido para "${name}":`, rawValue);
        continue;
      }
      const value = Math.max(0, Math.min(1, rawValue));
      await langfuseClient.score.create({
        traceId,
        name,
        value,
        dataType: "NUMERIC",
        comment: `LLM-as-Judge (${EVAL_MODEL})`,
      });
    }

    const f = scores.fidelidad?.toFixed(2) ?? "?";
    const r = scores.relevancia?.toFixed(2) ?? "?";
    const u = scores.utilidad?.toFixed(2) ?? "?";
    const p = scores.precision_contexto?.toFixed(2) ?? "?";
    console.log(`🧑‍⚖️ LLM-Judge: fidelidad=${f} relevancia=${r} utilidad=${u} precision_contexto=${p}`);

    await langfuseClient.score.flush();
  } catch (err) {
    console.error("Error LLM-Judge:", err.message);
  }
}

// ── Parsear pasos numerados desde texto libre ─────────────────
function parseStepsFromText(text) {
  const lines = (text || "").split("\n").map(l => l.trim()).filter(Boolean);
  const steps = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^(\d+)[.)]\s+(.+)/);
    if (m) {
      if (current) steps.push(current);
      current = { number: parseInt(m[1]), summary: m[2] };
    } else if (current) {
      current.summary += " " + line;
    }
  }
  if (current) steps.push(current);
  return steps;
}

// ── 3 niveles de respuesta según tipo_respuesta ───────────────
// NIVEL 1 "informativa" (o null): LLM reformula libremente con la info de BD
// NIVEL 2 "paso a paso":          LLM adapta tono pero conserva TODOS los pasos y datos exactos
// NIVEL 3 "seleccion":            Texto exacto de BD, sin ninguna modificación
async function presentFlowWithLLM(flow, question, history, orgName, countryCode, userId) {
  const raw = (flow.tipo_respuesta ?? flow.flow_type ?? "informativa") + "";
  const tipo = raw.toLowerCase().trim().normalize("NFD").replace(/[̀-ͯ]/g, "");

  // NIVEL 2: inicia navegación guiada — muestra UN paso a la vez
  const isNivel2 = tipo === "paso a paso" || tipo === "paso_a_paso";
  if (isNivel2 && userId) {
    const { data: kSteps } = await supabase
      .from("knowledge_steps")
      .select("step_number, step_summary")
      .eq("flow_id", flow.flow_id)
      .order("step_number", { ascending: true });

    const steps = (kSteps && kSteps.length > 0)
      ? kSteps.map(s => ({ number: s.step_number, summary: s.step_summary }))
      : parseStepsFromText(flow.answer);

    if (steps.length > 0) {
      console.log(`🪜 Flow NIVEL 2 (paso a paso guiado): ${flow.flow_id} — ${steps.length} pasos`);
      await upsertState(userId, countryCode, flow.flow_id, "paso a paso", 1, steps.length);
      return presentStepWithLLM(steps[0].summary, {
        isDetail: false, isLastStep: steps.length === 1,
        question, history, orgName, countryCode,
      });
    }
  }

  // NIVEL 3: con similarity >= 0.50 devuelve textual + relevanceGuard;
  // con similarity < 0.50 el LLM evalúa si realmente aplica antes de responder
  if (tipo === "seleccion") {
    const highConfidence = (flow.similarity ?? 0) >= 0.50;
    console.log(`📄 Flow NIVEL 3 (selección): ${flow.flow_id} sim=${flow.similarity?.toFixed(3)} highConfidence=${highConfidence}`);
    return startActiveObservation("claude-flow-response", async (obs) => {
      obs.update({ input: { question, tipo_respuesta: tipo, flow_id: flow.flow_id, similarity: flow.similarity } });
      const block2Text = highConfidence
        ? `Organización: ${orgName}. País: ${countryCode}.\nEvalúa si la siguiente información responde la pregunta del usuario.\n- Si SÍ es relevante: devuelve EXACTAMENTE este texto, sin ninguna modificación:\n${flow.answer}\n- Si NO es relevante: responde empáticamente indicando que aún no cuentas con esa información específica y sugiere contactar directamente a ${orgName}.`
        : `Organización: ${orgName}. País: ${countryCode}.\nSe encontró información relacionada pero con baja confianza. Evalúa con criterio estricto si realmente responde la pregunta del usuario.\n- Si SÍ aplica claramente: devuelve EXACTAMENTE este texto sin ninguna modificación:\n${flow.answer}\n- Si NO aplica o hay dudas: responde empáticamente que aún no cuentas con esa información específica y sugiere contactar directamente a ${orgName}.`;
      const msg = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 400,
        system: [
          { type: "text", text: STATIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          { type: "text", text: block2Text },
        ],
        messages: [...history, { role: "user", content: question }],
      });
      const resp = msg.content[0]?.text || flow.answer;
      obs.update({
        output: resp,
        model: CLAUDE_MODEL,
        usageDetails: {
          input: msg.usage.input_tokens,
          output: msg.usage.output_tokens,
          cache_read: msg.usage.cache_read_input_tokens ?? 0,
          cache_creation: msg.usage.cache_creation_input_tokens ?? 0,
        },
      });
      return resp;
    }, { asType: "generation" });
  }

  console.log(`🤖 Flow NIVEL 1 (informativa): ${flow.flow_id}`);

  const relevanceGuard = `\nANTES DE RESPONDER: evalúa internamente si la información de la base de conocimiento realmente responde la pregunta del usuario. Si NO es relevante o no la cubre, responde empáticamente indicando que aún no cuentas con esa información específica y sugiere contactar directamente a ${orgName}. No fuerces una respuesta con información que no aplica.`;

  const block2 = `Organización: ${orgName}. País: ${countryCode}.
Eres un asistente empático que apoya a migrantes y familias vulnerables. Usa la información de la base de conocimiento como guía, pero responde de forma natural y adaptada exactamente a lo que preguntó el usuario. Tono cálido, humano y cercano.
No inventes datos adicionales.${relevanceGuard}`;

  const userContent = `Información de la base de conocimiento:\n${flow.answer}\n\nPregunta del usuario: ${question}`;

  return startActiveObservation("claude-flow-response", async (obs) => {
    obs.update({ input: { question, tipo_respuesta: tipo, flow_id: flow.flow_id } });

    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      system: [
        { type: "text", text: STATIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: block2 },
      ],
      messages: [...history, { role: "user", content: userContent }],
    });

    const resp = msg.content[0]?.text || flow.answer;
    const cacheRead = msg.usage.cache_read_input_tokens ?? 0;
    if (cacheRead > 0) console.log(`💾 Cache hit Flow [${countryCode}]: ${cacheRead} tokens`);

    obs.update({
      output: resp,
      model: CLAUDE_MODEL,
      usageDetails: {
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
        cache_read: cacheRead,
        cache_creation: msg.usage.cache_creation_input_tokens ?? 0,
      },
    });
    return resp;
  }, { asType: "generation" });
}

// ── Clarificación inteligente ─────────────────────────────────
// Cuando el mensaje es vago, genera UNA pregunta empática y específica
// basada en lo que escribió el usuario, considerando el historial previo.
async function generateClarification(question, history, orgName, countryCode) {
  return startActiveObservation("claude-clarification", async (obs) => {
    obs.update({ input: question });
    const messages = [...history, { role: "user", content: question }];
    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 120,
      system: [
        { type: "text", text: STATIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        {
          type: "text",
          text: `Organización activa: ${orgName}. País: ${countryCode}. El usuario envió un mensaje vago o ambiguo. Formula UNA SOLA pregunta empática y específica para entender mejor qué necesita, considerando el historial de la conversación si lo hay. La pregunta debe ser breve, cálida y directamente relacionada con lo que escribió el usuario. No respondas a ningún tema concreto todavía — solo haz la pregunta de clarificación.`,
        },
      ],
      messages,
    });
    const resp = msg.content[0]?.text
      || `¿En qué área específica puedo orientarte sobre los servicios de ${orgName}?`;
    obs.update({
      output: resp,
      model: CLAUDE_MODEL,
      usageDetails: {
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
        cache_read: msg.usage.cache_read_input_tokens ?? 0,
        cache_creation: msg.usage.cache_creation_input_tokens ?? 0,
      },
    });
    return resp;
  }, { asType: "generation" });
}

// ── Core RAG ──────────────────────────────────────────────────
async function askAI(userId, countryCode, question) {
  const totalStart = Date.now();
  const orgName = COUNTRY_ORGS[countryCode] || `Aldeas Infantiles SOS (${countryCode})`;

  // propagateAttributes adjunta userId/sessionId/traceName a todas las observations
  // del árbol OTel — sin necesidad de pasarlos manualmente a cada función.
  return propagateAttributes(
    {
      traceName: "rag-query",
      userId,
      sessionId: userId,   // agrupa todas las trazas del mismo número en Langfuse Sessions
      metadata: { countryCode, orgName },
    },
    () =>
      startActiveObservation("rag-query", async (rootObs) => {
        // traceId capturado aquí (mientras el span está activo) para usar en
        // evaluateResponse fire-and-forget que corre después de cerrar el span.
        const traceId = rootObs.traceId;
        rootObs.update({ input: question });

        // 0. FLUJO ACTIVO — se evalúa primero.
        //    Si el mensaje es continuación clara → sigue el paso actual.
        //    Si es una pregunta nueva → retrieval para detectar intención nueva.
        //    precomputedFlow evita hacer doble llamada a embeddings si ya se buscó aquí.
        let precomputedFlow = null;

        const activeState = await getActiveState(userId, countryCode);
        if (activeState && (activeState.flow_type === "paso a paso" || activeState.flow_type === "paso_a_paso")) {
          const elapsed = Date.now() - new Date(activeState.updated_at).getTime();

          if (elapsed > ACTIVE_FLOW_TIMEOUT_MS) {
            // Flujo expirado → cancelar y procesar como mensaje nuevo
            console.log(`⏰ Flujo expirado (>30 min): ${activeState.flow_id} — cancelando`);
            await updateStep(activeState.id, activeState.current_step, "cancelled");

          } else if (CONTINUATION_REGEX.test(question.trim())) {
            // Señal de continuación explícita → seguir el paso actual sin retrieval
            console.log(`▶️ Continuación del flujo: ${activeState.flow_id} paso ${activeState.current_step}/${activeState.total_steps}`);
            const result = await handlePasoAPaso(userId, countryCode, question, activeState);
            if (result) {
              rootObs.update({ output: result.response, metadata: { search_type: "paso_a_paso" } });
              return result;
            }
            // accion "otro" → continúa al flujo normal

          } else {
            // Mensaje más complejo → verificar si es una intención nueva
            console.log(`🔍 Mensaje complejo con flujo activo — verificando intención nueva`);
            const candidate = await searchFlow(countryCode, question);

            if (candidate && candidate.similarity >= 0.55) {
              // Nueva intención con alta confianza → cancelar flujo anterior y usar el nuevo
              console.log(`🔀 Nueva intención (sim=${candidate.similarity?.toFixed(3)}): ${candidate.flow_id} — cancelando ${activeState.flow_id}`);
              await updateStep(activeState.id, activeState.current_step, "cancelled");
              precomputedFlow = candidate; // se usará en paso 4, sin re-embeddings

            } else {
              // Sin nueva intención clara → continuar con el flujo activo
              console.log(`↩️ Sin nueva intención — continuando: ${activeState.flow_id} paso ${activeState.current_step}`);
              const result = await handlePasoAPaso(userId, countryCode, question, activeState);
              if (result) {
                rootObs.update({ output: result.response, metadata: { search_type: "paso_a_paso" } });
                return result;
              }
            }
          }
        }

        // 1. SMALL TALK — solo si NO hay flujo activo
        if (SMALL_TALK_REGEX.test(question.trim())) {
          const response = `¡Hola! Soy el asistente virtual de ${orgName}. ¿En qué puedo ayudarte hoy?`;
          rootObs.update({ output: response, metadata: { search_type: "small_talk" } });
          return { response, metadata: { search_type: "small_talk", total_ms: Date.now() - totalStart } };
        }

        // 3. CACHE
        const cached = getCached(countryCode, question);
        if (cached) {
          rootObs.update({ output: cached, metadata: { search_type: "cache" } });
          return { response: cached, metadata: { search_type: "cache", total_ms: Date.now() - totalStart } };
        }

        // Historial disponible para todos los paths a partir de aquí
        const history = await getRecentHistory(userId, countryCode, 10);

        // 3.5 MENSAJE VAGO — pedir clarificación antes de buscar
        if (VAGUE_REGEX.test(question.trim())) {
          const response = await generateClarification(question, history, orgName, countryCode);
          rootObs.update({ output: response, metadata: { search_type: "clarification" } });
          return { response, metadata: { search_type: "clarification", total_ms: Date.now() - totalStart } };
        }

        // 4. BUSCAR EN knowledge_flows (Excel)
        // Si ya se buscó en el paso 0 (cambio de intención detectado), reutilizar sin re-embeddings.
        const flow = precomputedFlow ?? await searchFlow(countryCode, question);

        if (flow) {
          console.log(`📋 Flow: ${flow.flow_id} [${flow.flow_type}] sim: ${flow.similarity?.toFixed(3)}`);
          const normalizedType = flow.flow_type?.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

          if (normalizedType === "informativa" || normalizedType === "seleccion") {
            const response = await presentFlowWithLLM(flow, question, history, orgName, countryCode, userId);
            const searchType = normalizedType === "informativa" ? "flow_informativa" : "flow_seleccion";
            setCached(countryCode, question, response);
            rootObs.update({ output: response, metadata: { search_type: searchType, flow_id: flow.flow_id, tipo_respuesta: flow.tipo_respuesta ?? normalizedType } });
            return { response, metadata: { search_type: searchType, flow_id: flow.flow_id, total_ms: Date.now() - totalStart } };
          }

          if (normalizedType === "paso a paso" || normalizedType === "paso_a_paso") {
            const { data: steps } = await supabase
              .from("knowledge_steps")
              .select("step_number, step_summary")
              .eq("flow_id", flow.flow_id)
              .order("step_number", { ascending: true });

            if (!steps || steps.length === 0) {
              rootObs.update({ output: flow.answer, metadata: { search_type: "flow_paso_a_paso" } });
              return { response: flow.answer, metadata: { search_type: "flow_paso_a_paso" } };
            }

            await upsertState(userId, countryCode, flow.flow_id, "paso a paso", 1, steps.length);
            const response = await presentStepWithLLM(steps[0].step_summary, {
              isDetail: false, isLastStep: steps.length === 1,
              question, history, orgName, countryCode,
            });
            rootObs.update({ output: response, metadata: { search_type: "flow_paso_a_paso", flow_id: flow.flow_id } });
            return { response, metadata: { search_type: "flow_paso_a_paso", flow_id: flow.flow_id, total_steps: steps.length } };
          }
        }

        // 5. FALLBACK — búsqueda híbrida + Claude
        // search-hybrid agrupa semántica, keyword y la generación de Claude
        const hybridResult = await startActiveObservation("search-hybrid", async (hybridObs) => {
          hybridObs.update({ input: question });

          // searchSemantic y searchFast son hijos automáticos via OTel context
          // history ya fue obtenido antes del paso 4 (scope externo)
          const [semanticData, fastData] = await Promise.all([
            searchSemantic(countryCode, question, 5),
            searchFast(countryCode, question, 3),
          ]);

          const allResults = mergeResults(semanticData, fastData);

          if (allResults.length === 0) {
            hybridObs.update({ output: { count: 0 } });

            // Sin contexto en la BD — Claude usa el historial + conocimiento general
            // de la organización para responder con empatía sin inventar datos
            const noCtxResponse = await startActiveObservation("claude-no-context", async (noCtxObs) => {
              noCtxObs.update({ input: question });
              const noCtxMsg = await anthropic.messages.create({
                model: CLAUDE_MODEL,
                max_tokens: 200,
                system: [
                  { type: "text", text: STATIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
                  {
                    type: "text",
                    text: `Organización activa: ${orgName}. País: ${countryCode}. No hay información específica disponible en la base de conocimiento para esta consulta. Usa el historial de la conversación (si lo hay) y tu conocimiento general sobre ${orgName} para responder de forma cálida y empática. Reconoce el tema que pregunta el usuario, indica honestamente que no cuentas con esa información específica en este momento, y recomiéndale contactar directamente a ${orgName}. Nunca inventes datos, nombres, montos ni procedimientos concretos.`,
                  },
                ],
                messages: [...history, { role: "user", content: question }],
              });
              const resp = noCtxMsg.content[0]?.text
                || `Lo siento, no tengo esa información en este momento. Te recomiendo contactar directamente a ${orgName} para que te orienten mejor.`;
              noCtxObs.update({
                output: resp,
                model: CLAUDE_MODEL,
                usageDetails: {
                  input: noCtxMsg.usage.input_tokens,
                  output: noCtxMsg.usage.output_tokens,
                  cache_read: noCtxMsg.usage.cache_read_input_tokens ?? 0,
                  cache_creation: noCtxMsg.usage.cache_creation_input_tokens ?? 0,
                },
              });
              return resp;
            }, { asType: "generation" });

            return { response: noCtxResponse, searchType: "no_results_llm", context: null };
          }

          hybridObs.update({
            output: { semantic: semanticData.length, keyword: fastData.length, merged: allResults.length },
          });

          const context = allResults
            .map((item, i) => `Fuente ${i + 1}${item.source_name ? ` (${item.source_name})` : ""}:\n${item.chunk_text}`)
            .join("\n\n");

          // El contexto recuperado va en el mensaje del usuario para que varíe por pregunta
          const userContent = `Contexto:\n${context}\n\nPregunta: ${question}`.trim();
          const messages = [...history, { role: "user", content: userContent }];

          const llmStart = Date.now();

          // claude-rag-response es hijo de search-hybrid via OTel context
          // Sistema en dos bloques:
          //   Bloque 1 — STATIC_SYSTEM_PROMPT (≥2048 tokens, cache_control): cached en Anthropic
          //   Bloque 2 — Nombre de organización + país (dinámico): siempre fresco
          const finalResponse = await startActiveObservation("claude-rag-response", async (ragObs) => {
            ragObs.update({ input: messages, model: CLAUDE_MODEL });

            const stream = anthropic.messages.stream({
              model: CLAUDE_MODEL,
              max_tokens: 300,
              system: [
                {
                  type: "text",
                  text: STATIC_SYSTEM_PROMPT,
                  cache_control: { type: "ephemeral" },
                },
                {
                  type: "text",
                  text: `Organización activa: ${orgName}. País: ${countryCode}. Responde según el contexto de esta organización en este país.`,
                },
              ],
              messages,
            });
            const claudeResponse = await stream.finalMessage();

            const resp = claudeResponse.content[0]?.text
              || `Lo siento, no tengo esa información en este momento. Te recomiendo contactar directamente a ${orgName} para que te orienten mejor.`;

            const cacheRead = claudeResponse.usage.cache_read_input_tokens ?? 0;
            const cacheCreation = claudeResponse.usage.cache_creation_input_tokens ?? 0;
            if (cacheRead > 0) {
              console.log(`💾 Cache hit RAG [${countryCode}]: ${cacheRead} tokens (~${Math.round(cacheRead * 0.9)} ahorrados)`);
            }

            ragObs.update({
              output: resp,
              usageDetails: {
                input: claudeResponse.usage.input_tokens,
                output: claudeResponse.usage.output_tokens,
                cache_read: cacheRead,
                cache_creation: cacheCreation,
              },
            });
            return resp;
          }, { asType: "generation" });

          return { response: finalResponse, searchType: "hybrid", context, llm_ms: Date.now() - llmStart };
        });

        // Fire-and-forget: evaluación LLM-as-Judge en background.
        // traceId capturado antes — el span puede haber cerrado ya en este punto.
        if (hybridResult.context && langfuseClient) {
          evaluateResponse(traceId, question, hybridResult.context, hybridResult.response);
        }

        if (hybridResult.searchType === "hybrid" && !hybridResult.response.includes("Lo siento")) {
          setCached(countryCode, question, hybridResult.response);
        }

        rootObs.update({
          output: hybridResult.response,
          metadata: { search_type: hybridResult.searchType },
        });

        return {
          response: hybridResult.response,
          metadata: {
            search_type: hybridResult.searchType,
            total_ms: Date.now() - totalStart,
            ...(hybridResult.llm_ms ? { llm_ms: hybridResult.llm_ms } : {}),
          },
        };
      })
  );
}

module.exports = { askAI, saveConversationTurn };
