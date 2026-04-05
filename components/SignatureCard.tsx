import React from 'react';
import { ExtractedSignaturePage } from '../types';
import { Trash2, Users, FileText, Eye, UserPen, Briefcase } from 'lucide-react';

interface SignatureCardProps {
  page: ExtractedSignaturePage;
  existingParties?: string[];
  onUpdateCopies: (id: string, newCount: number) => void;
  onUpdateParty: (id: string, newParty: string) => void;
  onUpdateSignatory: (id: string, newSignatory: string) => void;
  onUpdateCapacity: (id: string, newCapacity: string) => void;
  onDelete: (id: string) => void;
  onPreview: (page: ExtractedSignaturePage) => void;
}

const SignatureCard: React.FC<SignatureCardProps> = ({
  page,
  existingParties = [],
  onUpdateCopies,
  onUpdateParty,
  onUpdateSignatory,
  onUpdateCapacity,
  onDelete,
  onPreview
}) => {
  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col md:flex-row overflow-hidden hover:shadow-md transition-shadow duration-200">
      {/* Thumbnail Preview */}
      <div className="w-full md:w-48 h-48 md:h-auto bg-slate-100 flex-shrink-0 relative border-b md:border-b-0 md:border-r border-slate-200 group cursor-pointer" onClick={() => onPreview(page)}>
        <img 
          src={page.thumbnailUrl} 
          alt={`Page ${page.pageNumber}`} 
          className="w-full h-full object-contain p-2"
        />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
            <div className="opacity-0 group-hover:opacity-100 bg-white/90 text-xs px-2 py-1.5 rounded shadow text-slate-700 font-medium flex items-center gap-1.5">
               <Eye size={12} /> View PDF
            </div>
        </div>
        <div className="absolute bottom-2 left-2 bg-slate-800/80 text-white text-xs px-2 py-0.5 rounded">
          Pg {page.pageNumber}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 flex flex-col gap-3">
        {/* Header: Doc Name */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 uppercase tracking-wide">
             <FileText size={14} />
             <span className="break-words whitespace-normal" title={page.documentName}>{page.documentName}</span>
          </div>
          <button 
            onClick={() => onDelete(page.id)}
            className="text-slate-400 hover:text-red-500 transition-colors"
            title="Remove page"
          >
            <Trash2 size={16} />
          </button>
        </div>

        {/* Edit Fields */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {/* Party Name */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Party</label>
            <div className="relative">
                <Users size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
                <input 
                  type="text" 
                  list={`parties-${page.id}`}
                  value={page.partyName}
                  onChange={(e) => onUpdateParty(page.id, e.target.value)}
                  className="w-full text-sm border-slate-300 rounded-md focus:ring-blue-500 focus:border-blue-500 border pl-8 pr-2 py-1.5 bg-white text-slate-900 placeholder-slate-400"
                  placeholder="e.g. Acme Corp"
                />
                <datalist id={`parties-${page.id}`}>
                  {existingParties.map(p => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
            </div>
          </div>

          {/* Signatory Name */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Signatory</label>
            <div className="relative">
                <UserPen size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
                <input 
                  type="text" 
                  value={page.signatoryName || ''}
                  onChange={(e) => onUpdateSignatory(page.id, e.target.value)}
                  className="w-full text-sm border-slate-300 rounded-md focus:ring-blue-500 focus:border-blue-500 border pl-8 pr-2 py-1.5 bg-white text-slate-900 placeholder-slate-400"
                  placeholder="e.g. Jane Smith"
                />
            </div>
          </div>

          {/* Capacity */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Capacity</label>
            <div className="relative">
                <Briefcase size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
                <input 
                type="text" 
                value={page.capacity}
                onChange={(e) => onUpdateCapacity(page.id, e.target.value)}
                className="w-full text-sm border-slate-300 rounded-md focus:ring-blue-500 focus:border-blue-500 border pl-8 pr-2 py-1.5 bg-white text-slate-900 placeholder-slate-400"
                placeholder="e.g. Director"
                />
            </div>
          </div>
        </div>

        {/* Footer: Controls */}
        <div className="mt-auto pt-3 flex items-center justify-between border-t border-slate-100">
           <div className="flex items-center gap-2">
             <span className="text-sm font-medium text-slate-700">Copies:</span>
             <button 
                onClick={() => onUpdateCopies(page.id, Math.max(0, page.copies - 1))}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 text-slate-600 transition-colors"
             >
               -
             </button>
             <span className="w-8 text-center font-bold text-slate-800">{page.copies}</span>
             <button 
                onClick={() => onUpdateCopies(page.id, page.copies + 1)}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 text-slate-600 transition-colors"
             >
               +
             </button>
           </div>
           
           {page.copies === 0 && (
             <span className="text-xs font-medium text-amber-600 bg-amber-50 px-2 py-1 rounded">Excluded from pack</span>
           )}
        </div>
      </div>
    </div>
  );
};

export default SignatureCard;