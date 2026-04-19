import express from "express";
import dotenv from "dotenv";
import { exec } from "child_process";

dotenv.config();

const app = express();
app.use(express.json());

app.post("/ask", async (req, res) => {
  try {
    const { question, country_code } = req.body;

    const path = require("path");

    const cmd = `node ${path.join(__dirname, "ask-ai.js")} ${country_code || "PE"} "${question}"`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        return res.status(500).json({ error: stderr });
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