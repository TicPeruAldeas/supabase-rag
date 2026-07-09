// Panel de administración: visor de conversaciones estilo WhatsApp.
// Se monta en /admin. Protegido con Basic Auth (contraseña = ADMIN_PASSWORD,
// o INGEST_SECRET como respaldo). Solo lectura sobre conversations.
const path = require("path");
const crypto = require("crypto");
const express = require("express");

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = function createAdminRouter(supabase) {
  const router = express.Router();

  // ── Basic Auth para todo /admin ──
  router.use((req, res, next) => {
    const password = process.env.ADMIN_PASSWORD || process.env.INGEST_SECRET;
    if (!password) {
      return res.status(503).send("Panel no disponible: define ADMIN_PASSWORD.");
    }
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString();
      const pass = decoded.slice(decoded.indexOf(":") + 1);
      if (safeEqual(pass, password)) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Aldeas Admin"');
    return res.status(401).send("Autenticación requerida");
  });

  // ── Página ──
  router.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "admin.html"));
  });

  // ── Lista de personas (último mensaje + fecha + conteo) ──
  router.get("/api/users", async (_req, res) => {
    const { data, error } = await supabase
      .from("conversations")
      .select("user_id,country_code,role,message,created_at")
      .in("role", ["user", "assistant"])
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

  return router;
};
