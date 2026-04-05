import type { ExecutedPageExtraction, SignatureBlockExtraction } from '../types';

async function postGemini<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 503) {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: string };
      detail = j.error ?? '';
    } catch {
      /* ignore */
    }
    throw new Error(detail || 'Gemini is not configured on the server (set GEMINI_API_KEY).');
  }

  if (!res.ok) {
    let detail = await res.text();
    try {
      const j = JSON.parse(detail) as { error?: string; detail?: string };
      detail = j.detail ?? j.error ?? detail;
    } catch {
      /* use raw text */
    }
    throw new Error(`Gemini API error (${res.status}): ${detail}`);
  }

  return res.json() as Promise<T>;
}

export const analyzePage = async (
  base64Image: string,
  modelName: string = 'gemini-2.5-flash',
): Promise<SignatureBlockExtraction> => {
  try {
    return await postGemini<SignatureBlockExtraction>('/api/gemini/analyze-signature-page', {
      base64Image,
      modelName,
    });
  } catch (error) {
    console.error('Gemini Analysis Error:', error);
    return { isSignaturePage: false, signatures: [] };
  }
};

export const analyzeExecutedPage = async (
  base64Image: string,
  modelName: string = 'gemini-2.5-flash',
): Promise<ExecutedPageExtraction> => {
  try {
    return await postGemini<ExecutedPageExtraction>('/api/gemini/analyze-executed-page', {
      base64Image,
      modelName,
    });
  } catch (error) {
    console.error('Gemini Executed Page Analysis Error:', error);
    return { isExecuted: false, documentName: '', signatures: [] };
  }
};
