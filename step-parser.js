// Convierte la celda "Respuesta" de un flow paso a paso en pasos numerados.
//
// Admite respuestas agrupadas en fases ("FASE 1: PAGOS", "Etapa 2 - ...") cuya
// numeración vuelve a empezar en cada fase. Los pasos se renumeran de forma
// continua (1..N) porque knowledge_steps es único por (flow, step_number): con
// la numeración original, los pasos de una fase pisaban a los de la anterior.
// El título de la fase y su texto introductorio se anteponen al primer paso de
// esa fase, y el texto previo al primer paso se antepone al paso 1, para que no
// se pierdan.

const PHASE_REGEX = /^(fase|etapa)\s+(\d+)\s*[:.\-–—]?\s*(.*)$/i;
const STEP_REGEX = /^(\d+)\.\s+(.+)/;

// "PRESENTA TU SOLICITUD" → "Presenta tu solicitud" (solo si viene en mayúsculas)
function sentenceCase(text) {
  const t = String(text || "").trim().replace(/[:.]+$/, "");
  if (!t || t !== t.toUpperCase()) return t;
  const lower = t.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function parseSteps(text) {
  const lines = String(text || "").split("\n").map(l => l.trim()).filter(Boolean);
  const totalPhases = lines.filter(l => PHASE_REGEX.test(l)).length;
  const steps = [];
  let current = null;
  let pending = []; // título de fase / texto que va antes del próximo paso
  let phaseCount = 0;

  for (const line of lines) {
    const phase = line.match(PHASE_REGEX);
    if (phase) {
      if (current) { steps.push(current); current = null; }
      phaseCount++;
      const name = sentenceCase(phase[3]);
      pending = [`Fase ${phaseCount} de ${totalPhases}${name ? ` — ${name}` : ""}.`];
      continue;
    }
    const step = line.match(STEP_REGEX);
    if (step) {
      if (current) steps.push(current);
      current = { text: [...pending, step[2]].join(" ") };
      pending = [];
    } else if (current) {
      current.text += " " + line;
    } else {
      pending.push(line);
    }
  }
  if (current) steps.push(current);
  return steps.map((s, i) => ({ number: i + 1, text: s.text }));
}

// Posición de cada paso dentro de su fase, leída del detalle guardado (el primer
// paso de cada fase empieza con "Fase X de Y — Nombre."). Recibe [{number, text}]
// y devuelve un Map number → {phase, totalPhases, name, local, localTotal}, o
// null si el proceso no tiene fases.
const PHASE_START = /^Fase (\d+) de (\d+)(?: — ([^.]*))?\./;

function phasePositions(steps) {
  const sorted = [...(steps || [])].sort((a, b) => a.number - b.number);
  if (!sorted.length || !PHASE_START.test(String(sorted[0].text || "").trim())) return null;
  const groups = [];
  for (const s of sorted) {
    const m = String(s.text || "").trim().match(PHASE_START);
    if (m) groups.push({ phase: Number(m[1]), totalPhases: Number(m[2]), name: (m[3] || "").trim(), numbers: [] });
    groups[groups.length - 1].numbers.push(s.number);
  }
  const positions = new Map();
  for (const g of groups) {
    g.numbers.forEach((n, i) => positions.set(n, {
      phase: g.phase, totalPhases: g.totalPhases, name: g.name, local: i + 1, localTotal: g.numbers.length,
    }));
  }
  return positions;
}

// "Paso 2 de 3" (dentro de su fase) o "Paso 5 de 9" si el proceso no tiene fases.
function stepLabel(number, total, phases) {
  const p = phases && phases.get(number);
  return p ? `Paso ${p.local} de ${p.localTotal}` : `Paso ${number} de ${total}`;
}

// "Fase 1 de 3: Pagos"
function phaseTitle(p) {
  return `Fase ${p.phase} de ${p.totalPhases}${p.name ? `: ${p.name}` : ""}`;
}

module.exports = { parseSteps, phasePositions, stepLabel, phaseTitle };
