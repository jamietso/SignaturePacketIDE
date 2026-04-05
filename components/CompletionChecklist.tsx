import React, { useEffect, useState, useRef, useMemo } from 'react';
import { ExtractedSignaturePage, AssemblyMatch, ExecutedSignaturePage } from '../types';
import { CheckCircle2, AlertTriangle, Minus, Printer, ChevronLeft, ChevronRight } from 'lucide-react';

interface CompletionChecklistProps {
  blankPages: ExtractedSignaturePage[];
  matches: AssemblyMatch[];
  executedPages: ExecutedSignaturePage[];
  onCellClick: (blankPageId: string, currentMatch: AssemblyMatch | null) => void;
}

interface CellData {
  blankPage: ExtractedSignaturePage;
  match: AssemblyMatch | null;
}

const CompletionChecklist: React.FC<CompletionChecklistProps> = ({
  blankPages,
  matches,
  executedPages,
  onCellClick,
}) => {
  // Build unique document names (rows)
  const docNameSet = new Set<string>();
  blankPages.forEach(p => docNameSet.add(p.documentName));
  const documentNames = Array.from(docNameSet).sort();

  // Unique signatory columns — stable key avoids resetting column order on unrelated parent re-renders.
  const signatorySetKey = useMemo(
    () =>
      Array.from(new Set(blankPages.map((p) => p.signatoryName || '(Unnamed)')))
        .sort()
        .join('\0'),
    [blankPages],
  );
  const derivedSignatories = useMemo(
    () => Array.from(new Set(blankPages.map((p) => p.signatoryName || '(Unnamed)'))).sort(),
    [signatorySetKey, blankPages],
  );
  const [signatoryOrder, setSignatoryOrder] = useState<string[]>(() => derivedSignatories);
  const lastSignatoryKeyRef = useRef(signatorySetKey);
  useEffect(() => {
    if (lastSignatoryKeyRef.current === signatorySetKey) return;
    lastSignatoryKeyRef.current = signatorySetKey;
    setSignatoryOrder(derivedSignatories);
  }, [signatorySetKey, derivedSignatories]);
  const signatoryNames = signatoryOrder;

  // Party names per signatory for header sub-labels
  const partiesBySignatory = (sigName: string): string[] =>
    Array.from(new Set<string>(blankPages
      .filter(p => (p.signatoryName || '(Unnamed)') === sigName)
      .map(p => p.partyName)
    )).sort();

  // Drag state
  const dragIndex = useRef<number | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const tableSizerRef = useRef<HTMLDivElement>(null);
  const [maxScrollLeft, setMaxScrollLeft] = useState<number>(0);
  const [scrollLeft, setScrollLeft] = useState<number>(0);
  const TABLE_DOC_COL_WIDTH = 260;
  const TABLE_SIG_COL_WIDTH = 220;
  const tablePixelWidth = TABLE_DOC_COL_WIDTH + (signatoryNames.length * TABLE_SIG_COL_WIDTH);

  // Build match lookup: blankPageId → AssemblyMatch
  const matchByBlankId = new Map<string, AssemblyMatch>();
  for (const match of matches) {
    matchByBlankId.set(match.blankPageId, match);
  }

  // For a (document, signatory) cell, return ALL blank pages for that combination (across all parties)
  const getCells = (docName: string, signatoryName: string): CellData[] => {
    const blanks = blankPages.filter(
      p => p.documentName === docName && (p.signatoryName || '(Unnamed)') === signatoryName
    );
    return blanks.map(blank => ({ blankPage: blank, match: matchByBlankId.get(blank.id) || null }));
  };

  // Summary counts
  const totalRequired = blankPages.length;
  const totalMatched = matches.length;
  const progressPct = totalRequired > 0 ? Math.round((totalMatched / totalRequired) * 100) : 0;

  const handlePrint = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    const now = new Date().toLocaleString();

    // Build table rows for print
    const headerCells = signatoryNames.map(s => {
      const parties = partiesBySignatory(s).map(p => `<span class="sub">${p}</span>`).join('');
      return `<th>${s}${parties ? `<br/>${parties}` : ''}</th>`;
    }).join('');

    const bodyRows = documentNames.map(docName => {
      const cells = signatoryNames.map(sigName => {
        const cellData = getCells(docName, sigName);
        if (cellData.length === 0) return `<td class="na">—</td>`;
        const allMatched = cellData.every(c => !!c.match);
        const anyMatched = cellData.some(c => !!c.match);
        if (allMatched) {
          const label = cellData[0].match!.status === 'auto-matched' ? 'Auto' : 'Manual';
          return `<td class="matched">✓ ${label}</td>`;
        }
        if (anyMatched) return `<td class="pending">⚠ Partial</td>`;
        return `<td class="pending">⚠ Pending</td>`;
      }).join('');
      return `<tr><td class="docname">${docName}</td>${cells}</tr>`;
    }).join('');

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Signature Packet Checklist</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 11px; color: #1e293b; margin: 0; padding: 24px; }
          h1 { font-size: 16px; margin: 0 0 4px; }
          .meta { color: #64748b; font-size: 10px; margin-bottom: 16px; }
          .progress { font-size: 12px; margin-bottom: 16px; color: ${totalMatched === totalRequired && totalRequired > 0 ? '#16a34a' : '#475569'}; font-weight: 600; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: center; vertical-align: middle; }
          th { background: #f8fafc; font-weight: 600; font-size: 10px; color: #475569; }
          td.docname { text-align: left; font-weight: 500; color: #1e293b; max-width: 220px; word-break: break-word; }
          td.matched { color: #15803d; background: #f0fdf4; font-weight: 600; }
          td.pending { color: #b45309; background: #fffbeb; font-weight: 600; }
          td.na { color: #cbd5e1; }
          .sub { font-weight: 400; color: #94a3b8; font-size: 9px; display: block; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        <h1>Signature Packet Checklist</h1>
        <div class="meta">Generated ${now}</div>
        <div class="progress">${totalMatched}/${totalRequired} signature pages matched</div>
        <table>
          <thead><tr><th>Document</th>${headerCells}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 300);
  };

  const handleChecklistWheel: React.WheelEventHandler<HTMLDivElement> = (event) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // Let trackpads handle natural horizontal scroll, but map vertical wheel
    // to horizontal movement when this grid can scroll sideways.
    const canScrollHorizontally = container.scrollWidth > container.clientWidth;
    if (!canScrollHorizontally) return;

    const dominantVertical = Math.abs(event.deltaY) > Math.abs(event.deltaX);
    if (dominantVertical && event.deltaY !== 0) {
      container.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  };

  useEffect(() => {
    const localViewport = scrollContainerRef.current;
    const sizer = tableSizerRef.current;
    if (!localViewport || !sizer) return;

    const updateScrollMetrics = () => {
      const width = Math.max(tablePixelWidth, sizer.scrollWidth);
      const max = Math.max(0, width - localViewport.clientWidth);
      setMaxScrollLeft(max);
      setScrollLeft(Math.min(localViewport.scrollLeft, max));
    };

    updateScrollMetrics();
    const observer = new ResizeObserver(updateScrollMetrics);
    observer.observe(localViewport);
    observer.observe(sizer);
    const onScroll = () => {
      setScrollLeft(localViewport.scrollLeft);
    };
    localViewport.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      localViewport.removeEventListener('scroll', onScroll);
    };
  }, [blankPages.length, matches.length, signatoryNames.length, documentNames.length, tablePixelWidth]);

  const handleSliderChange: React.ChangeEventHandler<HTMLInputElement> = (event) => {
    const next = Number(event.currentTarget.value);
    const host = scrollContainerRef.current;
    if (host) host.scrollLeft = next;
    setScrollLeft(next);
  };

  const scrollByAmount = (delta: number) => {
    const host = scrollContainerRef.current;
    if (!host) return;
    host.scrollLeft += delta;
    setScrollLeft(host.scrollLeft);
  };

  return (
    <div className="space-y-4 w-full min-w-0 max-w-full">
      {/* Summary bar */}
      <div className="flex items-center gap-4 bg-white border border-slate-200 rounded-lg px-4 py-3">
        <div className="flex-1">
          <div className="flex items-center justify-between text-sm mb-1.5">
            <span className="font-medium text-slate-700">
              Assembly Progress
            </span>
            <div className="flex items-center gap-3">
              <span className={`font-bold ${totalMatched === totalRequired && totalRequired > 0 ? 'text-green-600' : 'text-slate-600'}`}>
                {totalMatched}/{totalRequired} matched
              </span>
              <button
                onClick={handlePrint}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-slate-600 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors"
                title="Print / Export checklist"
              >
                <Printer size={13} />
                Export
              </button>
            </div>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all duration-500 ${
                totalMatched === totalRequired && totalRequired > 0
                  ? 'bg-green-500'
                  : 'bg-blue-500'
              }`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className="bg-white border border-slate-200 rounded-lg px-3 pt-2 w-full min-w-0 max-w-full">
        <div className="pb-2 px-1">
          <div className="flex items-center gap-2 mb-1">
            <button
              type="button"
              onClick={() => scrollByAmount(-320)}
              className="inline-flex items-center justify-center h-6 w-6 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
              title="Scroll left"
              aria-label="Scroll left"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              onClick={() => scrollByAmount(320)}
              className="inline-flex items-center justify-center h-6 w-6 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
              title="Scroll right"
              aria-label="Scroll right"
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(1, maxScrollLeft)}
            step={1}
            value={Math.min(scrollLeft, Math.max(1, maxScrollLeft))}
            onChange={handleSliderChange}
            className="w-full accent-blue-600"
            disabled={maxScrollLeft <= 0}
            aria-label="Scroll horizontally through assembly columns"
          />
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        onWheel={handleChecklistWheel}
        className="bg-white border border-slate-200 rounded-lg overflow-x-auto overflow-y-visible w-full min-w-0 max-w-full pb-2"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        <div ref={tableSizerRef} className="min-w-max" style={{ minWidth: tablePixelWidth, width: tablePixelWidth }}>
          <table className="text-sm border-collapse w-max min-w-max" style={{ minWidth: tablePixelWidth, width: tablePixelWidth }}>
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-4 py-3 font-semibold text-slate-600 min-w-[260px] w-[260px] max-w-[260px]"
                    style={{ position: 'sticky', left: 0, zIndex: 10, background: '#f8fafc', boxShadow: '2px 0 4px -1px rgba(0,0,0,0.08)' }}>
                  Document
                </th>
                {signatoryNames.map((sigName, idx) => (
                  <th
                    key={sigName}
                    draggable
                    onDragStart={() => { dragIndex.current = idx; }}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => {
                      const from = dragIndex.current;
                      if (from === null || from === idx) return;
                      const next = [...signatoryNames];
                      next.splice(idx, 0, next.splice(from, 1)[0]);
                      setSignatoryOrder(next);
                      dragIndex.current = null;
                    }}
                    className="text-center px-3 py-3 font-medium text-slate-600 min-w-[220px] w-[220px] max-w-[220px] cursor-grab select-none"
                  >
                    <div className="text-xs leading-snug truncate" title={sigName}>{sigName}</div>
                    <div className="flex flex-wrap justify-center gap-0.5 mt-1">
                      {partiesBySignatory(sigName).map(party => (
                        <span key={party} className="text-[9px] text-slate-400 font-normal bg-slate-100 rounded px-1 py-0.5 leading-tight max-w-[200px] truncate" title={party}>{party}</span>
                      ))}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {documentNames.map((docName, rowIdx) => (
                <tr key={docName} className="hover:bg-slate-50/50">
                  <td className="px-4 py-3 font-medium text-slate-700 min-w-[260px] w-[260px] max-w-[260px]"
                      style={{ position: 'sticky', left: 0, zIndex: 9, background: rowIdx % 2 === 0 ? '#ffffff' : '#f8fafc', boxShadow: '2px 0 4px -1px rgba(0,0,0,0.06)' }}>
                    <span className="break-words whitespace-normal block leading-snug" title={docName}>
                      {docName}
                    </span>
                  </td>
                  {signatoryNames.map(sigName => {
                    const cellData = getCells(docName, sigName);

                    if (cellData.length === 0) {
                      return (
                        <td key={sigName} className="text-center px-3 py-3 min-w-[220px] w-[220px] max-w-[220px]">
                          <div className="flex items-center justify-center">
                            <Minus size={16} className="text-slate-200" />
                          </div>
                        </td>
                      );
                    }

                    return (
                      <td key={sigName} className="text-center px-3 py-3 min-w-[220px] w-[220px] max-w-[220px]">
                        <div className="flex flex-col gap-1 items-center">
                          {cellData.map(cell => {
                            const isMatched = !!cell.match;
                            return (
                              <button
                                key={cell.blankPage.id}
                                onClick={() => onCellClick(cell.blankPage.id, cell.match)}
                                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                                  isMatched
                                    ? 'bg-green-50 text-green-700 hover:bg-green-100 border border-green-200'
                                    : 'bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200'
                                }`}
                                title={`${cell.blankPage.partyName}${isMatched ? ` — Matched (${cell.match!.status})` : ' — Click to assign'}`}
                              >
                                {isMatched ? (
                                  <>
                                    <CheckCircle2 size={14} />
                                    {cell.match!.status === 'auto-matched' ? 'Auto' : 'Manual'}
                                  </>
                                ) : (
                                  <>
                                    <AlertTriangle size={14} />
                                    Pending
                                  </>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default CompletionChecklist;
