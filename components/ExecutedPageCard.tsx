import React from 'react';
import { ExecutedSignaturePage, AssemblyMatch } from '../types';
import { CheckCircle2, AlertCircle, FileText, Users, UserPen, Briefcase, Eye } from 'lucide-react';

interface ExecutedPageCardProps {
  page: ExecutedSignaturePage;
  match: AssemblyMatch | null;
  onUnmatch?: (executedPageId: string) => void;
  onPreview?: (page: ExecutedSignaturePage) => void;
  onMatchNow?: (executedPageId: string) => void;
}

const ExecutedPageCard: React.FC<ExecutedPageCardProps> = ({ page, match, onUnmatch, onPreview, onMatchNow }) => {
  const isMatched = !!match;

  return (
    <div className={`bg-white rounded-lg border shadow-sm flex flex-col sm:flex-row overflow-hidden transition-shadow duration-200 ${
      isMatched
        ? 'border-green-200 hover:shadow-md'
        : page.isConfirmedExecuted
          ? 'border-amber-200 hover:shadow-md'
          : 'border-slate-200 opacity-60'
    }`}>
      {/* Thumbnail */}
      <div
        className="w-full sm:w-36 h-36 sm:h-auto bg-slate-100 flex-shrink-0 relative border-b sm:border-b-0 sm:border-r border-slate-200 group"
        onClick={onPreview ? () => onPreview(page) : undefined}
      >
        <img
          src={page.thumbnailUrl}
          alt={`Executed page ${page.pageNumber}`}
          className={`w-full h-full object-contain p-1.5 ${onPreview ? 'cursor-pointer' : ''}`}
        />
        {onPreview && (
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center pointer-events-none">
            <div className="opacity-0 group-hover:opacity-100 bg-white/90 text-xs px-2 py-1.5 rounded shadow text-slate-700 font-medium flex items-center gap-1.5">
              <Eye size={12} /> View PDF
            </div>
          </div>
        )}
        <div className="absolute bottom-1.5 left-1.5 bg-slate-800/80 text-white text-xs px-1.5 py-0.5 rounded">
          Pg {page.pageNumber}
        </div>
        {/* Status badge */}
        <div className={`absolute top-1.5 right-1.5 text-xs px-1.5 py-0.5 rounded font-medium ${
          isMatched
            ? 'bg-green-100 text-green-700'
            : page.isConfirmedExecuted
              ? 'bg-amber-100 text-amber-700'
              : 'bg-slate-100 text-slate-500'
        }`}>
          {isMatched ? 'Matched' : page.isConfirmedExecuted ? 'Unmatched' : 'Not signed'}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-3 flex flex-col gap-2 min-w-0">
        {/* Source file */}
        <div className="text-xs text-slate-400 truncate" title={page.sourceFileName}>
          From: {page.sourceFileName}
        </div>

        {/* Extracted metadata */}
        <div className="space-y-1.5">
          {page.extractedDocumentName && (
            <div className="flex items-center gap-1.5 text-sm">
              <FileText size={13} className="text-slate-400 flex-shrink-0" />
              <span className="text-slate-700 truncate" title={page.extractedDocumentName}>
                {page.extractedDocumentName}
              </span>
            </div>
          )}
          {page.extractedPartyName && (
            <div className="flex items-center gap-1.5 text-sm">
              <Users size={13} className="text-slate-400 flex-shrink-0" />
              <span className="text-slate-600 truncate">{page.extractedPartyName}</span>
            </div>
          )}
          {page.extractedSignatoryName && (
            <div className="flex items-center gap-1.5 text-sm">
              <UserPen size={13} className="text-slate-400 flex-shrink-0" />
              <span className="text-slate-600 truncate">{page.extractedSignatoryName}</span>
            </div>
          )}
          {page.extractedCapacity && (
            <div className="flex items-center gap-1.5 text-sm">
              <Briefcase size={13} className="text-slate-400 flex-shrink-0" />
              <span className="text-slate-600 italic truncate">{page.extractedCapacity}</span>
            </div>
          )}
        </div>

        {/* Match info */}
        {isMatched && match && (
          <div className="mt-auto pt-2 border-t border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-green-600">
              <CheckCircle2 size={14} />
              <span>
                Matched to <strong>{match.documentName}</strong> — {match.partyName}
              </span>
            </div>
            {onUnmatch && (
              <button
                onClick={() => onUnmatch(page.id)}
                className="text-xs text-slate-400 hover:text-red-500 transition-colors px-1.5 py-0.5"
                title="Remove match"
              >
                Unmatch
              </button>
            )}
          </div>
        )}

        {!isMatched && page.isConfirmedExecuted && (
          <div className="mt-auto pt-2 border-t border-slate-100 flex items-center justify-between gap-2 text-xs text-amber-600">
            <div className="flex items-center gap-1.5">
              <AlertCircle size={14} />
              <span>Awaiting match</span>
            </div>
            {onMatchNow && (
              <button
                onClick={() => onMatchNow(page.id)}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors px-1.5 py-0.5"
                title="Match this executed page now"
              >
                Match now
              </button>
            )}
          </div>
        )}

        {!page.isConfirmedExecuted && (
          <div className="mt-auto pt-2 border-t border-slate-100 flex items-center gap-1.5 text-xs text-slate-400">
            <AlertCircle size={14} />
            <span>This page does not appear to be signed</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default ExecutedPageCard;
