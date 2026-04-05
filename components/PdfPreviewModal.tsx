import React from 'react';
import { X, FileText } from 'lucide-react';

interface PdfPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  pdfUrl: string | null;
  title: string;
}

const PdfPreviewModal: React.FC<PdfPreviewModalProps> = ({ isOpen, onClose, pdfUrl, title }) => {
  if (!isOpen || !pdfUrl) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-white w-full h-full md:w-[90%] md:h-[90%] rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="bg-slate-50 border-b border-slate-200 px-4 py-3 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2 text-slate-700">
            <FileText size={18} className="text-blue-600" />
            <h3 className="font-semibold text-sm truncate max-w-md">{title}</h3>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 hover:bg-slate-200 rounded-full text-slate-500 hover:text-slate-800 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* PDF Viewer Content */}
        <div className="flex-1 bg-slate-100 relative">
          <iframe 
            src={pdfUrl} 
            className="w-full h-full absolute inset-0 border-0"
            title="PDF Preview"
          />
        </div>
      </div>
    </div>
  );
};

export default PdfPreviewModal;