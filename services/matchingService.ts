import { ExtractedSignaturePage, ExecutedSignaturePage, AssemblyMatch } from '../types';

/**
 * Normalizes a string for comparison: lowercase, trim, collapse whitespace.
 */
const normalize = (s: string): string =>
  s.toLowerCase().trim().replace(/\s+/g, ' ');

/**
 * Tokenizes a normalized string into a set of words.
 */
const tokenize = (s: string): Set<string> =>
  new Set(normalize(s).split(' ').filter(t => t.length > 0));

/**
 * Computes similarity between two strings using a tiered approach:
 *  1. Exact match (after normalization) → 1.0
 *  2. One contains the other → 0.8
 *  3. Jaccard token overlap → 0.0–1.0
 */
const similarity = (a: string, b: string): number => {
  if (!a || !b) return 0;

  const na = normalize(a);
  const nb = normalize(b);

  // Exact match
  if (na === nb) return 1.0;

  // Containment
  if (na.includes(nb) || nb.includes(na)) return 0.8;

  // Jaccard token overlap
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
};

/**
 * Scores a (blank, executed) pair using weighted similarity.
 *  - Document name:  50% weight
 *  - Party name:     35% weight
 *  - Signatory name: 15% weight
 */
const scorePair = (
  blank: ExtractedSignaturePage,
  executed: ExecutedSignaturePage
): number => {
  const docScore = similarity(blank.documentName, executed.extractedDocumentName);
  const partyScore = similarity(blank.partyName, executed.extractedPartyName);
  const sigScore = similarity(blank.signatoryName, executed.extractedSignatoryName);

  return docScore * 0.5 + partyScore * 0.35 + sigScore * 0.15;
};

const MATCH_THRESHOLD = 0.4;

/**
 * Auto-matches executed pages to blank signature pages.
 *
 * Algorithm:
 *  1. Score every possible (blank, executed) pair
 *  2. Filter pairs below threshold (0.4)
 *  3. Greedy assignment: sort by score descending, assign best pairs first
 *     (each blank and each executed page used only once)
 *  4. Return AssemblyMatch[] with status 'auto-matched'
 *
 * @param blankPages - The extracted blank signature pages from the original documents
 * @param executedPages - The uploaded executed (signed) signature pages
 * @param existingMatches - Any existing matches to preserve (user-confirmed or user-overridden)
 * @param excludedExecutedIds - Executed pages to skip (e.g. user removed the auto-matched blank)
 * @returns New auto-matched AssemblyMatch entries (does not include preserved existing matches)
 */
export const autoMatch = (
  blankPages: ExtractedSignaturePage[],
  executedPages: ExecutedSignaturePage[],
  existingMatches: AssemblyMatch[] = [],
  excludedExecutedIds: ReadonlySet<string> | readonly string[] = []
): AssemblyMatch[] => {
  const excluded =
    excludedExecutedIds instanceof Set
      ? excludedExecutedIds
      : new Set(excludedExecutedIds);

  // Determine which blanks and executed pages are already matched
  // (preserve user-confirmed and user-overridden matches)
  const preservedMatches = existingMatches.filter(
    m => m.status === 'user-confirmed' || m.status === 'user-overridden'
  );
  const usedBlankIds = new Set(preservedMatches.map(m => m.blankPageId));
  const usedExecutedIds = new Set(preservedMatches.map(m => m.executedPageId));

  // Filter to only unmatched pages
  const availableBlanks = blankPages.filter(b => !usedBlankIds.has(b.id));
  const availableExecuted = executedPages.filter(
    e =>
      !usedExecutedIds.has(e.id) &&
      e.isConfirmedExecuted &&
      !excluded.has(e.id)
  );

  // Score all possible pairs
  const candidates: Array<{
    blank: ExtractedSignaturePage;
    executed: ExecutedSignaturePage;
    score: number;
  }> = [];

  for (const blank of availableBlanks) {
    for (const executed of availableExecuted) {
      const score = scorePair(blank, executed);
      if (score >= MATCH_THRESHOLD) {
        candidates.push({ blank, executed, score });
      }
    }
  }

  // Sort by score descending (greedy assignment)
  candidates.sort((a, b) => b.score - a.score);

  // Greedy: assign best-scoring pairs, each page used only once
  const matchedBlankIds = new Set<string>();
  const matchedExecutedIds = new Set<string>();
  const newMatches: AssemblyMatch[] = [];

  for (const { blank, executed } of candidates) {
    if (matchedBlankIds.has(blank.id) || matchedExecutedIds.has(executed.id)) {
      continue;
    }

    matchedBlankIds.add(blank.id);
    matchedExecutedIds.add(executed.id);

    newMatches.push({
      blankPageId: blank.id,
      executedPageId: executed.id,
      documentId: blank.documentId,
      documentName: blank.documentName,
      pageIndex: blank.pageIndex,
      partyName: blank.partyName,
      signatoryName: blank.signatoryName,
      status: 'auto-matched',
    });
  }

  return newMatches;
};

/**
 * Creates a manual match between a blank page and an executed page.
 */
export const createManualMatch = (
  blank: ExtractedSignaturePage,
  executed: ExecutedSignaturePage
): AssemblyMatch => ({
  blankPageId: blank.id,
  executedPageId: executed.id,
  documentId: blank.documentId,
  documentName: blank.documentName,
  pageIndex: blank.pageIndex,
  partyName: blank.partyName,
  signatoryName: blank.signatoryName,
  status: 'user-overridden',
});
