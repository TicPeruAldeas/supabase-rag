// ── Capa de idioma por país ───────────────────────────────────
// El sistema nació en español (PE/CO). Brasil (BR) responde en portugués.
// Todo el texto de cara al usuario y las directivas de idioma para el LLM se
// centralizan aquí para no dispersar strings por el código.
//
// Regla de oro: para "es" se devuelven EXACTAMENTE los textos y prompts
// originales, de modo que el comportamiento de PE/CO no cambia en nada
// (mismo prompt cacheado, mismas respuestas).

// País → idioma. Cualquier país no listado usa "es".
const LANG_BY_COUNTRY = {
  BR: "pt",
};

function getLang(countryCode) {
  return LANG_BY_COUNTRY[String(countryCode || "").toUpperCase()] || "es";
}

// ── Directiva de idioma para prompts del LLM ──────────────────
// Se ANEXA al system prompt (después del bloque estático cacheado, que sigue
// siendo idéntico para todos los países). Para "es" es cadena vacía → el prompt
// queda byte a byte igual que antes y conserva el prompt-caching de PE/CO.
const LANG_DIRECTIVE = {
  es: "",
  pt: `

IDIOMA DE RESPOSTA (OBRIGATÓRIO): Responda SEMPRE em português do Brasil (pt-BR), independentemente do idioma da fonte, do histórico ou da pergunta do usuário. Esta instrução anula qualquer indicação anterior de responder em espanhol. Mantenha um tom empático, caloroso e natural em português brasileiro.`,
};

// ── Agente de PRUEBA (XT) ─────────────────────────────────────
// XT es el país de pruebas: se presenta como Perú y responde en mensajes cortos
// con viñetas, y su saludo lista las categorías de su base de conocimiento.
// Desde oct. 2026 PE usa lo mismo que XT. CO y BR NO cambian: para ellos la
// directiva de formato es "" y los textos son los de siempre.
const RICH_FORMAT_COUNTRIES = new Set(["XT", "PE"]);

function usesRichFormat(countryCode) {
  return RICH_FORMAT_COUNTRIES.has(String(countryCode || "").toUpperCase());
}

// Se anexa (junto a la directiva de idioma) al final de cada prompt de
// generación, así que tiene prioridad sobre "máximo 4 líneas / sin listas".
// Largo máximo de la respuesta por país (palabras; y en un paso del paso a paso).
// XT (agente de prueba) responde un poco más corto que PE.
const MAX_WORDS = { XT: [40, 65] };
const DEFAULT_MAX_WORDS = [50, 80];

const richFormatDirective = ([maxWords, maxStepWords]) => `

FORMATO DE RESPUESTA PARA WHATSAPP (OBLIGATORIO; reemplaza cualquier indicación anterior de "sin listas", "sin viñetas" o "máximo 4 líneas"):
- Empieza con UNA frase corta que responda o enmarque la consulta.
- Si hay varios datos, requisitos u opciones, lístalos en viñetas: cada línea empieza con "• " y tiene una sola idea corta (máximo 15 palabras).
- Entre 2 y 5 viñetas; si hay más contenido, elige lo más importante para la persona.
- Deja una línea en blanco entre la frase inicial, las viñetas y el cierre.
- Si hace falta continuar, cierra con UNA pregunta corta.
- Puedes resaltar una palabra clave con *asteriscos simples* (negrita de WhatsApp), con moderación. No uses "**", títulos con "#" ni tablas.
- Si las instrucciones anteriores piden un formato exacto (por ejemplo "Paso X de N:" o un JSON), respétalo y aplica las viñetas solo dentro del texto de la explicación.
- Si solo debes hacer una pregunta, hazla en una sola frase, sin viñetas.

LENGUAJE CLARO (OBLIGATORIO): escribe para que te entienda cualquier persona, aunque haya estudiado poco o el español no sea su idioma.
- Usa palabras de todos los días y frases cortas, de una idea cada una.
- Si usas un término técnico o legal, explícalo en la misma frase con palabras simples (por ejemplo: "calidad migratoria, es decir, el permiso para vivir aquí").
- Habla de forma directa y cercana (tú), sin tecnicismos innecesarios ni siglas sin explicar.

RESPUESTA CORTA Y CLARA (OBLIGATORIO; tiene prioridad sobre cualquier indicación anterior de formato o extensión, incluidas las viñetas):
- Máximo ${maxWords} palabras en total. Si presentas un paso ("Paso X de N"), hasta ${maxStepWords} palabras.
- Escribe 2 o 3 párrafos muy cortos (una o dos frases cada uno). NO uses viñetas, salvo cuando la persona deba elegir entre opciones (por ejemplo, "¿cuál es tu caso?").
- El primer párrafo responde directo a lo que preguntó. Incluye solo lo más importante para SU caso; el resto lo contarás si lo pide.
- Que se entienda a la primera, como si hablaras con alguien que no conoce los trámites: nunca uses siglas ni palabras legales sin explicarlas. Por ejemplo, di "sin papeles en regla" y no "situación irregular"; "permiso para vivir aquí" y no "calidad migratoria"; "CPP (permiso temporal de permanencia)" y no solo "CPP".
- Termina con UNA pregunta corta para seguir ayudando.
- No incluyas teléfonos, correos, direcciones ni páginas web si no los pidió; si son útiles, ofrécelos en la pregunta final (por ejemplo, "¿Quieres el teléfono de la Defensoría?").`;

// Países que responden en el idioma de cada mensaje: el contenido sigue en
// español y el modelo lo traduce al responder, y los textos fijos (bienvenida,
// saludo, avisos) salen en portugués si le escriben en portugués. Desactivado
// también en XT (26/10/2026): el agente de prueba responde siempre en español
// para no confundir a los equipos. Para reactivarlo, añadir "XT".
const AUTO_LANG_COUNTRIES = new Set([]);

function usesAutoLanguage(countryCode) {
  return AUTO_LANG_COUNTRIES.has(String(countryCode || "").toUpperCase());
}

const AUTO_LANG_DIRECTIVE = `

IDIOMA DE RESPUESTA (OBLIGATORIO): Responde en el MISMO idioma del ÚLTIMO mensaje del usuario. Si escribe en portugués, responde en portugués de Brasil; si escribe en español, responde en español. El contenido de la fuente está en español: tradúcelo con naturalidad, pero NO traduzcas ni cambies nombres propios, nombres de instituciones u organismos, siglas, teléfonos, correos ni enlaces: cópialos exactamente como aparecen en la fuente. Traduce también las frases fijas de formato y las preguntas de cierre que te indiquen las instrucciones (por ejemplo, en portugués "Paso 1 de 5:" se escribe "Passo 1 de 5:" y "¿Quieres que te diga el siguiente paso?" se escribe "Quer que eu te diga o próximo passo?"), sin mezclar idiomas en la misma respuesta. Si la respuesta debe ser un JSON, mantén las claves y los valores de control (como "accion") exactamente como se piden y aplica el idioma solo al texto para el usuario. Esta instrucción anula cualquier indicación anterior de responder siempre en español.`;

function langDirective(countryCode) {
  const cc = String(countryCode || "").toUpperCase();
  const format = usesRichFormat(cc) ? richFormatDirective(MAX_WORDS[cc] || DEFAULT_MAX_WORDS) : "";
  const lang = usesAutoLanguage(countryCode) ? AUTO_LANG_DIRECTIVE : (LANG_DIRECTIVE[getLang(countryCode)] || "");
  return lang + format;
}

// ── Textos de cara al usuario ─────────────────────────────────
// Cada valor es una función para permitir interpolar orgName / ubicación.
const STRINGS = {
  es: {
    smallTalkInFlow: () => `¡Hola! Seguimos con tu consulta. ¿Quieres que continúe con el siguiente paso?`,
    declineInFlow: () => `¡Perfecto! Lo dejamos aquí. Si más adelante quieres retomar o tienes otra consulta, con gusto te oriento.`,
    closingInFlow: () => `¡Con gusto! Me alegra haber podido ayudarte. Si necesitas algo más, aquí estaré.`,
    smallTalk: (org) => `¡Hola! Soy el asistente virtual de ${org}. ¿En qué puedo ayudarte hoy?`,
    closing: () => `¡Con gusto! Me alegra haber podido orientarte. Si más adelante necesitas algo más, aquí estaré para ayudarte.`,
    fallbackNoExcel: (org) => `Gracias por contarme. En este momento no puedo orientarte con precision sobre eso por aqui. Te recomiendo comunicarte por los canales oficiales de ${org} para que puedan evaluar tu caso.`,
    stepDone: () => `¡Entendido! Si necesitas más ayuda, con gusto te orientamos.`,
    allStepsIntro: (total) => `Claro, este es el resumen de los ${total} pasos:`,
    allStepsOutro: () => `¿Quieres más detalle de alguno? Dime el número del paso.`,
    contactFallback: (org) => `Gracias por contarme. En este momento no cuento con un contacto especifico para orientarte por aqui. Te recomiendo comunicarte por los canales oficiales de ${org} para que puedan evaluar tu caso.`,
    // Pidió un contacto que no figura en la base (países con contactos estrictos).
    contactNotFound: (org) => `No tengo ese contacto por aquí. Te recomiendo comunicarte por los canales oficiales de ${org}.`,
    contactDatosOnly: (datos) => `Estos son los datos de contacto que tengo sobre este tema:\n\n${datos}`,
    clarificationDefault: (org) => `¿En qué área específica puedo orientarte sobre los servicios de ${org}?`,
    locationFollowupDefault: (loc) => `Gracias por decirme que estas en ${loc}. Tu caso requiere atencion prioritaria. Es importante que puedas acercarte o contactar lo antes posible con servicios de apoyo en tu localidad para recibir orientacion, proteccion y acompanamiento.`,
    // server.js
    consentText: (userName) => {
      const saludo = userName ? `Hola ${userName}` : "Hola";
      return `${saludo}, soy el asistente virtual de Aldeas Infantiles SOS. Estoy aquí para orientarte sobre nuestros programas y servicios. Recuerda que tus consultas son confidenciales y se tratan con los estándares de seguridad y privacidad de la organización.\n\nPor favor, presiona el botón "Continuar" para comenzar 👇`;
    },
    consentButtonTitle: () => "Continuar",
    welcome: (userName) => {
      const saludo = userName ? `¡Gracias, ${userName}!` : "¡Gracias!";
      return `${saludo} Soy el asistente virtual de Aldeas Infantiles SOS. Cuéntame en qué puedo orientarte hoy —sobre nuestros programas, servicios o cómo acceder a ellos.`;
    },
    technicalError: () => `Disculpa, estamos teniendo un problema técnico en este momento. Por favor intenta de nuevo en unos minutos.`,
    sourceLabel: () => "Fuente",
  },
  pt: {
    smallTalkInFlow: () => `Olá! Vamos continuar com a sua consulta. Quer que eu siga com o próximo passo?`,
    declineInFlow: () => `Perfeito! Paramos por aqui. Se mais adiante quiser retomar ou tiver outra dúvida, fico à disposição para te orientar.`,
    closingInFlow: () => `Com prazer! Fico feliz em ter ajudado. Se precisar de mais alguma coisa, estarei por aqui.`,
    smallTalk: (org) => `Olá! Sou o assistente virtual da ${org}. Como posso te ajudar hoje?`,
    closing: () => `Com prazer! Fico feliz em ter podido te orientar. Se mais adiante precisar de algo, estarei aqui para ajudar.`,
    fallbackNoExcel: (org) => `Obrigado por compartilhar. Neste momento não consigo te orientar com precisão sobre isso por aqui. Recomendo entrar em contato pelos canais oficiais da ${org} para que possam avaliar o seu caso.`,
    stepDone: () => `Entendido! Se precisar de mais ajuda, com prazer te orientamos.`,
    allStepsIntro: (total) => `Claro, este é o resumo dos ${total} passos:`,
    allStepsOutro: () => `Quer mais detalhes de algum? Me diga o número do passo.`,
    contactFallback: (org) => `Obrigado por compartilhar. Neste momento não tenho um contato específico para te orientar por aqui. Recomendo entrar em contato pelos canais oficiais da ${org} para que possam avaliar o seu caso.`,
    contactNotFound: (org) => `Não tenho esse contato por aqui. Recomendo entrar em contato pelos canais oficiais da ${org}.`,
    contactDatosOnly: (datos) => `Estes são os dados de contato que tenho sobre este assunto:\n\n${datos}`,
    clarificationDefault: (org) => `Em qual área específica posso te orientar sobre os serviços da ${org}?`,
    locationFollowupDefault: (loc) => `Obrigado por me dizer que você está em ${loc}. O seu caso precisa de atenção prioritária. É importante procurar ou entrar em contato o quanto antes com serviços de apoio na sua região para receber orientação, proteção e acompanhamento.`,
    // server.js
    consentText: (userName) => {
      const saudacao = userName ? `Olá ${userName}` : "Olá";
      return `${saudacao}, sou o assistente virtual da Aldeias Infantis SOS. Estou aqui para te orientar sobre nossos programas e serviços. Lembre-se de que suas consultas são confidenciais e tratadas com os padrões de segurança e privacidade da organização.\n\nPor favor, pressione o botão "Continuar" para começar 👇`;
    },
    consentButtonTitle: () => "Continuar",
    welcome: (userName) => {
      const saudacao = userName ? `Obrigado, ${userName}!` : "Obrigado!";
      return `${saudacao} Sou o assistente virtual da Aldeias Infantis SOS. Me conte em que posso te orientar hoje — sobre nossos programas, serviços ou como acessá-los.`;
    },
    technicalError: () => `Desculpe, estamos com um problema técnico neste momento. Por favor, tente novamente em alguns minutos.`,
    sourceLabel: () => "Fonte",
  },
};

// Textos propios de un país que reemplazan a los de su idioma. Las funciones
// que listan temas reciben `topics` (líneas "• Tema" o ""); los textos base
// ignoran ese argumento, por eso se puede pasar siempre.
const XT_TOPICS = [
  "📄 *Documentación y situación migratoria:* documentos, regularización, refugio, multas y viajes",
  "🛡️ *Protección de niñas, niños y adolescentes:* violencia, abuso, pensión de alimentos y crianza",
  "🤝 *Acceso a derechos:* salud, colegio, trabajo, banco y vivienda",
].join("\n");
const XT_TOPICS_CLOSING = "Escríbelo con tus propias palabras, sin preocuparte por cómo lo digas 💙";

// PE usa los mismos textos que XT, con las 3 categorías de su matriz (V4, oct.
// 2026) con sus mismos nombres; los ejemplos son solo lo que la matriz responde.
const PE_TOPICS = [
  "📄 *Regularización y documentación:* documentos, multas y trámites de tus hijos",
  "🛡️ *Protección infantil y familiar:* violencia, abuso y separación familiar",
  "🤝 *Acceso a derechos:* trabajo, alimentación, salud, colegio y discapacidad",
].join("\n");

// Textos del "Agente Perú Multipaís". Temas escritos a mano (con ejemplos), no
// tomados de las categorías del Excel: si se agrega una categoría nueva, hay
// que añadirla en la lista de temas del país.
function peruAgentStrings(topics) {
  return {
    consentText: (userName) => {
      const saludo = userName ? `¡Hola, ${userName}! 👋` : "¡Hola! 👋";
      return `${saludo} Bienvenido/a 😊. Soy el Agente Perú Multipaís de Aldeas Infantiles SOS. Estoy aquí para orientarte sobre documentos, tus derechos y la protección de tus hijos, sin importar tu situación migratoria. *Todo lo que me cuentes es confidencial.*\n\nPresiona "Continuar" y empecemos 👇`;
    },
    welcome: (userName) => {
      const saludo = userName ? `¡Gracias, ${userName}! 😊` : "¡Gracias! 😊";
      return `${saludo} Cuéntame qué necesitas. Puedo orientarte sobre:\n\n${topics}\n\n${XT_TOPICS_CLOSING}`;
    },
    smallTalk: () => `¡Hola! 😊 Soy el Agente Perú Multipaís de Aldeas Infantiles SOS. Cuéntame qué necesitas. Puedo orientarte sobre:\n\n${topics}\n\n${XT_TOPICS_CLOSING}`,
    // Sin lista de temas: los temas se muestran solo en el saludo y la
    // bienvenida, no cada vez que una pregunta no encuentra respuesta.
    fallbackNoExcel: (org) => `Gracias por contarme. No tengo una orientación precisa sobre eso por aquí. Te recomiendo comunicarte por los canales oficiales de ${org} para que puedan ayudarte con tu caso.`,
  };
}

const COUNTRY_STRINGS = {
  XT: peruAgentStrings(XT_TOPICS),
  PE: {
    ...peruAgentStrings(PE_TOPICS),
    // Sin derivar a la organización: lo que no está en la matriz (alquiler,
    // préstamos...) no es algo en lo que Aldeas pueda ayudar.
    fallbackNoExcel: () => `Entiendo lo que necesitas 💙, pero sobre ese tema no tengo información por ahora.\n\nDonde sí puedo orientarte es en tus documentos, la protección de tus hijos y el acceso a salud, colegio, trabajo y alimentación. ¿Te ayudo con alguno de esos temas?`,
    // Se envía tras unos minutos sin respuesta de la persona (ver server.js).
    inactivityFarewell: () => `Parece que ya no estás por aquí 😊. Fue un gusto ayudarte.\n\nSi tienes otra consulta, escríbeme cuando quieras; estaré aquí para orientarte 💙`,
    // Variante si quedó a mitad de un paso a paso: invita a retomarlo.
    inactivityFarewellSteps: () => `Parece que ya no estás por aquí 😊. Cuando quieras seguir con los pasos, escríbeme *siguiente* y continuamos desde donde lo dejaste 💙`,
  },
};

// ── Agente de PRUEBA (XT) en portugués ────────────────────────
// Cuando la persona escribe en portugués, XT usa estos textos fijos (sobre los
// textos base "pt"). El nombre de la organización se mantiene en español
// ("Aldeas Infantiles SOS"), igual que el resto de nombres propios.
const XT_TOPICS_PT = [
  "📄 *Documentação e situação migratória:* documentos, regularização, refúgio, multas e viagens",
  "🛡️ *Proteção de crianças e adolescentes:* violência, abuso, pensão alimentícia e criação dos filhos",
  "🤝 *Acesso a direitos:* saúde, escola, trabalho, banco e moradia",
].join("\n");
const XT_TOPICS_CLOSING_PT = "Escreva com suas próprias palavras, sem se preocupar com a forma de dizer 💙";

const COUNTRY_STRINGS_PT = {
  XT: {
    consentText: (userName) => {
      const saudacao = userName ? `Olá, ${userName}! 👋` : "Olá! 👋";
      return `${saudacao} Seja bem-vindo/a 😊. Sou o Agente Peru Multipaís da Aldeas Infantiles SOS. Estou aqui para te orientar sobre documentos, seus direitos e a proteção dos seus filhos, independentemente da sua situação migratória. *Tudo o que você me contar é confidencial.*\n\nToque em "Continuar" e vamos começar 👇`;
    },
    welcome: (userName) => {
      const saudacao = userName ? `Obrigado/a, ${userName}! 😊` : "Obrigado/a! 😊";
      return `${saudacao} Me conte o que você precisa. Posso te orientar sobre:\n\n${XT_TOPICS_PT}\n\n${XT_TOPICS_CLOSING_PT}`;
    },
    smallTalk: () => `Olá! 😊 Sou o Agente Peru Multipaís da Aldeas Infantiles SOS. Me conte o que você precisa. Posso te orientar sobre:\n\n${XT_TOPICS_PT}\n\n${XT_TOPICS_CLOSING_PT}`,
    fallbackNoExcel: (org) => `Obrigado por compartilhar. Não tenho uma orientação precisa sobre isso por aqui. Recomendo entrar em contato pelos canais oficiais da ${org} para que possam te ajudar com o seu caso.`,
  },
};

// Heurística para detectar portugués en un mensaje corto o largo: letras y
// palabras que no se usan en español. Ante la duda, devuelve false (español).
// Límites de palabra con soporte de acentos ((?<!\p{L}) / (?!\p{L})): el \b de
// JavaScript no considera letra la "á" de "olá".
const PT_HINT_REGEX = /[ãõç]|(?<!\p{L})(voc[eê]|n[aã]o|ol[aá]|oi|obrigad[oa]|meu|minha|meus|minhas|filho|filha|filhos|filhas|posso|preciso|quero|tenho|estou|sou|bom\s+dia|boa\s+(tarde|noite)|ajuda|qual|onde|tamb[eé]m|ent[aã]o|isso|essa|esse|muito|fa[cç]o|trabalhar|direitos|documento\s+de\s+identidade)(?!\p{L})/iu;

function looksPortuguese(text) {
  return PT_HINT_REGEX.test(String(text || ""));
}

// Textos fijos de cara al usuario. `userText` (opcional) es el mensaje de la
// persona: en los países que responden en el idioma de cada mensaje (XT), si
// está en portugués se usan los textos en portugués. El resto de países ignora
// `userText` y conserva exactamente sus textos.
function strings(countryCode, userText) {
  const cc = String(countryCode || "").toUpperCase();
  if (usesAutoLanguage(cc) && looksPortuguese(userText)) {
    return { ...STRINGS.pt, ...(COUNTRY_STRINGS_PT[cc] || {}) };
  }
  const base = STRINGS[getLang(countryCode)] || STRINGS.es;
  const own = COUNTRY_STRINGS[cc];
  return own ? { ...base, ...own } : base;
}

// ── System prompt para el resumen de pasos (ingest / background) ──
const STEP_SUMMARY_SYSTEM = {
  es: "Resume el siguiente paso en máximo 2 líneas cortas y claras en español. Sin markdown.",
  pt: "Resuma o passo a seguir em no máximo 2 linhas curtas e claras em português do Brasil. Sem markdown.",
};

function stepSummarySystem(countryCode) {
  return STEP_SUMMARY_SYSTEM[getLang(countryCode)] || STEP_SUMMARY_SYSTEM.es;
}

// ── System prompt del módulo de comprensión (NLU) ─────────────
// Se ejecuta ANTES de decidir la ruta cuando hay historial. Lee la última
// respuesta del asistente y el mensaje nuevo, y devuelve JSON estructurado:
// intención, pregunta autónoma (para el retrieval), si cambió de tema y la
// ubicación si la dio. La pregunta reescrita va en el idioma del país para
// no desalinear los embeddings con el contenido del Excel.
const ANALYSIS_SYSTEM = {
  es: (org) => `Eres el módulo de comprensión de un asistente de WhatsApp de ${org}. Tu trabajo NO es responder: es entender el ÚLTIMO mensaje del usuario a la luz de la conversación.

PRINCIPIO: por defecto, el usuario está reaccionando a la ÚLTIMA respuesta del asistente (pregunta sobre eso, responde a lo que se le pidió, pide seguir o cierra). Pero puede cambiar de tema en cualquier momento; detéctalo con cuidado.

Devuelve SOLO JSON válido, sin texto fuera del JSON:
{"intent":"...","standalone_query":"...","topic_changed":true|false,"location":"..."|null,"confidence":0.0}

intent — elige exactamente uno:
- "followup": pregunta o comentario sobre la última respuesta del asistente ("y qué tal sería", "y eso cuánto demora", "cuál me conviene", "y si no tengo eso", "cómo hago eso").
- "new_topic": consulta nueva, independiente de la última respuesta.
- "location_answer": indica su ciudad, distrito o lugar (porque se le pidió o de forma espontánea). Rellena "location".
- "continue": solo quiere que sigas ("sí", "dale", "el siguiente", "ok").
- "decline": no quiere continuar ("no", "así está bien", "ya no").
- "closing": agradece o se despide.
- "greeting": solo saluda.
- "vague": pide ayuda sin decir de qué y el historial no permite deducirlo.
- "source_request": pide la fuente, referencia o enlace de la información.

standalone_query: el mensaje reescrito como UNA pregunta autónoma y breve en español, resolviendo referencias ("eso", "y qué tal", "ahí", "ese programa") con el tema de la última respuesta. Para "new_topic" es el mensaje casi tal cual. Para "location_answer" describe qué buscaba el usuario más su ubicación. Nunca contiene la respuesta.
topic_changed: true solo si el mensaje trata un tema distinto al de la última respuesta del asistente.
location: ciudad/lugar mencionado en el mensaje, o null.
confidence: 0.0 a 1.0.`,
  pt: (org) => `Você é o módulo de compreensão de um assistente de WhatsApp da ${org}. Seu trabalho NÃO é responder: é entender a ÚLTIMA mensagem do usuário à luz da conversa.

PRINCÍPIO: por padrão, o usuário está reagindo à ÚLTIMA resposta do assistente (pergunta sobre isso, responde ao que foi pedido, pede para continuar ou encerra). Mas ele pode mudar de assunto a qualquer momento; detecte isso com cuidado.

Devolva APENAS JSON válido, sem texto fora do JSON:
{"intent":"...","standalone_query":"...","topic_changed":true|false,"location":"..."|null,"confidence":0.0}

intent — escolha exatamente um:
- "followup": pergunta ou comentário sobre a última resposta do assistente ("e como seria", "e isso demora quanto", "qual me convém", "e se eu não tiver isso").
- "new_topic": consulta nova, independente da última resposta.
- "location_answer": informa sua cidade, bairro ou lugar (porque foi pedido ou espontaneamente). Preencha "location".
- "continue": só quer que você continue ("sim", "pode", "o próximo", "ok").
- "decline": não quer continuar ("não", "assim está bom", "já chega").
- "closing": agradece ou se despede.
- "greeting": só cumprimenta.
- "vague": pede ajuda sem dizer sobre o quê e o histórico não permite deduzir.
- "source_request": pede a fonte, referência ou link da informação.

standalone_query: a mensagem reescrita como UMA pergunta autônoma e breve em português do Brasil, resolvendo referências ("isso", "e como seria", "aí", "esse programa") com o tema da última resposta. Para "new_topic" é a mensagem quase igual. Para "location_answer" descreva o que o usuário buscava mais a localização. Nunca contém a resposta.
topic_changed: true apenas se a mensagem trata de um assunto diferente da última resposta do assistente.
location: cidade/lugar mencionado na mensagem, ou null.
confidence: 0.0 a 1.0.`,
};

function analysisSystem(countryCode, orgName) {
  const build = ANALYSIS_SYSTEM[getLang(countryCode)] || ANALYSIS_SYSTEM.es;
  return build(orgName);
}

module.exports = {
  getLang,
  usesRichFormat,
  usesAutoLanguage,
  looksPortuguese,
  langDirective,
  strings,
  stepSummarySystem,
  analysisSystem,
};
