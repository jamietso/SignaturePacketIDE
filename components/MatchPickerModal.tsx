import React, { useEffect, useState } from 'react';
import { X, CheckCircle2, FileText, Users, UserPen, Briefcase, ArrowRight, Unlink, Eye } from 'lucide-react';
import { ExtractedSignaturePage, ExecutedSignaturePage, AssemblyMatch } from '../types';

interface MatchPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  blankPage: ExtractedSignaturePage | null;
  currentMatch: AssemblyMatch | null;
  initialExecutedPageId?: string | null;
  executedPages: ExecutedSignaturePage[];
  allMatches: AssemblyMatch[];
  onConfirmMatch: (blankPageId: string, executedPageId: string) => void;
  onUnmatch: (blankPageId: string) => void;
  onPreviewBlank: (page: ExtractedSignaturePage) => void;
  onPreviewExecuted: (page: ExecutedSignaturePage) => void;
}

const MatchPickerModal: React.FC<MatchPickerModalProps> = ({
  isOpen,
  onClose,
  blankPage,
  currentMatch,
  initialExecutedPageId,
  executedPages,
  allMatches,
  onConfirmMatch,
  onUnmatch,
  onPreviewBlank,
  onPreviewExecuted,
}) => {
  const [selectedExecutedId, setSelectedExecutedId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedExecutedId(currentMatch?.executedPageId ?? initialExecutedPageId ?? null);
  }, [isOpen, currentMatch?.executedPageId, initialExecutedPageId]);

  if (!isOpen || !blankPage) return null;

  // Determine which executed pages are available (not matched to other blanks)
  const matchedExecutedIds = new Set(
    allMatches
      .filter(m => m.blankPageId !== blankPage.id) // exclude THIS blank's match
      .map(m => m.executedPageId)
  );

  const availableExecuted = executedPages.filter(
    ep => ep.isConfirmedExecuted && !matchedExecutedIds.has(ep.id)
  );

  // Also show the currently matched executed page at the top if it exists
  const currentMatchedPage = currentMatch
    ? executedPages.find(ep => ep.id === currentMatch.executedPageId)
    : null;

  const handleConfirm = () => {
    if (selectedExecutedId && blankPage) {
      onConfirmMatch(blankPage.id, selectedExecutedId);
      setSelectedExecutedId(null);
      onClose();
    }
  };

  const handleUnmatch = () => {
    if (blankPage) {
      onUnmatch(blankPage.id);
      setSelectedExecutedId(null);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-5xl max-h-[90vh] rounded-xl shadow-2xl flex flex-col animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="bg-slate-50 border-b border-slate-200 px-6 py-4 flex items-center justify-between rounded-t-xl">
          <h3 className="font-bold text-lg text-slate-800">
            {currentMatch ? 'Reassign Match' : 'Match Executed Page'}
          </h3>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-200 rounded-full text-slate-400 hover:text-slate-800 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex flex-col md:flex-row min-h-0">
          {/* Left: Blank signature page info */}
          <div className="md:w-1/3 border-b md:border-b-0 md:border-r border-slate-200 p-4 flex flex-col">
            <h4 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">
              Blank Signature Page
            </h4>
            <div
              className="bg-slate-50 rounded-lg overflow-hidden flex-shrink-0 mb-3 relative group cursor-pointer"
              onClick={() => onPreviewBlank(blankPage)}
              title="View full page"
            >
              <img
                src={blankPage.thumbnailUrl}
                alt={`Blank page ${blankPage.pageNumber}`}
                className="w-full h-48 object-contain p-2"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                <div className="opacity-0 group-hover:opacity-100 bg-white/90 text-xs px-2 py-1.5 rounded shadow text-slate-700 font-medium flex items-center gap-1.5">
                  <Eye size={12} /> View PDF
                </div>
              </div>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex items-start gap-2">
                <FileText size={14} className="text-slate-400 shrink-0 mt-0.5" />
                <span
                  className="text-slate-700 font-medium min-w-0 break-words"
                  title={blankPage.documentName}
                >
                  {blankPage.documentName}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Users size={14} className="text-slate-400" />
                <span className="text-slate-600">{blankPage.partyName}</span>
              </div>
              {blankPage.signatoryName && (
                <div className="flex items-center gap-2">
                  <UserPen size={14} className="text-slate-400" />
                  <span className="text-slate-600">{blankPage.signatoryName}</span>
                </div>
              )}
              {blankPage.capacity && (
                <div className="flex items-center gap-2">
                  <Briefcase size={14} className="text-slate-400" />
                  <span className="text-slate-600 italic">{blankPage.capacity}</span>
                </div>
              )}
              <div className="text-xs text-slate-400 mt-1">
                Page {blankPage.pageNumber} in original document
              </div>
            </div>

            {/* Current match info */}
            {currentMatch && currentMatchedPage && (
              <div className="mt-4 pt-3 border-t border-slate-200">
                <div className="text-xs font-medium text-green-600 mb-2">Currently matched to:</div>
                <div
                  className="bg-green-50 rounded-lg p-2 text-xs text-green-700 flex items-start gap-2"
                  title="View currently matched page"
                >
                  <button
                    onClick={() => onPreviewExecuted(currentMatchedPage)}
                    className="w-14 h-16 shrink-0 rounded overflow-hidden border border-green-200 bg-white hover:ring-1 hover:ring-green-400 transition-all"
                  >
                    <img
                      src={currentMatchedPage.thumbnailUrl}
                      alt={`Matched page ${currentMatchedPage.pageNumber}`}
                      className="w-full h-full object-contain"
                    />
                  </button>
                  <div className="min-w-0">
                    {currentMatchedPage.extractedPartyName} — {currentMatchedPage.sourceFileName} pg {currentMatchedPage.pageNumber}
                  </div>
                </div>
                <button
                  onClick={handleUnmatch}
                  className="mt-2 flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 transition-colors"
                >
                  <Unlink size={12} />
                  Remove this match
                </button>
              </div>
            )}
          </div>

          {/* Arrow divider */}
          <div className="hidden md:flex items-center px-2">
            <ArrowRight size={20} className="text-slate-300" />
          </div>

          {/* Right: Available executed pages */}
          <div className="flex-1 p-4 flex flex-col min-h-0">
            <h4 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">
              Select Executed Page ({availableExecuted.length} available)
            </h4>

            {availableExecuted.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
                No unmatched executed pages available.
                <br />
                Upload more signed pages or unmatch existing ones.
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-2">
                {availableExecuted.map(ep => {
                  const isSelected = selectedExecutedId === ep.id;

                  return (
                    <div
                      key={ep.id}
                      onClick={() => setSelectedExecutedId(isSelected ? null : ep.id)}
                      className={`w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-colors cursor-pointer ${
                        isSelected
                          ? 'border-blue-400 bg-blue-50 ring-1 ring-blue-400'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      {/* Thumbnail */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPreviewExecuted(ep);
                        }}
                        className="w-20 h-24 flex-shrink-0 bg-slate-100 rounded overflow-hidden border border-slate-200 hover:ring-1 hover:ring-blue-400 transition-all"
                        title={`View page ${ep.pageNumber}`}
                      >
                        <img
                          src={ep.thumbnailUrl}
                          alt={`Executed page ${ep.pageNumber}`}
                          className="w-full h-full object-contain"
                        />
                      </button>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-slate-400 break-words mb-1" title={ep.sourceFileName}>
                          {ep.sourceFileName}
                        </div>
                        {ep.extractedDocumentName && (
                          <div
                            className="text-sm text-slate-700 font-medium break-words"
                            title={ep.extractedDocumentName}
                          >
                            {ep.extractedDocumentName}
                          </div>
                        )}
                        {ep.extractedPartyName && (
                          <div className="text-xs text-slate-600 mt-0.5">{ep.extractedPartyName}</div>
                        )}
                        {ep.extractedSignatoryName && (
                          <div className="text-xs text-slate-500">{ep.extractedSignatoryName}</div>
                        )}
                      </div>

                      {/* Selection indicator */}
                      <div className="flex flex-col items-end gap-2 flex-shrink-0 mt-0.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedExecutedId(ep.id);
                          }}
                          className={`text-xs px-2 py-1 rounded border transition-colors ${
                            isSelected
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                          }`}
                        >
                          {isSelected ? 'Selected' : 'Select'}
                        </button>
                        {isSelected && (
                          <CheckCircle2 size={20} className="text-blue-500" />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-200 px-6 py-4 flex items-center justify-end gap-3 bg-slate-50 rounded-b-xl">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!selectedExecutedId}
            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Confirm Match
          </button>
        </div>
      </div>
    </div>
  );
};

export default MatchPickerModal;
