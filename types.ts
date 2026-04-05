export interface ProcessedDocument {
  id: string;
  name: string;
  file: File | null; // null when restored from config (awaiting re-upload)
  pageCount: number;
  status: 'pending' | 'processing' | 'completed' | 'error' | 'restored';
  wasRestored?: boolean; // true if this doc came from a saved config and needs merge-rescan
  savedPages?: ExtractedSignaturePage[]; // holds the saved pages during rescan so they survive state clearing
  progress?: number; // 0 to 100
  errorMessage?: string;
  extractedPages: ExtractedSignaturePage[];
}

export interface ExtractedSignaturePage {
  id: string;
  documentId: string;
  documentName: string;
  pageIndex: number; // 0-based index
  pageNumber: number; // 1-based human readable
  partyName: string;
  signatoryName: string; // The human signing
  capacity: string;
  copies: number;
  thumbnailUrl: string; // Data URL of the page image
  originalWidth: number;
  originalHeight: number;
}

export type GroupingMode = 'agreement' | 'counterparty' | 'signatory';

export type AppMode = 'extract' | 'assembly';

// --- Document Assembly Types ---

export interface ExecutedPageExtraction {
  isExecuted: boolean;
  documentName: string;
  signatures: Array<{
    partyName: string;
    signatoryName: string;
    capacity: string;
  }>;
}

export interface ExecutedSignaturePage {
  id: string;
  sourceUploadId: string;        // References ExecutedUpload.id
  sourceFileName: string;
  pageIndexInSource: number;     // 0-based within the uploaded file
  pageNumber: number;            // 1-based display

  // AI-extracted metadata
  extractedDocumentName: string; // "Investors' Rights Agreement" etc.
  extractedPartyName: string;
  extractedSignatoryName: string;
  extractedCapacity: string;
  isConfirmedExecuted: boolean;  // AI says it's actually signed

  thumbnailUrl: string;
  originalWidth: number;
  originalHeight: number;

  matchedBlankPageId: string | null;
  matchConfidence: 'auto' | 'manual' | null;
}

export interface ExecutedUpload {
  id: string;
  file: File;
  fileName: string;
  pageCount: number;
  status: 'pending' | 'processing' | 'completed' | 'error';
  progress?: number;
  errorMessage?: string;
  executedPages: ExecutedSignaturePage[];
}

export interface AssemblyMatch {
  blankPageId: string;           // ExtractedSignaturePage.id
  executedPageId: string;        // ExecutedSignaturePage.id
  documentId: string;            // ProcessedDocument.id
  documentName: string;
  pageIndex: number;             // Exact page position in original PDF
  partyName: string;
  signatoryName: string;
  status: 'auto-matched' | 'user-confirmed' | 'user-overridden';
}

export interface SavedConfiguration {
  version: 1;
  savedAt: string;
  groupingMode: GroupingMode;
  documents: Array<{
    id: string;
    name: string;
    pageCount: number;
    pdfBase64?: string; // Embedded PDF file data
  }>;
  extractedPages: ExtractedSignaturePage[];
  // Assembly state (optional for backward compatibility with older configs)
  executedUploads?: Array<{
    id: string;
    fileName: string;
    pageCount: number;
    executedPages: ExecutedSignaturePage[];
    pdfBase64?: string; // Embedded PDF file data
  }>;
  assemblyMatches?: AssemblyMatch[];
}

export interface SignatureBlockExtraction {
  isSignaturePage: boolean;
  signatures: Array<{
    partyName: string;
    signatoryName: string;
    capacity: string;
  }>;
}

// Ensure PDF.js types are recognized globally as we load via CDN
declare global {
  const pdfjsLib: any;
}