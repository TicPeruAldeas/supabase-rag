// ============================================================
// RAG Flow Presentation — Aldeas Infantiles SOS
// ============================================================
const pptxgen = require("pptxgenjs");

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.title = "Arquitectura RAG — Aldeas Infantiles SOS";

// Palette
const C = {
  navy:    "0A2342",
  blue:    "065A82",
  teal:    "1C7293",
  mint:    "02C39A",
  white:   "FFFFFF",
  lightBg: "EEF2F7",
  cardBg:  "FFFFFF",
  txt:     "1E293B",
  gray:    "64748B",
  orange:  "E06C00",
  purple:  "6D28D9",
  green:   "047857",
  red:     "B91C1C",
  pink:    "9D174D",
};

const FONT = "Calibri";
const W = 10, H = 5.625;

// ── Helpers ──────────────────────────────────────────────────

function mkShadow() {
  return { type: "outer", color: "000000", blur: 8, offset: 2, angle: 135, opacity: 0.12 };
}

function header(slide, title, subtitle) {
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: W, h: 0.72,
    fill: { color: C.navy }, line: { color: C.navy },
  });
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 0.09, h: 0.72,
    fill: { color: C.mint }, line: { color: C.mint },
  });
  slide.addText(title, {
    x: 0.28, y: 0, w: 6.5, h: 0.72,
    fontSize: 22, color: C.white, bold: true, valign: "middle",
    fontFace: FONT, margin: 0,
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: 6.5, y: 0, w: 3.3, h: 0.72,
      fontSize: 10, color: "99BBCC", align: "right", valign: "middle",
      fontFace: FONT, margin: 0,
    });
  }
}

function box(slide, label, x, y, w, h, fillColor, textColor, fontSize) {
  fontSize = fontSize || 10.5;
  textColor = textColor || C.white;
  slide.addShape(pres.shapes.RECTANGLE, {
    x, y, w, h,
    fill: { color: fillColor },
    line: { color: fillColor },
    shadow: mkShadow(),
  });
  slide.addText(label, {
    x, y, w, h,
    fontSize, color: textColor, bold: true,
    align: "center", valign: "middle",
    fontFace: FONT, margin: 0,
  });
}

function boxOutline(slide, label, x, y, w, h, borderColor, textColor, fontSize) {
  fontSize = fontSize || 10;
  textColor = textColor || C.txt;
  slide.addShape(pres.shapes.RECTANGLE, {
    x, y, w, h,
    fill: { color: C.white },
    line: { color: borderColor, width: 1.5 },
    shadow: mkShadow(),
  });
  slide.addText(label, {
    x, y, w, h,
    fontSize, color: textColor, bold: true,
    align: "center", valign: "middle",
    fontFace: FONT, margin: 0,
  });
}

function hLine(slide, x, y, w, color) {
  color = color || C.navy;
  slide.addShape(pres.shapes.LINE, {
    x, y, w, h: 0,
    line: { color, width: 1.8 },
  });
}

function vLine(slide, x, y, h, color) {
  color = color || C.navy;
  slide.addShape(pres.shapes.LINE, {
    x, y, w: 0, h,
    line: { color, width: 1.8 },
  });
}

function arrowH(slide, x, y, w, color) {
  color = color || C.navy;
  hLine(slide, x, y, w - 0.18, color);
  slide.addText("▶", {
    x: x + w - 0.22, y: y - 0.13, w: 0.22, h: 0.26,
    fontSize: 9, color, margin: 0,
  });
}

function arrowV(slide, x, y, h, color) {
  color = color || C.navy;
  vLine(slide, x, y, h - 0.16, color);
  slide.addText("▼", {
    x: x - 0.11, y: y + h - 0.22, w: 0.22, h: 0.22,
    fontSize: 9, color, margin: 0,
  });
}

function arrowLeft(slide, x, y, w, color) {
  color = color || C.navy;
  hLine(slide, x + 0.18, y, w - 0.18, color);
  slide.addText("◀", {
    x: x, y: y - 0.13, w: 0.22, h: 0.26,
    fontSize: 9, color, margin: 0,
  });
}

function label(slide, txt, x, y, w, color, fontSize) {
  color = color || C.gray;
  fontSize = fontSize || 8.5;
  slide.addText(txt, {
    x, y, w, h: 0.22,
    fontSize, color, align: "center", fontFace: FONT, margin: 0,
  });
}


// ══════════════════════════════════════════════════════════════
// SLIDE 1 — Title
// ══════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.navy };

  // Left accent bar
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 0.18, h: H,
    fill: { color: C.mint }, line: { color: C.mint },
  });
  // Top thin bar
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.18, y: 0, w: W - 0.18, h: 0.07,
    fill: { color: C.teal }, line: { color: C.teal },
  });
  // Bottom strip
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: H - 0.55, w: W, h: 0.55,
    fill: { color: C.teal }, line: { color: C.teal },
  });

  s.addText("ALDEAS INFANTILES SOS", {
    x: 0.5, y: 0.55, w: 9.2, h: 0.38,
    fontSize: 11, color: C.mint, bold: true,
    charSpacing: 5, fontFace: FONT, margin: 0,
  });
  s.addText("Arquitectura del Sistema RAG", {
    x: 0.5, y: 1.05, w: 9.2, h: 1.3,
    fontSize: 44, color: C.white, bold: true,
    fontFace: FONT, margin: 0,
  });
  s.addText("Flujo de servicios y procesamiento del chatbot WhatsApp multi-país", {
    x: 0.5, y: 2.55, w: 9.2, h: 0.55,
    fontSize: 16, color: "9FC8DC",
    fontFace: FONT, margin: 0,
  });

  // Tech badges
  const badges = [
    { txt: "Claude Sonnet 4.6",      color: C.purple },
    { txt: "OpenAI Embeddings",       color: C.green  },
    { txt: "Supabase pgvector",       color: C.teal   },
    { txt: "Meta Cloud API",          color: C.orange },
    { txt: "Railway · Node.js",       color: C.blue   },
  ];
  const bW = 1.72, bH = 0.42, bGap = 0.18, bStartX = 0.5, bY = 3.35;
  badges.forEach((b, i) => {
    const bx = bStartX + i * (bW + bGap);
    s.addShape(pres.shapes.RECTANGLE, {
      x: bx, y: bY, w: bW, h: bH,
      fill: { color: b.color, transparency: 25 },
      line: { color: b.color, width: 1.2 },
    });
    s.addText(b.txt, {
      x: bx, y: bY, w: bW, h: bH,
      fontSize: 10, color: C.white, align: "center", valign: "middle",
      fontFace: FONT, margin: 0,
    });
  });

  s.addText("RAG · WhatsApp · Multi-País · Langfuse Observabilidad", {
    x: 0.5, y: H - 0.55, w: 9.2, h: 0.55,
    fontSize: 10, color: "CCE8F0", align: "center", valign: "middle",
    fontFace: FONT, margin: 0,
  });
}


// ══════════════════════════════════════════════════════════════
// SLIDE 2 — Stack de Servicios
// ══════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.lightBg };
  header(s, "Stack de Servicios", "Todos los componentes del sistema RAG");

  const services = [
    { name: "Meta Cloud API",    role: "ENTRADA / SALIDA",   desc: "WhatsApp Business\nWebhook + envío de mensajes",       color: C.orange  },
    { name: "Railway · Node.js", role: "INFRAESTRUCTURA",    desc: "Hosting del servidor\nExpress 5 · server.js",           color: C.blue    },
    { name: "OpenAI",            role: "EMBEDDINGS",         desc: "text-embedding-3-small\nVectoriza preguntas del usuario", color: C.green   },
    { name: "Anthropic Claude",  role: "MODELO LLM",         desc: "claude-sonnet-4-6\nGenera y reformula respuestas",       color: C.purple  },
    { name: "Supabase",          role: "BASE DE DATOS",      desc: "PostgreSQL + pgvector\nKnowledge + historial + estado",  color: C.teal    },
    { name: "Langfuse v5",       role: "OBSERVABILIDAD",     desc: "OTel · Trazas completas\nCostos, métricas, sesiones",   color: C.orange  },
    { name: "Google Sheets",     role: "FUENTE DE DATOS",    desc: "Base de conocimiento Q&A\nFlows: informativa / paso-a-paso", color: C.green   },
    { name: "Make (Integromat)", role: "AUTOMATIZACIÓN",     desc: "Integra Sheets → /ingest-row\nActualización en tiempo real", color: C.pink    },
  ];

  const cols = 4;
  const cW = 2.2, cH = 1.72;
  const gX = 0.22, gY = 0.18;
  const sX = 0.3, sY = 0.9;

  services.forEach((svc, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = sX + col * (cW + gX);
    const y = sY + row * (cH + gY);

    // Card
    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w: cW, h: cH,
      fill: { color: C.white },
      line: { color: "DDE3EA", width: 0.6 },
      shadow: mkShadow(),
    });
    // Left accent bar
    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w: 0.07, h: cH,
      fill: { color: svc.color }, line: { color: svc.color },
    });
    // Top tint
    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w: cW, h: 0.42,
      fill: { color: svc.color, transparency: 88 },
      line: { color: svc.color, transparency: 85, width: 0.5 },
    });

    s.addText(svc.role, {
      x: x + 0.14, y: y + 0.07, w: cW - 0.2, h: 0.28,
      fontSize: 7.5, color: svc.color, bold: true,
      charSpacing: 1.5, fontFace: FONT, margin: 0,
    });
    s.addText(svc.name, {
      x: x + 0.14, y: y + 0.46, w: cW - 0.2, h: 0.38,
      fontSize: 13, color: C.txt, bold: true,
      fontFace: FONT, margin: 0,
    });
    s.addText(svc.desc, {
      x: x + 0.14, y: y + 0.88, w: cW - 0.2, h: 0.76,
      fontSize: 9.5, color: C.gray,
      fontFace: FONT, margin: 0,
    });
  });
}


// ══════════════════════════════════════════════════════════════
// SLIDE 3 — Flujo General del Sistema (End-to-End)
// ══════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.lightBg };
  header(s, "Flujo General del Sistema", "End-to-end · Mensaje WhatsApp → Respuesta");

  // ─── ROW 1: REQUEST PATH (left → right) ───────────────────
  // [Usuario WA] → [Meta Cloud API] → [Railway server.js] → [Dedup + Serial] → [askAI()]
  const r1y = 1.05;    // top of row1 boxes
  const bh = 0.92;     // box height
  const bw = 1.62;     // box width
  const gap = 0.28;    // gap between boxes
  const sx = 0.35;     // start x
  const midY = r1y + bh / 2; // vertical center of row1

  const row1 = [
    { lbl: "👤 Usuario\nWhatsApp",    color: C.green  },
    { lbl: "📱 Meta\nCloud API",      color: C.orange },
    { lbl: "🚂 Railway\nserver.js",   color: C.blue   },
    { lbl: "🔒 Dedup +\nSerialización", color: C.teal  },
    { lbl: "🧠 askAI()\nRAG Service", color: C.navy   },
  ];

  row1.forEach((b, i) => {
    const x = sx + i * (bw + gap);
    box(s, b.lbl, x, r1y, bw, bh, b.color, C.white, 10);
    if (i < row1.length - 1) {
      arrowH(s, x + bw, midY, gap, C.navy);
    }
  });

  // Step labels above row1
  const s1labels = ["1. Envía mensaje", "2. Webhook POST", "3. Valida firma", "4. Serializa cola", "5. Procesa RAG"];
  s1labels.forEach((lbl, i) => {
    label(s, lbl, sx + i * (bw + gap), r1y - 0.24, bw, C.gray, 8);
  });

  // ─── VERTICAL ARROW: askAI → data layer ────────────────────
  const askAIx = sx + 4 * (bw + gap); // x of askAI box
  const askAImidX = askAIx + bw / 2;
  const r2y = 3.0;
  const gap12 = r2y - (r1y + bh);

  vLine(s, askAImidX, r1y + bh, gap12 - 0.15, C.navy);
  s.addText("▼", {
    x: askAImidX - 0.11, y: r1y + bh + gap12 - 0.24, w: 0.22, h: 0.22,
    fontSize: 9, color: C.navy, margin: 0,
  });

  // ─── ROW 2: DATA + RESPONSE PATH (right → left) ──────────
  // [OpenAI Embed] ← [Supabase] ← [Claude LLM] ← [Respuesta] ← [Usuario ✓]
  // Positioned at same x as row1 (so askAI aligns with rightmost box)
  const r2bh = 0.88;
  const r2midY = r2y + r2bh / 2;

  const row2 = [
    { lbl: "🔢 OpenAI\nEmbeddings",   color: C.green  },
    { lbl: "🗄️ Supabase\npgvector",   color: C.teal   },
    { lbl: "🤖 Anthropic\nClaude",    color: C.purple },
    { lbl: "🛡️ Guardrail\n+ Sanitize", color: C.red    },
    { lbl: "✅ Usuario\nResponde",     color: C.green  },
  ];

  row2.forEach((b, i) => {
    const x = sx + i * (bw + gap);
    box(s, b.lbl, x, r2y, bw, r2bh, b.color, C.white, 10);
    if (i < row2.length - 1) {
      // arrows go right to left: draw ← arrows
      arrowLeft(s, x + bw + 0.01, r2midY, gap - 0.01, C.navy);
    }
  });

  // Step labels below row2
  const s2labels = ["6. Embedding", "7. Búsqueda vectorial", "8. Genera respuesta", "9. Valida datos", "10. Envía WA"];
  s2labels.forEach((lbl, i) => {
    label(s, lbl, sx + i * (bw + gap), r2y + r2bh + 0.06, bw, C.gray, 8);
  });

  // ─── ZONE LABELS ───────────────────────────────────────────
  s.addText("ENTRADA & PROCESAMIENTO →", {
    x: sx, y: r1y + bh + 0.04, w: 7.5, h: 0.2,
    fontSize: 7.5, color: C.teal, bold: true, charSpacing: 1.5,
    fontFace: FONT, margin: 0,
  });
  s.addText("← DATOS, GENERACIÓN & RESPUESTA", {
    x: sx, y: r2y - 0.24, w: 7.5, h: 0.2,
    fontSize: 7.5, color: C.purple, bold: true, charSpacing: 1.5,
    fontFace: FONT, margin: 0,
  });
}


// ══════════════════════════════════════════════════════════════
// SLIDE 4 — Pipeline RAG: Prioridades de askAI()
// ══════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.lightBg };
  header(s, "Pipeline RAG — Prioridades de askAI()", "6 rutas en cascada · Solo la primera que aplica se ejecuta");

  // Layout: 6 priority lanes side by side
  // Each lane: number badge + decision diamond + outcome box
  const lanes = [
    { num: "0", decision: "¿Flujo\nactivo?",    outcome: "handlePasoAPaso()\n/ location followup", color: C.teal,   note: "conversation_state" },
    { num: "1", decision: "¿Small\ntalk?",       outcome: "Saludo estático\nde bienvenida",          color: C.blue,   note: "Regex SMALL_TALK"   },
    { num: "2", decision: "¿Mensaje\nde cierre?", outcome: "Despedida\ncálida",                      color: C.mint,   note: "Regex CLOSING"      },
    { num: "3", decision: "¿En\ncaché?",         outcome: "Respuesta\nen memoria",                   color: C.orange, note: "TTL 10 min / userId" },
    { num: "4", decision: "¿Vago?",              outcome: "generateClarification\n(Claude)",          color: C.purple, note: "Regex VAGUE"        },
    { num: "5", decision: "searchFlow()\npgvector",outcome: "presentFlowWithLLM\no paso a paso",     color: C.navy,   note: "sim ≥ 0.45 / Excel"  },
  ];

  const lW = 1.52, lGap = 0.1;
  const lSX = 0.18;
  const lSY = 0.85;

  // Input box at top spanning full width
  box(s, "📩  Mensaje entrante del usuario", lSX, lSY, 9.6, 0.42, C.navy, C.white, 11);

  lanes.forEach((lane, i) => {
    const x = lSX + i * (lW + lGap);

    // Vertical line from input to number badge
    vLine(s, x + lW / 2, lSY + 0.42, 0.2, lane.color);

    // Number badge (circle-like small square)
    s.addShape(pres.shapes.RECTANGLE, {
      x: x + lW / 2 - 0.22, y: lSY + 0.62, w: 0.44, h: 0.3,
      fill: { color: lane.color }, line: { color: lane.color },
    });
    s.addText(`P${lane.num}`, {
      x: x + lW / 2 - 0.22, y: lSY + 0.62, w: 0.44, h: 0.3,
      fontSize: 9, color: C.white, bold: true,
      align: "center", valign: "middle", fontFace: FONT, margin: 0,
    });

    // Vertical line to decision box
    vLine(s, x + lW / 2, lSY + 0.92, 0.15, lane.color);

    // Decision box
    boxOutline(s, lane.decision, x, lSY + 1.07, lW, 0.7, lane.color, lane.color, 9);

    // Vertical line to outcome
    vLine(s, x + lW / 2, lSY + 1.77, 0.2, lane.color);

    // "SÍ" label
    s.addText("SÍ ▼", {
      x: x + lW / 2 + 0.02, y: lSY + 1.78, w: 0.4, h: 0.18,
      fontSize: 7, color: lane.color, bold: true, fontFace: FONT, margin: 0,
    });

    // Outcome box (filled, result)
    box(s, lane.outcome, x, lSY + 1.97, lW, 0.78, lane.color, C.white, 8.5);

    // Note at bottom
    s.addText(lane.note, {
      x, y: lSY + 2.82, w: lW, h: 0.28,
      fontSize: 7, color: C.gray, align: "center",
      fontFace: FONT, margin: 0,
    });
  });

  // Fallback arrow for P5 "NO match"
  const p5x = lSX + 5 * (lW + lGap);
  const fallbackY = lSY + 1.07 + 0.7 + 0.1;
  s.addText('NO → Fallback "canales oficiales"', {
    x: p5x - 3.2, y: fallbackY, w: 3.1, h: 0.22,
    fontSize: 8, color: C.red, bold: true, align: "right",
    fontFace: FONT, margin: 0,
  });

  // Bottom note
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: H - 0.36, w: W, h: 0.36,
    fill: { color: C.navy }, line: { color: C.navy },
  });
  s.addText("El caché (P3) nunca almacena respuestas de flows con seguimiento de ubicación · El flujo activo (P0) expira tras 30 min de inactividad", {
    x: 0.3, y: H - 0.36, w: 9.4, h: 0.36,
    fontSize: 8.5, color: "99BBCC", align: "center", valign: "middle",
    fontFace: FONT, margin: 0,
  });
}


// ══════════════════════════════════════════════════════════════
// SLIDE 5 — Ingestión de Conocimiento
// ══════════════════════════════════════════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: C.lightBg };
  header(s, "Ingestión de Conocimiento", "Google Sheets → Supabase · vía Make + /ingest-row");

  // Main pipeline: horizontal, 5 steps
  const steps = [
    { lbl: "📋 Google Sheets\n(Base de datos Q&A)",  color: C.green,  sub: "Categoría · Subtema\nPregunta · Respuesta · Tipo" },
    { lbl: "⚙️ Make\n(Automatización)",               color: C.pink,   sub: "Trigger: fila nueva\no actualizada en Sheets"    },
    { lbl: "🔌 POST /ingest-row\n(Railway API)",       color: C.blue,   sub: "Autenticado con\nBEARER INGEST_SECRET"           },
    { lbl: "🔢 OpenAI Embeddings\ntext-embedding-3-small", color: C.green, sub: "Vectoriza el campo\nPregunta → 1536 dims"    },
    { lbl: "🗄️ Supabase\nknowledge_flows",            color: C.teal,   sub: "Upsert con\nflow_id + country_code"             },
  ];

  const sW = 1.72, sH = 1.05;
  const sGap = 0.3;
  const sSX = 0.35;
  const sSY = 1.1;
  const sMidY = sSY + sH / 2;

  steps.forEach((st, i) => {
    const x = sSX + i * (sW + sGap);
    box(s, st.lbl, x, sSY, sW, sH, st.color, C.white, 9.5);
    label(s, st.sub, x, sSY + sH + 0.08, sW, C.gray, 7.8);
    if (i < steps.length - 1) {
      arrowH(s, x + sW, sMidY, sGap, C.navy);
    }
  });

  // Step numbers
  steps.forEach((_, i) => {
    const x = sSX + i * (sW + sGap);
    label(s, `Paso ${i + 1}`, x, sSY - 0.24, sW, C.navy, 8.5);
  });

  // ─── BRANCH: "paso a paso" → processStepsInBackground ──────
  // From step 5 (Supabase) vertically down, branching to Claude + knowledge_steps
  const step5X = sSX + 4 * (sW + sGap);
  const branchY = sSY + sH + 0.5;

  // Decision diamond (emulated as a rectangle with question)
  s.addShape(pres.shapes.RECTANGLE, {
    x: step5X, y: branchY, w: sW, h: 0.56,
    fill: { color: C.navy, transparency: 85 },
    line: { color: C.navy, width: 1.2 },
  });
  s.addText("¿Tipo = paso a paso?", {
    x: step5X, y: branchY, w: sW, h: 0.56,
    fontSize: 8.5, color: C.navy, bold: true,
    align: "center", valign: "middle", fontFace: FONT, margin: 0,
  });

  vLine(s, step5X + sW / 2, sSY + sH, branchY - (sSY + sH) - 0.05, C.navy);
  s.addText("▼", {
    x: step5X + sW / 2 - 0.11, y: branchY - 0.22, w: 0.22, h: 0.22,
    fontSize: 9, color: C.navy, margin: 0,
  });

  // SÍ branch → background processing
  const bgY = branchY + 0.56 + 0.22;
  vLine(s, step5X + sW / 2, branchY + 0.56, 0.22, C.purple);
  s.addText("SÍ ▼", {
    x: step5X + sW / 2 + 0.04, y: branchY + 0.6, w: 0.35, h: 0.18,
    fontSize: 7, color: C.purple, bold: true, fontFace: FONT, margin: 0,
  });

  box(s, "🔄 processStepsInBackground()\nRailway (async, sin bloquear)", sSX, bgY, 3.8, 0.72, C.purple, C.white, 9);
  arrowH(s, sSX + 3.8, bgY + 0.36, 0.35, C.purple);
  box(s, "🤖 Claude\nResume cada paso", sSX + 3.8 + 0.35, bgY, 2.0, 0.72, C.purple, C.white, 9);
  arrowH(s, sSX + 3.8 + 0.35 + 2.0, bgY + 0.36, 0.35, C.teal);
  box(s, "🗄️ Supabase\nknowledge_steps", sSX + 3.8 + 0.35 + 2.0 + 0.35, bgY, 2.0, 0.72, C.teal, C.white, 9);

  // Line from decision to bgY row
  hLine(s, sSX + sW, bgY + 0.36, step5X - (sSX + sW + 0.35), C.purple);
  s.addText("▶", {
    x: step5X - 0.22, y: bgY + 0.36 - 0.13, w: 0.22, h: 0.26,
    fontSize: 9, color: C.purple, margin: 0,
  });
  // Vertical from decision to hline
  vLine(s, sSX + sW / 2 + (step5X - (sSX + sW)), bgY + 0.36, branchY + 0.28 - bgY - 0.36, C.purple);
  // ... actually let me just draw a cleaner vertical from decision left side
  // Redraw: from step5X + sW/2 going down is already there.
  // Left horizontal from (step5X+sW/2) to beginning of bgRow
  const branchMidY = bgY + 0.36;
  const decisionMidX = step5X + sW / 2;
  // Vertical from bottom of decision to branchMidY
  vLine(s, decisionMidX, branchY + 0.56, branchMidY - branchY - 0.56 + 0.05, C.purple);
  // Horizontal from decisionMidX left to start of bg row
  hLine(s, sSX + 3.8, branchMidY, decisionMidX - (sSX + 3.8), C.purple);

  // NO branch label
  s.addText("NO → Solo knowledge_flows", {
    x: step5X - 2.5, y: branchY + 0.56 + 0.04, w: 2.4, h: 0.2,
    fontSize: 7.5, color: C.gray, align: "right", fontFace: FONT, margin: 0,
  });

  // Bottom bar
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: H - 0.32, w: W, h: 0.32,
    fill: { color: C.navy }, line: { color: C.navy },
  });
  s.addText("Los pasos se procesan en background para no bloquear el webhook de Make (evita timeout) · Upsert garantiza idempotencia en re-ingestiones", {
    x: 0.3, y: H - 0.32, w: 9.4, h: 0.32,
    fontSize: 8, color: "99BBCC", align: "center", valign: "middle",
    fontFace: FONT, margin: 0,
  });
}


// ── Write file ────────────────────────────────────────────────
pres.writeFile({ fileName: "RAG-Flow-AldeasSOS.pptx" })
  .then(() => console.log("✅ RAG-Flow-AldeasSOS.pptx generado"))
  .catch(err => { console.error("❌", err); process.exit(1); });
