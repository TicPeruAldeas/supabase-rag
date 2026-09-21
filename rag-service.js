require("dotenv").config({ quiet: true });

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai").default;
const Anthropic = require("@anthropic-ai/sdk");
const { getCached, setCached } = require("./cache");
const { langDirective, strings, analysisSystem } = require("./lang");

// Mapa flow_id → URL de la fuente (generado del Excel por ingest-excel.js).
// Se cita la fuente solo la PRIMERA vez que se toca un tema; mientras el tema
// (misma URL) no cambie, no se repite el link. Si el archivo no existe aún,
// el bot funciona igual pero sin citar fuentes.
let SOURCE_LINKS = {};
try {
  SOURCE_LINKS = require("./source-links.json");
} catch {
  console.warn("ℹ️  source-links.json no encontrado — las respuestas no citarán fuente.");
}

function getSourceLink(flowId) {
  return (flowId && SOURCE_LINKS[flowId]) || null;
}

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
// Modelo del módulo de comprensión (clasificación + reescritura en contexto).
// Por defecto el mismo; se puede apuntar a uno más rápido/barato por env.
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || CLAUDE_MODEL;

const COUNTRY_ORGS = {
  PE: "Aldeas Infantiles SOS Perú",
  CO: "Aldeas Infantiles SOS Colombia",
  BR: "Aldeias Infantis SOS Brasil",
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
9. USO DEL HISTORIAL DE CONVERSACIÓN: Interpreta cada mensaje a la luz de la conversación y, en especial, de tu ÚLTIMA respuesta. Si el usuario dice "¿y eso?", "¿y qué tal sería?", "¿cuál me conviene?" o "¿cómo hago eso?", se refiere a lo que acabas de decirle: responde ese punto concreto sin repetir lo ya dicho. Si el usuario cambia de tema, atiende el tema nuevo sin arrastrar el anterior. Usa el historial también para recordar los datos que ya compartió (nombre, ciudad, situación familiar) y NO volver a pedírselos.

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
Una sola idea principal por mensaje. Terminar con UNA sola pregunta concreta, y solo cuando sea necesaria para continuar; nunca dos preguntas en el mismo mensaje. Evitar bloques de texto largos.

REGLA E — EL FLOW ES LA FUENTE DE VERDAD
La respuesta final debe estar basada en el campo "Respuesta" del flow recuperado. No usar conocimiento externo para completar información. No agregar recomendaciones legales, migratorias, médicas o institucionales que no estén en el flow.

REGLA F — CONTACTOS VERIFICABLES
Nunca menciones teléfonos, correos, URLs, direcciones, sedes, líneas gratuitas ni nombres de canales específicos si no aparecen literalmente en el flow recuperado. Si no hay un contacto concreto en el Excel, usa solo "canales oficiales" sin inventar datos.`;

// Solo saludos reales. Confirmaciones cortas (sí, ok, listo...) se eliminaron
// para que nunca disparen el saludo si hay contexto activo o reciente.
const SMALL_TALK_REGEX = /^(hola+s?|buenos\s+(d[ií]as|tardes|noches)|buenas?(\s+(d[ií]as|tardes|noches))?|buen\s+d[ií]a|ol[áa]+|oi+|e\s+a[ií]|bom\s+dia|boa\s+(tarde|noite)|hi+|hey+|😊)[\s!?,.:]*$/i;

// Señales de continuación dentro de un flow activo o contexto reciente.
// "Sí", "ok", "listo", "luego qué hago", etc. nunca deben activar saludo.
// El grupo final opcional admite cortesías/afirmaciones encadenadas como
// "sí por favor", "si porfavor", "ya dale", "claro continúa", "ok gracias".
const CONTINUATION_REGEX = /^(sí|si|listo|ok|okay|ya|correcto|entendido|quiero\s+continuar|continuar|continúa|continua|siguiente|el\s+siguiente|segundo\s+paso|el\s+segundo\s+paso|paso\s+\d+|adelante|claro|dale|de\s+acuerdo|por\s+supuesto|bien|perfecto|genial|luego|luego\s+(que|qué)\s+hago|dime\s+m[aá]s|sim|pr[oó]ximo(\s+passo)?|o\s+pr[oó]ximo|seguinte|o\s+seguinte|passo\s+\d+|avan[çc]ar|vamos|isso|certo|entendi|me\s+diz\s+mais|depois|manda|👍|✅|☑)(?:\s+(?:por\s*favor|porfa|claro|dale|gracias|adelante|continúa|continua|sí|si|obrigad[oa]|isso))?[.!,?\s]*$/i;

function isContinuationMessage(question) {
  return CONTINUATION_REGEX.test((question || "").trim());
}

// ── Navegación explícita dentro de un paso a paso ────────────
// "dame todos los pasos" / "mándame todo" → lista resumida y enumerada de
// TODOS los pasos (se arma en código, no en JSON del modelo, para que nunca
// se corte ni se filtre el JSON al usuario).
const ALL_STEPS_REGEX = /\b(?:todos?\s+(?:los\s+)?pasos|todos?\s+(?:os\s+)?passos|todos?\s+(?:los|os)\s+\d+\s+pasos|todo\s+el\s+proceso|todo\s+o\s+processo|proceso\s+completo|processo\s+completo|resumen\s+completo|resumo\s+completo|lista\s+completa|lista\s+de\s+(?:los\s+)?pasos|m[aá]ndame\s+todo|manda\s+tudo|env[ií]ame\s+todo|dame\s+todo|dime\s+todo|me\s+d[aá]\s+tudo|todos\s+(?:de\s+una|juntos|de\s+una\s+vez)|de\s+una\s+vez\s+todo)\b/i;

function isAllStepsRequest(question) {
  const q = stripAccents(String(question || "").trim());
  return ALL_STEPS_REGEX.test(q) || /^(?:todos|todo|tudo|todos\s+los\s+pasos)[.!?\s]*$/i.test(q);
}

// "paso 3", "más detalle del paso 5", "explícame el 7", "el tercero", "3" →
// número de paso pedido (1..total) o null si no pide un paso concreto.
const ORDINALS = {
  primer: 1, primero: 1, primeiro: 1, segundo: 2, tercer: 3, tercero: 3, terceiro: 3,
  cuarto: 4, quarto: 4, quinto: 5, sexto: 6, septimo: 7, setimo: 7, octavo: 8, oitavo: 8, noveno: 9, nono: 9, decimo: 10,
};
const STEP_NUMBER_REGEX = /\b(?:paso|passo|n[uú]mero|numero|nro\.?|n[°º])\s*(\d{1,2})\b/i;
const STEP_ORDINAL_REGEX = /\b(?:el|o|del|do|al|ao)\s+(primer|primero|primeiro|segundo|tercer|tercero|terceiro|cuarto|quarto|quinto|sexto|septimo|setimo|octavo|oitavo|noveno|nono|decimo)(?:\s+paso|\s+passo)?\b/i;
const BARE_NUMBER_REGEX = /^(?:el|o|la|a|del|do)?\s*(\d{1,2})\s*[.!?]*$/i;
const LAST_STEP_REGEX = /\b(?:[uú]ltimo|ultimo|final)\s+(?:paso|passo)\b|\bel\s+[uú]ltimo\b|\bo\s+[uú]ltimo\b/i;

function parseRequestedStep(question, totalSteps) {
  const q = stripAccents(String(question || "").trim());
  const total = Number(totalSteps) || 0;
  let n = null;
  const m1 = q.match(STEP_NUMBER_REGEX);
  const m2 = q.match(BARE_NUMBER_REGEX);
  const m3 = q.match(STEP_ORDINAL_REGEX);
  if (m1) n = parseInt(m1[1], 10);
  else if (m2) n = parseInt(m2[1], 10);
  else if (m3) n = ORDINALS[m3[1].toLowerCase()] ?? null;
  else if (total && LAST_STEP_REGEX.test(q)) n = total;
  if (!n || n < 1) return null;
  if (total && n > total) return null;
  return n;
}

// El manejador de mensajes complejos pide al modelo un JSON {accion, respuesta}.
// Si el JSON llega cortado o malformado, rescatamos el texto de "respuesta"
// para no enviar nunca JSON crudo al usuario.
function salvageStepJson(raw) {
  const text = String(raw || "").trim();
  if (!text) return { accion: "detalle", respuesta: "" };
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        accion: String(parsed.accion ?? "detalle").toLowerCase().trim(),
        respuesta: String(parsed.respuesta ?? "").trim(),
      };
    }
  } catch {
    // sigue al rescate manual
  }
  if (!text.startsWith("{")) return { accion: "detalle", respuesta: text };
  const accionMatch = text.match(/"accion"\s*:\s*"([^"]*)"/i);
  const respMatch = text.match(/"respuesta"\s*:\s*"([\s\S]*)$/i);
  let respuesta = respMatch ? respMatch[1] : "";
  respuesta = respuesta
    .replace(/"\s*\}?\s*$/, "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .trim();
  return { accion: (accionMatch?.[1] || "detalle").toLowerCase().trim(), respuesta, salvaged: true };
}

// Mensajes de cierre / agradecimiento ("gracias", "listo muchas gracias",
// "chau", "todo claro"...). Reciben una despedida cálida en vez del fallback
// frío de "no tengo información". En un flujo activo se evalúa DESPUÉS de la
// continuación, para que "listo"/"ok"/"sí" sigan avanzando el paso.
const CLOSING_REGEX = /^(?:(?:muchas|mil|ok|okay|listo|perfecto|bien|excelente|genial|muito)[\s,]+)*(?:gracias|graci[ai]s|obrigad[oa])(?:\s+(?:por\s+(?:tu|la|su|todo|a)\s+\w+|de\s+nuevo|igualmente|mesmo))?[\s!.,]*$|^(?:listo|ok|okay|eso\s+es\s+todo|es\s+todo|ya\s+est[áa]|chau|cha[ií]to|adi[oó]s|hasta\s+(?:luego|pronto|la\s+pr[oó]xima)|nos\s+vemos|bye|todo\s+claro|todo\s+bien|valeu|tchau|at[ée]\s+(?:logo|mais|breve|a\s+pr[oó]xima)|[ée]\s+isso|tudo\s+(?:certo|bem|claro))[\s!.,]*$/i;

function isClosingMessage(question) {
  return CLOSING_REGEX.test((question || "").trim());
}

// Rechazo / declinación explícita ("no", "no gracias", "no quiero continuar",
// "así está bien", "ya no", "suficiente"...). Dentro de un flujo paso a paso el
// usuario pide DETENER, no avanzar. Se evalúa ANTES que la continuación para que
// "no gracias" nunca haga avanzar de paso.
const DECLINE_REGEX = /^(?:no|no,?\s+gracias|no\s+quiero(?:\s+(?:continuar|seguir|m[aá]s|nada))?|ya\s+no(?:\s+quiero)?|no\s+por\s+ahora|as[ií]\s+est[aá]\s+bien|est[aá]\s+bien\s+as[ií]|no\s+contin[uú]es?|no\s+sigas|suficiente|es\s+suficiente|ya\s+es\s+suficiente|n[ãa]o|n[ãa]o,?\s+obrigad[oa]|n[ãa]o\s+quero(?:\s+(?:continuar|seguir|mais|nada))?|agora\s+n[ãa]o|assim\s+est[áa]\s+bom|j[áa]\s+chega|chega|[ée]\s+suficiente|n[ãa]o\s+continue|n[ãa]o\s+precisa)[\s!.,]*$/i;

function isDeclineMessage(question) {
  return DECLINE_REGEX.test((question || "").trim());
}

const CONTACT_TOKEN_REGEX = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|https?:\/\/\S+|www\.\S+|\b(?:\+?\d[\d\s().-]{6,}\d)\b)/gi;
const SHORT_NUMBER_REGEX = /\b\d{2,6}\b/g;
const INSTITUTION_KEYWORD_REGEX = /\b(polic[ií]a|pol[íi]cia|municipalidad|comisar[ií]a|serenazgo|demuna|defensor[ií]a|ministerio|minist[ée]rio|hospital|centro de salud|l[ií]nea gratuita|delegacia|conselho\s+tutelar|prefeitura|defensoria\s+p[úu]blica|posto\s+de\s+sa[úu]de|disque\s+\d+|cras|creas)\b/i;

function normalizeContactToken(value) {
  return String(value || "").toLowerCase().replace(/[\s().-]+/g, "");
}

// URLs: se comparan sin protocolo, sin "www." inicial y sin la puntuación final
// que arrastra \S+ (p. ej. "www.sitio.org." al cerrar una frase). Antes esas
// diferencias de formato hacían que respuestas correctas cayeran al fallback.
const TRAILING_PUNCT_REGEX = /[.,;:!?)\]]+$/;
function normalizeUrl(value) {
  return String(value || "").toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "")
    .replace(TRAILING_PUNCT_REGEX, "").replace(/\/+$/, "");
}
function normalizeUrlsInSource(sourceText) {
  return String(sourceText || "").toLowerCase().replace(/https?:\/\//g, "").replace(/\bwww\./g, "");
}

// Devuelve el PRIMER dato de contacto de la respuesta que NO está en la fuente
// ({ kind, token }) o null. Es la base del guardrail; el token permite saber
// qué disparó el bloqueo (trazas y logs) en vez de un simple true/false.
function findUnsupportedContact(response, sourceText) {
  const text = String(response || "");
  const source = String(sourceText || "").toLowerCase();
  const normalizedSource = normalizeContactToken(sourceText);
  const urlSource = normalizeUrlsInSource(sourceText);

  for (const token of text.match(CONTACT_TOKEN_REGEX) || []) {
    const lower = token.toLowerCase();
    if (lower.includes("@")) {
      if (!source.includes(lower.replace(TRAILING_PUNCT_REGEX, ""))) return { kind: "email", token };
    } else if (lower.startsWith("http") || lower.startsWith("www.")) {
      if (!urlSource.includes(normalizeUrl(lower))) return { kind: "url", token };
    } else if (!normalizedSource.includes(normalizeContactToken(token))) {
      return { kind: "phone", token };
    }
  }
  for (const token of text.match(SHORT_NUMBER_REGEX) || []) {
    if (!source.includes(token.toLowerCase())) return { kind: "number", token };
  }
  if (INSTITUTION_KEYWORD_REGEX.test(text) && !INSTITUTION_KEYWORD_REGEX.test(String(sourceText || ""))) {
    return { kind: "institution", token: (text.match(INSTITUTION_KEYWORD_REGEX) || [""])[0] };
  }
  return null;
}

function hasUnsupportedContactInfo(response, sourceText) {
  return findUnsupportedContact(response, sourceText) !== null;
}

// Corta un texto largo en el final de frase más cercano al límite.
function truncateAtSentence(text, maxChars) {
  const value = String(text || "").trim();
  if (value.length <= maxChars) return value;
  const cut = value.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > maxChars * 0.5 ? cut.slice(0, end + 1).trim() : `${cut.trim()}…`;
}

// Fallback seguro cuando el guardrail bloquea. NO se vuelca la fuente completa:
// con la columna "Datos" fusionada eso era un muro de texto que terminaba con la
// etiqueta interna "DATOS DE CONTACTO:". Se entrega el inicio de la información
// principal (cortado en una frase) y los datos de contacto tal cual la fuente.
function guardGroundedContactInfo(response, sourceText, orgName, countryCode, offender = null) {
  const found = offender || findUnsupportedContact(response, sourceText);
  if (!found) return response;
  console.warn(`⚠️ Respuesta con contacto no presente en Excel (${found.kind}: "${found.token}"); usando fallback seguro.`);
  const { respuesta, datos } = splitDatos(sourceText);
  const brief = truncateAtSentence(respuesta, 600);
  return [brief, datos ? `Datos de contacto: ${datos}` : ""].filter(Boolean).join("\n\n").trim()
    || strings(countryCode).contactFallback(orgName);
}

function sanitizeUserFacingResponse(response) {
  return String(response || "")
    .replace(/\s+(en|dentro de)\s+(el\s+)?Excel\b/gi, "")
    .replace(/\b(seg[uú]n|de acuerdo con)\s+(la\s+)?informaci[oó]n disponible[,:\s]*/gi, "")
    .replace(/\b(en|desde|dentro de)\s+(la\s+)?base de (conocimiento|datos)\b/gi, "")
    .replace(/\b(la\s+)?respuesta fuente\b/gi, "la orientacion")
    .replace(/\bfuente\s+(recuperada|consultada)\b/gi, "orientacion")
    // Variantes en portugués (BR)
    .replace(/\s+(n[ao]|dentro d[ao])\s+(a\s+)?(planilha|Excel)\b/gi, "")
    .replace(/\b(de acordo com|segundo)\s+(a\s+)?informa[çc][ãa]o dispon[íi]vel[,:\s]*/gi, "")
    .replace(/\b(n[ao]|dentro d[ao])\s+(a\s+)?base de (conhecimento|dados)\b/gi, "")
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

const FLOW_MATCH_COUNT = envNumber("FLOW_MATCH_COUNT", 5);
const FLOW_MIN_SIMILARITY = envNumber("FLOW_MIN_SIMILARITY", 0.35);
const FLOW_RERANK_HIGH_CONFIDENCE = envNumber("FLOW_RERANK_HIGH_CONFIDENCE", 0.72);

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
const VAGUE_REGEX = /^(necesito(\s+(ayuda|apoyo|orientaci[oó]n|informaci[oó]n))?|tengo(\s+un)?\s+(problema|duda|consulta|pregunta)|me\s+(pueden?|podr[ií]a[ns]?)\s*ayudar|b[úu]sco\s+(ayuda|apoyo|informaci[oó]n|orientaci[oó]n)|ayuda(\s+por\s+favor)?|ay[úu]dame|orientaci[oó]n|quiero\s+(informaci[oó]n|saber|ayuda)|preciso(\s+de\s+(ajuda|apoio|orienta[çc][ãa]o|informa[çc][ãa]o))?|tenho\s+(um\s+problema|uma\s+d[úu]vida|uma\s+pergunta)|pode[mn]?\s+me\s+ajudar|busco\s+(ajuda|apoio|informa[çc][ãa]o|orienta[çc][ãa]o)|me\s+ajuda|ajuda|orienta[çc][ãa]o|quero\s+(informa[çc][ãa]o|saber|ajuda))[.!,?]*\s*$/i;

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

// ── Última fuente citada ──────────────────────────────────────
// Devuelve la URL de fuente del último turno del asistente que la tuviera.
// Sirve para NO repetir el link mientras el usuario siga en el mismo tema
// (misma URL). Se salta turnos sin fuente (saludos, cierres, clarificaciones)
// para que un "gracias" intercalado no reinicie la cita.
async function getLastCitedSource(userId, countryCode) {
  const { data, error } = await supabase
    .from("conversations")
    .select("metadata")
    .eq("user_id", userId)
    .eq("country_code", countryCode)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(15);
  if (error) {
    console.error(`⚠️  getLastCitedSource [${userId}/${countryCode}]:`, error.message);
    return null;
  }
  for (const row of data || []) {
    const url = row.metadata?.source_url;
    if (url) return url;
  }
  return null;
}

// ── Último tema tratado ───────────────────────────────────────
// Devuelve el flow_id del último turno del asistente que respondió desde un
// flow del Excel. Permite atender preguntas de seguimiento ("¿y qué tal
// sería?", "¿y eso cuánto demora?") desde el MISMO contenido, aunque la
// búsqueda semántica no lo recupere por sí sola. Se salta turnos sin flow
// (saludos, cierres, clarificaciones) igual que getLastCitedSource.
async function getLastFlowId(userId, countryCode) {
  const { data, error } = await supabase
    .from("conversations")
    .select("metadata")
    .eq("user_id", userId)
    .eq("country_code", countryCode)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(15);
  if (error) {
    console.error(`⚠️  getLastFlowId [${userId}/${countryCode}]:`, error.message);
    return null;
  }
  for (const row of data || []) {
    const flowId = row.metadata?.flow_id;
    if (flowId) return flowId;
  }
  return null;
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
async function searchFlow(countryCode, question, opts = {}) {
  return startActiveObservation("search-flows", async (obs) => {
    obs.update({ input: question });
    const queryEmbedding = await embedText(question);

    const candidates = await startActiveObservation("supabase-match-flows", async (dbObs) => {
      dbObs.update({ input: { country: countryCode, matchCount: FLOW_MATCH_COUNT, minSimilarity: FLOW_MIN_SIMILARITY } });
      const { data, error } = await supabase.rpc("match_flows_by_country", {
        query_embedding: queryEmbedding,
        filter_country: countryCode,
        match_count: FLOW_MATCH_COUNT,
        min_similarity: FLOW_MIN_SIMILARITY,
      });
      if (error) {
        dbObs.update({ output: { error: error.message } });
        throw error;
      }
      const results = data || [];
      dbObs.update({
        output: {
          count: results.length,
          candidates: results.map(item => ({
            flow_id: item.flow_id,
            flow_type: item.flow_type,
            similarity: item.similarity,
          })),
        },
      });
      return results;
    });

    const result = await chooseBestFlowCandidate(countryCode, question, candidates, opts);

    obs.update({
      output: {
        selected: result
          ? {
            flow_id: result.flow_id,
            flow_type: result.flow_type,
            similarity: result.similarity,
            reranked: !!result.reranked,
          }
          : null,
        candidate_count: candidates.length,
      },
    });
    return result;
  });
}

function truncateForRerank(text, maxChars = 900) {
  const value = String(text || "").trim();
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

async function chooseBestFlowCandidate(countryCode, question, candidates, opts = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const top = candidates[0];
  if (candidates.length === 1 || (top.similarity ?? 0) >= FLOW_RERANK_HIGH_CONFIDENCE) {
    return top;
  }

  return startActiveObservation("claude-flow-reranker", async (obs) => {
    obs.update({
      input: {
        country: countryCode,
        question,
        highConfidence: FLOW_RERANK_HIGH_CONFIDENCE,
        candidates: candidates.map(item => ({
          flow_id: item.flow_id,
          similarity: item.similarity,
          flow_type: item.flow_type,
        })),
      },
    });

    const candidateText = candidates.map((item, index) => `
CANDIDATO ${index + 1}
flow_id: ${item.flow_id}
similarity: ${item.similarity}
tipo: ${item.flow_type}
categoria: ${item.category ?? ""}
subtema: ${item.subtopic ?? ""}
pregunta: ${truncateForRerank(item.question, 500)}
respuesta: ${truncateForRerank(splitDatos(item.answer).respuesta, 700)}
datos_de_contacto: ${truncateForRerank(splitDatos(item.answer).datos, 300) || "(ninguno)"}
`.trim()).join("\n\n");

    // Si el usuario pide un dato de contacto, lo que importa es qué candidato
    // TIENE ese dato en su sección de Datos, aunque su pregunta sea de otro trámite.
    const contactHint = opts.contactRequest
      ? `\nEl usuario pide un DATO DE CONTACTO (telefono, sede, direccion, correo, horario, web). Elige el candidato cuyo campo datos_de_contacto contenga la institucion o el servicio que pide, aunque su "pregunta" trate de otro tramite. Solo responde null si ningun candidato tiene ese dato.`
      : "";

    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 120,
      temperature: 0,
      system: `Eres un reranker estricto para un RAG. Debes elegir el candidato que mejor responde la intencion real del usuario.
Cada candidato trae su "respuesta" (informacion principal) y sus "datos_de_contacto" (telefonos, sedes, direcciones, correos, horarios, webs).
Responde SOLO JSON valido: {"flow_id":"...", "confidence":0.0}
Si ningun candidato responde la intencion, usa {"flow_id":null, "confidence":0.0}.
No elijas por coincidencias superficiales de palabras; prioriza significado, categoria, subtema, respuesta y datos_de_contacto.${contactHint}`,
      messages: [
        {
          role: "user",
          content: `Pais: ${countryCode}
Pregunta del usuario:
${question}

Candidatos:
${candidateText}`,
        },
      ],
    });

    const raw = (msg.content[0]?.text ?? "").trim();
    let selected = null;
    let rejectedAll = false;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = match ? JSON.parse(match[0]) : null;
      rejectedAll = parsed?.flow_id === null;
      selected = candidates.find(item => item.flow_id === parsed?.flow_id) || null;
      if (selected) selected = { ...selected, reranked: true, rerank_confidence: parsed.confidence ?? null };
    } catch (err) {
      console.warn("Reranker: respuesta invalida:", raw.substring(0, 120));
    }

    const result = rejectedAll ? null : (selected || top);
    obs.update({
      output: {
        selected_flow_id: result?.flow_id ?? null,
        selected_similarity: result?.similarity ?? null,
        fallback_to_top: !selected && !rejectedAll,
        rejected_all: rejectedAll,
      },
      model: CLAUDE_MODEL,
      usageDetails: anthropicUsageDetails(msg.usage),
      costDetails: anthropicCostDetails(msg.usage),
    });

    return result;
  }, { asType: "generation" });
}

// Columna "Datos" (contactos complementarios): viaja dentro de `answer` bajo una
// sección etiquetada; ver datos-text.js.
const { splitDatos, DATOS_HEADER } = require("./datos-text");

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

// ── Consultas de contacto (columna "Datos") ───────────────────
// El usuario pide EXPLÍCITAMENTE un teléfono, sede, dirección, correo, horario,
// web o contacto. Estas consultas se atienden desde la sección de Datos del flow
// (reescritura fundamentada), sin iniciar un "paso a paso": pidió un dato, no un
// proceso. Solo señales fuertes, para no desviar preguntas normales.
// El patrón va SIN tildes y el texto se compara sin acentos (NFD + quitar marcas
// combinantes, como hace la normalización de flow_type). Así da igual que la
// tilde llegue precompuesta ("é") o descompuesta ("e" + acento), o que el
// usuario no la escriba: "teléfono", "telefono" y "teléfono" coinciden.
const CONTACT_REQUEST_REGEX = /\b(telefono(?:s)?|numero(?:s)?|celular|whatsapp|central\s+telefonica|correo(?:s)?(?:\s+electronico(?:s)?)?|e-?mail|direccion(?:es)?|sede(?:s)?|oficina(?:s)?|horario(?:s)?|donde\s+(?:queda|quedan|esta|estan|atienden|puedo\s+(?:ir|acudir|acercarme))|pagina\s+web|sitio\s+web|enlace|link|contacto(?:s)?|contactar(?:me|los|se)?|comunicar(?:me|se|nos|te|le|les)?|quien\s+(?:llamo|llamar|contacto|contactar)|llamar\s+(?:a|al)|marcar)\b/i;

function stripAccents(text) {
  return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function isContactRequest(text) {
  return CONTACT_REQUEST_REGEX.test(stripAccents(text));
}

// Palabras de la consulta que identifican la institución/servicio pedido (se
// descartan conectores y las propias palabras de "contacto"). Más largas primero.
const CONTACT_STOPWORDS = new Set(("cual cuál cuales cuáles como cómo donde dónde cuando cuándo que qué quien quién quiénes para por con sin " +
  "del los las una uno unos unas este esta esto estos estas ese esa eso hay tiene tienen puedo pueden quiero necesito saber " +
  "dame dime pasa pasame pásame hola buenas buenos dias días tardes noches gracias favor porfa cuanto cuánto cuanta cuánta " +
  "telefono teléfono telefonos teléfonos numero número numeros números celular whatsapp central correo correos email direccion " +
  "dirección direcciones sede sedes oficina oficinas horario horarios pagina página sitio web enlace link contacto contactos " +
  "contactar comunicarme comunicar llamar llamo marcar atienden queda quedan esta está están estan tengo tienes ellos ellas " +
  "puede quisiera podria podría podrian podrían ayuda ayudar informacion información").split(/\s+/));

function contactSearchTokens(text) {
  // NFC: la BD guarda las tildes precompuestas; un token descompuesto no haría match en ilike.
  const words = String(text || "").normalize("NFC").toLowerCase().replace(/[^\p{L}\s]/gu, " ").split(/\s+/);
  return [...new Set(words.filter(w => w.length >= 4 && !CONTACT_STOPWORDS.has(w)))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 4);
}

// Búsqueda por palabra clave DENTRO de la sección de Datos ("buscar principalmente
// en la columna Datos"). Se usa cuando el usuario pide un contacto y el embedding
// no encontró flow. El patrón `%DATOS DE CONTACTO:%token%` exige que el token
// aparezca DESPUÉS del encabezado, es decir, en los Datos y no en la Respuesta.
async function findFlowByDatosKeyword(countryCode, text) {
  for (const token of contactSearchTokens(text)) {
    const { data, error } = await supabase
      .from("knowledge_flows")
      .select("flow_id, country_code, flow_type, question, answer")
      .eq("country_code", countryCode)
      .ilike("answer", `%${DATOS_HEADER}%${token}%`)
      .limit(1);
    if (error) {
      console.error(`⚠️  findFlowByDatosKeyword [${countryCode}/${token}]:`, error.message);
      return null;
    }
    if (data && data.length > 0) return { ...data[0], similarity: null, datos_keyword: token };
  }
  return null;
}

// Presentar un paso con LLM.
// Presentacion inicial: lista pasos breves y desarrolla solo el paso actual.
// Presentaciones siguientes o detalle: indicar "Paso N:" explicitamente.
async function presentStepWithLLM(stepContent, { isDetail, isLastStep, question, history, orgName, countryCode, allSteps, currentStepNumber, datos }) {
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

    // Datos de contacto del flow (columna "Datos"): complementarios a los pasos.
    // El modelo solo los entrega si el usuario los pide o si son útiles para el
    // paso; y el guardrail debe reconocerlos como fuente legítima (si no, un
    // teléfono real que no esté en el texto del paso quedaría bloqueado).
    const datosText = String(datos || "").trim();
    if (datosText) {
      systemText += `\n\nDATOS DE CONTACTO del proceso (complementarios; entrégalos EXACTOS solo si el usuario pide un teléfono, sede, dirección, correo o contacto, o si son claramente útiles para este paso; nunca los inventes ni modifiques):\n${datosText}`;
    }
    const guardSource = datosText ? `${stepContent}\n${datosText}` : stepContent;

    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: isInitialPresentation ? 400 : 250,
      system: [
        { type: "text", text: STATIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: systemText + langDirective(countryCode) },
      ],
      messages: [...history, { role: "user", content: userTask }],
    });

    const rawResponse = msg.content[0]?.text || stepContent;
    const guardrailBlocked = hasUnsupportedContactInfo(rawResponse, guardSource);
    const resp = guardGroundedContactInfo(rawResponse, guardSource, orgName, countryCode);
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

// ── Lista resumida de TODOS los pasos ─────────────────────────
// Fallback sin LLM: primera frase de cada resumen, enumerada.
function firstSentence(text, max = 110) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^(.{15,}?[.!?])(\s|$)/);
  let s = m ? m[1] : t;
  if (s.length > max) s = s.slice(0, max - 1).replace(/[\s,;:]+\S*$/, "") + "…";
  return s;
}

function formatAllStepsFallback(allSteps, countryCode) {
  const steps = (allSteps || []).map(s => ({
    number: s.number ?? s.step_number,
    summary: s.summary ?? s.step_summary,
  }));
  const lines = steps.map(s => `${s.number}. ${firstSentence(s.summary)}`);
  const t = strings(countryCode);
  return `${t.allStepsIntro(steps.length)}\n\n${lines.join("\n")}\n\n${t.allStepsOutro()}`;
}

// El modelo condensa cada paso a UNA línea corta (numerada, en orden). Si la
// salida no trae todos los números o falla, se usa el fallback determinista.
async function presentAllStepsWithLLM(allSteps, { orgName, countryCode, datos }) {
  const steps = (allSteps || []).map(s => ({
    number: s.number ?? s.step_number,
    summary: s.summary ?? s.step_summary,
  }));
  const fallback = formatAllStepsFallback(steps, countryCode);
  if (!steps.length) return fallback;

  return startActiveObservation("claude-all-steps-summary", async (obs) => {
    obs.update({ input: { total: steps.length } });
    const source = steps.map(s => `[${s.number}] ${s.summary}`).join("\n");
    const t = strings(countryCode);
    const systemText = `Organización: ${orgName}. País: ${countryCode}.
El usuario pidió ver TODOS los pasos del proceso de una vez. Entrega una lista enumerada, ordenada y RESUMIDA.

PASOS (fuente Excel):
${source}

FORMATO EXACTO (sin markdown, sin negritas, sin viñetas):
${t.allStepsIntro(steps.length)}

1. [una sola línea, máximo 15 palabras]
2. [una sola línea, máximo 15 palabras]
... hasta el ${steps.length}.

${t.allStepsOutro()}

REGLAS:
- Exactamente ${steps.length} líneas numeradas, en el mismo orden, sin omitir ninguna
- Cada línea resume la acción principal del paso en lenguaje simple; no copies literalmente
- No agregues información fuera de la fuente ni teléfonos, direcciones o correos
- No expliques ni desarrolles ningún paso: el detalle se da después si el usuario lo pide`;

    try {
      const msg = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 900,
        system: [
          { type: "text", text: STATIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          { type: "text", text: systemText + langDirective(countryCode) },
        ],
        messages: [{ role: "user", content: "Dame todos los pasos resumidos." }],
      });
      const raw = (msg.content[0]?.text ?? "").trim();
      const numbered = steps.every(s => new RegExp(`(^|\\n)\\s*${s.number}[.)]\\s`).test(raw));
      const truncated = msg.stop_reason === "max_tokens";
      const guardSource = source + "\n" + String(datos || "");
      const invented = hasUnsupportedContactInfo(raw, guardSource);
      const ok = raw && numbered && !truncated && !invented;
      obs.update({
        output: ok ? raw : fallback,
        model: CLAUDE_MODEL,
        metadata: { used_fallback: !ok, numbered, truncated, invented },
        usageDetails: anthropicUsageDetails(msg.usage),
        costDetails: anthropicCostDetails(msg.usage),
      });
      return ok ? raw : fallback;
    } catch (err) {
      console.error("❌ presentAllStepsWithLLM:", err.message);
      obs.update({ output: fallback, metadata: { used_fallback: true, error: err.message } });
      return fallback;
    }
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
    const [history, stepsResult, flowRow] = await Promise.all([
      getRecentHistory(userId, countryCode, 10, question),
      supabase
        .from("knowledge_steps")
        .select("step_number, step_summary, step_detail")
        .eq("flow_id", state.flow_id)
        .eq("country_code", countryCode)
        .order("step_number", { ascending: true }),
      getFlowById(countryCode, state.flow_id),
    ]);
    // Datos de contacto del flow (columna "Datos"), complementarios a los pasos.
    const datos = splitDatos(flowRow?.answer).datos;

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
      return { response: strings(countryCode).stepDone(), metadata: { flow_type: "paso_a_paso" } };
    }

    // Resumen de todos los pasos + detalle completo solo del actual y el siguiente
    const stepsOverview = allSteps.map(s => `[${s.step_number}] ${s.step_summary}`).join("\n");
    const currentContent = currentStep.step_detail || currentStep.step_summary;
    const nextContent = followingStep ? (followingStep.step_detail || followingStep.step_summary) : null;

    // Navegación explícita: "todos los pasos" → lista resumida (el flujo sigue
    // activo para que pueda pedir el detalle de uno); "paso N" → ese paso.
    if (isAllStepsRequest(question)) {
      const response = await presentAllStepsWithLLM(allSteps, { orgName, countryCode, datos });
      await updateStep(state.id, state.current_step, "active");
      return {
        response,
        metadata: { flow_type: "paso_a_paso", step: state.current_step, all_steps_overview: true },
      };
    }

    const requestedStep = parseRequestedStep(question, lastStepNumber);
    const requestedRow = requestedStep ? allSteps.find(s => s.step_number === requestedStep) : null;
    if (requestedRow) {
      const response = await presentStepWithLLM(requestedRow.step_detail || requestedRow.step_summary, {
        isDetail: false,
        isLastStep: requestedStep >= lastStepNumber,
        question,
        history,
        orgName,
        countryCode,
        allSteps,
        currentStepNumber: requestedStep,
        datos,
      });
      await updateStep(state.id, requestedStep, "active");
      return {
        response,
        metadata: { flow_type: "paso_a_paso", step: requestedStep, requested_step: requestedStep },
      };
    }

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
        datos,
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

${datos ? `DATOS DE CONTACTO del proceso (complementarios; entrégalos EXACTOS solo si el usuario pide un teléfono, sede, dirección, correo o contacto, o si son claramente útiles para el paso; nunca los inventes ni modifiques):\n${datos}\n\n` : ""}LÓGICA DE RESPUESTA:
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
- Si el usuario pide un teléfono, sede, dirección, correo o contacto (o si es claramente útil para el paso), entrégalo EXACTO desde DATOS DE CONTACTO; nunca inventes ni modifiques esos datos
- NO preguntar "¿ya hiciste este paso?" ni pedir confirmación de ejecución
- No hagas preguntas cuya respuesta no cambie el contenido de los pasos siguientes. Si el flow tiene los mismos pasos independientemente de la respuesta del usuario, no preguntes por esa variable. Solo pregunta lo que realmente determina el siguiente paso según el contenido del flow
- ${isLastStep ? 'Último paso. Cerrar con: "Esos son los pasos principales. ¿Tienes alguna duda sobre alguno de ellos?"' : ''}
- Tono empático y cercano para WhatsApp`;

    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 600,
      system: [
        { type: "text", text: STATIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: systemContext + langDirective(countryCode) },
      ],
      messages: [...history, { role: "user", content: question }],
    });

    const raw = (msg.content[0]?.text ?? "").trim();
    let { accion, respuesta, salvaged } = salvageStepJson(raw);
    if (salvaged) console.warn(`⚠️ JSON paso-a-paso cortado/malformado (stop=${msg.stop_reason}) — texto rescatado`);

    // "todos" decidido por el modelo → lista resumida generada en código (nunca
    // el JSON del modelo, que con muchos pasos se corta).
    if (accion === "todos") {
      const overview = await presentAllStepsWithLLM(allSteps, { orgName, countryCode, datos });
      await updateStep(state.id, state.current_step, "active");
      return {
        response: overview,
        metadata: { flow_type: "paso_a_paso", step: state.current_step, all_steps_overview: true },
      };
    }
    if (!respuesta || respuesta.startsWith("{")) {
      // Sin texto utilizable → explicar el paso actual sin avanzar
      respuesta = await presentStepWithLLM(currentContent, {
        isDetail: true, isLastStep, question, history, orgName, countryCode, allSteps,
        currentStepNumber: state.current_step, datos,
      });
      accion = "detalle";
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
// context.standaloneQuery: la pregunta interpretada en contexto por el módulo
// de comprensión (si difiere del texto literal). context.isFollowup: el
// mensaje es un seguimiento de la última respuesta del asistente.
async function presentFlowWithLLM(flow, question, history, orgName, countryCode, context = {}) {
  const { standaloneQuery = null, isFollowup = false, contactRequest = false } = context;

  return startActiveObservation("claude-flow-grounded-response", async (obs) => {
    obs.update({ input: { question, standaloneQuery, isFollowup, flow_type: flow.flow_type, flow_id: flow.flow_id } });

    const interpretation = standaloneQuery && normalizeMessageText(standaloneQuery) !== normalizeMessageText(question)
      ? `\n\nInterpretación del mensaje en el contexto de la conversación:\n${standaloneQuery}`
      : "";
    const followupNote = isFollowup
      ? "\n- El mensaje es un SEGUIMIENTO de tu respuesta anterior: contesta ese punto concreto y no repitas lo que ya dijiste."
      : "";
    const contactNote = contactRequest
      ? `\n- El usuario pide EXPLÍCITAMENTE un dato de contacto: respóndelo primero y de forma directa con el dato EXACTO de ${DATOS_HEADER} (institución + dato + web oficial si figura), en una o dos frases. Si ese dato concreto no figura, dilo con calidez y ofrece los canales que sí figuran; nunca lo inventes.`
      : "";

    const request = {
      model: CLAUDE_MODEL,
      max_tokens: 450,
      temperature: 0,
      system: [
        {
          type: "text",
          text: `Eres el asistente de WhatsApp de ${orgName}. Reescribe la RESPUESTA FUENTE de forma natural y empática para responder al usuario, teniendo en cuenta la conversación previa.

RESPUESTA FUENTE tiene dos partes: la información PRINCIPAL y, si existe, una sección final "${DATOS_HEADER}" con datos COMPLEMENTARIOS (teléfonos, centrales, sedes, direcciones, horarios, correos, webs, canales).

REGLAS ESTRICTAS:
- Usa únicamente la información de RESPUESTA FUENTE (información principal + ${DATOS_HEADER}).
- Responde en función de lo que el usuario pregunta AHORA, apoyándote en la información principal y complementándola con los datos de contacto cuando aporten (si hay una interpretación en contexto, guíate por ella).${followupNote}${contactNote}
- Si el usuario pide explícitamente un teléfono, sede, dirección, correo, horario, web o contacto, búscalo en ${DATOS_HEADER} y entrégalo EXACTO tal como figura (sin abreviar, alterar ni completar).
- Si no lo pide pero por el contexto ese dato le sirve para resolver su consulta (por ejemplo dónde ir o a quién llamar), inclúyelo siempre que esté en ${DATOS_HEADER}.
- Si el usuario vuelve a preguntar lo mismo porque no entendió o quiere más detalle, responde de forma más clara y completa usando de nuevo la información principal y los datos de contacto.
- No agregues, inventes ni modifiques instituciones, teléfonos, números, correos, enlaces, ciudades, sedes, horarios, requisitos, beneficios ni canales que no aparezcan literalmente en RESPUESTA FUENTE.
- Si RESPUESTA FUENTE no cubre el punto que pregunta, reconócelo con calidez y sin frases robóticas, ofrece lo que sí cubre y sugiere comunicarse por los canales oficiales de ${orgName}. Nunca inventes.
- Si la fuente pide un dato al usuario (por ejemplo su ciudad) y aún no lo ha dado, pídeselo. Si ya lo dio en la conversación, no lo vuelvas a pedir.
- Termina con UNA sola pregunta como máximo, y solo si hace falta para continuar.
- No ofrezcas enviar pasos, listas, detalles o requisitos que no estén en RESPUESTA FUENTE; no prometas lo que no puedes entregar.
- No digas "Excel", "base de datos", "base de conocimiento", "fuente", "respuesta fuente" ni "información disponible" al usuario.
- Máximo 4 líneas, salvo cuando entregues datos de contacto: en ese caso inclúyelos completos y exactos aunque ocupen algo más. Aun así sé conciso: si el usuario solo pide un dato de contacto, dáselo directamente sin repetir toda la información principal. Nunca dejes una frase a medias. Sin markdown, listas ni emojis.${langDirective(countryCode)}`,
        },
      ],
      messages: [
        ...history,
        {
          role: "user",
          content: `Mensaje del usuario:
${question}${interpretation}

RESPUESTA FUENTE:
${flow.answer}`,
        },
      ],
    };

    let msg = await anthropic.messages.create(request);
    let rawResponse = msg.content[0]?.text || flow.answer;
    let offender = findUnsupportedContact(rawResponse, flow.answer);
    const guardrailBlocked = offender !== null;
    let guardrailRetried = false;
    if (offender) {
      // Reintento ÚNICO con instrucción estricta (nombrando el dato que no figura)
      // antes de caer al fallback: casi siempre el modelo solo reformateó un
      // enlace/número o añadió una institución de memoria, y corrige a la primera.
      guardrailRetried = true;
      const strictNote = `\n- ATENCIÓN: tu borrador anterior incluyó "${offender.token}", que NO figura en RESPUESTA FUENTE. Responde de nuevo usando SOLO teléfonos, enlaces, correos, sedes e instituciones que aparezcan LITERALMENTE en RESPUESTA FUENTE, copiados tal cual; si tienes duda sobre un dato, omítelo.`;
      const retryRequest = {
        ...request,
        system: request.system.map((block, i) => (i === 0 ? { ...block, text: block.text + strictNote } : block)),
      };
      msg = await anthropic.messages.create(retryRequest);
      rawResponse = msg.content[0]?.text || flow.answer;
      offender = findUnsupportedContact(rawResponse, flow.answer);
    }
    const resp = guardGroundedContactInfo(rawResponse, flow.answer, orgName, countryCode, offender);
    obs.update({
      output: resp,
      model: CLAUDE_MODEL,
      metadata: {
        flow_id: flow.flow_id,
        flow_type: flow.flow_type,
        flow_similarity: flow.similarity ?? null,
        guardrail_contact_blocked: guardrailBlocked,
        guardrail_retried: guardrailRetried,
        guardrail_offender: offender ? `${offender.kind}:${offender.token}` : null,
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
- Maximo 4 lineas. Sin markdown, listas ni emojis.${langDirective(countryCode)}`,
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
      || strings(countryCode).locationFollowupDefault(location);
    const resp = guardGroundedContactInfo(rawResponse, `${flow.answer}\n${location}`, orgName, countryCode);

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
          text: `Organización activa: ${orgName}. País: ${countryCode}. El usuario envió un mensaje vago o ambiguo. Formula UNA SOLA pregunta empática y específica para entender mejor qué necesita, considerando el historial de la conversación si lo hay. La pregunta debe ser breve, cálida y directamente relacionada con lo que escribió el usuario. No respondas a ningún tema concreto todavía — solo haz la pregunta de clarificación.${langDirective(countryCode)}`,
        },
      ],
      messages,
    });
    const resp = msg.content[0]?.text
      || strings(countryCode).clarificationDefault(orgName);
    obs.update({
      output: resp,
      model: CLAUDE_MODEL,
      usageDetails: anthropicUsageDetails(msg.usage),
      costDetails: anthropicCostDetails(msg.usage),
    });
    return resp;
  }, { asType: "generation" });
}

// ── Módulo de comprensión (NLU) ───────────────────────────────
// Se ejecuta ANTES de decidir la ruta cuando hay historial. Interpreta el
// mensaje a la luz de la conversación: por defecto el usuario reacciona a la
// ÚLTIMA respuesta del asistente, pero puede cambiar de tema. Devuelve
// {intent, standalone_query, topic_changed, location, confidence} o null si no
// hay historial o falla (en ese caso se usan las heurísticas de texto de
// siempre). Solo orienta el routing y el retrieval: la respuesta final sigue
// basándose únicamente en el contenido recuperado del Excel.
const ANALYSIS_INTENTS = new Set([
  "followup", "new_topic", "location_answer", "continue", "decline",
  "closing", "greeting", "vague", "source_request",
]);
const ANALYSIS_HISTORY_TURNS = 6; // últimos 3 pares user/assistant

function parseAnalysis(raw, question) {
  const match = String(raw || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const intent = String(parsed.intent || "").toLowerCase().trim();
  if (!ANALYSIS_INTENTS.has(intent)) return null;

  const standalone = String(parsed.standalone_query || "").trim().replace(/^["']|["']$/g, "");
  const location = parsed.location ? String(parsed.location).trim() : "";
  const confidence = Number(parsed.confidence);
  return {
    intent,
    standalone_query: standalone || String(question || "").trim(),
    topic_changed: parsed.topic_changed === true,
    location: location || null,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null,
  };
}

async function analyzeMessage(question, history, orgName, countryCode) {
  if (!history || history.length === 0) return null;

  // Solo los últimos turnos: bastan para resolver referencias y abaratan la llamada.
  let recent = history.slice(-ANALYSIS_HISTORY_TURNS);
  const firstUser = recent.findIndex(m => m.role === "user");
  if (firstUser > 0) recent = recent.slice(firstUser);

  return startActiveObservation("claude-message-analysis", async (obs) => {
    obs.update({ input: { question, history_turns: recent.length } });
    const t0 = Date.now();
    try {
      const msg = await anthropic.messages.create({
        model: ANALYSIS_MODEL,
        max_tokens: 200,
        temperature: 0,
        system: analysisSystem(countryCode, orgName),
        messages: [...recent, { role: "user", content: question }],
      });
      const analysis = parseAnalysis(msg.content[0]?.text, question);
      obs.update({
        output: analysis,
        model: ANALYSIS_MODEL,
        usageDetails: anthropicUsageDetails(msg.usage),
        costDetails: anthropicCostDetails(msg.usage),
      });
      if (analysis) {
        console.log(`🧠 Comprensión (${Date.now() - t0}ms): ${analysis.intent}${analysis.topic_changed ? " (cambio de tema)" : ""} → "${analysis.standalone_query}"`);
      } else {
        console.warn("⚠️  analyzeMessage: respuesta no interpretable:", String(msg.content[0]?.text || "").slice(0, 120));
      }
      return analysis;
    } catch (err) {
      console.error("⚠️  analyzeMessage:", err.message);
      return null;
    }
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

        // Cache de la última fuente citada (perezoso): se consulta una sola vez.
        let lastCitedSource;
        const getLastCited = async () => {
          if (lastCitedSource === undefined) {
            lastCitedSource = await getLastCitedSource(userId, countryCode);
          }
          return lastCitedSource;
        };

        const finishTrace = (response, metadata = {}) => {
          // La fuente NO se cita automáticamente. Se guarda source_url en la
          // metadata (para poder entregarla si el usuario la pide luego), pero
          // no se añade al texto de la respuesta.
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

        // Decide metadata de cita para un flow: siempre registra source_url (para
        // el seguimiento de tema) y define cite_source_url solo si el tema cambió.
        const buildSourceMeta = async (flowId) => {
          const url = getSourceLink(flowId);
          if (!url) return {};
          const last = await getLastCited();
          return { source_url: url, ...(url !== last ? { cite_source_url: url } : {}) };
        };

        // PETICIÓN EXPLÍCITA DE LA FUENTE — no se cita automáticamente, pero si
        // la persona la pide ("dame la fuente", "la referencia", "el enlace",
        // "de dónde sacaste eso"), se entrega la fuente del último tema tratado.
        const SOURCE_REQUEST_REGEX = /(fuente|referencia|referencias|enlace|link|c[ií]ta(me)?|bibliograf[ií]a|de d[oó]nde (sacaste|obtuviste|viene|sale|proviene))/i;
        if (question.trim().length <= 60 && SOURCE_REQUEST_REGEX.test(question)) {
          const url = await getLastCited();
          if (url) {
            const response = `Con gusto. Esta orientación se basa en información de ${orgName}. Puedes consultarla aquí: ${url}`;
            return finishTrace(response, { search_type: "source_request", route: "source_request", source_url: url });
          }
          // Sin fuente previa registrada → sigue el flujo normal.
        }

        // 0. FLUJO ACTIVO — se evalúa primero.
        //    Si el mensaje es continuación clara → sigue el paso actual.
        //    Si es una pregunta nueva → retrieval para detectar intención nueva.
        //    precomputedFlow evita hacer doble llamada a embeddings si ya se buscó aquí.
        let precomputedFlow = null;

        // Historial (últimos 5 pares) disponible para todos los paths. Sobre él
        // trabaja el módulo de comprensión, que se invoca de forma perezosa: las
        // rutas triviales (continuación "sí", cierre "gracias"...) no lo pagan.
        const history = await getRecentHistory(userId, countryCode, 10, question);
        traceMetrics.history_turns = history.length;

        let analysisPromise;
        const getAnalysis = () => {
          if (history.length === 0) return Promise.resolve(null);
          if (!analysisPromise) analysisPromise = analyzeMessage(question, history, orgName, countryCode);
          return analysisPromise;
        };
        const recordAnalysis = (analysis) => {
          if (!analysis) return;
          Object.assign(traceMetrics, {
            analysis_intent: analysis.intent,
            analysis_topic_changed: analysis.topic_changed ? 1 : 0,
            analysis_confidence: analysis.confidence,
            analysis_query: analysis.standalone_query,
            ...(analysis.location ? { analysis_location: analysis.location } : {}),
          });
        };

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
          } else if (String(activeState.flow_type || "").startsWith("followup_location") && !SMALL_TALK_REGEX.test(question.trim())) {
            // ¿Es realmente la ubicación que se pidió? Con historial lo decide el
            // módulo de comprensión (evita tomar "y qué tal sería" por una ciudad);
            // sin historial, la heurística de texto.
            const analysis = await getAnalysis();
            recordAnalysis(analysis);
            const isLocation = analysis
              ? analysis.intent === "location_answer" && !!analysis.location
              : isLikelyLocationAnswer(question);

            if (isLocation) {
              const flow = await getFlowById(countryCode, activeState.flow_id);
              if (flow) {
                const location = analysis?.location || extractLocationAnswer(question);
                Object.assign(traceMetrics, {
                  retrieval_found: 1,
                  flow_id: flow.flow_id,
                  flow_type: flow.flow_type,
                  normalized_flow_type: "followup_location",
                  followup_location: location,
                });

                const response = await presentLocationFollowup(flow, location, question, history, orgName, countryCode);
                await updateStep(activeState.id, activeState.current_step, "completed");
                const followupUrl = getSourceLink(flow.flow_id);
                return finishTrace(response, {
                  search_type: "flow_location_followup",
                  route: "flow_location_followup",
                  flow_id: flow.flow_id,
                  followup_location: location,
                  ...(followupUrl ? { source_url: followupUrl } : {}),
                });
              }
            } else if (analysis?.topic_changed) {
              // Cambió de tema sin dar la ciudad → la espera de ubicación ya no aplica.
              console.log(`🔀 Cambio de tema durante espera de ubicación — cerrando: ${activeState.flow_id}`);
              await updateStep(activeState.id, activeState.current_step, "cancelled");
            }
            // Seguimiento sin ubicación → sigue el flujo normal (el estado queda
            // vigente por si la da en el próximo mensaje).
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
            const response = strings(countryCode).smallTalkInFlow();
            return finishTrace(response, {
              search_type: "small_talk_in_flow",
              route: "active_flow_smalltalk",
              flow_id: activeState.flow_id,
              step: activeState.current_step,
            });

          } else if (isDeclineMessage(question)) {
            // Rechazo explícito ("no", "no gracias"...) → cerrar el flujo sin avanzar.
            console.log(`🚫 Rechazo dentro de flujo — finalizando sin avanzar: ${activeState.flow_id} paso ${activeState.current_step}`);
            await updateStep(activeState.id, activeState.current_step, "completed");
            const response = strings(countryCode).declineInFlow();
            return finishTrace(response, {
              search_type: "decline",
              route: "active_flow_decline",
              flow_id: activeState.flow_id,
              step: activeState.current_step,
            });

          } else if (isAllStepsRequest(question) || parseRequestedStep(question, activeState.total_steps)) {
            // Navegación explícita ("todos los pasos", "paso 3") → sin retrieval ni análisis
            console.log(`🧭 Navegación explícita en flujo: ${activeState.flow_id} — "${question}"`);
            const result = await handlePasoAPaso(userId, countryCode, question, activeState);
            if (result) {
              const stepUrl = getSourceLink(activeState.flow_id);
              return finishTrace(result.response, {
                ...result.metadata,
                search_type: "paso_a_paso",
                route: "active_step_navigation",
                ...(stepUrl ? { source_url: stepUrl } : {}),
              });
            }

          } else if (isContinuationMessage(question)) {
            // Señal de continuación explícita → seguir el paso actual sin retrieval
            console.log(`▶️ Continuación del flujo: ${activeState.flow_id} paso ${activeState.current_step}/${activeState.total_steps}`);
            const result = await handlePasoAPaso(userId, countryCode, question, activeState);
            if (result) {
              // Mismo tema: registra source_url para el seguimiento, sin volver a citar.
              const stepUrl = getSourceLink(activeState.flow_id);
              return finishTrace(result.response, {
                ...result.metadata,
                search_type: "paso_a_paso",
                route: "active_step_continuation",
                ...(stepUrl ? { source_url: stepUrl } : {}),
              });
            }
            // accion "otro" → continúa al flujo normal

          } else if (isClosingMessage(question)) {
            // Despedida/agradecimiento → cerrar el flujo con gracia (sin fallback frío).
            console.log(`🙏 Cierre dentro de flujo activo — finalizando: ${activeState.flow_id} paso ${activeState.current_step}`);
            await updateStep(activeState.id, activeState.current_step, "completed");
            const response = strings(countryCode).closingInFlow();
            return finishTrace(response, {
              search_type: "closing",
              route: "active_flow_closing",
              flow_id: activeState.flow_id,
              step: activeState.current_step,
            });

          } else {
            // Mensaje más complejo → verificar si es una intención nueva
            console.log(`🔍 Mensaje complejo con flujo activo — verificando intención nueva`);
            // El módulo de comprensión decide si sigue en el mismo tema (duda sobre
            // el paso actual → se atiende dentro del flujo) o si cambió de tema
            // (→ se busca la nueva intención con la pregunta interpretada).
            const analysis = await getAnalysis();
            recordAnalysis(analysis);
            const candidate = analysis && !analysis.topic_changed
              ? null
              : await searchFlow(countryCode, analysis?.standalone_query || question);
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
                const stepUrl = getSourceLink(activeState.flow_id);
                return finishTrace(result.response, {
                  ...result.metadata,
                  search_type: "paso_a_paso",
                  route: "active_step_complex_message",
                  ...(stepUrl ? { source_url: stepUrl } : {}),
                });
              }
            }
          }
        }

        // 1. SMALL TALK — solo si NO hay flujo activo
        if (SMALL_TALK_REGEX.test(question.trim())) {
          const response = strings(countryCode).smallTalk(orgName);
          return finishTrace(response, { search_type: "small_talk", route: "small_talk" });
        }

        // 2. CIERRE / AGRADECIMIENTO — despedida cálida en vez del fallback frío.
        if (isClosingMessage(question)) {
          const response = strings(countryCode).closing();
          return finishTrace(response, { search_type: "closing", route: "closing" });
        }

        // 3. COMPRENSIÓN EN CONTEXTO — con historial, el módulo de comprensión
        //    interpreta el mensaje a la luz de la última respuesta del asistente:
        //    resuelve intenciones conversacionales, reescribe la pregunta para el
        //    retrieval y detecta si cambió de tema. Sin historial → null y se
        //    aplican las heurísticas de texto (mensaje autónomo).
        const analysis = precomputedFlow ? null : await getAnalysis();
        recordAnalysis(analysis);
        let searchQuery = question;
        let isFollowup = false;

        if (analysis) {
          searchQuery = analysis.standalone_query || question;
          isFollowup = analysis.intent === "followup" && !analysis.topic_changed;

          if (analysis.intent === "closing") {
            return finishTrace(strings(countryCode).closing(), { search_type: "closing", route: "closing_nlu" });
          }
          if (analysis.intent === "greeting") {
            return finishTrace(strings(countryCode).smallTalk(orgName), { search_type: "small_talk", route: "small_talk_nlu" });
          }
          if (analysis.intent === "decline") {
            return finishTrace(strings(countryCode).declineInFlow(), { search_type: "decline", route: "decline_nlu" });
          }
          if (analysis.intent === "source_request") {
            const url = await getLastCited();
            if (url) {
              const response = `Con gusto. Esta orientación se basa en información de ${orgName}. Puedes consultarla aquí: ${url}`;
              return finishTrace(response, { search_type: "source_request", route: "source_request_nlu", source_url: url });
            }
          }
          if (analysis.intent === "vague") {
            const response = await generateClarification(question, history, orgName, countryCode);
            return finishTrace(response, { search_type: "clarification", route: "clarification_nlu" });
          }
          if (analysis.intent === "location_answer" && analysis.location) {
            // Dio su ubicación sin que hubiera una espera registrada → se retoma
            // el último tema tratado y se responde con esa ubicación.
            const lastFlowId = await getLastFlowId(userId, countryCode);
            const lastFlow = lastFlowId ? await getFlowById(countryCode, lastFlowId) : null;
            if (lastFlow) {
              Object.assign(traceMetrics, {
                retrieval_found: 1,
                flow_id: lastFlow.flow_id,
                flow_type: lastFlow.flow_type,
                normalized_flow_type: "followup_location",
                followup_location: analysis.location,
              });
              const response = await presentLocationFollowup(lastFlow, analysis.location, question, history, orgName, countryCode);
              const followupUrl = getSourceLink(lastFlow.flow_id);
              return finishTrace(response, {
                search_type: "flow_location_followup",
                route: "flow_location_followup_nlu",
                flow_id: lastFlow.flow_id,
                followup_location: analysis.location,
                ...(followupUrl ? { source_url: followupUrl } : {}),
              });
            }
          }
          // "continue" sin flujo activo, "followup" y "new_topic" → retrieval
          // con la pregunta interpretada en contexto.
        }

        // 4. CACHE (por usuario — la respuesta puede contener datos personales).
        //    Solo para consultas autónomas: un seguimiento depende del contexto
        //    y no debe servirse desde cache.
        if (!analysis || analysis.intent === "new_topic") {
          const cached = getCached(countryCode, userId, question);
          if (cached) {
            traceMetrics.cache_hit = 1;
            // La cita se recalcula: aunque la respuesta esté cacheada, el link se
            // incluye solo si el tema cambió respecto a la última fuente citada.
            let citeMeta = {};
            if (cached.sourceUrl) {
              const last = await getLastCited();
              citeMeta = { source_url: cached.sourceUrl, ...(cached.sourceUrl !== last ? { cite_source_url: cached.sourceUrl } : {}) };
            }
            return finishTrace(cached.value, { search_type: "cache", route: "cache", ...citeMeta });
          }
        }

        // 4.5 MENSAJE VAGO sin historial — pedir clarificación antes de buscar
        //     (con historial ya lo decidió el módulo de comprensión).
        if (!analysis && VAGUE_REGEX.test(question.trim())) {
          const response = await generateClarification(question, history, orgName, countryCode);
          return finishTrace(response, { search_type: "clarification", route: "clarification" });
        }

        // 5. BUSCAR EN knowledge_flows (Excel) con la pregunta interpretada.
        //    Si ya se buscó en el paso 0 (cambio de intención detectado), reutilizar sin re-embeddings.
        traceMetrics.retrieval_query = searchQuery;
        // ¿Pide explícitamente un dato de contacto? Se mira el mensaje literal y la
        // interpretación (la reescritura puede perder la palabra "teléfono").
        const contactRequest = isContactRequest(question) || isContactRequest(searchQuery);
        if (contactRequest) traceMetrics.contact_request = 1;
        let flow = precomputedFlow ?? await searchFlow(countryCode, searchQuery, { contactRequest });

        // 5.5 SEGUIMIENTO SIN MATCH — es un seguimiento de la última respuesta y
        //     la búsqueda no trajo nada: se responde desde el contenido del último
        //     tema (el LLM contesta ese punto o reconoce que no lo cubre; nunca
        //     inventa). Un flow "paso a paso" reutilizado NO reinicia sus pasos.
        if (!flow && isFollowup) {
          const lastFlowId = await getLastFlowId(userId, countryCode);
          const lastFlow = lastFlowId ? await getFlowById(countryCode, lastFlowId) : null;
          if (lastFlow) {
            flow = { ...lastFlow, similarity: null, reused_last_topic: true };
            traceMetrics.followup_reused_last_flow = 1;
            console.log(`🔁 Seguimiento sin match — reutilizando último tema: ${lastFlow.flow_id}`);
          }
        }

        // 5.6 CONSULTA DE CONTACTO SIN MATCH — pide un teléfono/sede/correo… y el
        //     embedding no trajo flow: se busca por palabra clave dentro de la
        //     sección de Datos ("buscar principalmente en la columna Datos").
        if (!flow && contactRequest) {
          flow = await findFlowByDatosKeyword(countryCode, question);
          if (flow) {
            traceMetrics.contact_keyword_hit = 1;
            traceMetrics.contact_keyword = flow.datos_keyword;
            console.log(`🔎 Contacto por palabra clave "${flow.datos_keyword}" → ${flow.flow_id}`);
          }
        }

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
            flow_reranked: flow.reranked ? 1 : 0,
            flow_rerank_confidence: flow.rerank_confidence ?? null,
            flow_question_chars: textMetrics(flow.question).chars,
            flow_answer_chars: textMetrics(flow.answer).chars,
          });

          // Un "paso a paso" NO se inicia si el usuario pidió un dato de contacto:
          // se le responde el dato (ruta fundamentada, más abajo), no el proceso.
          if ((normalizedType === "paso a paso" || normalizedType === "paso_a_paso") && !flow.reused_last_topic && !contactRequest) {
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
                ...(await buildSourceMeta(flow.flow_id)),
              });
            }

            await upsertState(userId, countryCode, flow.flow_id, "paso a paso", 1, steps.length);
            traceMetrics.total_steps = steps.length;
            const response = await presentStepWithLLM(steps[0].step_summary, {
              isDetail: false, isLastStep: steps.length === 1,
              question, history, orgName, countryCode,
              allSteps: steps, currentStepNumber: 1,
              datos: splitDatos(flow.answer).datos,
            });
            // La fuente se cita solo en el PRIMER paso (inicio del tema).
            return finishTrace(response, {
              search_type: "flow_paso_a_paso",
              route: "flow_step_start",
              flow_id: flow.flow_id,
              total_steps: steps.length,
              step: 1,
              ...(await buildSourceMeta(flow.flow_id)),
            });
          }

          // Caso por defecto para cualquier otro tipo de respuesta: "informativa",
          // "seleccion", "orientación y derivación", "informativa y derivación",
          // "informativa y preventiva", etc. Se responde de forma puntual y
          // fundamentada en la "Respuesta" del flow. Es el DEFAULT a propósito: un
          // flow recuperado nunca debe caer al fallback por tener un tipo no previsto.
          const response = await presentFlowWithLLM(flow, question, history, orgName, countryCode, {
            standaloneQuery: searchQuery,
            isFollowup,
            contactRequest,
          });
          const searchType = normalizedType === "informativa" ? "flow_informativa"
            : normalizedType === "seleccion" ? "flow_seleccion"
            : "flow_grounded";
          traceMetrics.guardrail_final_unsupported_contact = hasUnsupportedContactInfo(response, flow.answer) ? 1 : 0;
          const sourceMeta = await buildSourceMeta(flow.flow_id);
          if (sourceRequestsLocation(flow.answer)) {
            // No cachear: la próxima pregunta debe entrar al follow-up de ubicación,
            // no devolver la respuesta previa que aún pedía la ciudad.
            await upsertState(userId, countryCode, flow.flow_id, `followup_location:${normalizedType}`, 0, 0);
            traceMetrics.awaiting_location_followup = 1;
          } else if (!isFollowup) {
            // Se cachea la respuesta BASE (sin link) + la fuente por separado.
            // Un seguimiento no se cachea: su respuesta depende del contexto.
            setCached(countryCode, userId, question, response, getSourceLink(flow.flow_id));
          }
          return finishTrace(response, {
            search_type: searchType,
            route: contactRequest ? "flow_contact_data" : isFollowup ? "flow_grounded_followup" : "flow_grounded_rewrite",
            flow_id: flow.flow_id,
            tipo_respuesta: normalizedType,
            ...sourceMeta,
          });
        }

        // 5. FALLBACK - solo Excel: sin flow recuperado no se llama al LLM.
        // Esto evita que el modelo invente telefonos, correos, sedes o links.
        const noCtxResponse = strings(countryCode).fallbackNoExcel(orgName);

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
  isClosingMessage,
  isDeclineMessage,
  isContactRequest,
  contactSearchTokens,
  findUnsupportedContact,
  parseAnalysis,
  isAllStepsRequest,
  parseRequestedStep,
  salvageStepJson,
  formatAllStepsFallback,
};
