# Signature Packet IDE

**Signature Packet IDE** is an AI-powered legal technology tool designed to automate the painful, manual process of preparing wet-ink signature pages for M&A, financing, and corporate transactions.

Instead of junior associates manually scrolling through hundreds of pages to find, extract, and sort signature pages, **Signature Packet IDE** uses computer vision and LLMs to identify, tag, and organize them in seconds.

## Demo

https://github.com/user-attachments/assets/1b2ab8e4-0129-4319-aa13-05d31d714266

## Features

### Extraction
- **AI-Powered Extraction**: Uses Google Gemini 2.5 Flash to visually identify signature pages and extract:
  - **Party Name** (Entity bound by the contract)
  - **Signatory Name** (Human signing the document)
  - **Capacity** (Title/Role)
- **Smart Grouping**: Organize output by:
  - **Agreement** (e.g., all pages for the SPA)
  - **Counterparty** (e.g., all pages for "Acme Corp" across all docs)
  - **Signatory** (e.g., all pages "Jane Smith" needs to sign)
- **Batch Processing**: Upload multiple transaction documents (PDF or DOCX) at once.
- **DOCX Conversion**: `.docx` uploads are converted to PDF through a server-side converter endpoint backed by Microsoft Graph (M365) to preserve layout fidelity.
- **Integrated Preview**: View original PDFs and extracted signature pages instantly.
- **Automatic Instructions**: Generates a per-signatory signing table (with party and capacity) to send to your client.
- **Print-Ready Export**: Downloads a ZIP file containing perfectly sorted PDF packets for each party or agreement.

### Document Assembly
- **Executed Page Matching**: Upload signed/executed PDFs and let the AI identify which signature pages they correspond to.
- **Auto-Match**: Automatically matches executed pages to blank signature pages by document name, party, and signatory.
- **Assembly Progress Grid**: Visual checklist organized by signatory (columns) and document (rows) showing match status at a glance. Columns are drag-to-reorder.
- **Manual Override**: Click any cell to manually assign or reassign an executed page.
- **Assemble & Download**: Produces final assembled PDFs with blank signature pages swapped for their executed counterparts.

### Configuration
- **Save/Load Config**: Save your entire session (extracted pages, edits, assembly matches) to a `.json` file.
- **Bundled PDFs**: Saved configs embed the original PDF files so you can restore a full session without re-uploading anything.
- **Privacy-First**: PDF extraction and matching happen in-browser. If DOCX upload is enabled, DOCX files are sent only to your configured conversion endpoint.

## Tech Stack

- **Frontend**: React 19, Tailwind CSS, Lucide Icons
- **PDF Processing**: `pdf-lib`, `pdf.js`
- **AI/ML**: Google Gemini API (`gemini-2.5-flash`) via `@google/genai` SDK
- **Build**: TypeScript, Vite-compatible structure

## Setup & Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/jamietso/signature-packet-ide.git
   cd signature-packet-ide
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Environment Configuration**:
   Create a `.env` file in the root directory and add your Google Gemini API Key.  
   For DOCX conversion via M365, add Microsoft Graph app credentials:
   ```env
   GEMINI_API_KEY=your_google_gemini_api_key_here
   M365_TENANT_ID=your_microsoft_tenant_id
   M365_CLIENT_ID=your_app_registration_client_id
   M365_CLIENT_SECRET=your_app_registration_client_secret
   M365_USER_ID=user-object-id-or-upn-for-conversion-drive
   # Optional temporary folder in that user's OneDrive
   M365_UPLOAD_FOLDER=SignaturePacketIDE-Temp
   # Optional (defaults to /api/docx-to-pdf; works with Vite proxy)
   VITE_DOCX_CONVERTER_URL=/api/docx-to-pdf
   # Optional backend port (default 8787)
   DOCX_CONVERTER_PORT=8787
   ```

4. **Run the full stack (frontend + DOCX converter backend)**:
   ```bash
   npm run dev:full
   ```

## Usage Guide

### DOCX Conversion Endpoint Contract
- Method: `POST`
- URL: `VITE_DOCX_CONVERTER_URL` (defaults to `/api/docx-to-pdf`)
- Request: `multipart/form-data` with a `file` field containing `.docx`
- Response: `200` with `Content-Type: application/pdf` and raw PDF bytes
- Auth: this app sends `credentials: include`, so cookie/session-based auth is supported

### Local backend
- Backend entrypoint: `backend/server.ts`
- Health check: `GET /api/health`
- Converter route: `POST /api/docx-to-pdf`
- Uses Microsoft Graph conversion (`.../content?format=pdf`) for high-fidelity Office-to-PDF rendering.

### M365 permissions
- Register an app in Azure/Microsoft Entra and create a client secret.
- Add Microsoft Graph **Application** permissions:
  - `Files.ReadWrite.All` (for upload + conversion + cleanup)
- Grant admin consent for your tenant.
- Set `M365_USER_ID` to a user/service account whose OneDrive will hold temporary uploads.

### Extract Mode
1. **Upload**: Drag and drop your transaction documents (PDFs or DOCX files) into the sidebar, then click **Extract**.
2. **Review**: The AI will identify signature pages. Review the "Party", "Signatory", and "Capacity" fields for each page.
3. **Adjust**:
   - Use the **Grouping Toggles** (Agreement / Party / Signatory) to change how pages are sorted.
   - Edit the **Copies** counter if a party needs to sign multiple originals.
4. **Instructions**: Click "Instructions" to view and copy a per-signatory signing table to send to your client.
5. **Download**: Click "Download ZIP" to get the organized PDF packets.

### Assembly Mode
1. Switch to the **Assembly** tab in the toolbar.
2. **Upload Signed Pages**: Drop executed/scanned PDFs or DOCX files into the "Executed Pages" section of the sidebar.
3. **Auto-Match**: Click **Auto-Match** to let the AI match executed pages to their corresponding blank signature pages.
4. **Review**: The Assembly Progress grid shows each document (rows) × signatory (columns). Green = matched, amber = pending.
5. **Manual Override**: Click any cell to manually assign or reassign a page.
6. **Assemble & Download**: Click **Assemble & Download** to generate final PDFs with executed pages inserted.

### Save & Restore
- Click **Save Config** at any time to export your session (including all PDFs) to a `.json` file.
- Click **Load Config** to restore a previous session instantly — no re-uploading required.

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## License

[MIT](https://choosealicense.com/licenses/mit/)
