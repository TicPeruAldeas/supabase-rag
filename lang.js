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
    allStepsIntro: (total) => `Claro, este es el resumen de los ${total} pasos:`,
    allStepsOutro: () => `¿Quieres más detalle de alguno? Dime el número del paso.`,
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
    allStepsIntro: (total) => `Claro, este é o resumo dos ${total} passos:`,
    allStepsOutro: () => `Quer mais detalhes de algum? Me diga o número do passo.`,
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
  langDirective,
  strings,
  stepSummarySystem,
  analysisSystem,
};
