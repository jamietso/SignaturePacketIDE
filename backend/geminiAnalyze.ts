/**
 * Server-only Gemini calls. Uses GEMINI_API_KEY from the environment (e.g. Secret Manager on Cloud Run).
 *
 * **Important:** `@google/genai` reads `GOOGLE_GENAI_USE_VERTEXAI` from the environment. If it is `true`,
 * the client targets Vertex (`aiplatform.googleapis.com`), which does **not** accept API keys → 401.
 * We pass `vertexai: false` explicitly so API-key mode always uses the Gemini Developer API, even when
 * Cloud Run still has Vertex env vars from a prior deploy.
 *
 * Verbose extraction logging (PII-heavy): set DEBUG_GEMINI=1. Default is quiet for production logs.
 */
import { GoogleGenAI, Type, Schema } from '@google/genai';

const debugGemini = (): boolean => process.env.DEBUG_GEMINI === '1';

export interface SignatureBlockExtraction {
  isSignaturePage: boolean;
  signatures: Array<{
    partyName: string;
    signatoryName: string;
    capacity: string;
  }>;
}

export interface ExecutedPageExtraction {
  isExecuted: boolean;
  documentName: string;
  signatures: Array<{
    partyName: string;
    signatoryName: string;
    capacity: string;
  }>;
}

const SYSTEM_INSTRUCTION = `
You are a specialized legal AI assistant for transaction lawyers.
Your task is to analyze an image of a document page and identify if it is a "Signature Page" (or "Execution Page").

### CRITICAL DEFINITIONS FOR EXTRACTION

1. **PARTY**: The legal entity OR individual person who is a party to the contract.
   - For COMPANIES: Found in headings like "EXECUTED by ABC HOLDINGS LIMITED" or "ABC CORP:". The company name is the party.
   - For INDIVIDUALS: The label above the signature line (e.g. "KEY HOLDER:", "FOUNDER:", "GUARANTOR:", "INVESTOR:") is a ROLE, NOT the party name. The party is the INDIVIDUAL'S NAME printed below or beside the signature line.
   - NEVER use a role label like "Key Holder", "Founder", "Guarantor", "Investor" as the party name when a person's name is present.
   - If the only name present is a person's name (e.g. "John Smith"), use that as the party name.

2. **SIGNATORY**: The human being physically signing the page.
   - For companies: the named officer/director signing on behalf of the company (found under "Name:", "By:", or "Signed by:").
   - For individuals signing in their personal capacity: the signatory IS the same person as the party. Use their name for BOTH partyName and signatoryName.
   - A company name (e.g. "Acme Corp") can NEVER be a signatory.

3. **CAPACITY**: The role or authority of the signatory.
   - For company signatories: "Director", "CEO", "Authorised Signatory", "General Partner", etc.
   - For individuals signing personally: use the label from the block (e.g. "Key Holder", "Founder", "Guarantor") as the capacity, NOT as the party name.

### COMMON INDIVIDUAL SIGNATURE BLOCK PATTERN (very important):
\`\`\`
KEY HOLDER:

______________________________
John Smith
\`\`\`
→ partyName: "John Smith", signatoryName: "John Smith", capacity: "Key Holder"

### COMMON COMPANY SIGNATURE BLOCK PATTERN:
\`\`\`
ACME CORP:

By: ______________________________
Name: Jane Smith
Title: Director
\`\`\`
→ partyName: "Acme Corp", signatoryName: "Jane Smith", capacity: "Director"

### MULTI-LEVEL ENTITY SIGNATURE BLOCKS (funds, LPs, trusts)
Many entities sign through a chain of intermediaries. The pattern looks like:

\`\`\`
[ROLE LABEL] (if an entity):
Name of [Role]: [Top-Level Entity], L.P.
By: [Intermediate Entity], L.L.C., its general partner
  By: ______________________________
  Name: [Individual Name]
  Title: [Title]
\`\`\`

Rules for multi-level entities:
- The PARTY is always the TOP-LEVEL named entity (the fund, LP, or trust — e.g. "[Fund] IX, L.P.")
- The SIGNATORY is always the INDIVIDUAL PERSON who physically signs (the innermost "Name:" line)
- The CAPACITY should describe the signing chain, e.g. "Member of [GP Entity], L.L.C., its General Partner"
- The role label before the block (e.g. "HOLDER", "INVESTOR") is NOT the party name — it goes in capacity if relevant
- Look for "Name of Holder:", "Name of Investor:", etc. as the source of the party name
- Intermediate entities (the "By: [Entity], its general partner" lines) are NOT the party — they are part of the signing authority chain

Example:
\`\`\`
HOLDER (if an entity):
Name of Holder: Sequoia Capital Fund XV, L.P.
By: SC XV Management, L.L.C., its general partner
  By: ______________________________
  Name: Jane Smith
  Title: Managing Member
\`\`\`
→ partyName: "Sequoia Capital Fund XV, L.P.", signatoryName: "Jane Smith", capacity: "Managing Member of SC XV Management, L.L.C., its General Partner"

Example with deeper nesting:
\`\`\`
INVESTOR:
Name of Investor: Acme Growth Partners III, L.P.
By: Acme Growth GP III, L.L.C., its general partner
By: Acme Capital Holdings, Inc., its managing member
  By: ______________________________
  Name: John Doe
  Title: President
\`\`\`
→ partyName: "Acme Growth Partners III, L.P.", signatoryName: "John Doe", capacity: "President of Acme Capital Holdings, Inc."

### RULES
1. If this is a signature page, set isSignaturePage to true.
2. Extract ALL signature blocks found on the page.
3. For each block, strictly separate the **Party Name** (Entity or Individual), **Signatory Name** (Human), and **Capacity** (Title/Role).
4. When you see nested "By:" lines, always trace to the TOP-LEVEL entity for partyName and the BOTTOM-LEVEL individual for signatoryName.
5. Look for "Name of [Role]:" patterns (e.g. "Name of Holder:", "Name of Investor:") as a reliable indicator of the top-level party name.
6. If a field is blank (e.g. "Name: _______"), leave the extracted value as empty string.
7. If it is NOT a signature page (e.g. text clauses only), set isSignaturePage to false.
`;

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    isSignaturePage: {
      type: Type.BOOLEAN,
      description: 'True if the page contains a signature block for execution.',
    },
    signatures: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          partyName: {
            type: Type.STRING,
            description:
              "The legal entity or individual who is a party to the contract. For companies: the company name. For multi-level entities (LPs, funds): the TOP-LEVEL entity name from 'Name of Holder/Investor:' lines, NOT intermediate entities. For individuals: the person's actual name (e.g. 'John Smith'), NOT their role label (e.g. NOT 'Key Holder' or 'Founder').",
          },
          signatoryName: {
            type: Type.STRING,
            description:
              "The human name of the person physically signing. For multi-level entity chains, this is the individual at the bottom of the 'By:' chain. For individuals signing personally, this is the same as partyName. Never use a company name here.",
          },
          capacity: {
            type: Type.STRING,
            description:
              "The title or role of the signatory. For multi-level entity chains, include the signing authority context (e.g. 'Managing Member of [GP], its General Partner'). For company signatories: 'Director', 'CEO', etc. For individuals signing personally: use their block label, e.g. 'Key Holder', 'Founder', 'Guarantor'.",
          },
        },
      },
    },
  },
  required: ['isSignaturePage', 'signatures'],
};

const EXECUTED_PAGE_SYSTEM_INSTRUCTION = `
You are a specialized legal AI assistant for transaction lawyers.
Your task is to analyze an image of an EXECUTED (signed) signature page from a legal document.

### YOUR TASK
1. Determine if this page contains an actual signature (handwritten ink, electronic signature, DocuSign stamp, or similar).
2. Extract the following information:

**documentName**: The name of the agreement/contract this signature page belongs to.
- Look for text like "Signature Page to [Agreement Name]" or "[Signature Page]" headers/footers.
- Look for running headers, footers, or watermarks that reference the agreement name.
- Common patterns: "Signature Page to Amended and Restated Investors' Rights Agreement"
- If you find it, extract ONLY the agreement name (e.g. "Amended and Restated Investors' Rights Agreement"), not the "Signature Page to" prefix.
- If you cannot determine the document name, return an empty string.

**partyName**: The legal entity or individual who signed.
- Apply the same rules as for blank pages: company name for companies, individual's actual name for individuals.
- NEVER use role labels ("Key Holder", "Founder") as the party name.
- For multi-level entities (LPs, funds, trusts): use the TOP-LEVEL entity name from "Name of Holder/Investor:" lines, NOT intermediate entities.

**signatoryName**: The human being who physically signed.
- For individuals signing personally, this is the same as partyName.
- For multi-level entity chains, this is the individual at the bottom of the "By:" chain.

**capacity**: The role/title of the signatory.
- For individuals signing personally, use their role label (e.g. "Key Holder", "Founder").
- For multi-level entity chains, include the signing authority context (e.g. "Managing Member of [GP Entity], its General Partner").

**isExecuted**: Whether this page appears to actually be signed/executed.
- true if there is a visible signature (ink, electronic, stamp, DocuSign completion marker).
- false if the signature line is blank/unsigned.

### MULTI-LEVEL ENTITY SIGNATURE BLOCKS (funds, LPs, trusts)
Many entities sign through a chain of intermediaries:

\`\`\`
[ROLE LABEL] (if an entity):
Name of [Role]: [Top-Level Entity], L.P.
By: [Intermediate Entity], L.L.C., its general partner
  By: ______________________________
  Name: [Individual Name]
  Title: [Title]
\`\`\`

- The PARTY is the TOP-LEVEL named entity (the fund/LP/trust)
- The SIGNATORY is the INDIVIDUAL who physically signed (innermost "Name:" line)
- The CAPACITY describes the signing chain
- "Name of Holder:", "Name of Investor:" etc. indicate the top-level party name
- Intermediate "By: [Entity], its general partner" lines are NOT the party

Example:
\`\`\`
HOLDER (if an entity):
Name of Holder: Sequoia Capital Fund XV, L.P.
By: SC XV Management, L.L.C., its general partner
  By: [signature]
  Name: Jane Smith
  Title: Managing Member
\`\`\`
→ partyName: "Sequoia Capital Fund XV, L.P.", signatoryName: "Jane Smith", capacity: "Managing Member of SC XV Management, L.L.C., its General Partner"

### RULES
1. The documentName is CRITICAL for matching this executed page to its agreement. Look carefully for it.
2. If this is a scanned page, OCR the text to extract all information.
3. If multiple signature blocks appear on one page, extract all of them.
4. Apply the same Party vs Signatory vs Capacity distinction rules as for blank signature pages.
5. When you see nested "By:" lines, always trace to the TOP-LEVEL entity for partyName and the BOTTOM-LEVEL individual for signatoryName.
6. Look for "Name of [Role]:" patterns as a reliable indicator of the top-level party name.
`;

const EXECUTED_PAGE_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    isExecuted: {
      type: Type.BOOLEAN,
      description: 'True if the page appears to contain an actual signature (not blank/unsigned).',
    },
    documentName: {
      type: Type.STRING,
      description:
        "The name of the agreement this signature page belongs to, extracted from page text (e.g. 'Amended and Restated Investors Rights Agreement'). Empty string if not determinable.",
    },
    signatures: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          partyName: {
            type: Type.STRING,
            description:
              "The legal entity or individual party. For multi-level entities (LPs, funds): the TOP-LEVEL entity name from 'Name of Holder/Investor:' lines, NOT intermediate entities. For individuals: their actual name, NOT their role label.",
          },
          signatoryName: {
            type: Type.STRING,
            description:
              "The human name of the person who signed. For multi-level entity chains, this is the individual at the bottom of the 'By:' chain. For individuals signing personally, same as partyName.",
          },
          capacity: {
            type: Type.STRING,
            description:
              "The title or role of the signatory. For multi-level entity chains, include the signing authority context (e.g. 'Managing Member of [GP], its General Partner'). For individuals: use their block label (e.g. 'Key Holder').",
          },
        },
      },
    },
  },
  required: ['isExecuted', 'documentName', 'signatures'],
};

const needsRetry = (signatures: Array<{ partyName: string; signatoryName: string; capacity: string }>): boolean =>
  signatures.some((s) => !s.partyName || !s.signatoryName);

export function getGeminiApiKey(): string | undefined {
  const k = process.env.GEMINI_API_KEY?.trim() || process.env.API_KEY?.trim();
  return k || undefined;
}

/** Gemini Developer API (API key). `vertexai: false` overrides GOOGLE_GENAI_USE_VERTEXAI in the environment. */
function createGeminiApiKeyClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey, vertexai: false });
}

function stripDataUrlPrefix(dataUrlOrRaw: string): string {
  if (dataUrlOrRaw.startsWith('data:') && dataUrlOrRaw.includes(',')) {
    return dataUrlOrRaw.split(',')[1] ?? dataUrlOrRaw;
  }
  return dataUrlOrRaw;
}

export async function analyzeSignaturePageWithGemini(
  base64Image: string,
  modelName: string = 'gemini-2.5-flash',
): Promise<SignatureBlockExtraction> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    console.error('[gemini] Missing GEMINI_API_KEY');
    return { isSignaturePage: false, signatures: [] };
  }

  const cleanBase64 = stripDataUrlPrefix(base64Image);

  const callAI = async (promptText: string): Promise<SignatureBlockExtraction> => {
    const ai = createGeminiApiKeyClient(apiKey);
    const response = await ai.models.generateContent({
      model: modelName,
      contents: {
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
          { text: promptText },
        ],
      },
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    });
    const text = response.text;
    if (!text) throw new Error('No response from AI');
    return JSON.parse(text) as SignatureBlockExtraction;
  };

  try {
    const result = await callAI(
      'Analyze this page. Is it a signature page? Extract the Party, Signatory, and Capacity according to the definitions.',
    );

    if (result.isSignaturePage && debugGemini()) {
      console.log('[analyzeSignaturePage] Raw extraction:', JSON.stringify(result.signatures, null, 2));
    }

    if (result.isSignaturePage && needsRetry(result.signatures)) {
      const problematic = result.signatures.filter((s) => !s.partyName || !s.signatoryName);
      if (debugGemini()) {
        console.warn(
          '[analyzeSignaturePage] Missing party/signatory — retrying. Problematic blocks:',
          problematic,
        );
      } else {
        console.warn(
          `[analyzeSignaturePage] Missing party/signatory — retrying (${problematic.length} incomplete block(s))`,
        );
      }
      try {
        const retry = await callAI(
          'IMPORTANT: One or more signature blocks on this page returned an empty partyName or signatoryName. ' +
            'Look very carefully at the FULL signature block structure. ' +
            "If you see a pattern like 'Name of Holder: [Fund Name]' or 'Name of Investor: [Fund Name]', " +
            'that IS the partyName — use it even if it is a long entity name with L.P., L.L.C., etc. ' +
            "Trace all nested 'By:' lines to find the individual's name at the bottom — that is the signatoryName. " +
            'Re-extract ALL signature blocks, ensuring partyName and signatoryName are never empty.',
        );
        if (debugGemini()) {
          console.log('[analyzeSignaturePage] Retry result:', JSON.stringify(retry.signatures, null, 2));
        }
        if (retry.isSignaturePage && retry.signatures.length > 0) {
          return retry;
        }
      } catch (retryErr) {
        console.error('analyzeSignaturePage retry failed:', retryErr);
      }
    }

    return result;
  } catch (error) {
    console.error('Gemini Analysis Error:', error);
    return { isSignaturePage: false, signatures: [] };
  }
}

export async function analyzeExecutedPageWithGemini(
  base64Image: string,
  modelName: string = 'gemini-2.5-flash',
): Promise<ExecutedPageExtraction> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    console.error('[gemini] Missing GEMINI_API_KEY');
    return { isExecuted: false, documentName: '', signatures: [] };
  }

  const cleanBase64 = stripDataUrlPrefix(base64Image);

  const callAI = async (promptText: string): Promise<ExecutedPageExtraction> => {
    const ai = createGeminiApiKeyClient(apiKey);
    const response = await ai.models.generateContent({
      model: modelName,
      contents: {
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
          { text: promptText },
        ],
      },
      config: {
        systemInstruction: EXECUTED_PAGE_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: EXECUTED_PAGE_RESPONSE_SCHEMA,
      },
    });
    const text = response.text;
    if (!text) throw new Error('No response from AI');
    return JSON.parse(text) as ExecutedPageExtraction;
  };

  try {
    const result = await callAI(
      'Analyze this executed signature page. Is it actually signed? Extract the document name, party, signatory, and capacity.',
    );

    if (result.isExecuted && debugGemini()) {
      console.log(
        '[analyzeExecutedPage] Raw extraction:',
        JSON.stringify({ documentName: result.documentName, signatures: result.signatures }, null, 2),
      );
    }

    if (result.isExecuted && needsRetry(result.signatures)) {
      const problematic = result.signatures.filter((s) => !s.partyName || !s.signatoryName);
      if (debugGemini()) {
        console.warn('[analyzeExecutedPage] Missing party/signatory — retrying. Problematic blocks:', problematic);
      } else {
        console.warn(
          `[analyzeExecutedPage] Missing party/signatory — retrying (${problematic.length} incomplete block(s))`,
        );
      }
      try {
        const retry = await callAI(
          'IMPORTANT: One or more signature blocks returned an empty partyName or signatoryName. ' +
            'Look very carefully at the full signature block. ' +
            "If you see 'Name of Holder:', 'Name of Investor:', or similar, that fund/entity name IS the partyName. " +
            "Trace all nested 'By:' lines to the individual at the bottom — that name is the signatoryName. " +
            "Also look for the agreement name in headers or footers (e.g. 'Signature Page to [Agreement Name]'). " +
            'Re-extract everything, ensuring partyName and signatoryName are never empty.',
        );
        if (debugGemini()) {
          console.log('[analyzeExecutedPage] Retry result:', JSON.stringify(retry.signatures, null, 2));
        }
        if (retry.isExecuted && retry.signatures.length > 0) {
          return retry;
        }
      } catch (retryErr) {
        console.error('analyzeExecutedPage retry failed:', retryErr);
      }
    }

    return result;
  } catch (error) {
    console.error('Gemini Executed Page Analysis Error:', error);
    return { isExecuted: false, documentName: '', signatures: [] };
  }
}
