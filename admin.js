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
    // Clave en minúsculas: el usuario no distingue mayúsculas al entrar.
    users.set(user.toLowerCase(), { name: user, pass, countries });
  }
  return users;
}

// ¿El usuario puede ver este país?
function canAccess(countries, country) {
  if (!Array.isArray(countries)) return false;
  return countries.includes("*") || countries.includes(String(country || "").toUpperCase());
}

// ── Contraseñas: scrypt (integrado en Node, sin dependencias) ──
// Formato almacenado: scrypt$<salt hex>$<hash hex>. Nunca se guarda en claro.
function hashPassword(pass) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pass), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(pass, stored) {
  const [alg, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  return safeEqual(crypto.scryptSync(String(pass), salt, 64).toString("hex"), hash);
}

// Normaliza el texto de países ("*", "CO", "PE|CO") a un arreglo.
function parseCountries(raw) {
  const value = String(raw || "*").trim();
  if (!value || value === "*") return ["*"];
  return value.split("|").map((c) => c.trim().toUpperCase()).filter(Boolean);
}

// ── Sesión por cookie firmada (para la pantalla de login) ─────
const SESSION_COOKIE = "aldeas_admin";
const SESSION_TTL_MS = (Number(process.env.ADMIN_SESSION_HOURS) || 8) * 60 * 60 * 1000;
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || process.env.INGEST_SECRET || "";

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySession(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    return payload.exp && Date.now() < payload.exp ? payload : null;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || null;
}

// ── Auditoría ─────────────────────────────────────────────────
// Escribe en la tabla admin_audit si existe; si no, deja rastro en los logs.
let auditTableOk = null; // null = aún no se sabe

async function audit(supabase, { user, action, country = null, target = null, ip = null, details = {} }) {
  const linea = `📋 AUDIT ${user || "?"} · ${action}${country ? " · " + country : ""}${target ? " · " + target : ""}`;
  if (auditTableOk === false) return void console.log(linea);

  const { error } = await supabase.from("admin_audit").insert({
    admin_user: user || null,
    action,
    country_code: country,
    target_user: target,
    ip,
    details,
  });

  if (error) {
    if (auditTableOk === null) {
      auditTableOk = false;
      console.warn(`⚠️  Tabla admin_audit no disponible (${error.message}). La auditoría quedará solo en los logs; corre la migración para persistirla.`);
    }
    console.log(linea);
  } else {
    auditTableOk = true;
  }
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
    console.log(`🔐 Panel /admin: usuario "${process.env.ADMIN_USER || "admin"}" + ADMIN_PASSWORD. Considera usar ADMIN_USERS para accesos por persona.`);
  } else if (sharedPassword) {
    console.warn(`⚠️  Panel /admin: usuario "${process.env.ADMIN_USER || "admin"}" + INGEST_SECRET como contraseña. NO lo compartas: también da acceso a la ingesta. Define ADMIN_USERS o ADMIN_PASSWORD.`);
  }

  // Valida usuario/clave y devuelve la identidad (nombre + países) o null.
  // Orden: 1) tabla admin_users  2) variable ADMIN_USERS  3) clave compartida.
  async function checkCredentials(user, pass) {
    if (user) {
      const { data, error } = await supabase
        .from("admin_users")
        .select("username,password_hash,countries,active")
        .ilike("username", user)
        .limit(1);
      if (!error && data && data.length > 0) {
        const row = data[0];
        if (row.active && verifyPassword(pass, row.password_hash)) {
          return { name: row.username, countries: parseCountries(row.countries) };
        }
        return null; // usuario existe en BD: no se cae al respaldo
      }
    }
    if (adminUsers.size > 0) {
      const found = adminUsers.get(String(user || "").toLowerCase());
      if (found && safeEqual(pass, found.pass)) return { name: found.name, countries: found.countries };
      return null;
    }
    if (sharedPassword) {
      // Modo de contraseña compartida: se valida TAMBIÉN el usuario (no entra
      // "cualquiera"). El usuario esperado es ADMIN_USER (por defecto "admin").
      const expectedUser = (process.env.ADMIN_USER || "admin").trim().toLowerCase();
      if (String(user || "").trim().toLowerCase() === expectedUser && safeEqual(pass, sharedPassword)) {
        return { name: process.env.ADMIN_USER || "admin", countries: ["*"] };
      }
    }
    return null;
  }

  function setSessionCookie(req, res, identity) {
    const token = signSession({ u: identity.name, c: identity.countries, exp: Date.now() + SESSION_TTL_MS });
    const secure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
    res.setHeader("Set-Cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/admin; HttpOnly; SameSite=Lax; ` +
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`);
  }

  // ── Pantalla de login (el link que se comparte) ──
  router.get("/login", (req, res) => {
    if (verifySession(parseCookies(req)[SESSION_COOKIE])) return res.redirect("/admin/");
    res.sendFile(path.join(__dirname, "admin-login.html"));
  });

  router.post("/login", async (req, res) => {
    const user = String(req.body?.user || "").trim();
    // .trim(): las claves largas se pegan a menudo con un espacio o salto de
    // línea al final, lo que hacía fallar el acceso sin motivo aparente.
    const pass = String(req.body?.password || "").trim();
    const identity = await checkCredentials(user, pass);
    if (!identity) {
      await audit(supabase, { user: user || "(vacío)", action: "login_fallido", ip: clientIp(req) });
      return res.redirect("/admin/login?error=1");
    }
    setSessionCookie(req, res, identity);
    await audit(supabase, { user: identity.name, action: "inicio_sesion", ip: clientIp(req), details: { countries: identity.countries } });
    res.redirect("/admin/");
  });

  router.get("/logout", (req, res) => {
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect("/admin/login");
  });

  // ── Autenticación: cookie de sesión, o Basic Auth como respaldo ──
  router.use(async (req, res, next) => {
    const sess = verifySession(parseCookies(req)[SESSION_COOKIE]);
    if (sess) {
      req.adminUser = { name: sess.u, countries: sess.c };
      return next();
    }
    const [scheme, encoded] = String(req.headers.authorization || "").split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString();
      const i = decoded.indexOf(":");
      const identity = await checkCredentials(i >= 0 ? decoded.slice(0, i) : "", i >= 0 ? decoded.slice(i + 1) : decoded);
      if (identity) {
        req.adminUser = identity;
        return next();
      }
    }
    // Sin sesión: las páginas van al login; las APIs devuelven 401.
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "No autorizado" });
    return res.redirect("/admin/login");
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

    audit(supabase, { user: req.adminUser.name, action: "ver_conversacion", country, target: user, ip: clientIp(req) });
    res.json({ user, country, turns: data });
  });

  // ── Gestión de usuarios (solo administradores generales, alcance *) ──
  function requireGeneralAdmin(req, res) {
    if (!req.adminUser.countries.includes("*")) {
      res.status(403).json({ error: "Solo los administradores generales pueden gestionar usuarios" });
      return false;
    }
    return true;
  }

  // Países disponibles: los configurados en el entorno + los presentes en datos.
  router.get("/api/countries", async (req, res) => {
    const set = new Set();
    for (const key of Object.keys(process.env)) {
      const m = key.match(/^WHATSAPP_PHONE_NUMBER_ID_([A-Z]{2})$/);
      if (m && process.env[key]) set.add(m[1]);
    }
    const { data } = await supabase.from("conversations").select("country_code").limit(2000);
    for (const r of data || []) if (r.country_code) set.add(String(r.country_code).toUpperCase());
    res.json({ countries: [...set].sort() });
  });

  router.get("/api/admin-users", async (req, res) => {
    if (!requireGeneralAdmin(req, res)) return;
    const { data, error } = await supabase
      .from("admin_users")
      .select("id,username,countries,active,created_at,updated_at")
      .order("username");
    if (error) return res.status(503).json({ error: "Falta la tabla admin_users. Corre la migración.", detail: error.message });
    res.json({ users: data, envFallback: adminUsers.size > 0 ? [...adminUsers.keys()] : [] });
  });

  router.post("/api/admin-users", async (req, res) => {
    if (!requireGeneralAdmin(req, res)) return;
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const countries = String(req.body?.countries || "*").trim();
    if (!username || !password) return res.status(400).json({ error: "Usuario y contraseña son obligatorios" });
    if (password.length < 8) return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres" });
    if (!COUNTRY_SPEC.test(countries)) return res.status(400).json({ error: 'Países inválidos. Usa "*", "CO" o "PE|CO"' });

    const { error } = await supabase.from("admin_users").insert({
      username, password_hash: hashPassword(password), countries: countries.toUpperCase() === "*" ? "*" : countries.toUpperCase(),
    });
    if (error) {
      const dup = /duplicate|unique/i.test(error.message);
      return res.status(dup ? 409 : 500).json({ error: dup ? "Ese usuario ya existe" : error.message });
    }
    audit(supabase, { user: req.adminUser.name, action: "usuario_creado", target: username, ip: clientIp(req), details: { countries } });
    res.json({ ok: true });
  });

  router.patch("/api/admin-users/:id", async (req, res) => {
    if (!requireGeneralAdmin(req, res)) return;
    const patch = {};
    if (req.body?.password) {
      if (String(req.body.password).length < 8) return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres" });
      patch.password_hash = hashPassword(String(req.body.password));
    }
    if (req.body?.countries !== undefined) {
      const c = String(req.body.countries).trim();
      if (!COUNTRY_SPEC.test(c)) return res.status(400).json({ error: 'Países inválidos. Usa "*", "CO" o "PE|CO"' });
      patch.countries = c.toUpperCase() === "*" ? "*" : c.toUpperCase();
    }
    if (req.body?.active !== undefined) patch.active = !!req.body.active;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "Nada que actualizar" });
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from("admin_users").update(patch).eq("id", req.params.id).select("username");
    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });
    audit(supabase, { user: req.adminUser.name, action: "usuario_actualizado", target: data[0].username, ip: clientIp(req), details: Object.keys(patch) });
    res.json({ ok: true });
  });

  router.delete("/api/admin-users/:id", async (req, res) => {
    if (!requireGeneralAdmin(req, res)) return;
    const { data: found } = await supabase.from("admin_users").select("username").eq("id", req.params.id).limit(1);
    const nombre = found?.[0]?.username;
    if (!nombre) return res.status(404).json({ error: "Usuario no encontrado" });
    // Evita que alguien se elimine a sí mismo y se quede fuera.
    if (String(nombre).toLowerCase() === String(req.adminUser.name).toLowerCase()) {
      return res.status(400).json({ error: "No puedes eliminar tu propio usuario" });
    }
    const { error } = await supabase.from("admin_users").delete().eq("id", req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    audit(supabase, { user: req.adminUser.name, action: "usuario_eliminado", target: nombre, ip: clientIp(req) });
    res.json({ ok: true });
  });

  // ── Bitácora de auditoría (solo usuarios con alcance total) ──
  router.get("/api/audit", async (req, res) => {
    if (!req.adminUser.countries.includes("*")) {
      return res.status(403).json({ error: "Solo disponible para administradores generales" });
    }
    const { data, error } = await supabase
      .from("admin_audit")
      .select("admin_user,action,country_code,target_user,ip,created_at")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return res.status(503).json({ error: "Bitácora no disponible: falta la tabla admin_audit", detail: error.message });
    res.json({ entries: data });
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

    audit(supabase, { user: req.adminUser.name, action: "descargar_excel", country, target: user, ip: clientIp(req), details: { filas: rows.length } });

    const safeUser = String(user).replace(/[^\dA-Za-z]/g, "");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="chat_${country}_${safeUser}.xlsx"`);
    res.send(buf);
  });

  // ── Exportar TODOS los mensajes de un periodo (último 1/3/6 meses) ──
  // Respeta el alcance por país del usuario. Pagina para no truncar en 1.000.
  router.get("/api/export-all", async (req, res) => {
    const months = [1, 3, 6].includes(Number(req.query.months)) ? Number(req.query.months) : 1;
    const desde = new Date();
    desde.setMonth(desde.getMonth() - months);
    const sinceIso = desde.toISOString();

    const PAGE = 1000;
    const MAX = 100000; // tope de seguridad
    const all = [];
    let from = 0;
    while (from < MAX) {
      let q = supabase
        .from("conversations")
        .select("user_id,country_code,role,message,created_at,source,metadata")
        .in("role", ["user", "assistant"])
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (!req.adminUser.countries.includes("*")) {
        q = q.in("country_code", req.adminUser.countries);
      }
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      all.push(...(data || []));
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }

    const rows = all.map((t) => ({
      "Fecha y hora": fmtFecha(t.created_at),
      "País": t.country_code || "",
      "Número": t.user_id || "",
      "Rol": t.role === "assistant" ? "Asistente" : "Usuario",
      "Mensaje": t.message || "",
      "Canal": t.source || "",
      "Tipo de respuesta": tipoRespuesta(t.metadata),
      "ID de contenido": t.metadata?.flow_id || "",
    }));

    const ws = XLSX.utils.json_to_sheet(rows, {
      header: ["Fecha y hora", "País", "Número", "Rol", "Mensaje", "Canal", "Tipo de respuesta", "ID de contenido"],
    });
    ws["!cols"] = [{ wch: 18 }, { wch: 7 }, { wch: 16 }, { wch: 10 }, { wch: 80 }, { wch: 10 }, { wch: 34 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Mensajes");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    audit(supabase, { user: req.adminUser.name, action: "descargar_excel_masivo", ip: clientIp(req), details: { meses: months, filas: rows.length } });

    const capped = all.length >= MAX;
    if (capped) res.setHeader("X-Export-Capped", "true");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="mensajes_${months}meses.xlsx"`);
    res.send(buf);
  });

  return router;
};
