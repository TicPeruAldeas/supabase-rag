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

if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  const { LangfuseSpanProcessor } = require("@langfuse/otel");

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
La respuesta final debe estar basada en el campo "Respuesta" del flow recuperado. No usar conocimiento externo para completar información. No agregar recomendaciones legales, migratorias, médicas o institucionales que no estén en el flow.

REGLA F — CONTACTOS VERIFICABLES
Nunca menciones teléfonos, correos, URLs, direcciones, sedes, líneas gratuitas ni nombres de canales específicos si no aparecen literalmente en el flow recuperado. Si no hay un contacto concreto en el Excel, usa solo "canales oficiales" sin inventar datos.`;

// Solo saludos reales. Confirmaciones cortas (sí, ok, listo...) se eliminaron
// para que nunca disparen el saludo si hay contexto activo o reciente.
const SMALL_TALK_REGEX = /^(hola+s?|buenos\s+(d[ií]as|tardes|noches)|buenas?(\s+(d[ií]as|tardes|noches))?|buen\s+d[ií]a|hi+|hey+|😊)[\s!?,.:]*$/i;

// Señales de continuación dentro de un flow activo o contexto reciente.
// "Sí", "ok", "listo", "luego qué hago", etc. nunca deben activar saludo.
// El grupo final opcional admite cortesías/afirmaciones encadenadas como
// "sí por favor", "si porfavor", "ya dale", "claro continúa", "ok gracias".
const CONTINUATION_REGEX = /^(sí|si|no|listo|ok|okay|ya|correcto|entendido|no\s+s[eé]|todav[ií]a\s+no|quiero\s+continuar|continuar|continúa|continua|siguiente|el\s+siguiente|segundo\s+paso|el\s+segundo\s+paso|paso\s+\d+|adelante|claro|dale|de\s+acuerdo|por\s+supuesto|a[ú]n\s+no|bien|perfecto|genial|luego|luego\s+(que|qué)\s+hago|dime\s+m[aá]s|👍|✅|☑)(?:\s+(?:por\s*favor|porfa|claro|dale|gracias|adelante|continúa|continua|sí|si))?[.!,?\s]*$/i;

function isContinuationMessage(question) {
  return CONTINUATION_REGEX.test((question || "").trim());
}

const CONTACT_TOKEN_REGEX = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|https?:\/\/\S+|www\.\S+|\b(?:\+?\d[\d\s().-]{6,}\d)\b)/gi;
const SHORT_NUMBER_REGEX = /\b\d{2,6}\b/g;
const INSTITUTION_KEYWORD_REGEX = /\b(polic[ií]a|municipalidad|comisar[ií]a|serenazgo|demuna|defensor[ií]a|ministerio|hospital|centro de salud|l[ií]nea gratuita)\b/i;

function normalizeContactToken(value) {
  return String(value || "").toLowerCase().replace(/[\s().-]+/g, "");
}

function hasUnsupportedContactInfo(response, sourceText) {
  const tokens = String(response || "").match(CONTACT_TOKEN_REGEX) || [];
  const shortNumbers = String(response || "").match(SHORT_NUMBER_REGEX) || [];

  const source = String(sourceText || "").toLowerCase();
  const normalizedSource = normalizeContactToken(sourceText);

  const hasUnsupportedContact = tokens.some((token) => {
    const lowerToken = token.toLowerCase();
    if (lowerToken.includes("@") || lowerToken.startsWith("http") || lowerToken.startsWith("www.")) {
      return !source.includes(lowerToken);
    }
    return !normalizedSource.includes(normalizeContactToken(token));
  });

  const hasUnsupportedShortNumber = shortNumbers.some((token) => !source.includes(token.toLowerCase()));
  const hasUnsupportedInstitution = INSTITUTION_KEYWORD_REGEX.test(response || "")
    && !INSTITUTION_KEYWORD_REGEX.test(sourceText || "");

  return hasUnsupportedContact || hasUnsupportedShortNumber || hasUnsupportedInstitution;
}

function guardGroundedContactInfo(response, sourceText, orgName) {
  if (!hasUnsupportedContactInfo(response, sourceText)) return response;
  console.warn("⚠️ Respuesta con contacto no presente en Excel; usando fallback seguro.");
  return String(sourceText || "").trim()
    || `Gracias por contarme. En este momento no cuento con un contacto especifico para orientarte por aqui. Te recomiendo comunicarte por los canales oficiales de ${orgName} para que puedan evaluar tu caso.`;
}

function sanitizeUserFacingResponse(response) {
  return String(response || "")
    .replace(/\s+(en|dentro de)\s+(el\s+)?Excel\b/gi, "")
    .replace(/\b(seg[uú]n|de acuerdo con)\s+(la\s+)?informaci[oó]n disponible[,:\s]*/gi, "")
    .replace(/\b(en|desde|dentro de)\s+(la\s+)?base de (conocimiento|datos)\b/gi, "")
    .replace(/\b(la\s+)?respuesta fuente\b/gi, "la orientacion")
    .replace(/\bfuente\s+(recuperada|consultada)\b/gi, "orientacion")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function textMetrics(text) {
  const value = String(text || "").trim();
  const words = value ? value.split(/\s+/).length : 0;
  const lines = value ? value.split(/\r?\n/).filter(Boolean).length : 0;
  return {
    chars: value.length,
    words,
    lines,
  };
}

function similarityBucket(similarity) {
  if (typeof similarity !== "number") return "none";
  if (similarity >= 0.75) return "high";
  if (similarity >= 0.55) return "medium";
  return "low";
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const COST_PER_MTOK = {
  claudeInput: envNumber("CLAUDE_INPUT_USD_PER_MTOK", 3),
  claudeOutput: envNumber("CLAUDE_OUTPUT_USD_PER_MTOK", 15),
  claudeCacheWrite: envNumber("CLAUDE_CACHE_WRITE_USD_PER_MTOK", 3.75),
  claudeCacheRead: envNumber("CLAUDE_CACHE_READ_USD_PER_MTOK", 0.30),
  embeddingInput: envNumber("OPENAI_EMBEDDING_USD_PER_MTOK", 0.02),
};

function perMillion(tokens, usdPerMillion) {
  return ((tokens || 0) * usdPerMillion) / 1_000_000;
}

function anthropicUsageDetails(usage = {}) {
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens + cacheReadTokens + cacheCreationTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}

function anthropicCostDetails(usage = {}) {
  const input = perMillion(usage.input_tokens ?? 0, COST_PER_MTOK.claudeInput);
  const output = perMillion(usage.output_tokens ?? 0, COST_PER_MTOK.claudeOutput);
  const cacheRead = perMillion(usage.cache_read_input_tokens ?? 0, COST_PER_MTOK.claudeCacheRead);
  const cacheCreation = perMillion(usage.cache_creation_input_tokens ?? 0, COST_PER_MTOK.claudeCacheWrite);
  const totalCost = input + output + cacheRead + cacheCreation;
  return {
    input,
    output,
    cacheRead,
    cacheCreation,
    totalCost,
  };
}

function embeddingUsageDetails(usage = {}) {
  const promptTokens = usage.total_tokens ?? 0;
  return {
    promptTokens,
    totalTokens: promptTokens,
  };
}

function embeddingCostDetails(usage = {}) {
  const input = perMillion(usage.total_tokens ?? 0, COST_PER_MTOK.embeddingInput);
  return {
    input,
    totalCost: input,
  };
}

function sourceRequestsLocation(text) {
  return /\b(ciudad|localidad|d[oó]nde|donde|cercana|cercano|ubicaci[oó]n|encuentras|encuentra)\b/i
    .test(String(text || ""));
}

function isLikelyLocationAnswer(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (value.length > 80) return false;
  return /^(me\s+encuentro\s+en|estoy\s+en|en|vivo\s+en|ando\s+en|soy\s+de)?\s*[a-záéíóúñü]+(?:[\s,.-]+[a-záéíóúñü]+){0,4}\s*$/i
    .test(value);
}

function extractLocationAnswer(text) {
  return String(text || "")
    .trim()
    .replace(/^(me\s+encuentro\s+en|estoy\s+en|en|vivo\s+en|ando\s+en|soy\s+de)\s+/i, "")
    .replace(/[.!,?]+$/g, "")
    .trim();
}

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
      model: "text-embedding-3-small",
      output: { tokens: response.usage.total_tokens, dimensions: response.data[0].embedding.length },
      usageDetails: embeddingUsageDetails(response.usage),
      costDetails: embeddingCostDetails(response.usage),
    });
    return response.data[0].embedding;
  }, { asType: "embedding" });
}


// ── Estado conversacional ─────────────────────────────────────
async function getActiveState(userId, countryCode) {
  // order+limit(1)+maybeSingle: tolera 0 o varias filas activas sin romper
  // (.single() devolvía error/null si había !=1 fila).
  const { data, error } = await supabase
    .from("conversation_state")
    .select("*")
    .eq("user_id", userId)
    .eq("country_code", countryCode)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) console.error(`⚠️  getActiveState [${userId}/${countryCode}]:`, error.message);
  return data || null;
}

function storedStateStatus(status, stateId) {
  if (status === "active") return status;
  return `${status}:${stateId}`;
}

async function closeState(stateId, currentStep, status = "cancelled") {
  const storedStatus = storedStateStatus(status, stateId);
  const { error } = await supabase
    .from("conversation_state")
    .update({ current_step: currentStep, status: storedStatus, updated_at: new Date().toISOString() })
    .eq("id", stateId);
  if (error) console.error(`❌ closeState [${stateId}] → paso ${currentStep}/${storedStatus}:`, error.message);
  return !error;
}

async function closeActiveStates(userId, countryCode, status = "cancelled") {
  const { data, error } = await supabase
    .from("conversation_state")
    .select("id,current_step")
    .eq("user_id", userId)
    .eq("country_code", countryCode)
    .eq("status", "active");

  if (error) {
    console.error(`⚠️  closeActiveStates(select) [${userId}/${countryCode}]:`, error.message);
    return;
  }

  for (const row of data || []) {
    await closeState(row.id, row.current_step, status);
  }
}

async function upsertState(userId, countryCode, flowId, flowType, currentStep, totalSteps, status = "active") {
  await closeActiveStates(userId, countryCode, "cancelled");

  if (status === "cancelled") return;

  const { error: insertErr } = await supabase.from("conversation_state").insert({
    user_id: userId,
    country_code: countryCode,
    flow_id: flowId,
    flow_type: flowType,
    current_step: currentStep,
    total_steps: totalSteps,
    status,
    updated_at: new Date().toISOString(),
  });
  // Si esto falla (p. ej. RLS sin policy / clave sin permisos), el flujo NO
  // se persiste y la continuación ("sí") no avanzará. Hay que verlo en logs.
  if (insertErr) console.error(`❌ upsertState(insert) [${userId}/${countryCode}] flow=${flowId}:`, insertErr.message);
}

async function updateStep(stateId, currentStep, status = "active") {
  const { error } = await supabase
    .from("conversation_state")
    .update({ current_step: currentStep, status: storedStateStatus(status, stateId), updated_at: new Date().toISOString() })
    .eq("id", stateId);
  if (error) console.error(`❌ updateStep [${stateId}] → paso ${currentStep}/${status}:`, error.message);
}

// ── Historial reciente ────────────────────────────────────────
// limit = 10 → últimos 5 mensajes del usuario + sus 5 respuestas (5 pares completos)
// Reset por inactividad: si el último mensaje tiene más de 24 h, se ignora
// el historial anterior y se trata como conversación nueva (sin borrar BD).
const HISTORY_EXPIRY_MS    = 24 * 60 * 60 * 1000; // 24 horas
const ACTIVE_FLOW_TIMEOUT_MS = 30 * 60 * 1000;      // 30 minutos sin interacción cierra el flujo

function normalizeMessageText(text) {
  return String(text || "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function getRecentHistory(userId, countryCode, limit = 10, excludeLatestUserText = null) {
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
  const excludedText = normalizeMessageText(excludeLatestUserText);

  if (
    excludedText &&
    messages.length > 0 &&
    messages[messages.length - 1].role === "user" &&
    normalizeMessageText(messages[messages.length - 1].content) === excludedText
  ) {
    messages.pop();
  }

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

async function getFlowById(countryCode, flowId) {
  const { data, error } = await supabase
    .from("knowledge_flows")
    .select("flow_id, country_code, flow_type, question, answer")
    .eq("country_code", countryCode)
    .eq("flow_id", flowId)
    .maybeSingle();

  if (error) {
    console.error(`❌ getFlowById [${countryCode}/${flowId}]:`, error.message);
    return null;
  }

  return data || null;
}

// Presentar un paso con LLM.
// Presentacion inicial: lista pasos breves y desarrolla solo el paso actual.
// Presentaciones siguientes o detalle: indicar "Paso N:" explicitamente.
async function presentStepWithLLM(stepContent, { isDetail, isLastStep, question, history, orgName, countryCode, allSteps, currentStepNumber }) {
  return startActiveObservation("claude-step-response", async (obs) => {
    obs.update({ input: { isDetail, isLastStep, currentStepNumber } });

    // Normaliza allSteps a {number, summary} independientemente del origen
    const steps = (allSteps || []).map(s => ({
      number: s.number ?? s.step_number,
      summary: s.summary ?? s.step_summary,
    }));

    const isInitialPresentation = !isDetail && currentStepNumber === 1 && steps.length > 0;

    let systemText;
    let userTask;

    if (isInitialPresentation) {
      systemText = `Organización: ${orgName}. País: ${countryCode}.
Eres un asistente de WhatsApp que entrega información de forma progresiva, un paso a la vez.

DETALLE DEL PASO 1 DE ${steps.length} (fuente Excel — reformular, no copiar literalmente):
${stepContent}

Genera la respuesta con EXACTAMENTE este formato:
"[Breve frase de contexto si aplica].

Paso 1 de ${steps.length}:
[Explicación breve del Paso 1 en lenguaje simple para WhatsApp].

¿Quieres que te diga el siguiente paso?"

REGLAS OBLIGATORIAS:
- NO listar todos los pasos al inicio
- Explicar SOLO el Paso 1
- Reformular en lenguaje simple; no copiar literalmente el Excel
- No agregar información fuera del Excel
- No preguntar "¿ya hiciste este paso?" ni pedir confirmación de ejecución
- No hagas preguntas cuya respuesta no cambie el contenido de los pasos siguientes. Si los pasos del flow son los mismos independientemente de la respuesta del usuario, no preguntes por esa variable. Solo pregunta lo que realmente determina el siguiente paso según el flow
- Terminar con "¿Quieres que te diga el siguiente paso?" o una variante natural
- Tono empático y cercano`;
      userTask = `La pregunta original del usuario fue: "${question}"`;

    } else if (isDetail) {
      systemText = `Organización: ${orgName}. País: ${countryCode}.
Eres un asistente de WhatsApp. Explica el siguiente detalle de forma breve y clara.
REGLAS:
- No copies el texto literalmente; reformula con palabras simples
- No cambies datos concretos (direcciones, teléfonos, requisitos, instituciones)
- No agregues información fuera del texto
- Tono empático y cercano
- Termina con una pregunta concreta relacionada al detalle`;
      userTask = `Detalle a explicar:\n${stepContent}`;

    } else {
      // Paso N > 1 durante navegación
      systemText = `Organización: ${orgName}. País: ${countryCode}.
Eres un asistente de WhatsApp guiando al usuario en el Paso ${currentStepNumber ?? ''}.
REGLAS:
- Comienza indicando el número: "Paso ${currentStepNumber ?? ''}: ..."
- Reformula el contenido brevemente, sin copiar literalmente
- No cambies datos concretos (direcciones, teléfonos, requisitos, instituciones)
- No agregues información fuera del texto
- ${isLastStep ? 'Es el último paso. Al terminar pregunta si necesita más ayuda.' : 'Termina con una pregunta concreta para continuar o aclarar dudas'}`;
      userTask = `Contenido del Paso ${currentStepNumber ?? ''}:\n${stepContent}`;
    }

    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: isInitialPresentation ? 400 : 250,
      system: [
        { type: "text", text: STATIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: systemText },
      ],
      messages: [...history, { role: "user", content: userTask }],
    });

    const rawResponse = msg.content[0]?.text || stepContent;
    const guardrailBlocked = hasUnsupportedContactInfo(rawResponse, stepContent);
    const resp = guardGroundedContactInfo(rawResponse, stepContent, orgName);
    obs.update({
      output: resp,
      model: CLAUDE_MODEL,
      metadata: {
        guardrail_contact_blocked: guardrailBlocked,
        response_chars: textMetrics(resp).chars,
      },
      usageDetails: anthropicUsageDetails(msg.usage),
      costDetails: anthropicCostDetails(msg.usage),
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
      getRecentHistory(userId, countryCode, 10, question),
      supabase
        .from("knowledge_steps")
        .select("step_number, step_summary, step_detail")
        .eq("flow_id", state.flow_id)
        .eq("country_code", countryCode)
        .order("step_number", { ascending: true }),
    ]);

    const allSteps = stepsResult.data || [];
    const lastStepNumber = allSteps.length
      ? Math.max(...allSteps.map(s => s.step_number))
      : state.total_steps;
    const currentStep = allSteps.find(s => s.step_number === state.current_step);
    const nextStep = allSteps.find(s => s.step_number === state.current_step + 1);
    const followingStep = nextStep || allSteps.find(s => s.step_number > state.current_step);
    const isLastStep = state.current_step >= lastStepNumber;

    if (!currentStep) {
      await updateStep(state.id, state.current_step, "completed");
      return { response: "¡Entendido! Si necesitas más ayuda, con gusto te orientamos.", metadata: { flow_type: "paso_a_paso" } };
    }

    // Resumen de todos los pasos + detalle completo solo del actual y el siguiente
    const stepsOverview = allSteps.map(s => `[${s.step_number}] ${s.step_summary}`).join("\n");
    const currentContent = currentStep.step_detail || currentStep.step_summary;
    const nextContent = followingStep ? (followingStep.step_detail || followingStep.step_summary) : null;

    if (isContinuationMessage(question) && followingStep) {
      const nextNumber = followingStep.step_number;
      const response = await presentStepWithLLM(nextContent, {
        isDetail: false,
        isLastStep: nextNumber >= lastStepNumber,
        question,
        history,
        orgName,
        countryCode,
        allSteps,
        currentStepNumber: nextNumber,
      });
      await updateStep(state.id, nextNumber, nextNumber >= lastStepNumber ? "completed" : "active");
      return {
        response,
        metadata: { flow_type: "paso_a_paso", step: nextNumber, deterministic_continuation: true },
      };
    }

    const systemContext = `Organización: ${orgName}. País: ${countryCode}.
Estás orientando al usuario en un proceso de ${state.total_steps} pasos por WhatsApp. Va en el paso ${state.current_step}.

RESUMEN DE TODOS LOS PASOS (para que conozcas el proceso completo):
${stepsOverview}

CONTENIDO DEL PASO ACTUAL (${state.current_step}) — fuente Excel:
${currentContent}

${nextContent ? `CONTENIDO DEL SIGUIENTE PASO (${followingStep.step_number}) — lo mostrarás solo si el usuario confirma:\n${nextContent}` : "ESTE ES EL ÚLTIMO PASO."}

LÓGICA DE RESPUESTA:
1. Si el usuario dice "sí", "si", "siguiente", "continúa", "continua", "luego", "luego qué hago", "dime más", "paso ${state.current_step + 1}" u otra señal de querer continuar → mostrar el Paso ${state.current_step + 1} (accion: "siguiente")
2. Si pide explícitamente ver TODOS los pasos ("dime todos los pasos", "mándame todo", "quiero ver todo el proceso", "dame el resumen completo") → mostrar todos con formato "Paso X de ${state.total_steps}" cada uno (accion: "todos")
3. Si tiene dudas o pide más detalle del paso actual → explicar sin avanzar (accion: "detalle")
4. Si pregunta algo completamente diferente o cambia de tema → cerrar flow (accion: "otro")
5. Si se despide o ya tiene todo claro → cerrar flow (accion: "finalizar")

Responde ÚNICAMENTE con JSON válido (sin texto fuera del JSON):
{"accion": "siguiente|todos|detalle|finalizar|otro", "respuesta": "..."}

REGLAS para el campo "respuesta":
- Al avanzar, SIEMPRE usar el formato: "Paso ${state.current_step + 1} de ${state.total_steps}:\n[explicación breve].\n\n¿Quieres que te diga el paso ${state.current_step + 2}?"
- Si accion es "todos", listar TODOS los pasos con "Paso X de ${state.total_steps}: [resumen breve]" y cerrar con "¿Tienes alguna duda sobre alguno de ellos?"
- Un solo paso por mensaje (salvo accion "todos")
- Reformular el contenido del Excel en lenguaje simple; no copiar literalmente
- No agregar información fuera del Excel
- NO preguntar "¿ya hiciste este paso?" ni pedir confirmación de ejecución
- No hagas preguntas cuya respuesta no cambie el contenido de los pasos siguientes. Si el flow tiene los mismos pasos independientemente de la respuesta del usuario, no preguntes por esa variable. Solo pregunta lo que realmente determina el siguiente paso según el contenido del flow
- ${isLastStep ? 'Último paso. Cerrar con: "Esos son los pasos principales. ¿Tienes alguna duda sobre alguno de ellos?"' : ''}
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
      usageDetails: anthropicUsageDetails(msg.usage),
      costDetails: anthropicCostDetails(msg.usage),
    });

    if (accion === "siguiente") {
      isLastStep
        ? await updateStep(state.id, state.current_step, "completed")
        : await updateStep(state.id, state.current_step + 1);
    } else if (accion === "todos") {
      // Usuario pidió todos los pasos explícitamente → marcar como completado
      await updateStep(state.id, state.total_steps, "completed");
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

// ── Respuesta puntual basada en un flow (informativa / seleccion) ──
// El LLM reformula la "Respuesta" del Excel de forma natural y empática,
// sin agregar datos que no estén en la fuente. Los flows "paso a paso" se
// manejan aparte en askAI (navegación guiada paso por paso).
async function presentFlowWithLLM(flow, question, history, orgName, countryCode) {
  return startActiveObservation("claude-flow-grounded-response", async (obs) => {
    obs.update({ input: { question, flow_type: flow.flow_type, flow_id: flow.flow_id } });

    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 260,
      temperature: 0,
      system: [
        {
          type: "text",
          text: `Eres un asistente de WhatsApp. Reescribe la respuesta fuente de forma natural y empatica para responder al usuario.

REGLAS ESTRICTAS:
- Usa unicamente la informacion de RESPUESTA FUENTE.
- No agregues instituciones, telefonos, numeros, correos, enlaces, ciudades, sedes, requisitos, beneficios ni canales que no aparezcan literalmente en RESPUESTA FUENTE.
- Si la fuente pide un dato al usuario, conserva esa pregunta.
- No digas "Excel", "base de datos", "base de conocimiento", "fuente", "respuesta fuente" ni "informacion disponible" al usuario.
- Maximo 4 lineas. Sin markdown, listas ni emojis.`,
        },
      ],
      messages: [
        {
          role: "user",
          content: `Pregunta del usuario:
${question}

RESPUESTA FUENTE:
${flow.answer}`,
        },
      ],
    });

    const rawResponse = msg.content[0]?.text || flow.answer;
    const guardrailBlocked = hasUnsupportedContactInfo(rawResponse, flow.answer);
    const resp = guardGroundedContactInfo(rawResponse, flow.answer, orgName);
    obs.update({
      output: resp,
      model: CLAUDE_MODEL,
      metadata: {
        flow_id: flow.flow_id,
        flow_type: flow.flow_type,
        flow_similarity: flow.similarity ?? null,
        guardrail_contact_blocked: guardrailBlocked,
        response_chars: textMetrics(resp).chars,
      },
      usageDetails: anthropicUsageDetails(msg.usage),
      costDetails: anthropicCostDetails(msg.usage),
    });
    return resp;
  }, { asType: "generation" });

}

async function presentLocationFollowup(flow, location, question, history, orgName, countryCode) {
  return startActiveObservation("claude-location-followup", async (obs) => {
    obs.update({ input: { flow_id: flow.flow_id, location, question } });

    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 220,
      temperature: 0,
      system: [
        {
          type: "text",
          text: `Eres un asistente de WhatsApp. El usuario respondió la ciudad o ubicación que se le pidió antes.

REGLAS ESTRICTAS:
- Responde usando únicamente RESPUESTA FUENTE y la ubicación que el usuario acaba de dar.
- Puedes reconocer la ubicación del usuario.
- No inventes instituciones, sedes, teléfonos, números, correos, enlaces ni servicios específicos si no aparecen literalmente en RESPUESTA FUENTE.
- No digas "Excel", "base de datos", "base de conocimiento", "fuente", "respuesta fuente" ni "informacion disponible" al usuario.
- Maximo 4 lineas. Sin markdown, listas ni emojis.`,
        },
      ],
      messages: [
        ...history,
        {
          role: "user",
          content: `Ubicacion indicada por el usuario: ${location}

Mensaje actual:
${question}

RESPUESTA FUENTE:
${flow.answer}`,
        },
      ],
    });

    const rawResponse = msg.content[0]?.text
      || `Gracias por decirme que estas en ${location}. Tu caso requiere atencion prioritaria. Es importante que puedas acercarte o contactar lo antes posible con servicios de apoyo en tu localidad para recibir orientacion, proteccion y acompanamiento.`;
    const resp = guardGroundedContactInfo(rawResponse, `${flow.answer}\n${location}`, orgName);

    obs.update({
      output: resp,
      model: CLAUDE_MODEL,
      metadata: {
        flow_id: flow.flow_id,
        location,
        response_chars: textMetrics(resp).chars,
      },
      usageDetails: anthropicUsageDetails(msg.usage),
      costDetails: anthropicCostDetails(msg.usage),
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
      usageDetails: anthropicUsageDetails(msg.usage),
      costDetails: anthropicCostDetails(msg.usage),
    });
    return resp;
  }, { asType: "generation" });
}

// ── Core RAG ──────────────────────────────────────────────────
async function askAI(userId, countryCode, question, options = {}) {
  const totalStart = Date.now();
  const orgName = COUNTRY_ORGS[countryCode] || `Aldeas Infantiles SOS (${countryCode})`;
  const inputStats = textMetrics(question);
  const traceMetrics = {
    metrics_version: "2026-06-04.1",
    app_environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || "production",
    channel: options.source || "api",
    wa_message_id: options.waMessageId || null,
    phone_number_id: options.phoneNumberId || null,
    country_code: countryCode,
    org_name: orgName,
    input_chars: inputStats.chars,
    input_words: inputStats.words,
    input_lines: inputStats.lines,
    model_generation: CLAUDE_MODEL,
    model_embedding: "text-embedding-3-small",
    cache_hit: 0,
    retrieval_found: 0,
    history_turns: 0,
    active_state_present: 0,
    active_flow_expired: 0,
    continuation_message: isContinuationMessage(question) ? 1 : 0,
    guardrail_final_unsupported_contact: 0,
  };

  // propagateAttributes adjunta userId/sessionId/traceName a todas las observations
  // del árbol OTel — sin necesidad de pasarlos manualmente a cada función.
  return propagateAttributes(
    {
      traceName: "rag-query",
      userId,
      sessionId: userId,   // agrupa todas las trazas del mismo número en Langfuse Sessions
      tags: [
        `country:${countryCode}`,
        `channel:${options.source || "api"}`,
        `env:${process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || "production"}`,
      ],
      metadata: {
        countryCode,
        orgName,
        channel: options.source || "api",
        app_environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || "production",
      },
    },
    () =>
      startActiveObservation("rag-query", async (rootObs) => {
        rootObs.update({ input: question });

        const finishTrace = (response, metadata = {}) => {
          const sanitizedResponse = sanitizeUserFacingResponse(response);
          const responseStats = textMetrics(sanitizedResponse);
          const finalMetadata = {
            ...traceMetrics,
            ...metadata,
            total_ms: Date.now() - totalStart,
            response_chars: responseStats.chars,
            response_words: responseStats.words,
            response_lines: responseStats.lines,
            response_empty: responseStats.chars === 0 ? 1 : 0,
          };

          rootObs.update({ output: sanitizedResponse, metadata: finalMetadata });
          return { response: sanitizedResponse, metadata: finalMetadata };
        };

        // 0. FLUJO ACTIVO — se evalúa primero.
        //    Si el mensaje es continuación clara → sigue el paso actual.
        //    Si es una pregunta nueva → retrieval para detectar intención nueva.
        //    precomputedFlow evita hacer doble llamada a embeddings si ya se buscó aquí.
        let precomputedFlow = null;

        const activeState = await getActiveState(userId, countryCode);
        if (activeState && !(activeState.flow_type === "paso a paso" || activeState.flow_type === "paso_a_paso")) {
          const elapsed = Date.now() - new Date(activeState.updated_at).getTime();
          Object.assign(traceMetrics, {
            active_state_present: 1,
            active_flow_id: activeState.flow_id,
            active_flow_type: activeState.flow_type,
            active_flow_step: activeState.current_step,
            active_flow_total_steps: activeState.total_steps,
            active_flow_age_ms: elapsed,
          });

          if (elapsed > ACTIVE_FLOW_TIMEOUT_MS) {
            console.log(`⏰ Flujo contextual expirado (>30 min): ${activeState.flow_id} — cancelando`);
            await updateStep(activeState.id, activeState.current_step, "cancelled");
            traceMetrics.active_flow_expired = 1;
          } else if (String(activeState.flow_type || "").startsWith("followup_location") && isLikelyLocationAnswer(question) && !SMALL_TALK_REGEX.test(question.trim())) {
            const flow = await getFlowById(countryCode, activeState.flow_id);
            if (flow) {
              const location = extractLocationAnswer(question);
              const history = await getRecentHistory(userId, countryCode, 10, question);
              traceMetrics.history_turns = history.length;
              Object.assign(traceMetrics, {
                retrieval_found: 1,
                flow_id: flow.flow_id,
                flow_type: flow.flow_type,
                normalized_flow_type: "followup_location",
                followup_location: location,
              });

              const response = await presentLocationFollowup(flow, location, question, history, orgName, countryCode);
              await updateStep(activeState.id, activeState.current_step, "completed");
              return finishTrace(response, {
                search_type: "flow_location_followup",
                route: "flow_location_followup",
                flow_id: flow.flow_id,
                followup_location: location,
              });
            }
          }
        }

        if (activeState && (activeState.flow_type === "paso a paso" || activeState.flow_type === "paso_a_paso")) {
          const elapsed = Date.now() - new Date(activeState.updated_at).getTime();
          Object.assign(traceMetrics, {
            active_state_present: 1,
            active_flow_id: activeState.flow_id,
            active_flow_type: activeState.flow_type,
            active_flow_step: activeState.current_step,
            active_flow_total_steps: activeState.total_steps,
            active_flow_age_ms: elapsed,
          });

          if (elapsed > ACTIVE_FLOW_TIMEOUT_MS) {
            // Flujo expirado → cancelar y procesar como mensaje nuevo
            console.log(`⏰ Flujo expirado (>30 min): ${activeState.flow_id} — cancelando`);
            await updateStep(activeState.id, activeState.current_step, "cancelled");
            traceMetrics.active_flow_expired = 1;

          } else if (SMALL_TALK_REGEX.test(question.trim())) {
            // Saludo a media conversación: NO cancelar ni reiniciar el flujo.
            // Devolvemos un saludo breve que mantiene el contexto del paso actual.
            console.log(`👋 Saludo dentro de flujo activo — sin cancelar: ${activeState.flow_id} paso ${activeState.current_step}`);
            const response = `¡Hola! Seguimos con tu consulta. ¿Quieres que continúe con el siguiente paso?`;
            return finishTrace(response, {
              search_type: "small_talk_in_flow",
              route: "active_flow_smalltalk",
              flow_id: activeState.flow_id,
              step: activeState.current_step,
            });

          } else if (isContinuationMessage(question)) {
            // Señal de continuación explícita → seguir el paso actual sin retrieval
            console.log(`▶️ Continuación del flujo: ${activeState.flow_id} paso ${activeState.current_step}/${activeState.total_steps}`);
            const result = await handlePasoAPaso(userId, countryCode, question, activeState);
            if (result) {
              return finishTrace(result.response, {
                ...result.metadata,
                search_type: "paso_a_paso",
                route: "active_step_continuation",
              });
            }
            // accion "otro" → continúa al flujo normal

          } else {
            // Mensaje más complejo → verificar si es una intención nueva
            console.log(`🔍 Mensaje complejo con flujo activo — verificando intención nueva`);
            const candidate = await searchFlow(countryCode, question);
            if (candidate) {
              Object.assign(traceMetrics, {
                active_flow_new_intent_candidate_found: 1,
                active_flow_new_intent_candidate_id: candidate.flow_id,
                active_flow_new_intent_similarity: candidate.similarity ?? null,
                active_flow_new_intent_similarity_bucket: similarityBucket(candidate.similarity),
              });
            } else {
              traceMetrics.active_flow_new_intent_candidate_found = 0;
            }

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
                return finishTrace(result.response, {
                  ...result.metadata,
                  search_type: "paso_a_paso",
                  route: "active_step_complex_message",
                });
              }
            }
          }
        }

        // 1. SMALL TALK — solo si NO hay flujo activo
        if (SMALL_TALK_REGEX.test(question.trim())) {
          const response = `¡Hola! Soy el asistente virtual de ${orgName}. ¿En qué puedo ayudarte hoy?`;
          return finishTrace(response, { search_type: "small_talk", route: "small_talk" });
        }

        // 3. CACHE (por usuario — la respuesta puede contener datos personales)
        const cached = getCached(countryCode, userId, question);
        if (cached) {
          traceMetrics.cache_hit = 1;
          return finishTrace(cached, { search_type: "cache", route: "cache" });
        }

        // Historial disponible para todos los paths a partir de aquí
        const history = await getRecentHistory(userId, countryCode, 10, question);
        traceMetrics.history_turns = history.length;

        // 3.5 MENSAJE VAGO — pedir clarificación antes de buscar
        if (VAGUE_REGEX.test(question.trim())) {
          const response = await generateClarification(question, history, orgName, countryCode);
          return finishTrace(response, { search_type: "clarification", route: "clarification" });
        }

        // 4. BUSCAR EN knowledge_flows (Excel)
        // Si ya se buscó en el paso 0 (cambio de intención detectado), reutilizar sin re-embeddings.
        const flow = precomputedFlow ?? await searchFlow(countryCode, question);

        if (flow) {
          console.log(`📋 Flow: ${flow.flow_id} [${flow.flow_type}] sim: ${flow.similarity?.toFixed(3)}`);
          const normalizedType = flow.flow_type?.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
          Object.assign(traceMetrics, {
            retrieval_found: 1,
            flow_id: flow.flow_id,
            flow_type: flow.flow_type,
            normalized_flow_type: normalizedType,
            flow_similarity: flow.similarity ?? null,
            flow_similarity_bucket: similarityBucket(flow.similarity),
            flow_question_chars: textMetrics(flow.question).chars,
            flow_answer_chars: textMetrics(flow.answer).chars,
          });

          if (normalizedType === "informativa" || normalizedType === "seleccion") {
            const response = await presentFlowWithLLM(flow, question, history, orgName, countryCode);
            const searchType = normalizedType === "informativa" ? "flow_informativa" : "flow_seleccion";
            traceMetrics.guardrail_final_unsupported_contact = hasUnsupportedContactInfo(response, flow.answer) ? 1 : 0;
            if (sourceRequestsLocation(flow.answer)) {
              // No cachear: la próxima pregunta debe entrar al follow-up de ubicación,
              // no devolver la respuesta previa que aún pedía la ciudad.
              await upsertState(userId, countryCode, flow.flow_id, `followup_location:${normalizedType}`, 0, 0);
              traceMetrics.awaiting_location_followup = 1;
            } else {
              setCached(countryCode, userId, question, response);
            }
            return finishTrace(response, {
              search_type: searchType,
              route: "flow_grounded_rewrite",
              flow_id: flow.flow_id,
              tipo_respuesta: normalizedType,
            });
          }

          if (normalizedType === "paso a paso" || normalizedType === "paso_a_paso") {
            const { data: steps } = await supabase
              .from("knowledge_steps")
              .select("step_number, step_summary")
              .eq("flow_id", flow.flow_id)
              .eq("country_code", countryCode)
              .order("step_number", { ascending: true });

            if (!steps || steps.length === 0) {
              return finishTrace(flow.answer, {
                search_type: "flow_paso_a_paso",
                route: "flow_step_without_steps",
                flow_id: flow.flow_id,
                total_steps: 0,
              });
            }

            await upsertState(userId, countryCode, flow.flow_id, "paso a paso", 1, steps.length);
            traceMetrics.total_steps = steps.length;
            const response = await presentStepWithLLM(steps[0].step_summary, {
              isDetail: false, isLastStep: steps.length === 1,
              question, history, orgName, countryCode,
              allSteps: steps, currentStepNumber: 1,
            });
            return finishTrace(response, {
              search_type: "flow_paso_a_paso",
              route: "flow_step_start",
              flow_id: flow.flow_id,
              total_steps: steps.length,
              step: 1,
            });
          }
        }

        // 5. FALLBACK - solo Excel: sin flow recuperado no se llama al LLM.
        // Esto evita que el modelo invente telefonos, correos, sedes o links.
        const noCtxResponse = `Gracias por contarme. En este momento no puedo orientarte con precision sobre eso por aqui. Te recomiendo comunicarte por los canales oficiales de ${orgName} para que puedan evaluar tu caso.`;

        return finishTrace(noCtxResponse, { search_type: "no_excel_match", route: "fallback_no_excel" });
      })
  );
}

module.exports = {
  askAI,
  saveConversationTurn,
  // Helpers puros expuestos para pruebas unitarias (sin efectos de red).
  hasUnsupportedContactInfo,
  sanitizeUserFacingResponse,
  isContinuationMessage,
};
