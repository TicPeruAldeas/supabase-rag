require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function chunkText(text, chunkSize = 2000, overlap = 300) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start += chunkSize - overlap;
  }

  return chunks;
}

async function extractPdfText(fileBuffer) {
  const parser = new PDFParse({ data: fileBuffer });
  const result = await parser.getText();
  await parser.destroy();
  return result.text;
}

async function main() {
  const filePath = process.argv[2];
  const countryCode = process.argv[3];

  if (!filePath || !countryCode) {
    console.log('Uso: node ingest-pdf.js "files/tu-archivo.pdf" PE');
    process.exit(1);
  }

  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);

  const { data: countryExists, error: countryError } = await supabase
    .from("countries")
    .select("code")
    .eq("code", countryCode)
    .maybeSingle();

  if (countryError) {
    console.error("Error validando país:", countryError);
    process.exit(1);
  }

  if (!countryExists) {
    console.error(`El país ${countryCode} no existe en la tabla countries.`);
    process.exit(1);
  }

  const storagePath = `pdfs/${countryCode}/${Date.now()}-${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from(process.env.SUPABASE_BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType: "application/pdf",
      upsert: false,
    });

  if (uploadError) {
    console.error("Error subiendo archivo a Storage:", uploadError);
    process.exit(1);
  }

  console.log("PDF subido a Storage:", storagePath);

  const { data: docData, error: docError } = await supabase
    .from("documents")
    .insert({
      country_code: countryCode,
      source_name: fileName,
      storage_path: storagePath,
      mime_type: "application/pdf",
    })
    .select()
    .single();

  if (docError) {
    console.error("Error insertando documento:", docError);
    process.exit(1);
  }

  const documentId = docData.id;
  console.log("Documento registrado con ID:", documentId);

  const fullText = await extractPdfText(fileBuffer);

  if (!fullText || fullText.trim().length === 0) {
    console.error("No se pudo extraer texto del PDF.");
    process.exit(1);
  }

  console.log("Texto extraído correctamente.");

  const chunks = chunkText(fullText, 2000, 300);
  console.log(`Total de chunks: ${chunks.length}`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunk,
    });

    const embedding = embeddingResponse.data[0].embedding;

    const { error: chunkError } = await supabase
      .from("knowledge_chunks")
      .insert({
        document_id: documentId,
        country_code: countryCode,
        source_name: fileName,
        storage_path: storagePath,
        page_number: null,
        section: null,
        chunk_text: chunk,
        metadata: { chunk_index: i + 1 },
        embedding,
      });

    if (chunkError) {
      console.error(`Error insertando chunk ${i + 1}:`, chunkError);
      process.exit(1);
    }

    console.log(`Chunk ${i + 1}/${chunks.length} insertado.`);
  }

  console.log("Ingesta completada.");
}

main().catch((err) => {
  console.error("Error general:", err);
  process.exit(1);
});