import { describe, it, expect } from 'vitest';
import { autoMatch, createManualMatch } from './matchingService';
import { ExtractedSignaturePage, ExecutedSignaturePage, AssemblyMatch } from '../types';

// --- Fixtures ---

function makeBlank(overrides: Partial<ExtractedSignaturePage> & { id: string }): ExtractedSignaturePage {
  return {
    id: overrides.id,
    documentId: overrides.documentId ?? 'doc-1',
    documentName: overrides.documentName ?? 'Investors Rights Agreement',
    pageIndex: overrides.pageIndex ?? 0,
    pageNumber: overrides.pageNumber ?? 1,
    partyName: overrides.partyName ?? 'Acme Corp',
    signatoryName: overrides.signatoryName ?? 'Jane Smith',
    capacity: overrides.capacity ?? 'Chief Executive Officer',
    copies: overrides.copies ?? 1,
    thumbnailUrl: '',
    originalWidth: 612,
    originalHeight: 792,
  };
}

function makeExecuted(overrides: Partial<ExecutedSignaturePage> & { id: string }): ExecutedSignaturePage {
  return {
    id: overrides.id,
    sourceUploadId: overrides.sourceUploadId ?? 'upload-1',
    sourceFileName: overrides.sourceFileName ?? 'executed.pdf',
    pageIndexInSource: overrides.pageIndexInSource ?? 0,
    pageNumber: overrides.pageNumber ?? 1,
    extractedDocumentName: overrides.extractedDocumentName ?? 'Investors Rights Agreement',
    extractedPartyName: overrides.extractedPartyName ?? 'Acme Corp',
    extractedSignatoryName: overrides.extractedSignatoryName ?? 'Jane Smith',
    extractedCapacity: overrides.extractedCapacity ?? 'Chief Executive Officer',
    isConfirmedExecuted: overrides.isConfirmedExecuted ?? true,
    thumbnailUrl: '',
    originalWidth: 612,
    originalHeight: 792,
    matchedBlankPageId: null,
    matchConfidence: null,
  };
}

// --- Tests ---

describe('autoMatch', () => {
  it('matches identical blank and executed pages', () => {
    const blank = makeBlank({ id: 'b1' });
    const executed = makeExecuted({ id: 'e1' });

    const matches = autoMatch([blank], [executed]);

    expect(matches).toHaveLength(1);
    expect(matches[0].blankPageId).toBe('b1');
    expect(matches[0].executedPageId).toBe('e1');
    expect(matches[0].status).toBe('auto-matched');
  });

  it('does not match executed pages with isConfirmedExecuted = false', () => {
    const blank = makeBlank({ id: 'b1' });
    const executed = makeExecuted({ id: 'e1', isConfirmedExecuted: false });

    const matches = autoMatch([blank], [executed]);

    expect(matches).toHaveLength(0);
  });

  it('does not match pairs below the 0.4 threshold', () => {
    const blank = makeBlank({ id: 'b1', documentName: 'Stock Purchase Agreement', partyName: 'Acme Corp', signatoryName: 'Jane Smith' });
    const executed = makeExecuted({ id: 'e1', extractedDocumentName: 'Completely Different Document', extractedPartyName: 'Other LLC', extractedSignatoryName: 'Bob Jones' });

    const matches = autoMatch([blank], [executed]);

    expect(matches).toHaveLength(0);
  });

  it('each blank page is matched at most once', () => {
    const blank = makeBlank({ id: 'b1' });
    const exec1 = makeExecuted({ id: 'e1' });
    const exec2 = makeExecuted({ id: 'e2' });

    const matches = autoMatch([blank], [exec1, exec2]);

    expect(matches).toHaveLength(1);
    expect(matches[0].blankPageId).toBe('b1');
  });

  it('each executed page is matched at most once', () => {
    const blank1 = makeBlank({ id: 'b1' });
    const blank2 = makeBlank({ id: 'b2' });
    const executed = makeExecuted({ id: 'e1' });

    const matches = autoMatch([blank1, blank2], [executed]);

    expect(matches).toHaveLength(1);
    expect(matches[0].executedPageId).toBe('e1');
  });

  it('prefers the higher-scoring pair in greedy assignment', () => {
    const blank1 = makeBlank({ id: 'b1', documentName: 'Investors Rights Agreement', partyName: 'Acme Corp', signatoryName: 'Jane Smith' });
    const blank2 = makeBlank({ id: 'b2', documentName: 'Stock Purchase Agreement', partyName: 'Beta LLC', signatoryName: 'John Doe' });
    // exec1 is a perfect match for blank1
    const exec1 = makeExecuted({ id: 'e1', extractedDocumentName: 'Investors Rights Agreement', extractedPartyName: 'Acme Corp', extractedSignatoryName: 'Jane Smith' });
    // exec2 is a decent but lower match for blank1
    const exec2 = makeExecuted({ id: 'e2', extractedDocumentName: 'Investors Rights Agreement', extractedPartyName: 'Beta LLC', extractedSignatoryName: 'John Doe' });

    const matches = autoMatch([blank1, blank2], [exec1, exec2]);

    expect(matches).toHaveLength(2);
    const match1 = matches.find(m => m.blankPageId === 'b1');
    const match2 = matches.find(m => m.blankPageId === 'b2');
    expect(match1?.executedPageId).toBe('e1');
    expect(match2?.executedPageId).toBe('e2');
  });

  it('preserves user-confirmed matches and excludes their pages from auto-matching', () => {
    const blank1 = makeBlank({ id: 'b1' });
    const blank2 = makeBlank({ id: 'b2', documentName: 'NVCA Side Letter', partyName: 'Beta LLC', signatoryName: 'John Doe' });
    const exec1 = makeExecuted({ id: 'e1' });
    const exec2 = makeExecuted({ id: 'e2', extractedDocumentName: 'NVCA Side Letter', extractedPartyName: 'Beta LLC', extractedSignatoryName: 'John Doe' });

    const existingConfirmed: AssemblyMatch = {
      blankPageId: 'b1',
      executedPageId: 'e1',
      documentId: 'doc-1',
      documentName: 'Investors Rights Agreement',
      pageIndex: 0,
      partyName: 'Acme Corp',
      signatoryName: 'Jane Smith',
      status: 'user-confirmed',
    };

    const matches = autoMatch([blank1, blank2], [exec1, exec2], [existingConfirmed]);

    // Should only auto-match b2/e2; b1/e1 are already user-confirmed (preserved externally)
    expect(matches).toHaveLength(1);
    expect(matches[0].blankPageId).toBe('b2');
    expect(matches[0].executedPageId).toBe('e2');
  });

  it('preserves user-overridden matches the same way as user-confirmed', () => {
    const blank = makeBlank({ id: 'b1' });
    const executed = makeExecuted({ id: 'e1' });

    const existingOverride: AssemblyMatch = {
      blankPageId: 'b1',
      executedPageId: 'e1',
      documentId: 'doc-1',
      documentName: 'Investors Rights Agreement',
      pageIndex: 0,
      partyName: 'Acme Corp',
      signatoryName: 'Jane Smith',
      status: 'user-overridden',
    };

    const matches = autoMatch([blank], [executed], [existingOverride]);

    // b1 and e1 are already consumed by the override — nothing new to match
    expect(matches).toHaveLength(0);
  });

  it('does not auto-match executed pages in excludedExecutedIds', () => {
    const blank = makeBlank({ id: 'b1' });
    const executed = makeExecuted({ id: 'e1' });
    const matches = autoMatch([blank], [executed], [], new Set(['e1']));
    expect(matches).toHaveLength(0);

    const matches2 = autoMatch([blank], [executed], [], ['e1']);
    expect(matches2).toHaveLength(0);
  });

  it('does not preserve auto-matched entries from existingMatches (they are re-computed)', () => {
    const blank = makeBlank({ id: 'b1' });
    const executed = makeExecuted({ id: 'e1' });

    const staleAutoMatch: AssemblyMatch = {
      blankPageId: 'b1',
      executedPageId: 'e1',
      documentId: 'doc-1',
      documentName: 'Investors Rights Agreement',
      pageIndex: 0,
      partyName: 'Acme Corp',
      signatoryName: 'Jane Smith',
      status: 'auto-matched',
    };

    // auto-matched existing entries are NOT preserved — pages become available again
    const matches = autoMatch([blank], [executed], [staleAutoMatch]);

    expect(matches).toHaveLength(1);
    expect(matches[0].blankPageId).toBe('b1');
    expect(matches[0].executedPageId).toBe('e1');
  });

  it('handles empty inputs gracefully', () => {
    expect(autoMatch([], [])).toEqual([]);
    expect(autoMatch([makeBlank({ id: 'b1' })], [])).toEqual([]);
    expect(autoMatch([], [makeExecuted({ id: 'e1' })])).toEqual([]);
  });

  it('matches with minor whitespace / case differences in names', () => {
    const blank = makeBlank({ id: 'b1', documentName: 'Investors Rights Agreement', signatoryName: 'Jane Smith' });
    const executed = makeExecuted({ id: 'e1', extractedDocumentName: '  investors rights agreement  ', extractedSignatoryName: 'JANE SMITH' });

    const matches = autoMatch([blank], [executed]);

    expect(matches).toHaveLength(1);
  });

  it('matches when executed document name contains the blank document name (containment)', () => {
    const blank = makeBlank({ id: 'b1', documentName: 'Rights Agreement' });
    const executed = makeExecuted({ id: 'e1', extractedDocumentName: 'Investors Rights Agreement' });

    const matches = autoMatch([blank], [executed]);

    expect(matches).toHaveLength(1);
  });
});

describe('createManualMatch', () => {
  it('creates a user-overridden match with correct fields', () => {
    const blank = makeBlank({ id: 'b1', documentId: 'doc-42', documentName: 'SPA', partyName: 'Acme Corp', signatoryName: 'Jane Smith', pageIndex: 3 });
    const executed = makeExecuted({ id: 'e1' });

    const match = createManualMatch(blank, executed);

    expect(match.blankPageId).toBe('b1');
    expect(match.executedPageId).toBe('e1');
    expect(match.documentId).toBe('doc-42');
    expect(match.documentName).toBe('SPA');
    expect(match.partyName).toBe('Acme Corp');
    expect(match.signatoryName).toBe('Jane Smith');
    expect(match.pageIndex).toBe(3);
    expect(match.status).toBe('user-overridden');
  });
});
