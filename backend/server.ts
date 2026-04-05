import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeExecutedPageWithGemini,
  analyzeSignaturePageWithGemini,
  getGeminiApiKey,
} from './geminiAnalyze.js';

const app = express();

/** Large JSON bodies for base64 page images → Gemini */
const geminiJsonParser = express.json({ limit: '35mb' });
// Cloud Run sets PORT; local dev may use DOCX_CONVERTER_PORT
const port = Number(process.env.PORT || process.env.DOCX_CONVERTER_PORT || 8787);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Vite `dist/`: next to `backend/` when using `tsx`; two levels up when running compiled `backend/dist/server.js`. */
const distPath = (() => {
  const nextToBackend = path.resolve(__dirname, '../dist');
  if (fs.existsSync(path.join(nextToBackend, 'index.html'))) {
    return nextToBackend;
  }
  return path.resolve(__dirname, '../../dist');
})();
const graphBaseUrl = process.env.M365_GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

const requiredEnv = ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET', 'M365_USER_ID'] as const;

const requireConfig = () => {
  const missing = requiredEnv.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing M365 converter config: ${missing.join(', ')}`);
  }
  return {
    tenantId: process.env.M365_TENANT_ID!,
    clientId: process.env.M365_CLIENT_ID!,
    clientSecret: process.env.M365_CLIENT_SECRET!,
    userId: process.env.M365_USER_ID!,
    folder: process.env.M365_UPLOAD_FOLDER || 'SignaturePacketIDE-Temp',
  };
};

const getGraphToken = async (): Promise<string> => {
  const { tenantId, clientId, clientSecret } = requireConfig();
  const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Token request failed (${response.status}): ${detail}`);
  }

  const json = await response.json() as { access_token?: string };
  if (!json.access_token) {
    throw new Error('Token response missing access_token');
  }

  return json.access_token;
};

const buildUserDrivePathUrl = (userId: string, folder: string, fileName: string): string => {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fullPath = `${folder}/${randomUUID()}-${safeName}`;
  return `${graphBaseUrl}/users/${encodeURIComponent(userId)}/drive/root:/${fullPath}:/content`;
};

app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/api/gemini/health', (_req, res) => {
  res.status(200).json({ ok: true, geminiConfigured: Boolean(getGeminiApiKey()) });
});

app.post('/api/gemini/analyze-signature-page', geminiJsonParser, async (req, res) => {
  try {
    if (!getGeminiApiKey()) {
      res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server' });
      return;
    }
    const base64Image = req.body?.base64Image;
    if (typeof base64Image !== 'string' || !base64Image.trim()) {
      res.status(400).json({ error: 'Missing or invalid base64Image' });
      return;
    }
    const modelName =
      typeof req.body?.modelName === 'string' && req.body.modelName.trim()
        ? req.body.modelName.trim()
        : 'gemini-2.5-flash';
    const result = await analyzeSignaturePageWithGemini(base64Image, modelName);
    res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Gemini error';
    console.error('Gemini signature-page route failed:', message);
    res.status(500).json({ error: 'Gemini analysis failed', detail: message });
  }
});

app.post('/api/gemini/analyze-executed-page', geminiJsonParser, async (req, res) => {
  try {
    if (!getGeminiApiKey()) {
      res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server' });
      return;
    }
    const base64Image = req.body?.base64Image;
    if (typeof base64Image !== 'string' || !base64Image.trim()) {
      res.status(400).json({ error: 'Missing or invalid base64Image' });
      return;
    }
    const modelName =
      typeof req.body?.modelName === 'string' && req.body.modelName.trim()
        ? req.body.modelName.trim()
        : 'gemini-2.5-flash';
    const result = await analyzeExecutedPageWithGemini(base64Image, modelName);
    res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Gemini error';
    console.error('Gemini executed-page route failed:', message);
    res.status(500).json({ error: 'Gemini analysis failed', detail: message });
  }
});

app.post('/api/docx-to-pdf', upload.single('file'), async (req, res) => {
  try {
    const uploaded = req.file;
    if (!uploaded) {
      res.status(400).json({ error: 'No file uploaded. Use multipart/form-data with field "file".' });
      return;
    }

    const looksLikeDocx =
      uploaded.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      uploaded.originalname.toLowerCase().endsWith('.docx');

    if (!looksLikeDocx) {
      res.status(400).json({ error: 'Only .docx files are supported for this endpoint.' });
      return;
    }

    const token = await getGraphToken();
    const { userId, folder } = requireConfig();
    const uploadUrl = buildUserDrivePathUrl(userId, folder, uploaded.originalname);

    // 1) Upload DOCX to service account OneDrive
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': uploaded.mimetype || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      body: uploaded.buffer,
    });

    if (!uploadResponse.ok) {
      const detail = await uploadResponse.text();
      throw new Error(`Graph upload failed (${uploadResponse.status}): ${detail}`);
    }

    const uploadedItem = await uploadResponse.json() as { id?: string };
    if (!uploadedItem.id) {
      throw new Error('Graph upload response missing item id');
    }

    // 2) Request converted content as PDF
    const convertUrl =
      `${graphBaseUrl}/users/${encodeURIComponent(userId)}/drive/items/${encodeURIComponent(uploadedItem.id)}/content?format=pdf`;
    const pdfResponse = await fetch(convertUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!pdfResponse.ok) {
      const detail = await pdfResponse.text();
      throw new Error(`Graph conversion failed (${pdfResponse.status}): ${detail}`);
    }

    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());

    // 3) Best-effort cleanup of temp file
    const deleteUrl = `${graphBaseUrl}/users/${encodeURIComponent(userId)}/drive/items/${encodeURIComponent(uploadedItem.id)}`;
    void fetch(deleteUrl, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch((cleanupErr) => {
      console.warn('Cleanup warning:', cleanupErr);
    });

    const safeName = uploaded.originalname.replace(/\.docx$/i, '.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.status(200).send(pdfBuffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown conversion error';
    console.error('DOCX conversion failed:', message);
    res.status(500).json({ error: 'DOCX conversion failed', detail: message });
  }
});

// --- Production: serve Vite static app + SPA fallback (same origin as /api) ---
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api')) {
      next();
      return;
    }
    const indexFile = path.join(distPath, 'index.html');
    if (!fs.existsSync(indexFile)) {
      next();
      return;
    }
    res.sendFile(indexFile);
  });
}

// Unknown API paths → JSON 404 (avoid sending index.html for /api/*)
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(port, '0.0.0.0', () => {
  const mode = fs.existsSync(distPath) ? 'app + API' : 'API only';
  console.log(`Listening on 0.0.0.0:${port} (${mode})`);
});
