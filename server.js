require("dotenv").config({ quiet: true });

const express = require("express");
const { askAI } = require("./rag-service");

const app = express();
app.use(express.json());

app.post("/ask", async (req, res) => {
  try {
    const { question, country_code } = req.body;

    if (!question) {
      return res.status(400).json({ error: "Falta question" });
    }

    const response = await askAI(country_code || "PE", question);

    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});