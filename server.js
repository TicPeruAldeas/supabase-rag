require("dotenv").config({ quiet: true });

const express = require("express");
const { askAI, saveConversationTurn } = require("./rag-service");

const app = express();
app.use(express.json());

app.post("/ask", async (req, res) => {
  try {
    const { question, country_code, user_id } = req.body;

    if (!question) {
      return res.status(400).json({ error: "Falta question" });
    }

    if (!user_id) {
      return res.status(400).json({ error: "Falta user_id" });
    }

    const countryCode = country_code || "PE";

    await saveConversationTurn(user_id, countryCode, "user", question);

    const response = await askAI(user_id, countryCode, question);

    await saveConversationTurn(user_id, countryCode, "assistant", response);

    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});