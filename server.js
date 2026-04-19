const express = require("express");
const dotenv = require("dotenv");
const { execFile } = require("child_process");
const path = require("path");

dotenv.config();

const app = express();
app.use(express.json());

app.post("/ask", async (req, res) => {
  try {
    const { question, country_code } = req.body;

    if (!question) {
      return res.status(400).json({ error: "Falta question" });
    }

    const scriptPath = path.join(__dirname, "ask-ai.js");
    const args = [scriptPath, country_code || "PE", question];

    execFile(
      "node",
      args,
      {
        env: {
          ...process.env,
          SUPABASE_URL: process.env.SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          SUPABASE_BUCKET: process.env.SUPABASE_BUCKET,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          return res.status(500).json({
            error: stderr || error.message,
          });
        }

        res.json({ response: stdout });
      }
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
  console.log("SUPABASE_URL existe:", !!process.env.SUPABASE_URL);
  console.log("SUPABASE_SERVICE_ROLE_KEY existe:", !!process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.log("OPENAI_API_KEY existe:", !!process.env.OPENAI_API_KEY);
});