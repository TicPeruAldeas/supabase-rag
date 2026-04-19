const express = require("express");
const dotenv = require("dotenv");
const { exec } = require("child_process");
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

    const safeQuestion = String(question).replace(/"/g, '\\"');
    const cmd = `node "${path.join(__dirname, "ask-ai.js")}" ${country_code || "PE"} "${safeQuestion}"`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        return res.status(500).json({
          error: stderr || error.message,
        });
      }

      res.json({ response: stdout });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});