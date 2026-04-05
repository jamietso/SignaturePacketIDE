import React, { useState, useMemo, useRef, useEffect } from 'react';
import { UploadCloud, File as FileIcon, Loader2, Download, Layers, Users, X, CheckCircle2, FileText, Eye, UserPen, Save, FolderOpen, AlertTriangle, ArrowLeftRight, Wand2, Package, Pencil, Check } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { ExtractedSignaturePage, GroupingMode, ProcessedDocument, SavedConfiguration, AppMode, ExecutedUpload, ExecutedSignaturePage, AssemblyMatch } from './types';
import { getPageCount, renderPageToImage, generateGroupedPdfs, findSignaturePageCandidates, extractSinglePagePdf, assembleAllDocuments } from './services/pdfService';
import { analyzePage, analyzeExecutedPage } from './services/geminiService';
import { autoMatch, createManualMatch } from './services/matchingService';
import { convertDocxToPdf } from './services/docxService';
import SignatureCard from './components/SignatureCard';
import PdfPreviewModal from './components/PdfPreviewModal';
import InstructionsModal from './components/InstructionsModal';
import CompletionChecklist from './components/CompletionChecklist';
import ExecutedPageCard from './components/ExecutedPageCard';
import MatchPickerModal from './components/MatchPickerModal';

// Concurrency Constants for AI - Keeping AI limit per doc to avoid rate limits, but unlimited docs
const CONCURRENT_AI_REQUESTS_PER_DOC = 5;

/** When the PDF text layer has no signature keywords (common for DocuSign/scanned exports), scan every page with vision. */
function allPageIndices(pageCount: number): number[] {
  return Array.from({ length: pageCount }, (_, i) => i);
}

const FALLBACK_AI_PAGE_WARN_THRESHOLD = 60;

/** Preview URLs may use `blob:…#page=N`; revoke must use the blob URL only. */
function revokePreviewBlobUrl(url: string | null | undefined) {
  if (!url) return;
  URL.revokeObjectURL(url.split('#')[0]);
}

type SupportedSourceFormat = 'pdf' | 'docx';
type NormalizedUpload = { sourceFile: File; pdfFile: File | null; errorMessage?: string };

const App: React.FC = () => {
  const [documents, setDocuments] = useState<ProcessedDocument[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<string>('');
  
  // Grouping & Filtering State
  const [groupingMode, setGroupingMode] = useState<GroupingMode>('agreement');
  
  // App Mode State
  const [appMode, setAppMode] = useState<AppMode>('extract');

  // Assembly State
  const [executedUploads, setExecutedUploads] = useState<ExecutedUpload[]>([]);
  const [assemblyMatches, setAssemblyMatches] = useState<AssemblyMatch[]>([]);
  /** Executed pages that must not be auto-matched again after user removes an auto-match or deletes an auto-matched blank. Cleared when user manually matches that executed page. */
  const [autoMatchExcludedExecutedIds, setAutoMatchExcludedExecutedIds] = useState<string[]>([]);
  const [isDraggingExecuted, setIsDraggingExecuted] = useState(false);

  // Match Picker Modal State
  const [matchPickerState, setMatchPickerState] = useState<{
    isOpen: boolean;
    blankPageId: string | null;
    currentMatch: AssemblyMatch | null;
    initialExecutedPageId: string | null;
  }>({ isOpen: false, blankPageId: null, currentMatch: null, initialExecutedPageId: null });
  const normalizeForMatch = (value: string | null | undefined): string =>
    (value ?? '').toLowerCase().trim().replace(/\s+/g, ' ');

  const pickBestBlankForExecuted = (executed: ExecutedSignaturePage): ExtractedSignaturePage | null => {
    const matchedBlankIds = new Set(assemblyMatches.map(m => m.blankPageId));
    const candidates = allPages.filter(p => !matchedBlankIds.has(p.id));
    if (candidates.length === 0) return null;

    const edoc = normalizeForMatch(executed.extractedDocumentName);
    const eparty = normalizeForMatch(executed.extractedPartyName);
    const esig = normalizeForMatch(executed.extractedSignatoryName);

    const score = (blank: ExtractedSignaturePage): number => {
      const bdoc = normalizeForMatch(blank.documentName);
      const bparty = normalizeForMatch(blank.partyName);
      const bsig = normalizeForMatch(blank.signatoryName);
      let s = 0;
      if (edoc && bdoc && (edoc === bdoc || edoc.includes(bdoc) || bdoc.includes(edoc))) s += 5;
      if (eparty && bparty && (eparty === bparty || eparty.includes(bparty) || bparty.includes(eparty))) s += 3;
      if (esig && bsig && (esig === bsig || esig.includes(bsig) || bsig.includes(esig))) s += 2;
      return s;
    };

    const ranked = [...candidates].sort((a, b) => score(b) - score(a));
    return ranked[0] ?? null;
  };


  // Drag & Drop State
  const [isDragging, setIsDragging] = useState(false);

  // Preview State
  const [previewState, setPreviewState] = useState<{
    isOpen: boolean;
    url: string | null;
    title: string;
  }>({ isOpen: false, url: null, title: '' });

  // Instructions Modal State
  const [isInstructionsOpen, setIsInstructionsOpen] = useState(false);
  const [renamingDocId, setRenamingDocId] = useState<string | null>(null);
  const [renamingExecutedId, setRenamingExecutedId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  // Ref for load-config hidden file input
  const loadConfigInputRef = useRef<HTMLInputElement>(null);
  const replaceDocInputRef = useRef<HTMLInputElement>(null);
  const [replaceTargetDocId, setReplaceTargetDocId] = useState<string | null>(null);
  /** Assembly: filter for “Missing pages” ZIP (`__all__` or exact signatory label). */
  const [missingPackSignatoryFilter, setMissingPackSignatoryFilter] = useState<string>('__all__');

  // Guard against duplicate restore runs (StrictMode double-invoke, rapid re-uploads)
  const restoringIds = useRef<Set<string>>(new Set());

  // --- Handlers ---

  const getSupportedSourceFormat = (file: File): SupportedSourceFormat | null => {
    const lowerName = file.name.toLowerCase();
    if (file.type === 'application/pdf' || lowerName.endsWith('.pdf')) return 'pdf';
    if (
      file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      lowerName.endsWith('.docx')
    ) return 'docx';
    return null;
  };

  const normalizeUploadToPdf = async (file: File): Promise<File | null> => {
    const format = getSupportedSourceFormat(file);
    if (!format) return null;
    if (format === 'pdf') return file;
    return convertDocxToPdf(file);
  };

  const getErrorMessage = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error.trim()) return error;
    return fallback;
  };

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const uploadedFiles = Array.from(files);
    setCurrentStatus('Preparing uploads...');

    const normalizedUploads: NormalizedUpload[] = await Promise.all(uploadedFiles.map(async (f) => {
      try {
        const pdfFile = await normalizeUploadToPdf(f);
        if (!pdfFile) {
          return { sourceFile: f, pdfFile: null, errorMessage: 'Unsupported file type. Please upload PDF or DOCX.' };
        }
        return { sourceFile: f, pdfFile };
      } catch (error) {
        console.error(`Failed to normalize file ${f.name}`, error);
        return { sourceFile: f, pdfFile: null, errorMessage: getErrorMessage(error, 'DOCX conversion failed') };
      }
    }));
    setCurrentStatus('');

    // Snapshot current docs before setState to find version updates by filename.
    const versionUpdates: ProcessedDocument[] = [];
    for (const normalized of normalizedUploads) {
      if (!normalized.pdfFile) continue;
      const matched = documents.find(d => d.name === normalized.pdfFile.name);
      if (matched && !restoringIds.current.has(matched.id)) {
        restoringIds.current.add(matched.id);
        versionUpdates.push({
          ...matched,
          file: normalized.pdfFile,
          status: 'pending',
          wasRestored: true,
          savedPages: matched.extractedPages
        });
      }
    }

    setDocuments(prev => {
      const updatedDocs = [...prev];
      const newDocs: ProcessedDocument[] = [];

      for (const normalized of normalizedUploads) {
        const file = normalized.pdfFile;
        const existingIdx = file ? updatedDocs.findIndex(d => d.name === file.name) : -1;

        if (existingIdx !== -1) {
          updatedDocs[existingIdx] = {
            ...updatedDocs[existingIdx],
            file,
            status: 'pending',
            errorMessage: undefined,
            wasRestored: true,
            savedPages: updatedDocs[existingIdx].extractedPages,
          };
        } else {
          newDocs.push({
            id: uuidv4(),
            name: file?.name ?? normalized.sourceFile.name,
            file,
            pageCount: 0,
            status: file ? 'pending' : 'error',
            errorMessage: normalized.errorMessage,
            extractedPages: [],
          });
        }
      }

      return [...updatedDocs, ...newDocs];
    });

    if (versionUpdates.length > 0) {
      await processVersionUpdatedDocuments(versionUpdates);
      versionUpdates.forEach(d => restoringIds.current.delete(d.id));
    }
  };

  const handleReplaceDocumentClick = (docId: string) => {
    setReplaceTargetDocId(docId);
    replaceDocInputRef.current?.click();
  };

  const handleReplaceDocumentSelected = async (file: File | null) => {
    if (!file || !replaceTargetDocId) {
      if (replaceDocInputRef.current) replaceDocInputRef.current.value = '';
      setReplaceTargetDocId(null);
      return;
    }

    const targetDoc = documents.find(d => d.id === replaceTargetDocId);
    if (!targetDoc) {
      if (replaceDocInputRef.current) replaceDocInputRef.current.value = '';
      setReplaceTargetDocId(null);
      return;
    }

    setCurrentStatus(`Preparing replacement for '${targetDoc.name}'...`);

    let normalizedFile: File | null = null;
    try {
      normalizedFile = await normalizeUploadToPdf(file);
    } catch (error) {
      setCurrentStatus(getErrorMessage(error, 'Replacement conversion failed'));
      setTimeout(() => setCurrentStatus(''), 3500);
      if (replaceDocInputRef.current) replaceDocInputRef.current.value = '';
      setReplaceTargetDocId(null);
      return;
    }

    if (!normalizedFile) {
      setCurrentStatus('Unsupported file type. Please upload PDF or DOCX.');
      setTimeout(() => setCurrentStatus(''), 3000);
      if (replaceDocInputRef.current) replaceDocInputRef.current.value = '';
      setReplaceTargetDocId(null);
      return;
    }

    if (!restoringIds.current.has(targetDoc.id)) {
      restoringIds.current.add(targetDoc.id);
    }

    const versionUpdate: ProcessedDocument = {
      ...targetDoc,
      file: normalizedFile,
      status: 'pending',
      errorMessage: undefined,
      wasRestored: true,
      savedPages: targetDoc.extractedPages,
    };

    setDocuments(prev => prev.map(d => d.id === targetDoc.id ? versionUpdate : d));
    await processVersionUpdatedDocuments([versionUpdate]);
    restoringIds.current.delete(targetDoc.id);

    if (replaceDocInputRef.current) replaceDocInputRef.current.value = '';
    setReplaceTargetDocId(null);
  };

  const handleProcessPending = () => {
    // Only process truly new pending docs — restored ones auto-rescan via useEffect
    const pendingDocs = documents.filter(d => d.status === 'pending' && d.file !== null && !d.wasRestored);
    processAllDocuments(pendingDocs);
  };

  /**
   * Process all documents in parallel ("All in one go")
   */
  const processAllDocuments = async (docsToProcess: ProcessedDocument[]) => {
    if (docsToProcess.length === 0) return;

    setIsProcessing(true);
    setCurrentStatus(`Processing ${docsToProcess.length} documents...`);

    // Fire off all requests simultaneously
    await Promise.all(docsToProcess.map(doc => processSingleDocument(doc)));

    setIsProcessing(false);
    setCurrentStatus('');
  };

  /**
   * Re-process an updated version of existing documents while preserving prior
   * extracted page edits. Existing extracted pages are retained by pageIndex;
   * newly detected signature pages are appended.
   */
  const processVersionUpdatedDocuments = async (updatedDocs: ProcessedDocument[]) => {
    if (updatedDocs.length === 0) return;

    setIsProcessing(true);
    setCurrentStatus(`Updating ${updatedDocs.length} document version${updatedDocs.length > 1 ? 's' : ''}...`);

    await Promise.all(updatedDocs.map(doc => processSingleDocumentWithMerge(doc)));

    setIsProcessing(false);
    setCurrentStatus('');
  };

  /**
   * Re-processes a version-updated document:
   * 1) preserves prior extracted pages by pageIndex (including user edits)
   * 2) refreshes their thumbnails from the new file when page indices still exist
   * 3) scans for newly added signature pages and appends them
   */
  const processSingleDocumentWithMerge = async (doc: ProcessedDocument) => {
    // savedPages was snapshotted onto the doc object at upload time, before we clear extractedPages
    const savedPages: ExtractedSignaturePage[] = doc.savedPages ?? doc.extractedPages;

    setDocuments(prev => prev.map(d => d.id === doc.id ? {
      ...d,
      status: 'processing',
      progress: 0,
      errorMessage: undefined,
      extractedPages: [],
      savedPages: undefined
    } : d));

    try {
      const file = doc.file!;
      const pageCount = await getPageCount(file);

      // First pass: refresh thumbnails for known extracted pages
      const uniquePageIndices = Array.from(new Set(savedPages.map(p => p.pageIndex))).sort((a, b) => a - b);
      const totalKnown = uniquePageIndices.length;
      const freshPages: ExtractedSignaturePage[] = [];
      const knownIndexSet = new Set(uniquePageIndices);
      const changedKnownIndices = new Set<number>();

      for (let i = 0; i < uniquePageIndices.length; i++) {
        const pageIndex = uniquePageIndices[i];
        if (pageIndex >= pageCount) {
          // Page no longer exists in latest version; keep prior extraction.
          savedPages.filter(sp => sp.pageIndex === pageIndex).forEach(saved => freshPages.push(saved));
        } else {
          try {
            const { dataUrl, width, height } = await renderPageToImage(file, pageIndex);
            const pagesAtIndex = savedPages.filter(sp => sp.pageIndex === pageIndex);
            const wasChanged = pagesAtIndex.some(saved => saved.thumbnailUrl !== dataUrl);
            if (wasChanged) changedKnownIndices.add(pageIndex);
            pagesAtIndex.forEach(saved => {
              freshPages.push({ ...saved, thumbnailUrl: dataUrl, originalWidth: width, originalHeight: height });
            });
          } catch (err) {
            console.error(`Error rendering page ${pageIndex} of ${doc.name}`, err);
            // Keep saved page as-is if render fails (stale thumbnail better than nothing)
            savedPages.filter(sp => sp.pageIndex === pageIndex).forEach(saved => freshPages.push(saved));
          }
        }
        const progressKnown = totalKnown === 0 ? 40 : Math.round(((i + 1) / totalKnown) * 40);
        setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, progress: progressKnown } : d));
      }

      // Second pass: detect newly added signature pages
      const candidateIndices = await findSignaturePageCandidates(file, (curr, total) => {
        const progress = 40 + Math.round((curr / total) * 30);
        setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, progress } : d));
      });
      let effectiveCandidates = candidateIndices;
      const mergeHeuristicFallback = candidateIndices.length === 0 && pageCount > 0;
      if (mergeHeuristicFallback) {
        effectiveCandidates = allPageIndices(pageCount);
      }
      const changedIndices = Array.from(changedKnownIndices).filter(pageIndex => pageIndex < pageCount);
      const newCandidateIndices = effectiveCandidates.filter(pageIndex => !knownIndexSet.has(pageIndex));
      const indicesToAnalyze = Array.from(new Set([...newCandidateIndices, ...changedIndices])).sort((a, b) => a - b);

      if (mergeHeuristicFallback && indicesToAnalyze.length > 0) {
        if (pageCount >= FALLBACK_AI_PAGE_WARN_THRESHOLD) {
          console.warn(
            `[Signature scan] No keyword matches in "${doc.name}" (merge) — analyzing ${indicesToAnalyze.length} page(s) with AI (full-doc fallback).`
          );
        }
        setCurrentStatus(`No keyword matches — scanning pages with AI for updates…`);
      }

      if (indicesToAnalyze.length > 0) {
        let processedNew = 0;
        const totalNew = indicesToAnalyze.length;
        const changedIndexResults = new Map<number, ExtractedSignaturePage[]>();
        const changedIndexErrors = new Set<number>();

        for (let i = 0; i < indicesToAnalyze.length; i += CONCURRENT_AI_REQUESTS_PER_DOC) {
          const chunk = indicesToAnalyze.slice(i, i + CONCURRENT_AI_REQUESTS_PER_DOC);
          const chunkPromises = chunk.map(async (pageIndex) => {
            try {
              const { dataUrl, width, height } = await renderPageToImage(file, pageIndex);
              const analysis = await analyzePage(dataUrl);
              if (analysis.isSignaturePage) {
                const pages = analysis.signatures.map(sig => ({
                  id: uuidv4(),
                  documentId: doc.id,
                  documentName: doc.name,
                  pageIndex,
                  pageNumber: pageIndex + 1,
                  partyName: sig.partyName || "Unknown Party",
                  signatoryName: sig.signatoryName || "",
                  capacity: sig.capacity || "Signatory",
                  copies: 1,
                  thumbnailUrl: dataUrl,
                  originalWidth: width,
                  originalHeight: height
                }));
                return { pageIndex, pages, failed: false };
              }
              return { pageIndex, pages: [] as ExtractedSignaturePage[], failed: false };
            } catch (err) {
              console.error(`Error analyzing updated page ${pageIndex} of ${doc.name}`, err);
              return { pageIndex, pages: [] as ExtractedSignaturePage[], failed: true };
            }
          });

          const chunkResults = await Promise.all(chunkPromises);
          chunkResults.forEach(result => {
            const isChangedIndex = changedKnownIndices.has(result.pageIndex);
            if (isChangedIndex) {
              if (result.failed) {
                changedIndexErrors.add(result.pageIndex);
              } else {
                changedIndexResults.set(result.pageIndex, result.pages);
              }
              return;
            }
            result.pages.forEach(p => freshPages.push(p));
          });

          processedNew += chunk.length;
          const aiProgress = 70 + Math.round((processedNew / totalNew) * 30);
          setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, progress: aiProgress } : d));
        }

        // Replace changed pages with newly analyzed content when analysis succeeded.
        changedIndices.forEach(pageIndex => {
          if (changedIndexErrors.has(pageIndex)) {
            // Keep previously preserved entries if analysis failed.
            return;
          }
          const replacementPages = changedIndexResults.get(pageIndex) ?? [];
          const withoutOld = freshPages.filter(p => p.pageIndex !== pageIndex);
          withoutOld.push(...replacementPages);
          freshPages.length = 0;
          withoutOld.forEach(p => freshPages.push(p));
        });
      }

      setDocuments(prev => prev.map(d => d.id === doc.id ? {
        ...d,
        status: 'completed',
        progress: 100,
        errorMessage: undefined,
        pageCount,
        extractedPages: freshPages,
        wasRestored: undefined,
        savedPages: undefined,
      } : d));

      restoringIds.current.delete(doc.id);
      if (mergeHeuristicFallback && indicesToAnalyze.length > 0) {
        setCurrentStatus(`Updated '${doc.name}' — kept prior pages; used full-document AI scan for new pages`);
        setTimeout(() => setCurrentStatus(''), 4000);
      } else {
        setCurrentStatus(`Updated '${doc.name}' — kept prior pages, added new detections`);
        setTimeout(() => setCurrentStatus(''), 3000);
      }

    } catch (error) {
      console.error(`Error restoring ${doc.name}`, error);
      restoringIds.current.delete(doc.id);
      setDocuments(prev => prev.map(d => d.id === doc.id ? {
        ...d,
        status: 'error',
        errorMessage: getErrorMessage(error, 'Failed to restore this document'),
        wasRestored: undefined,
        savedPages: undefined
      } : d));
    }
  };

  const processSingleDocument = async (doc: ProcessedDocument) => {
      if (!doc.file) return; // Safety guard — should not happen for normal pending docs

      // Update status to processing
      setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, status: 'processing', progress: 0, errorMessage: undefined } : d));

      try {
        const pageCount = await getPageCount(doc.file);
        
        // 1. Full Document Text Scan (Heuristic) - Optimized in pdfService
        const candidateIndices = await findSignaturePageCandidates(doc.file, (curr, total) => {
           // Update progress for scanning phase (0-30%)
           const progress = Math.round((curr / total) * 30);
           setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, progress } : d));
        });

        let indicesForAI = candidateIndices;
        if (candidateIndices.length === 0 && pageCount > 0) {
          indicesForAI = allPageIndices(pageCount);
          if (pageCount >= FALLBACK_AI_PAGE_WARN_THRESHOLD) {
            console.warn(
              `[Signature scan] No keyword matches in "${doc.name}" — analyzing all ${pageCount} pages with AI (slower, higher API use).`
            );
          }
          setCurrentStatus(`No keyword matches — scanning all ${pageCount} pages with AI…`);
        }

        // 2. Visual AI Analysis on Candidate Pages (Parallelized)
        const extractedPages: ExtractedSignaturePage[] = [];

        if (indicesForAI.length === 0) {
           setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, progress: 100 } : d));
        } else {
            // Process candidates in chunks to respect AI concurrency limit PER DOC
            let processedCount = 0;
            const totalCandidates = indicesForAI.length;

            for (let i = 0; i < indicesForAI.length; i += CONCURRENT_AI_REQUESTS_PER_DOC) {
                const chunk = indicesForAI.slice(i, i + CONCURRENT_AI_REQUESTS_PER_DOC);
                
                const chunkPromises = chunk.map(async (pageIndex) => {
                    try {
                        const { dataUrl, width, height } = await renderPageToImage(doc.file, pageIndex);
                        const analysis = await analyzePage(dataUrl);

                        if (analysis.isSignaturePage) {
                            return analysis.signatures.map(sig => ({
                                id: uuidv4(),
                                documentId: doc.id,
                                documentName: doc.name,
                                pageIndex: pageIndex,
                                pageNumber: pageIndex + 1,
                                partyName: sig.partyName || "Unknown Party",
                                signatoryName: sig.signatoryName || "",
                                capacity: sig.capacity || "Signatory",
                                copies: 1,
                                thumbnailUrl: dataUrl,
                                originalWidth: width,
                                originalHeight: height
                            }));
                        }
                    } catch (err) {
                        console.error(`Error analyzing page ${pageIndex} of ${doc.name}`, err);
                    }
                    return [];
                });

                const chunkResults = await Promise.all(chunkPromises);
                
                // Update progress for AI phase (30-100%)
                processedCount += chunk.length;
                const aiProgress = 30 + Math.round((processedCount / totalCandidates) * 70);
                setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, progress: aiProgress } : d));

                // Flatten and add to results
                chunkResults.flat().forEach(p => {
                    if(p) extractedPages.push(p);
                });
            }
        }

        setDocuments(prev => prev.map(d => d.id === doc.id ? { 
          ...d, 
          status: 'completed', 
          progress: 100,
          errorMessage: undefined,
          pageCount,
          extractedPages 
        } : d));

        if (candidateIndices.length === 0 && pageCount > 0) {
          setTimeout(() => setCurrentStatus(''), 4000);
        }

      } catch (error) {
        console.error(`Error processing doc ${doc.name}`, error);
        setDocuments(prev => prev.map(d => d.id === doc.id ? {
          ...d,
          status: 'error',
          errorMessage: getErrorMessage(error, 'Failed to process this document')
        } : d));
      }
  };

  const handleUpdateCopies = (pageId: string, newCount: number) => {
    setDocuments(prev => prev.map(doc => ({
      ...doc,
      extractedPages: doc.extractedPages.map(p => p.id === pageId ? { ...p, copies: newCount } : p)
    })));
  };

  const handleUpdateParty = (pageId: string, newParty: string) => {
     setDocuments(prev => prev.map(doc => ({
      ...doc,
      extractedPages: doc.extractedPages.map(p => p.id === pageId ? { ...p, partyName: newParty } : p)
    })));
  };

  const handleUpdateSignatory = (pageId: string, newSignatory: string) => {
    setDocuments(prev => prev.map(doc => ({
     ...doc,
     extractedPages: doc.extractedPages.map(p => p.id === pageId ? { ...p, signatoryName: newSignatory } : p)
   })));
 };

  const handleUpdateCapacity = (pageId: string, newCapacity: string) => {
     setDocuments(prev => prev.map(doc => ({
      ...doc,
      extractedPages: doc.extractedPages.map(p => p.id === pageId ? { ...p, capacity: newCapacity } : p)
    })));
  };

  const handleDeletePage = (pageId: string) => {
    const match = assemblyMatches.find(m => m.blankPageId === pageId);
    if (match?.status === 'auto-matched') {
      setAutoMatchExcludedExecutedIds(prev =>
        prev.includes(match.executedPageId) ? prev : [...prev, match.executedPageId]
      );
    }
    setAssemblyMatches(prev => prev.filter(m => m.blankPageId !== pageId));
    setDocuments(prev => prev.map(doc => ({
      ...doc,
      extractedPages: doc.extractedPages.filter(p => p.id !== pageId)
    })));
  };

  const removeDocument = (docId: string) => {
    const doc = documents.find(d => d.id === docId);
    const blankIds = new Set(doc?.extractedPages.map(p => p.id) ?? []);
    const toExclude = assemblyMatches
      .filter(m => blankIds.has(m.blankPageId) && m.status === 'auto-matched')
      .map(m => m.executedPageId);
    if (toExclude.length > 0) {
      setAutoMatchExcludedExecutedIds(prev => [...new Set([...prev, ...toExclude])]);
    }
    setAssemblyMatches(prev => prev.filter(m => !blankIds.has(m.blankPageId)));
    setDocuments(prev => prev.filter(d => d.id !== docId));
  };

  const beginRenameDocument = (doc: ProcessedDocument) => {
    setRenamingDocId(doc.id);
    setRenameDraft(doc.name);
  };

  const saveRenameDocument = (docId: string) => {
    const nextName = renameDraft.trim();
    if (!nextName) {
      setRenamingDocId(null);
      setRenameDraft('');
      return;
    }

    setDocuments(prev => prev.map(doc => doc.id === docId ? {
      ...doc,
      name: nextName,
      extractedPages: doc.extractedPages.map(p => ({ ...p, documentName: nextName }))
    } : doc));
    setAssemblyMatches(prev => prev.map(m => m.documentId === docId ? { ...m, documentName: nextName } : m));
    setRenamingDocId(null);
    setRenameDraft('');
  };

  const beginRenameExecutedUpload = (upload: ExecutedUpload) => {
    setRenamingExecutedId(upload.id);
    setRenameDraft(upload.fileName);
  };

  const saveRenameExecutedUpload = (uploadId: string) => {
    const nextName = renameDraft.trim();
    if (!nextName) {
      setRenamingExecutedId(null);
      setRenameDraft('');
      return;
    }

    setExecutedUploads(prev => prev.map(upload => upload.id === uploadId ? {
      ...upload,
      fileName: nextName,
      executedPages: upload.executedPages.map(page => ({ ...page, sourceFileName: nextName }))
    } : upload));
    setRenamingExecutedId(null);
    setRenameDraft('');
  };

  // --- Save / Load Configuration ---

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Strip the data:...;base64, prefix to store raw base64
        resolve(result.split(',')[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handleSaveConfiguration = async () => {
    const pages = documents.flatMap(d => d.extractedPages);
    if (pages.length === 0) return;

    setIsProcessing(true);
    setCurrentStatus('Bundling PDFs into config...');

    try {
      // Convert document PDFs to base64
      const docEntries = await Promise.all(documents.map(async ({ id, name, pageCount, file }) => {
        const entry: { id: string; name: string; pageCount: number; pdfBase64?: string } = { id, name, pageCount };
        if (file) {
          entry.pdfBase64 = await fileToBase64(file);
        }
        return entry;
      }));

      // Convert executed upload PDFs to base64
      const execEntries = await Promise.all(
        executedUploads
          .filter(u => u.status === 'completed')
          .map(async ({ id, fileName, pageCount, executedPages, file }) => {
            const entry: { id: string; fileName: string; pageCount: number; executedPages: typeof executedPages; pdfBase64?: string } = { id, fileName, pageCount, executedPages };
            if (file) {
              entry.pdfBase64 = await fileToBase64(file);
            }
            return entry;
          })
      );

      const config: SavedConfiguration = {
        version: 1,
        savedAt: new Date().toISOString(),
        groupingMode,
        documents: docEntries,
        extractedPages: pages,
        executedUploads: execEntries,
        assemblyMatches,
      };

      const blob = new Blob([JSON.stringify(config)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `SignatureConfig_${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.error('Error saving configuration:', e);
      alert('Failed to save configuration.');
    } finally {
      setIsProcessing(false);
      setCurrentStatus('');
    }
  };

  const base64ToFile = (base64: string, fileName: string): File => {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new File([bytes], fileName, { type: 'application/pdf' });
  };

  const handleLoadConfiguration = (file: File | null) => {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const raw = e.target?.result as string;
        const config = JSON.parse(raw) as SavedConfiguration;

        // Basic validation
        if (config.version !== 1 || !Array.isArray(config.documents) || !Array.isArray(config.extractedPages)) {
          alert('Invalid configuration file.');
          return;
        }

        // Build restored documents, distributing extractedPages back by documentId
        const pagesByDocId = new Map<string, ExtractedSignaturePage[]>();
        for (const page of config.extractedPages) {
          const arr = pagesByDocId.get(page.documentId) ?? [];
          arr.push(page);
          pagesByDocId.set(page.documentId, arr);
        }

        const hasBundledPdfs = config.documents.some(d => !!d.pdfBase64);

        const restoredDocs: ProcessedDocument[] = config.documents.map(d => {
          const pdfFile = d.pdfBase64 ? base64ToFile(d.pdfBase64, d.name) : null;
          return {
            id: d.id,
            name: d.name,
            file: pdfFile,
            pageCount: d.pageCount,
            status: pdfFile ? 'completed' as const : 'restored' as const,
            extractedPages: pagesByDocId.get(d.id) ?? [],
          };
        });

        setDocuments(restoredDocs);
        setGroupingMode(config.groupingMode);

        // Restore assembly state if present
        if (config.executedUploads && config.executedUploads.length > 0) {
          const restoredUploads: ExecutedUpload[] = config.executedUploads.map(u => ({
            ...u,
            file: u.pdfBase64 ? base64ToFile(u.pdfBase64, u.fileName) : null as unknown as File,
            status: 'completed' as const,
          }));
          setExecutedUploads(restoredUploads);
        }
        if (config.assemblyMatches && config.assemblyMatches.length > 0) {
          setAssemblyMatches(config.assemblyMatches);
        }

        if (hasBundledPdfs) {
          setCurrentStatus('Configuration loaded with bundled PDFs');
        } else {
          setCurrentStatus('Configuration loaded — re-upload PDFs to enable pack download');
        }
        setTimeout(() => setCurrentStatus(''), 4000);
      } catch {
        alert('Could not read configuration file. Make sure it is a valid Signature Packet IDE JSON.');
      }
    };
    reader.readAsText(file);

    // Reset so the same file can be re-loaded later
    if (loadConfigInputRef.current) loadConfigInputRef.current.value = '';
  };

  // --- Assembly Mode Handlers ---

  const allExecutedPages = useMemo(() => {
    return executedUploads.flatMap(u => u.executedPages);
  }, [executedUploads]);

  const handleExecutedFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const uploadedFiles = Array.from(files);
    setCurrentStatus('Preparing executed uploads...');

    const normalizedUploads: NormalizedUpload[] = await Promise.all(uploadedFiles.map(async (f) => {
      try {
        const pdfFile = await normalizeUploadToPdf(f);
        if (!pdfFile) {
          return { sourceFile: f, pdfFile: null, errorMessage: 'Unsupported file type. Please upload PDF or DOCX.' };
        }
        return { sourceFile: f, pdfFile };
      } catch (error) {
        console.error(`Failed to normalize executed file ${f.name}`, error);
        return { sourceFile: f, pdfFile: null, errorMessage: getErrorMessage(error, 'DOCX conversion failed') };
      }
    }));
    setCurrentStatus('');

    // Create ExecutedUpload entries
    const newUploads: ExecutedUpload[] = normalizedUploads
      .map(item => ({
        id: uuidv4(),
        file: item.pdfFile ?? item.sourceFile,
        fileName: (item.pdfFile?.name ?? item.sourceFile.name),
        pageCount: 0,
        status: item.pdfFile ? 'pending' as const : 'error' as const,
        errorMessage: item.errorMessage,
        executedPages: [],
      }))
      .filter(u => u.status === 'pending' || u.status === 'error');

    // Check for duplicate filenames
    const existingNames = new Set(executedUploads.map(u => `${u.fileName}_${u.file.size}`));
    const deduped = newUploads.filter(u => {
      const key = `${u.fileName}_${u.file.size}`;
      if (existingNames.has(key)) {
        console.warn(`Skipping duplicate executed upload: ${u.fileName}`);
        return false;
      }
      return true;
    });

    if (deduped.length === 0) return;

    setExecutedUploads(prev => [...prev, ...deduped]);

    // Process each upload
    for (const upload of deduped.filter(u => u.status === 'pending')) {
      await processExecutedUpload(upload);
    }
  };

  const processExecutedUpload = async (upload: ExecutedUpload) => {
    setExecutedUploads(prev => prev.map(u => u.id === upload.id ? { ...u, status: 'processing', progress: 0, errorMessage: undefined } : u));

    try {
      const pageCount = await getPageCount(upload.file);
      const executedPages: ExecutedSignaturePage[] = [];

      for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
        try {
          const { dataUrl, width, height } = await renderPageToImage(upload.file, pageIndex);
          const analysis = await analyzeExecutedPage(dataUrl);

          if (analysis.signatures.length > 0) {
            // Create an ExecutedSignaturePage for each signature block found
            for (const sig of analysis.signatures) {
              executedPages.push({
                id: uuidv4(),
                sourceUploadId: upload.id,
                sourceFileName: upload.fileName,
                pageIndexInSource: pageIndex,
                pageNumber: pageIndex + 1,
                extractedDocumentName: analysis.documentName || '',
                extractedPartyName: sig.partyName || '',
                extractedSignatoryName: sig.signatoryName || '',
                extractedCapacity: sig.capacity || '',
                isConfirmedExecuted: analysis.isExecuted,
                thumbnailUrl: dataUrl,
                originalWidth: width,
                originalHeight: height,
                matchedBlankPageId: null,
                matchConfidence: null,
              });
            }
          } else {
            // No signatures found, but still create an entry for the page
            executedPages.push({
              id: uuidv4(),
              sourceUploadId: upload.id,
              sourceFileName: upload.fileName,
              pageIndexInSource: pageIndex,
              pageNumber: pageIndex + 1,
              extractedDocumentName: analysis.documentName || '',
              extractedPartyName: '',
              extractedSignatoryName: '',
              extractedCapacity: '',
              isConfirmedExecuted: analysis.isExecuted,
              thumbnailUrl: dataUrl,
              originalWidth: width,
              originalHeight: height,
              matchedBlankPageId: null,
              matchConfidence: null,
            });
          }
        } catch (err) {
          console.error(`Error processing executed page ${pageIndex} of ${upload.fileName}`, err);
        }

        // Update progress
        const progress = Math.round(((pageIndex + 1) / pageCount) * 100);
        setExecutedUploads(prev => prev.map(u => u.id === upload.id ? { ...u, progress } : u));
      }

      setExecutedUploads(prev => prev.map(u => u.id === upload.id ? {
        ...u,
        status: 'completed',
        progress: 100,
        errorMessage: undefined,
        pageCount,
        executedPages,
      } : u));

    } catch (error) {
      console.error(`Error processing executed upload ${upload.fileName}`, error);
      setExecutedUploads(prev => prev.map(u => u.id === upload.id ? {
        ...u,
        status: 'error',
        errorMessage: getErrorMessage(error, 'Failed to process this executed upload')
      } : u));
    }
  };

  const handleAutoMatch = () => {
    const newMatches = autoMatch(
      allPages,
      allExecutedPages,
      assemblyMatches,
      autoMatchExcludedExecutedIds
    );
    if (newMatches.length === 0) {
      setCurrentStatus('No new matches found');
      setTimeout(() => setCurrentStatus(''), 2000);
      return;
    }

    // Merge: keep existing confirmed/overridden matches, replace auto-matches, add new ones
    setAssemblyMatches(prev => {
      const preserved = prev.filter(m => m.status === 'user-confirmed' || m.status === 'user-overridden');
      return [...preserved, ...newMatches];
    });

    setCurrentStatus(`Auto-matched ${newMatches.length} page${newMatches.length > 1 ? 's' : ''}`);
    setTimeout(() => setCurrentStatus(''), 3000);
  };

  const handleManualMatch = (blankPageId: string, executedPageId: string) => {
    const blank = allPages.find(p => p.id === blankPageId);
    const executed = allExecutedPages.find(p => p.id === executedPageId);
    if (!blank || !executed) return;

    const match = createManualMatch(blank, executed);

    setAssemblyMatches(prev => {
      // Remove any existing match for this blank page
      const filtered = prev.filter(m => m.blankPageId !== blankPageId);
      return [...filtered, match];
    });
    setAutoMatchExcludedExecutedIds(prev => prev.filter(id => id !== executedPageId));
  };

  const handleUnmatch = (blankPageId: string) => {
    const match = assemblyMatches.find(m => m.blankPageId === blankPageId);
    if (match?.status === 'auto-matched') {
      setAutoMatchExcludedExecutedIds(prev =>
        prev.includes(match.executedPageId) ? prev : [...prev, match.executedPageId]
      );
    }
    setAssemblyMatches(prev => prev.filter(m => m.blankPageId !== blankPageId));
  };

  const handleUnmatchByExecutedId = (executedPageId: string) => {
    const match = assemblyMatches.find(m => m.executedPageId === executedPageId);
    if (match?.status === 'auto-matched') {
      setAutoMatchExcludedExecutedIds(prev =>
        prev.includes(executedPageId) ? prev : [...prev, executedPageId]
      );
    }
    setAssemblyMatches(prev => prev.filter(m => m.executedPageId !== executedPageId));
  };

  const handleChecklistCellClick = (blankPageId: string, currentMatch: AssemblyMatch | null) => {
    setMatchPickerState({
      isOpen: true,
      blankPageId,
      currentMatch,
      initialExecutedPageId: null,
    });
  };

  const handleMatchFromExecutedCard = (executedPageId: string) => {
    const executed = allExecutedPages.find(p => p.id === executedPageId);
    if (!executed) return;
    const targetBlank = pickBestBlankForExecuted(executed);
    if (!targetBlank) {
      setCurrentStatus('No unmatched blank signature pages available to match');
      setTimeout(() => setCurrentStatus(''), 2500);
      return;
    }
    setMatchPickerState({
      isOpen: true,
      blankPageId: targetBlank.id,
      currentMatch: assemblyMatches.find(m => m.blankPageId === targetBlank.id) ?? null,
      initialExecutedPageId: executedPageId,
    });
  };

  const handleAssembleDocuments = async () => {
    if (assemblyMatches.length === 0) return;

    // Warn about unmatched pages
    const unmatchedCount = allPages.length - assemblyMatches.length;
    if (unmatchedCount > 0) {
      const proceed = window.confirm(
        `${unmatchedCount} signature page${unmatchedCount > 1 ? 's' : ''} still unmatched. ` +
        `Unmatched pages will keep the original (blank) signature page in the assembled document. Continue?`
      );
      if (!proceed) return;
    }

    setIsProcessing(true);
    setCurrentStatus('Assembling documents...');
    let assemblyFailed = false;

    try {
      const assembledPdfs = await assembleAllDocuments(documents, assemblyMatches, executedUploads);

      const zip = new JSZip();
      for (const [filename, data] of Object.entries(assembledPdfs)) {
        zip.file(filename, data);
      }

      const zipContent = await zip.generateAsync({ type: 'blob' });
      const url = window.URL.createObjectURL(zipContent);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Assembled_Documents_${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

    } catch (e) {
      assemblyFailed = true;
      console.error('Assembly error:', e);
      const message = getErrorMessage(e, 'Failed to assemble documents');
      setCurrentStatus(`Assembly failed: ${message}`);
      setTimeout(() => setCurrentStatus(''), 8000);
      alert(`Failed to assemble documents.\n\n${message}`);
    } finally {
      setIsProcessing(false);
      if (!assemblyFailed) setCurrentStatus('');
    }
  };

  const removeExecutedUpload = (uploadId: string) => {
    // Also remove any matches that reference pages from this upload
    setExecutedUploads(prev => {
      const upload = prev.find(u => u.id === uploadId);
      if (upload) {
        const pageIds = new Set(upload.executedPages.map(p => p.id));
        setAssemblyMatches(matches => matches.filter(m => !pageIds.has(m.executedPageId)));
      }
      return prev.filter(u => u.id !== uploadId);
    });
  };

  // --- Preview Logic ---

  const openPreview = (url: string, title: string) => {
    setPreviewState({ isOpen: true, url, title });
  };

  const closePreview = () => {
    revokePreviewBlobUrl(previewState.url);
    setPreviewState({ isOpen: false, url: null, title: '' });
  };

  /** Escape closes the top overlay: PDF preview (z above match picker), then Reassign / Match dialog. */
  useEffect(() => {
    if (!previewState.isOpen && !matchPickerState.isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (previewState.isOpen) {
        revokePreviewBlobUrl(previewState.url);
        setPreviewState({ isOpen: false, url: null, title: '' });
        return;
      }
      if (matchPickerState.isOpen) {
        setMatchPickerState({ isOpen: false, blankPageId: null, currentMatch: null, initialExecutedPageId: null });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewState.isOpen, previewState.url, matchPickerState.isOpen]);

  const handlePreviewDocument = async (doc: ProcessedDocument) => {
    if (doc.status === 'error' || doc.status === 'restored' || !doc.file) return;
    const url = URL.createObjectURL(doc.file);
    openPreview(url, doc.name);
  };

  const handlePreviewSignaturePage = async (page: ExtractedSignaturePage) => {
    // Find the original document file
    const parentDoc = documents.find(d => d.id === page.documentId);
    if (!parentDoc || !parentDoc.file) return;

    try {
      const pdfBytes = await extractSinglePagePdf(parentDoc.file, page.pageIndex);
      const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      openPreview(url, `${page.documentName} - Page ${page.pageNumber}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[Preview] Single-page extract failed (blank). Using full PDF + #page.', e);
      const blobUrl = URL.createObjectURL(parentDoc.file);
      openPreview(`${blobUrl}#page=${page.pageNumber}`, `${page.documentName} - Page ${page.pageNumber}`);
      setCurrentStatus(`Preview: full document at page ${page.pageNumber} (extract: ${message})`);
      setTimeout(() => setCurrentStatus(''), 7000);
    }
  };

  const handlePreviewExecutedPage = async (page: ExecutedSignaturePage) => {
    const sourceUpload = executedUploads.find(u => u.id === page.sourceUploadId);
    if (!sourceUpload) return;

    try {
      const pdfBytes = await extractSinglePagePdf(sourceUpload.file, page.pageIndexInSource);
      const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      openPreview(url, `${page.sourceFileName} - Page ${page.pageNumber}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[Preview] Single-page extract failed (executed). Using full PDF + #page.', e);
      const blobUrl = URL.createObjectURL(sourceUpload.file);
      openPreview(`${blobUrl}#page=${page.pageNumber}`, `${page.sourceFileName} - Page ${page.pageNumber}`);
      setCurrentStatus(`Preview: full document at page ${page.pageNumber} (extract: ${message})`);
      setTimeout(() => setCurrentStatus(''), 7000);
    }
  };

  // --- Derived State for View ---

  const allPages = useMemo(() => {
    return documents.flatMap(d => d.extractedPages);
  }, [documents]);

  const uniqueParties = useMemo(() => {
    const parties = new Set(allPages.map(p => p.partyName));
    return ['All', ...(Array.from(parties) as string[]).sort()];
  }, [allPages]);

  const displayedPages = useMemo(() => {
    let pages = allPages;
    
    // Sort logic
    if (groupingMode === 'agreement') {
      return pages.sort((a, b) => {
        if (a.documentName !== b.documentName) return a.documentName.localeCompare(b.documentName);
        return a.pageIndex - b.pageIndex;
      });
    } else if (groupingMode === 'counterparty') {
      return pages.sort((a, b) => {
        if (a.partyName !== b.partyName) return a.partyName.localeCompare(b.partyName);
        return a.documentName.localeCompare(b.documentName);
      });
    } else {
       // By Signatory
       return pages.sort((a, b) => {
         const sigA = a.signatoryName || 'ZZZ';
         const sigB = b.signatoryName || 'ZZZ';
         if (sigA !== sigB) return sigA.localeCompare(sigB);
         return a.partyName.localeCompare(b.partyName);
       });
    }
  }, [allPages, groupingMode]);

  const navigationGroups = useMemo(() => {
    const groups = new Set<string>();
    displayedPages.forEach(p => {
      if (groupingMode === 'agreement') groups.add(p.documentName);
      else if (groupingMode === 'counterparty') groups.add(p.partyName);
      else groups.add(p.signatoryName || 'Unknown Signatory');
    });
    return Array.from(groups);
  }, [displayedPages, groupingMode]);

  /** Blank signature pages with no assembly match (copies > 0). */
  const missingBlankPages = useMemo(() => {
    const matched = new Set(assemblyMatches.map((m) => m.blankPageId));
    return allPages.filter((p) => p.copies > 0 && !matched.has(p.id));
  }, [allPages, assemblyMatches]);

  /** Subset we can export (parent document still has PDF on disk). */
  const { missingDownloadablePages, missingSkippedNoSourceFile } = useMemo(() => {
    const downloadable: ExtractedSignaturePage[] = [];
    let skipped = 0;
    for (const p of missingBlankPages) {
      const doc = documents.find((d) => d.id === p.documentId);
      if (doc?.file) downloadable.push(p);
      else skipped += 1;
    }
    return { missingDownloadablePages: downloadable, missingSkippedNoSourceFile: skipped };
  }, [missingBlankPages, documents]);

  const missingSignatoryOptions = useMemo(() => {
    const names = new Set<string>();
    for (const p of missingDownloadablePages) {
      names.add(p.signatoryName?.trim() || 'Unknown Signatory');
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [missingDownloadablePages]);

  useEffect(() => {
    if (missingPackSignatoryFilter === '__all__') return;
    if (!missingSignatoryOptions.includes(missingPackSignatoryFilter)) {
      setMissingPackSignatoryFilter('__all__');
    }
  }, [missingSignatoryOptions, missingPackSignatoryFilter]);

  const pagesForMissingPack = useMemo(() => {
    if (missingPackSignatoryFilter === '__all__') return missingDownloadablePages;
    return missingDownloadablePages.filter(
      (p) => (p.signatoryName?.trim() || 'Unknown Signatory') === missingPackSignatoryFilter,
    );
  }, [missingDownloadablePages, missingPackSignatoryFilter]);

  const scrollToGroup = (groupName: string) => {
    const id = `group-${groupName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // --- Export Logic ---

  const handleDownloadPack = async () => {
    if (displayedPages.length === 0) return;
    setIsProcessing(true);
    setCurrentStatus('Generating ZIP Pack...');
    
    try {
      const pdfs = await generateGroupedPdfs(documents, displayedPages, groupingMode);
      
      const zip = new JSZip();
      
      // Add each PDF to the zip file
      for (const [filename, data] of Object.entries(pdfs)) {
        zip.file(filename, data);
      }

      // Generate the ZIP blob
      const zipContent = await zip.generateAsync({ type: 'blob' });
      
      // Trigger download
      const url = window.URL.createObjectURL(zipContent);
      const link = document.createElement('a');
      link.href = url;
      link.download = `SignaturePack_${groupingMode}_${new Date().toISOString().slice(0,10)}.zip`;
      link.click();
      
    } catch (e) {
      console.error(e);
      alert("Failed to generate ZIP pack");
    } finally {
      setIsProcessing(false);
      setCurrentStatus('');
    }
  };

  /**
   * ZIP of blank signature pages that are still unmatched — for chasing a signatory or counsel.
   * PDFs are grouped by agreement name (stable in Assembly when grouping toggles are hidden).
   */
  const handleDownloadMissingPack = async () => {
    if (pagesForMissingPack.length === 0) return;
    setIsProcessing(true);
    setCurrentStatus('Generating missing-pages pack...');

    try {
      const pdfs = await generateGroupedPdfs(documents, pagesForMissingPack, 'agreement');

      const zip = new JSZip();
      for (const [filename, data] of Object.entries(pdfs)) {
        zip.file(filename, data);
      }

      const zipContent = await zip.generateAsync({ type: 'blob' });
      const url = window.URL.createObjectURL(zipContent);
      const link = document.createElement('a');
      link.href = url;
      const who =
        missingPackSignatoryFilter === '__all__'
          ? 'all'
          : missingPackSignatoryFilter.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 80);
      link.download = `SignaturePack_missing_${who}_${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);

      if (missingSkippedNoSourceFile > 0) {
        window.alert(
          `${missingSkippedNoSourceFile} unmatched page(s) were omitted because the source document has no PDF on disk (re-upload from a saved config to include them).`,
        );
      }
    } catch (e) {
      console.error(e);
      window.alert('Failed to generate missing-pages pack');
    } finally {
      setIsProcessing(false);
      setCurrentStatus('');
    }
  };

  // --- Render ---

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      
      {/* PDF Preview Modal */}
      <PdfPreviewModal 
        isOpen={previewState.isOpen}
        title={previewState.title}
        onClose={closePreview}
        pdfUrl={previewState.url}
      />

      {/* Instructions Modal */}
      <InstructionsModal
        isOpen={isInstructionsOpen}
        onClose={() => setIsInstructionsOpen(false)}
        pages={displayedPages}
      />

      {/* Match Picker Modal */}
      <MatchPickerModal
        isOpen={matchPickerState.isOpen}
        onClose={() => setMatchPickerState({ isOpen: false, blankPageId: null, currentMatch: null, initialExecutedPageId: null })}
        blankPage={allPages.find(p => p.id === matchPickerState.blankPageId) || null}
        currentMatch={matchPickerState.currentMatch}
        initialExecutedPageId={matchPickerState.initialExecutedPageId}
        executedPages={allExecutedPages}
        allMatches={assemblyMatches}
        onConfirmMatch={handleManualMatch}
        onUnmatch={handleUnmatch}
        onPreviewBlank={handlePreviewSignaturePage}
        onPreviewExecuted={handlePreviewExecutedPage}
      />

      {/* Replace Version Input */}
      <input
        ref={replaceDocInputRef}
        type="file"
        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={(e) => handleReplaceDocumentSelected(e.target.files?.[0] ?? null)}
      />

      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between flex-shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center p-1 shrink-0"
            aria-hidden
          >
            <div className="w-full h-full bg-white rounded flex items-center justify-center overflow-hidden">
              <img
                src="/favicon-32.png"
                alt=""
                width={22}
                height={22}
                className="w-[22px] h-[22px] object-contain"
                decoding="async"
              />
            </div>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800 tracking-tight leading-none">Signature Packet IDE</h1>
            <p className="text-xs text-slate-500 font-medium">Automated Signature Page Extraction</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
             {/* Stats */}
             <div className="hidden md:flex gap-4 text-xs font-medium text-slate-500 mr-4">
               <span>{documents.length} Docs</span>
               <span>{allPages.length} Sig Pages Found</span>
             </div>
             {/* Save / Load Config */}
             <div className="flex items-center gap-2">
               <input
                 ref={loadConfigInputRef}
                 type="file"
                 accept=".json"
                 className="hidden"
                 id="loadConfigInput"
                 onChange={(e) => handleLoadConfiguration(e.target.files?.[0] ?? null)}
               />
               <button
                 onClick={() => loadConfigInputRef.current?.click()}
                 className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors"
                 title="Load a previously saved configuration"
               >
                 <FolderOpen size={13} /> Load Config
               </button>
               <button
                 onClick={handleSaveConfiguration}
                 disabled={allPages.length === 0}
                 className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed rounded-md transition-colors"
                 title="Save current configuration as JSON"
               >
                 <Save size={13} /> Save Config
               </button>
             </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden min-w-0">

        {/* Sidebar: Documents */}
        <div className="w-80 bg-white border-r border-slate-200 flex flex-col flex-shrink-0">
          <div className="p-4 border-b border-slate-100">
             <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Documents</h2>
             <div 
                className={`border-2 border-dashed rounded-lg p-6 flex flex-col items-center justify-center text-center transition-colors cursor-pointer ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-slate-300 hover:border-blue-400 hover:bg-slate-50'}`}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  handleFileUpload(e.dataTransfer.files);
                }}
             >
                <input 
                  type="file" 
                  multiple 
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="hidden" 
                  id="fileInput"
                  onChange={(e) => handleFileUpload(e.target.files)}
                />
                <label htmlFor="fileInput" className="cursor-pointer flex flex-col items-center">
                   <UploadCloud className="text-blue-500 mb-2" size={24} />
                   <span className="text-sm font-medium text-slate-700">Upload Agreements</span>
                   <span className="text-xs text-slate-400 mt-1">PDF or DOCX (DOCX converts via configured service)</span>
                </label>
             </div>

             <button
                onClick={handleProcessPending}
                disabled={isProcessing || !documents.some(d => d.status === 'pending')}
                className="w-full mt-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white py-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2"
             >
                {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
                Extract
             </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-2">
             {documents.map(doc => (
               <div key={doc.id} className={`group relative flex items-center gap-3 p-3 rounded-md border transition-all ${
                 doc.status === 'error' ? 'bg-red-50 border-red-100' :
                 doc.status === 'restored' ? 'bg-amber-50 border-amber-100' :
                 'hover:bg-slate-50 border-transparent hover:border-slate-100'
               }`}>
                  <div className={`p-2 rounded text-slate-500 ${
                    doc.status === 'error' ? 'bg-red-100 text-red-500' :
                    doc.status === 'restored' ? 'bg-amber-100 text-amber-600' :
                    'bg-slate-100'
                  }`}>
                     <FileIcon size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    {renamingDocId === doc.id ? (
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveRenameDocument(doc.id);
                          if (e.key === 'Escape') { setRenamingDocId(null); setRenameDraft(''); }
                        }}
                        className="w-full text-sm px-2 py-1 rounded border border-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    ) : (
                      <p className={`text-sm font-medium break-words whitespace-normal leading-snug ${
                        doc.status === 'error' ? 'text-red-700' :
                        doc.status === 'restored' ? 'text-amber-800' :
                        'text-slate-700'
                      }`} title={doc.name}>{doc.name}</p>
                    )}
                     <div className="text-xs text-slate-500 flex flex-col gap-1">
                        <div className="flex items-center gap-1">
                          {doc.status === 'processing' && <><Loader2 size={10} className="animate-spin" /> Processing...</>}
                          {doc.status === 'completed' && <><CheckCircle2 size={10} className="text-green-500" /> {doc.extractedPages.length} sig pages</>}
                          {doc.status === 'error' && (
                            <span className="text-red-500">
                              {doc.errorMessage || 'PDF or DOCX only'}
                            </span>
                          )}
                          {doc.status === 'pending' && 'Queued'}
                          {doc.status === 'restored' && (
                            <span className="flex items-center gap-1 text-amber-600" title="Re-upload this PDF to enable pack download and re-scan for changes">
                              <AlertTriangle size={10} /> Needs file
                            </span>
                          )}
                        </div>
                        {doc.status === 'restored' && (
                          <span className="text-amber-500 text-xs">{doc.extractedPages.length} sig pages (saved)</span>
                        )}
                        {doc.status === 'processing' && doc.progress !== undefined && (
                          <div className="w-full bg-slate-200 rounded-full h-1.5 mt-1">
                            <div
                              className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                              style={{ width: `${doc.progress}%` }}
                            ></div>
                          </div>
                        )}
                     </div>
                  </div>

                  {/* Document Actions */}
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                    {doc.status !== 'error' && doc.status !== 'restored' && (
                        <button
                        onClick={() => handlePreviewDocument(doc)}
                        className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-blue-500 transition-all mr-1"
                        title="Preview Document"
                        >
                        <Eye size={14} />
                        </button>
                    )}
                    {renamingDocId === doc.id ? (
                      <>
                        <button
                          onClick={() => saveRenameDocument(doc.id)}
                          className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-green-600 transition-all mr-1"
                          title="Save name"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={() => { setRenamingDocId(null); setRenameDraft(''); }}
                          className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-red-500 transition-all"
                          title="Cancel rename"
                        >
                          <X size={14} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => beginRenameDocument(doc)}
                          className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-blue-500 transition-all mr-1"
                          title="Rename document"
                        >
                          <Pencil size={14} />
                        </button>
                        {doc.status !== 'processing' && (
                          <button
                            onClick={() => handleReplaceDocumentClick(doc.id)}
                            className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-indigo-500 transition-all mr-1"
                            title="Replace with new version"
                          >
                            <UploadCloud size={14} />
                          </button>
                        )}
                        <button
                          onClick={() => removeDocument(doc.id)}
                          className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-red-500 transition-all"
                          title="Remove Document"
                        >
                          <X size={14} />
                        </button>
                      </>
                    )}
                  </div>

               </div>
             ))}

             {documents.length === 0 && (
               <div className="text-center p-8 text-slate-400 text-sm">
                 No documents uploaded yet.
               </div>
             )}

             {/* Executed Uploads Section (Assembly Mode) */}
             {appMode === 'assembly' && (
               <>
                 <div className="border-t border-slate-200 my-2"></div>
                 <div className="px-2 pt-2">
                   <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Executed Pages</h2>
                   <div
                     className={`border-2 border-dashed rounded-lg p-4 flex flex-col items-center justify-center text-center transition-colors cursor-pointer ${isDraggingExecuted ? 'border-green-500 bg-green-50' : 'border-slate-300 hover:border-green-400 hover:bg-slate-50'}`}
                     onDragOver={(e) => { e.preventDefault(); setIsDraggingExecuted(true); }}
                     onDragLeave={() => setIsDraggingExecuted(false)}
                     onDrop={(e) => {
                       e.preventDefault();
                       setIsDraggingExecuted(false);
                       handleExecutedFileUpload(e.dataTransfer.files);
                     }}
                   >
                     <input
                       type="file"
                       multiple
                      accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                       className="hidden"
                       id="executedFileInput"
                       onChange={(e) => handleExecutedFileUpload(e.target.files)}
                     />
                     <label htmlFor="executedFileInput" className="cursor-pointer flex flex-col items-center">
                       <UploadCloud className="text-green-500 mb-1.5" size={20} />
                       <span className="text-xs font-medium text-slate-700">Upload Signed Pages</span>
                       <span className="text-[10px] text-slate-400 mt-0.5">Scanned or electronic</span>
                     </label>
                   </div>
                 </div>

                 {/* Executed uploads list */}
                 {executedUploads.map(upload => (
                   <div key={upload.id} className={`group relative flex items-center gap-3 p-3 rounded-md border transition-all ${
                     upload.status === 'error' ? 'bg-red-50 border-red-100' :
                     'hover:bg-slate-50 border-transparent hover:border-slate-100'
                   }`}>
                     <div className={`p-2 rounded ${
                       upload.status === 'error' ? 'bg-red-100 text-red-500' :
                       upload.status === 'completed' ? 'bg-green-100 text-green-600' :
                       'bg-slate-100 text-slate-500'
                     }`}>
                       <FileIcon size={16} />
                     </div>
                     <div className="flex-1 min-w-0">
                      {renamingExecutedId === upload.id ? (
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveRenameExecutedUpload(upload.id);
                            if (e.key === 'Escape') { setRenamingExecutedId(null); setRenameDraft(''); }
                          }}
                          className="w-full text-sm px-2 py-1 rounded border border-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      ) : (
                        <p className="text-sm font-medium break-words whitespace-normal leading-snug text-slate-700" title={upload.fileName}>{upload.fileName}</p>
                      )}
                       <div className="text-xs text-slate-500 flex flex-col gap-1">
                         <div className="flex items-center gap-1">
                           {upload.status === 'processing' && <><Loader2 size={10} className="animate-spin" /> Analyzing...</>}
                           {upload.status === 'completed' && <><CheckCircle2 size={10} className="text-green-500" /> {upload.executedPages.filter(p => p.isConfirmedExecuted).length} signed pages</>}
                          {upload.status === 'error' && (
                            <span className="text-red-500">
                              {upload.errorMessage || 'Error'}
                            </span>
                          )}
                           {upload.status === 'pending' && 'Queued'}
                         </div>
                         {upload.status === 'processing' && upload.progress !== undefined && (
                           <div className="w-full bg-slate-200 rounded-full h-1.5 mt-1">
                             <div
                               className="bg-green-500 h-1.5 rounded-full transition-all duration-300"
                               style={{ width: `${upload.progress}%` }}
                             ></div>
                           </div>
                         )}
                       </div>
                     </div>
                     <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                      {renamingExecutedId === upload.id ? (
                        <>
                          <button
                            onClick={() => saveRenameExecutedUpload(upload.id)}
                            className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-green-600 transition-all mr-1"
                            title="Save name"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            onClick={() => { setRenamingExecutedId(null); setRenameDraft(''); }}
                            className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-red-500 transition-all"
                            title="Cancel rename"
                          >
                            <X size={14} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => beginRenameExecutedUpload(upload)}
                            className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-blue-500 transition-all mr-1"
                            title="Rename upload"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            onClick={() => removeExecutedUpload(upload.id)}
                            className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-red-500 transition-all"
                            title="Remove"
                          >
                            <X size={14} />
                          </button>
                        </>
                      )}
                     </div>
                   </div>
                 ))}
               </>
             )}
          </div>
        </div>

        {/* Main Content: Review Grid */}
        <div className="flex-1 min-w-0 flex flex-col bg-slate-50/50">
          
          {/* Toolbar */}
          <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between flex-shrink-0 shadow-sm z-10">
            <div className="flex items-center gap-4">
              {/* Mode Toggle */}
              <div className="flex bg-slate-100 p-1 rounded-md">
                <button
                  onClick={() => setAppMode('extract')}
                  className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-2 transition-all ${appMode === 'extract' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  <FileText size={14} /> Extract
                </button>
                <button
                  onClick={() => setAppMode('assembly')}
                  disabled={allPages.length === 0}
                  className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-2 transition-all ${appMode === 'assembly' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'} disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  <ArrowLeftRight size={14} /> Assembly
                </button>
              </div>

              {/* Grouping toggle (only in extract mode) */}
              {appMode === 'extract' && (
                <div className="flex bg-slate-100 p-1 rounded-md">
                  <button
                    onClick={() => setGroupingMode('agreement')}
                    className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-2 transition-all ${groupingMode === 'agreement' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    <Layers size={14} /> Agreement
                  </button>
                  <button
                    onClick={() => setGroupingMode('counterparty')}
                    className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-2 transition-all ${groupingMode === 'counterparty' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    <Users size={14} /> Party
                  </button>
                  <button
                    onClick={() => setGroupingMode('signatory')}
                    className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-2 transition-all ${groupingMode === 'signatory' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    <UserPen size={14} /> Signatory
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Content Area with Nav */}
          <div className="flex-1 flex overflow-hidden min-w-0">
            {/* Grid Area */}
            <div data-assembly-scroll-host className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-6 scroll-smooth">

             {appMode === 'extract' ? (
               // --- Extract Mode Content ---
               <>
                 {displayedPages.length === 0 ? (
                   <div className="h-full flex flex-col items-center justify-center text-slate-400">
                      <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                        <Layers size={32} className="text-slate-300" />
                      </div>
                      <p className="text-lg font-medium text-slate-500">No signature pages found yet</p>
                     <p className="text-sm max-w-md text-center mt-2">Upload agreements (PDF or DOCX) to begin extraction.</p>
                   </div>
                 ) : (
                    <div className="space-y-8 pb-20">
                       {/* Render grouping headers based on current mode */}
                       {displayedPages.reduce((acc: React.ReactNode[], page, idx, arr) => {
                          const prev = arr[idx-1];
                          let shouldInsertHeader = false;
                          let headerText = '';
                          let HeaderIcon = Layers;

                          if (groupingMode === 'agreement') {
                              shouldInsertHeader = !prev || prev.documentName !== page.documentName;
                              headerText = page.documentName;
                              HeaderIcon = FileText;
                          } else if (groupingMode === 'counterparty') {
                              shouldInsertHeader = !prev || prev.partyName !== page.partyName;
                              headerText = page.partyName;
                              HeaderIcon = Users;
                          } else {
                              // Signatory
                              const currentSig = page.signatoryName || 'Unknown Signatory';
                              const prevSig = prev?.signatoryName || 'Unknown Signatory';
                              shouldInsertHeader = !prev || prevSig !== currentSig;
                              headerText = currentSig;
                              HeaderIcon = UserPen;
                          }

                          if (shouldInsertHeader) {
                            const headerId = `group-${headerText.replace(/[^a-zA-Z0-9]/g, '_')}`;
                            acc.push(
                              <div id={headerId} key={`head-${headerText}-${idx}`} className="flex items-center gap-2 pb-2 border-b border-slate-200 mt-4 first:mt-0 scroll-mt-4">
                                <HeaderIcon size={16} className="text-slate-400" />
                                <h3 className="text-sm font-bold text-slate-700">{headerText}</h3>
                              </div>
                            );
                          }

                          acc.push(
                            <SignatureCard
                                key={page.id}
                                page={page}
                                existingParties={uniqueParties.filter(p => p !== 'All')}
                                onUpdateCopies={handleUpdateCopies}
                                onUpdateParty={handleUpdateParty}
                                onUpdateSignatory={handleUpdateSignatory}
                                onUpdateCapacity={handleUpdateCapacity}
                                onDelete={handleDeletePage}
                                onPreview={handlePreviewSignaturePage}
                            />
                          );
                          return acc;
                       }, [])}
                    </div>
                 )}
               </>
             ) : (
               // --- Assembly Mode Content ---
              <div className="space-y-6 pb-20 w-full min-w-0 max-w-full overflow-x-hidden">
                 {/* Completion Checklist Grid */}
                 <CompletionChecklist
                   blankPages={allPages}
                   matches={assemblyMatches}
                   executedPages={allExecutedPages}
                   onCellClick={handleChecklistCellClick}
                 />

                 {/* Executed Pages Cards */}
                 {allExecutedPages.length > 0 && (
                   <div className="space-y-3">
                     <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
                       <Package size={16} className="text-slate-400" />
                       Uploaded Executed Pages ({allExecutedPages.filter(p => p.isConfirmedExecuted).length} signed)
                     </h3>
                     <div className="space-y-2">
                       {allExecutedPages.map(ep => (
                         <ExecutedPageCard
                           key={ep.id}
                           page={ep}
                           match={assemblyMatches.find(m => m.executedPageId === ep.id) || null}
                           onUnmatch={handleUnmatchByExecutedId}
                          onPreview={handlePreviewExecutedPage}
                          onMatchNow={handleMatchFromExecutedCard}
                         />
                       ))}
                     </div>
                   </div>
                 )}

                 {allExecutedPages.length === 0 && (
                   <div className="h-64 flex flex-col items-center justify-center text-slate-400">
                     <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                       <ArrowLeftRight size={32} className="text-slate-300" />
                     </div>
                     <p className="text-lg font-medium text-slate-500">No executed pages yet</p>
                    <p className="text-sm max-w-md text-center mt-2">Upload signed PDFs or DOCX files in the sidebar to begin matching.</p>
                   </div>
                 )}
               </div>
             )}

            </div>

            {/* Right Nav Rail (Extract mode only) */}
            {appMode === 'extract' && displayedPages.length > 0 && (
              <div className="w-64 bg-white border-l border-slate-200 overflow-y-auto p-4 hidden xl:block flex-shrink-0">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                  Jump to {groupingMode === 'counterparty' ? 'Party' : groupingMode === 'signatory' ? 'Signatory' : 'Agreement'}
                </h3>
                <ul className="space-y-1">
                  {navigationGroups.map(g => (
                    <li key={g}>
                      <button
                        onClick={() => scrollToGroup(g)}
                        className="text-sm text-slate-600 hover:text-blue-600 hover:bg-slate-50 w-full text-left px-2 py-1.5 rounded transition-colors truncate"
                        title={g}
                      >
                        {g}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Floating Action Bar — Extract Mode */}
          {appMode === 'extract' && displayedPages.length > 0 && (
            <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 bg-slate-900 text-white px-1 py-1 rounded-full shadow-xl flex items-center gap-1 z-20">
               <button
                 onClick={() => setIsInstructionsOpen(true)}
                 disabled={isProcessing}
                 className="px-5 py-2.5 rounded-full hover:bg-slate-800 transition-colors font-medium text-sm flex items-center gap-2 disabled:opacity-50"
               >
                 <FileText size={16} /> Instructions
               </button>
               <div className="w-px h-5 bg-slate-700"></div>
               <button
                 onClick={handleDownloadPack}
                 disabled={isProcessing}
                 className="px-5 py-2.5 rounded-full bg-blue-600 hover:bg-blue-500 transition-colors font-medium text-sm flex items-center gap-2 shadow-lg shadow-blue-900/20 disabled:opacity-50"
               >
                 {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                 Download
               </button>
            </div>
          )}

          {/* Floating Action Bar — Assembly Mode */}
          {appMode === 'assembly' && allPages.length > 0 && (
            <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 bg-slate-900 text-white px-2 py-2 rounded-2xl shadow-xl flex flex-wrap items-center justify-center gap-1 max-w-[min(56rem,calc(100vw-2rem))] z-20">
               <button
                 onClick={handleAutoMatch}
                 disabled={isProcessing || allExecutedPages.filter(p => p.isConfirmedExecuted).length === 0}
                 className="px-4 py-2.5 rounded-full hover:bg-slate-800 transition-colors font-medium text-sm flex items-center gap-2 disabled:opacity-50"
               >
                 <Wand2 size={16} /> Auto-Match
               </button>
               <div className="w-px h-5 bg-slate-700 hidden sm:block"></div>
               {missingSignatoryOptions.length > 0 && (
                 <select
                   aria-label="Filter missing pages by signatory"
                   value={missingPackSignatoryFilter}
                   onChange={(e) => setMissingPackSignatoryFilter(e.target.value)}
                   className="text-slate-900 text-xs font-medium rounded-full border-0 bg-slate-100 px-3 py-2 max-w-[11rem] sm:max-w-[14rem] truncate"
                 >
                   <option value="__all__">All signatories ({missingDownloadablePages.length})</option>
                   {missingSignatoryOptions.map((name) => {
                     const count = missingDownloadablePages.filter(
                       (p) => (p.signatoryName?.trim() || 'Unknown Signatory') === name,
                     ).length;
                     return (
                       <option key={name} value={name}>
                         {name} ({count})
                       </option>
                     );
                   })}
                 </select>
               )}
               <button
                 onClick={handleDownloadMissingPack}
                 disabled={isProcessing || pagesForMissingPack.length === 0}
                 title="ZIP of unmatched blank signature pages only, one PDF per agreement"
                 className="px-4 py-2.5 rounded-full bg-amber-600 hover:bg-amber-500 transition-colors font-medium text-sm flex items-center gap-2 shadow-lg shadow-amber-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
               >
                 {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Package size={16} />}
                 Missing pages
               </button>
               <div className="w-px h-5 bg-slate-700 hidden sm:block"></div>
               <button
                 onClick={handleAssembleDocuments}
                 disabled={isProcessing || assemblyMatches.length === 0}
                 className="px-4 py-2.5 rounded-full bg-green-600 hover:bg-green-500 transition-colors font-medium text-sm flex items-center gap-2 shadow-lg shadow-green-900/20 disabled:opacity-50"
               >
                 {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                 Assemble & Download
               </button>
            </div>
          )}

          {/* Status Toast */}
          {currentStatus && (
            <div className="absolute top-4 right-6 bg-white border border-slate-200 shadow-lg rounded-md px-4 py-3 flex items-center gap-3 animate-in fade-in slide-in-from-top-4 z-50 max-w-sm">
               <Loader2 size={18} className="animate-spin text-blue-500" />
               <span className="text-sm font-medium text-slate-700">{currentStatus}</span>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

export default App;