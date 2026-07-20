// Panel de administración: visor de conversaciones estilo WhatsApp.
// Se monta en /admin. Protegido con Basic Auth (contraseña = ADMIN_PASSWORD,
// o INGEST_SECRET como respaldo). Solo lectura sobre conversations.
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const XLSX = require("xlsx");

// Fecha legible en hora de Colombia/Perú (UTC-5). Si el entorno no soporta
// zonas horarias, cae a los primeros 16 caracteres del ISO.
function fmtFecha(iso) {
  try {
    return new Date(iso).toLocaleString("es-CO", {
      timeZone: "America/Bogota",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  } catch {
    return String(iso || "").replace("T", " ").slice(0, 16);
  }
}

// Traduce los códigos internos de ruta/evento a etiquetas legibles para el Excel.
const ROUTE_LABELS = {
  small_talk: "Saludo",
  closing: "Despedida",
  cache: "Respuesta en caché",
  clarification: "Pregunta de aclaración",
  flow_grounded_rewrite: "Respuesta de la base de conocimiento",
  flow_step_start: "Inicio de guía paso a paso",
  flow_step_without_steps: "Respuesta paso a paso",
  flow_location_followup: "Respuesta según la ciudad",
  fallback_no_excel: "Sin coincidencia en la base",
  active_flow_smalltalk: "Saludo (durante una guía)",
  active_flow_closing: "Despedida (durante una guía)",
  active_flow_decline: "El usuario decidió no continuar",
  active_step_continuation: "Siguiente paso de la guía",
  active_step_complex_message: "Consulta durante una guía",
};
const EVENT_LABELS = {
  consent_prompt: "Solicitud de consentimiento",
  consent_welcome: "Mensaje de bienvenida",
  consent_accept: "Aceptó el consentimiento",
};

function tipoRespuesta(md = {}) {
  if (md.route) return ROUTE_LABELS[md.route] || md.route;
  if (md.event) return EVENT_LABELS[md.event] || "";
  return "";
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Usuarios del panel, uno por persona, con alcance por país. Formato:
//   ADMIN_USERS="ana:clave1:CO,luis:clave2:PE|CO,jordan:clave3:*"
// El tercer campo es opcional (por defecto "*" = todos los países).
// Nota: las contraseñas no deben contener ":".
const COUNTRY_SPEC = /^(\*|[A-Za-z]{2}(\|[A-Za-z]{2})*)$/;

function loadAdminUsers() {
  const users = new Map();
  for (const entry of (process.env.ADMIN_USERS || "").split(",")) {
    const raw = entry.trim();
    if (!raw) continue;
    const parts = raw.split(":");
    if (parts.length < 2) continue;

    const user = parts[0].trim();
    const last = parts[parts.length - 1].trim();
    let pass, countriesRaw;
    // Si el último campo parece un país (CO, PE|CO, *), es el alcance.
    if (parts.length >= 3 && COUNTRY_SPEC.test(last)) {
      pass = parts.slice(1, -1).join(":").trim();
      countriesRaw = last;
    } else {
      pass = parts.slice(1).join(":").trim();
      countriesRaw = "*";
    }
    if (!user || !pass) continue;

    const countries = countriesRaw === "*"
      ? ["*"]
      : countriesRaw.split("|").map((c) => c.trim().toUpperCase()).filter(Boolean);
    users.set(user, { pass, countries });
  }
  return users;
}

// ¿El usuario puede ver este país?
function canAccess(countries, country) {
  if (!Array.isArray(countries)) return false;
  return countries.includes("*") || countries.includes(String(country || "").toUpperCase());
}

module.exports = function createAdminRouter(supabase) {
  const router = express.Router();

  const adminUsers = loadAdminUsers();
  // Respaldo de un solo acceso compartido (sin usuario). INGEST_SECRET es el
  // último recurso: NO debe compartirse porque también permite ingestar contenido.
  const sharedPassword = process.env.ADMIN_PASSWORD || process.env.INGEST_SECRET;

  if (adminUsers.size > 0) {
    const detalle = [...adminUsers.entries()]
      .map(([u, v]) => `${u}[${v.countries.join("|")}]`)
      .join(", ");
    console.log(`🔐 Panel /admin: ${adminUsers.size} usuario(s) — ${detalle}`);
  } else if (process.env.ADMIN_PASSWORD) {
    console.log("🔐 Panel /admin: contraseña compartida (ADMIN_PASSWORD). Considera usar ADMIN_USERS para accesos por persona.");
  } else if (sharedPassword) {
    console.warn("⚠️  Panel /admin usando INGEST_SECRET como contraseña. NO lo compartas: también da acceso a la ingesta. Define ADMIN_USERS o ADMIN_PASSWORD.");
  }

  // ── Basic Auth para todo /admin ──
  router.use((req, res, next) => {
    if (adminUsers.size === 0 && !sharedPassword) {
      return res.status(503).send("Panel no disponible: define ADMIN_USERS o ADMIN_PASSWORD.");
    }
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString();
      const i = decoded.indexOf(":");
      const user = i >= 0 ? decoded.slice(0, i) : "";
      const pass = i >= 0 ? decoded.slice(i + 1) : decoded;

      if (adminUsers.size > 0) {
        // Con usuarios configurados, el usuario debe coincidir además de la clave.
        const expected = adminUsers.get(user);
        if (expected && safeEqual(pass, expected.pass)) {
          req.adminUser = { name: user, countries: expected.countries };
          return next();
        }
      } else if (safeEqual(pass, sharedPassword)) {
        // Acceso compartido: sin restricción de país.
        req.adminUser = { name: user || "admin", countries: ["*"] };
        return next();
      }
    }
    res.set("WWW-Authenticate", 'Basic realm="Aldeas Admin"');
    return res.status(401).send("Autenticación requerida");
  });

  // ── Página ──
  router.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "admin.html"));
  });

  // ── Quién soy y qué países puedo ver ──
  router.get("/api/me", (req, res) => {
    res.json({ user: req.adminUser.name, countries: req.adminUser.countries });
  });

  // ── Lista de personas (último mensaje + fecha + conteo) ──
  router.get("/api/users", async (req, res) => {
    let query = supabase
      .from("conversations")
      .select("user_id,country_code,role,message,created_at")
      .in("role", ["user", "assistant"]);
    // Alcance por país: se filtra en la CONSULTA, no en la interfaz.
    if (!req.adminUser.countries.includes("*")) {
      query = query.in("country_code", req.adminUser.countries);
    }
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(5000);
    if (error) return res.status(500).json({ error: error.message });

    const byUser = new Map();
    for (const r of data) {
      const key = `${r.country_code}|${r.user_id}`;
      if (!byUser.has(key)) {
        byUser.set(key, {
          user_id: r.user_id,
          country_code: r.country_code,
          last_message: r.message,
          last_role: r.role,
          last_at: r.created_at,
          count: 0,
        });
      }
      byUser.get(key).count++;
    }
    const users = [...byUser.values()].sort((a, b) => new Date(b.last_at) - new Date(a.last_at));
    res.json({ users, capped: data.length >= 5000 });
  });

  // ── Hilo de una persona ──
  router.get("/api/thread", async (req, res) => {
    const user = req.query.user;
    const country = req.query.country || "PE";
    if (!user) return res.status(400).json({ error: "Falta el parámetro user" });
    if (!canAccess(req.adminUser.countries, country)) {
      return res.status(403).json({ error: `Sin acceso al país ${country}` });
    }

    const { data, error } = await supabase
      .from("conversations")
      .select("role,message,created_at,metadata")
      .eq("user_id", user)
      .eq("country_code", country)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: true })
      .limit(2000);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ user, country, turns: data });
  });

  // ── Exportar el hilo completo a Excel ──
  router.get("/api/export", async (req, res) => {
    const user = req.query.user;
    const country = req.query.country || "PE";
    if (!user) return res.status(400).json({ error: "Falta el parámetro user" });
    if (!canAccess(req.adminUser.countries, country)) {
      return res.status(403).json({ error: `Sin acceso al país ${country}` });
    }

    const { data, error } = await supabase
      .from("conversations")
      .select("role,message,created_at,source,metadata")
      .eq("user_id", user)
      .eq("country_code", country)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: true })
      .limit(10000);
    if (error) return res.status(500).json({ error: error.message });

    const rows = (data || []).map((t) => ({
      "Fecha y hora": fmtFecha(t.created_at),
      "Rol": t.role === "assistant" ? "Asistente" : "Usuario",
      "Mensaje": t.message || "",
      "Canal": t.source || "",
      "Tipo de respuesta": tipoRespuesta(t.metadata),
      "ID de contenido": t.metadata?.flow_id || "",
    }));

    const ws = XLSX.utils.json_to_sheet(rows, {
      header: ["Fecha y hora", "Rol", "Mensaje", "Canal", "Tipo de respuesta", "ID de contenido"],
    });
    ws["!cols"] = [{ wch: 18 }, { wch: 10 }, { wch: 90 }, { wch: 10 }, { wch: 34 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Conversacion");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const safeUser = String(user).replace(/[^\dA-Za-z]/g, "");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="chat_${country}_${safeUser}.xlsx"`);
    res.send(buf);
  });

  return router;
};
