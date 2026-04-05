import { PDFDocument } from 'pdf-lib';
import { ExtractedSignaturePage, ProcessedDocument, GroupingMode, AssemblyMatch, ExecutedUpload } from '../types';

/**
 * Adobe Sign, DocuSign, etc. often set Encrypt in the trailer (restrictions / certificate workflows).
 * pdf-lib throws EncryptedPDFError unless this is set. Copying pages may still fail for some files;
 * callers can fall back to opening the whole PDF in the browser viewer.
 */
const PDF_LOAD_USER_UPLOADS = { ignoreEncryption: true } as const;

/**
 * Reads a file and returns its ArrayBuffer
 */
export const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
};

/**
 * Renders a specific page of a PDF to a base64 image string.
 * Uses pdf.js (loaded via CDN in index.html).
 */
export const renderPageToImage = async (
  file: File,
  pageIndex: number,
  scale = 1.5
): Promise<{ dataUrl: string; width: number; height: number }> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const loadingTask = pdfjsLib.getDocument(arrayBuffer);
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageIndex + 1); // PDF.js uses 1-based indexing for getPage

  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) throw new Error('Could not get canvas context');

  canvas.height = viewport.height;
  canvas.width = viewport.width;

  await page.render({
    canvasContext: context,
    viewport: viewport,
  }).promise;

  // Cleanup
  page.cleanup();

  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.8),
    width: viewport.width,
    height: viewport.height,
  };
};

/**
 * Gets the total page count of a PDF
 */
export const getPageCount = async (file: File): Promise<number> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const loadingTask = pdfjsLib.getDocument(arrayBuffer);
  const pdf = await loadingTask.promise;
  return pdf.numPages;
};

/**
 * Scans the entire document for pages containing signature-related keywords using Regex.
 * Optimized to process pages in parallel batches to speed up large documents.
 */
export const findSignaturePageCandidates = async (
  file: File,
  onProgress?: (processed: number, total: number) => void
): Promise<number[]> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const loadingTask = pdfjsLib.getDocument(arrayBuffer);
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  const candidatePages: number[] = [];
  const BATCH_SIZE = 10; // Process 10 pages at a time

  // Regex provided for signature detection
  const regex = /(?<!\w)(Signature|Execution|Excution|Signatory|Executed|Signed|Witness|Agreed\s+and\s+Accepted|Accepted\s+by|Acknowledged\s+by|Duly\s+Authorized|Duly\s+Authorised|By:|Name:|Title:|Position:|Date:)(?!\w)/i;

  let processedCount = 0;

  // Process in batches
  for (let i = 1; i <= numPages; i += BATCH_SIZE) {
    const batchPromises = [];
    const end = Math.min(i + BATCH_SIZE - 1, numPages);

    for (let pageNum = i; pageNum <= end; pageNum++) {
      batchPromises.push(
        (async () => {
          try {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const text = textContent.items.map((item: any) => item.str).join(' ');
            
            // Explicitly release memory
            page.cleanup();

            if (regex.test(text)) {
              return pageNum - 1; // Return 0-based index
            }
            return null;
          } catch (e) {
            console.error(`Error scanning page ${pageNum}`, e);
            return null;
          }
        })()
      );
    }

    const results = await Promise.all(batchPromises);
    
    // Collect valid candidates
    results.forEach(res => {
      if (res !== null) candidatePages.push(res);
    });

    processedCount += (end - i + 1);
    if (onProgress) {
      onProgress(processedCount, numPages);
    }
  }

  return candidatePages.sort((a, b) => a - b);
};

/**
 * Extracts a single page from a PDF file and returns it as a new PDF Uint8Array.
 * Useful for previewing a specific extracted page.
 */
export const extractSinglePagePdf = async (
  file: File,
  pageIndex: number
): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const srcDoc = await PDFDocument.load(arrayBuffer, PDF_LOAD_USER_UPLOADS);
  const newPdf = await PDFDocument.create();
  
  const [copiedPage] = await newPdf.copyPages(srcDoc, [pageIndex]);
  newPdf.addPage(copiedPage);
  
  return await newPdf.save();
};

/**
 * Generates separated PDFs based on grouping mode.
 * Returns a map of Filename -> PDF Uint8Array
 */
export const generateGroupedPdfs = async (
  documents: ProcessedDocument[],
  pagesToInclude: ExtractedSignaturePage[],
  groupingMode: GroupingMode
): Promise<Record<string, Uint8Array>> => {
  
  const results: Record<string, Uint8Array> = {};
  const sourceDocsCache: Record<string, PDFDocument> = {};

  // Group pages based on the mode
  const groups: Record<string, ExtractedSignaturePage[]> = {};

  for (const page of pagesToInclude) {
    if (page.copies <= 0) continue;

    let key = '';
    if (groupingMode === 'agreement') {
        key = page.documentName;
    } else if (groupingMode === 'counterparty') {
        key = page.partyName;
    } else {
        key = page.signatoryName || 'Unknown_Signatory';
    }

    if (!groups[key]) groups[key] = [];
    groups[key].push(page);
  }

  // Process each group into a separate PDF
  for (const [groupName, pages] of Object.entries(groups)) {
    const newPdf = await PDFDocument.create();

    // Sort pages to maintain order (by doc then page number usually looks best)
    pages.sort((a, b) => {
      if (a.documentName !== b.documentName) return a.documentName.localeCompare(b.documentName);
      return a.pageIndex - b.pageIndex;
    });

    // One physical PDF page may produce several rows (multiple signature blocks / entities).
    // For packs (especially per-signatory), include each sheet once — the signer signs one page in multiple places.
    const physicalKey = (p: ExtractedSignaturePage) => `${p.documentId}\x00${p.pageIndex}`;
    const byPhysical = new Map<string, ExtractedSignaturePage>();
    for (const page of pages) {
      const k = physicalKey(page);
      const prev = byPhysical.get(k);
      if (!prev) {
        byPhysical.set(k, { ...page });
      } else {
        byPhysical.set(k, { ...prev, copies: Math.max(prev.copies, page.copies) });
      }
    }
    const dedupedPages = Array.from(byPhysical.values()).sort((a, b) => {
      if (a.documentName !== b.documentName) return a.documentName.localeCompare(b.documentName);
      return a.pageIndex - b.pageIndex;
    });

    for (const pageReq of dedupedPages) {
      let srcDoc = sourceDocsCache[pageReq.documentId];
      
      if (!srcDoc) {
        const docData = documents.find((d) => d.id === pageReq.documentId);
        if (!docData) continue;
        
        const buffer = await readFileAsArrayBuffer(docData.file);
        srcDoc = await PDFDocument.load(buffer, PDF_LOAD_USER_UPLOADS);
        sourceDocsCache[pageReq.documentId] = srcDoc;
      }

      const [copiedPage] = await newPdf.copyPages(srcDoc, [pageReq.pageIndex]);

      for (let i = 0; i < pageReq.copies; i++) {
        newPdf.addPage(copiedPage);
      }
    }

    const pdfBytes = await newPdf.save();
    
    // Improved Sanitize filename: Allow spaces, dots, parens. Remove strict illegal chars.
    let safeName = groupName.replace(/[/\\?%*:|"<>]/g, '').trim();
    if (!safeName) safeName = "Signature_Pack";
    
    // Ensure .pdf extension
    if (!safeName.toLowerCase().endsWith('.pdf')) {
      safeName += '.pdf';
    }

    results[safeName] = pdfBytes;
  }

  return results;
};

// --- Document Assembly Functions ---

/** One executed PDF page to splice in for a blank at a given original page index. */
export type AssemblyPageReplacement = {
  executedFile: File;
  pageIndexInExecuted: number;
};

/** PDF.js render scale for assembly raster fallback (lower = faster; 1.5 is usually plenty for signing). */
const ASSEMBLY_RASTER_SCALE = 1.5;
const ASSEMBLY_RASTER_JPEG_QUALITY = 0.88;

type PdfJsDocumentProxy = { numPages: number; getPage: (num: number) => Promise<unknown> };

/**
 * One PDF.js open per File per assembly (raster path was re-parsing the same PDF on every page).
 */
function getPdfJsDocumentForFile(file: File, cache: Map<File, Promise<PdfJsDocumentProxy>>): Promise<PdfJsDocumentProxy> {
  let loading = cache.get(file);
  if (!loading) {
    loading = (async () => {
      const arrayBuffer = await readFileAsArrayBuffer(file);
      const loadingTask = pdfjsLib.getDocument(arrayBuffer);
      return loadingTask.promise as Promise<PdfJsDocumentProxy>;
    })();
    cache.set(file, loading);
  }
  return loading;
}

/**
 * When pdf-lib `copyPages` fails (Adobe Sign / certificate / malformed trees often throw
 * "Expected instance of PDFDict*, but got undefined"), render via PDF.js and embed one raster page.
 */
async function appendPageAsRasterFromPdfJsDoc(
  assembledPdf: PDFDocument,
  pdfJsDoc: PdfJsDocumentProxy,
  pageIndex0: number,
  fileLabel: string,
  contextLabel: string,
  rasterScale = ASSEMBLY_RASTER_SCALE
): Promise<void> {
  if (pageIndex0 < 0 || pageIndex0 >= pdfJsDoc.numPages) {
    throw new Error(
      `[${contextLabel}] Raster fallback: page index ${pageIndex0} is out of range (${pdfJsDoc.numPages} pages) in "${fileLabel}"`
    );
  }
  const pdfPage = (await pdfJsDoc.getPage(pageIndex0 + 1)) as {
    getViewport: (opts: { scale: number }) => { width: number; height: number };
    render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
    cleanup: () => void;
  };
  const baseViewport = pdfPage.getViewport({ scale: 1 });
  const widthPt = baseViewport.width;
  const heightPt = baseViewport.height;
  const renderViewport = pdfPage.getViewport({ scale: rasterScale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(renderViewport.width);
  canvas.height = Math.ceil(renderViewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`[${contextLabel}] Raster fallback: could not get canvas context`);

  await pdfPage.render({ canvasContext: ctx, viewport: renderViewport }).promise;
  pdfPage.cleanup();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', ASSEMBLY_RASTER_JPEG_QUALITY)
  );
  if (!blob) {
    throw new Error(`[${contextLabel}] Raster fallback: JPEG export failed for "${fileLabel}"`);
  }
  const jpgBytes = new Uint8Array(await blob.arrayBuffer());
  const image = await assembledPdf.embedJpg(jpgBytes);
  const page = assembledPdf.addPage([widthPt, heightPt]);
  page.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
}

/**
 * Full assembly without pdf-lib loading user PDFs: page count and rendering via PDF.js only.
 * Use when PDFDocument.load / copyPages / save throws (e.g. Adobe Sign "PDFDict… undefined").
 */
async function assembleDocumentRasterOnly(
  originalFile: File,
  replacements: Map<number, AssemblyPageReplacement[]>,
  documentLabel: string
): Promise<Uint8Array> {
  const assembledPdf = await PDFDocument.create();
  const pdfJsCache = new Map<File, Promise<PdfJsDocumentProxy>>();
  const origJs = await getPdfJsDocumentForFile(originalFile, pdfJsCache);
  const totalPages = origJs.numPages;

  for (let i = 0; i < totalPages; i++) {
    const replacementList = replacements.get(i);

    if (replacementList && replacementList.length > 0) {
      for (const replacement of replacementList) {
        try {
          const execJs = await getPdfJsDocumentForFile(replacement.executedFile, pdfJsCache);
          await appendPageAsRasterFromPdfJsDoc(
            assembledPdf,
            execJs,
            replacement.pageIndexInExecuted,
            replacement.executedFile.name,
            documentLabel
          );
        } catch (err) {
          console.warn(
            `[assembleDocument] Raster insert failed for executed "${replacement.executedFile.name}" page ${replacement.pageIndexInExecuted}; using blank page ${i} from agreement.`,
            err
          );
          await appendPageAsRasterFromPdfJsDoc(assembledPdf, origJs, i, originalFile.name, documentLabel);
        }
      }
    } else {
      await appendPageAsRasterFromPdfJsDoc(assembledPdf, origJs, i, originalFile.name, documentLabel);
    }
  }

  return assembledPdf.save();
}

/** Fast path: pdf-lib load + copyPages; may throw on some vendor PDFs before any page runs. */
async function assembleDocumentViaVectorCopy(
  originalFile: File,
  replacements: Map<number, AssemblyPageReplacement[]>,
  documentLabel: string
): Promise<Uint8Array> {
  const originalBuffer = await readFileAsArrayBuffer(originalFile);
  const originalDoc = await PDFDocument.load(originalBuffer, PDF_LOAD_USER_UPLOADS);
  const assembledPdf = await PDFDocument.create();

  const executedDocCache = new Map<File, PDFDocument>();
  const pdfJsRasterCache = new Map<File, Promise<PdfJsDocumentProxy>>();

  const totalPages = originalDoc.getPageCount();

  for (let i = 0; i < totalPages; i++) {
    const replacementList = replacements.get(i);

    if (replacementList && replacementList.length > 0) {
      for (const replacement of replacementList) {
        let executedDoc = executedDocCache.get(replacement.executedFile);
        if (!executedDoc) {
          const execBuffer = await readFileAsArrayBuffer(replacement.executedFile);
          executedDoc = await PDFDocument.load(execBuffer, PDF_LOAD_USER_UPLOADS);
          executedDocCache.set(replacement.executedFile, executedDoc);
        }

        const executedPageCount = executedDoc.getPageCount();
        if (
          replacement.pageIndexInExecuted < 0 ||
          replacement.pageIndexInExecuted >= executedPageCount
        ) {
          console.warn(
            `[assembleDocument] Skipping invalid executed page index ${replacement.pageIndexInExecuted} for "${replacement.executedFile.name}" (pages: ${executedPageCount}) while assembling "${documentLabel}".`
          );
          continue;
        }

        try {
          const [copiedPage] = await assembledPdf.copyPages(executedDoc, [
            replacement.pageIndexInExecuted,
          ]);
          assembledPdf.addPage(copiedPage);
        } catch (err) {
          console.warn(
            `[assembleDocument] copyPages from executed failed for "${replacement.executedFile.name}" page ${replacement.pageIndexInExecuted} while assembling "${documentLabel}"; using raster fallback.`,
            err
          );
          const execJs = await getPdfJsDocumentForFile(replacement.executedFile, pdfJsRasterCache);
          await appendPageAsRasterFromPdfJsDoc(
            assembledPdf,
            execJs,
            replacement.pageIndexInExecuted,
            replacement.executedFile.name,
            documentLabel
          );
        }
      }
    } else {
      try {
        const [copiedPage] = await assembledPdf.copyPages(originalDoc, [i]);
        assembledPdf.addPage(copiedPage);
      } catch (err) {
        console.warn(
          `[assembleDocument] copyPages from original failed at page ${i} while assembling "${documentLabel}"; using raster fallback.`,
          err
        );
        const origJs = await getPdfJsDocumentForFile(originalFile, pdfJsRasterCache);
        await appendPageAsRasterFromPdfJsDoc(assembledPdf, origJs, i, originalFile.name, documentLabel);
      }
    }
  }

  return assembledPdf.save();
}

/**
 * Assembles a single document by replacing blank signature pages with executed pages.
 * Every page from the original document is copied; pages that have one or more replacements
 * (same physical page can have multiple signature rows / parties) insert each executed page
 * in order; otherwise the original page is kept once.
 *
 * If pdf-lib cannot load or save the vector document (common with Adobe Sign), falls back to
 * an all-raster build using PDF.js only.
 *
 * @param originalFile - The original agreement PDF file
 * @param replacements - Map of 0-based page index → ordered list of executed pages to insert
 * @returns The assembled PDF as Uint8Array
 */
export const assembleDocument = async (
  originalFile: File,
  replacements: Map<number, AssemblyPageReplacement[]>,
  documentLabel = originalFile.name
): Promise<Uint8Array> => {
  try {
    return await assembleDocumentViaVectorCopy(originalFile, replacements, documentLabel);
  } catch (err) {
    console.warn(
      `[assembleDocument] Vector assembly failed for "${documentLabel}"; rebuilding all pages via PDF.js raster.`,
      err
    );
    return assembleDocumentRasterOnly(originalFile, replacements, documentLabel);
  }
};

/**
 * Assembles all documents that have at least one matched executed page.
 * Groups matches by documentId, builds replacement maps, calls assembleDocument for each.
 *
 * @param documents - All processed documents (must have non-null file)
 * @param matches - All assembly matches (auto + manual)
 * @param executedUploads - All uploaded executed files
 * @returns Map of sanitized filename → assembled PDF bytes
 */
export const assembleAllDocuments = async (
  documents: ProcessedDocument[],
  matches: AssemblyMatch[],
  executedUploads: ExecutedUpload[]
): Promise<Record<string, Uint8Array>> => {
  const results: Record<string, Uint8Array> = {};

  // Build a lookup: executedPageId → { file, pageIndexInSource }
  const executedPageLookup = new Map<string, { file: File; pageIndexInSource: number }>();
  for (const upload of executedUploads) {
    for (const execPage of upload.executedPages) {
      executedPageLookup.set(execPage.id, {
        file: upload.file,
        pageIndexInSource: execPage.pageIndexInSource,
      });
    }
  }

  // Group matches by documentId
  const matchesByDoc: Record<string, AssemblyMatch[]> = {};
  for (const match of matches) {
    if (!matchesByDoc[match.documentId]) matchesByDoc[match.documentId] = [];
    matchesByDoc[match.documentId].push(match);
  }

  // Assemble each document
  for (const [docId, docMatches] of Object.entries(matchesByDoc)) {
    const doc = documents.find(d => d.id === docId);
    if (!doc || !doc.file) continue;

    // Group matches by original page index (one physical page can have multiple parties / rows).
    const matchesByPageIndex = new Map<number, AssemblyMatch[]>();
    for (const match of docMatches) {
      const list = matchesByPageIndex.get(match.pageIndex) ?? [];
      list.push(match);
      matchesByPageIndex.set(match.pageIndex, list);
    }

    const replacements = new Map<number, AssemblyPageReplacement[]>();

    for (const [pageIndex, pageMatches] of matchesByPageIndex) {
      pageMatches.sort((a, b) => a.blankPageId.localeCompare(b.blankPageId));
      const slice: AssemblyPageReplacement[] = [];
      for (const match of pageMatches) {
        const execInfo = executedPageLookup.get(match.executedPageId);
        if (execInfo) {
          slice.push({
            executedFile: execInfo.file,
            pageIndexInExecuted: execInfo.pageIndexInSource,
          });
        }
      }
      if (slice.length > 0) {
        replacements.set(pageIndex, slice);
      }
    }

    if (replacements.size === 0) continue;

    const assembledBytes = await assembleDocument(doc.file, replacements, doc.name);

    // Sanitize filename
    let safeName = doc.name.replace(/[/\\?%*:|"<>]/g, '').trim();
    if (!safeName) safeName = 'Assembled_Document';

    // Add "_assembled" suffix before .pdf
    if (safeName.toLowerCase().endsWith('.pdf')) {
      safeName = safeName.slice(0, -4) + '_assembled.pdf';
    } else {
      safeName += '_assembled.pdf';
    }

    results[safeName] = assembledBytes;
  }

  return results;
};