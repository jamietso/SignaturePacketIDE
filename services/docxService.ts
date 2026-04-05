const DEFAULT_CONVERTER_URL = '/api/docx-to-pdf';

const getConverterUrl = (): string => {
  const configured = import.meta.env.VITE_DOCX_CONVERTER_URL;
  return configured && configured.trim() ? configured.trim() : DEFAULT_CONVERTER_URL;
};

/**
 * Converts a DOCX file into a PDF via a server-side converter.
 * Use a backend that calls Adobe PDF Services (or equivalent) for layout-fidelity.
 */
export const convertDocxToPdf = async (docxFile: File): Promise<File> => {
  const converterUrl = getConverterUrl();
  const formData = new FormData();
  formData.append('file', docxFile, docxFile.name);

  const response = await fetch(converterUrl, {
    method: 'POST',
    body: formData,
    credentials: 'include',
  });

  if (!response.ok) {
    let detail = '';
    const contentType = response.headers.get('content-type') || '';
    try {
      if (contentType.toLowerCase().includes('application/json')) {
        const payload = await response.json() as { error?: string; detail?: string };
        detail = [payload.error, payload.detail].filter(Boolean).join(': ');
      } else {
        detail = (await response.text()).trim();
      }
    } catch {
      // Ignore parse failure and fall back to status text.
    }
    const suffix = detail ? ` - ${detail}` : '';
    throw new Error(`DOCX conversion failed (${response.status} ${response.statusText})${suffix}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/pdf')) {
    throw new Error('DOCX converter returned a non-PDF response');
  }

  const pdfBytes = await response.arrayBuffer();
  const pdfName = docxFile.name.replace(/\.docx$/i, '.pdf');
  return new File([pdfBytes], pdfName, { type: 'application/pdf', lastModified: Date.now() });
};
