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

function langDirective(countryCode) {
  return LANG_DIRECTIVE[getLang(countryCode)] || "";
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
    contactFallback: (org) => `Gracias por contarme. En este momento no cuento con un contacto especifico para orientarte por aqui. Te recomiendo comunicarte por los canales oficiales de ${org} para que puedan evaluar tu caso.`,
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
    contactFallback: (org) => `Obrigado por compartilhar. Neste momento não tenho um contato específico para te orientar por aqui. Recomendo entrar em contato pelos canais oficiais da ${org} para que possam avaliar o seu caso.`,
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

function strings(countryCode) {
  return STRINGS[getLang(countryCode)] || STRINGS.es;
}

// ── System prompt para el resumen de pasos (ingest / background) ──
const STEP_SUMMARY_SYSTEM = {
  es: "Resume el siguiente paso en máximo 2 líneas cortas y claras en español. Sin markdown.",
  pt: "Resuma o passo a seguir em no máximo 2 linhas curtas e claras em português do Brasil. Sem markdown.",
};

function stepSummarySystem(countryCode) {
  return STEP_SUMMARY_SYSTEM[getLang(countryCode)] || STEP_SUMMARY_SYSTEM.es;
}

// ── System prompt del condensador de preguntas (retrieval) ────
// La pregunta reescrita debe ir en el idioma del país para no desalinear los
// embeddings con el contenido del Excel (que está en ese idioma).
const CONDENSE_SYSTEM = {
  es: `Reescribe el ÚLTIMO mensaje del usuario como una pregunta autónoma y breve en español, resolviendo referencias como "eso", "esas palabras", "y entonces", "y a qué edad" con el tema del historial.
REGLAS:
- NUNCA respondas la pregunta ni des información; tu única tarea es REESCRIBIRLA.
- Devuelve SOLO la pregunta reformulada, sin comillas ni explicaciones.
- Conserva la intención real; no agregues temas que el usuario no tocó.
- Si el mensaje ya es una pregunta autónoma o no se relaciona con el historial, devuélvelo tal cual.`,
  pt: `Reescreva a ÚLTIMA mensagem do usuário como uma pergunta autônoma e breve em português do Brasil, resolvendo referências como "isso", "essas palavras", "e então", "e com que idade" com o tema do histórico.
REGRAS:
- NUNCA responda à pergunta nem dê informações; sua única tarefa é REESCREVÊ-LA.
- Devolva APENAS a pergunta reformulada, sem aspas nem explicações.
- Preserve a intenção real; não acrescente temas que o usuário não mencionou.
- Se a mensagem já for uma pergunta autônoma ou não se relacionar com o histórico, devolva-a como está.`,
};

function condenseSystem(countryCode) {
  return CONDENSE_SYSTEM[getLang(countryCode)] || CONDENSE_SYSTEM.es;
}

module.exports = {
  getLang,
  langDirective,
  strings,
  stepSummarySystem,
  condenseSystem,
};
