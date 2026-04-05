# Google Cloud Run deployment plan

This document is the **implementation plan** for running Signature Packet IDE as **one Cloud Run service** (Vite static build + Node API), with **Identity-Aware Proxy (IAP)** so only allowed Google Workspace users can access it.

**Target architecture:** Option A — single container, same origin for UI and `/api/*`, no load balancer required for IAP ([IAP for Cloud Run](https://cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run)).

**Placeholders in examples:** Replace **`YOUR_PROJECT_ID`** with your Google Cloud **project ID** and **`YOUR_REGION`** with your deploy **region** (examples often use `us-central1` or `europe-west1`). Several snippets reuse **`YOUR_PROJECT_ID`** as the **Cloud Run service name**, **Artifact Registry repo name**, and **local Docker image tag** for simplicity; override `SERVICE`, `REPO`, and `LOCAL_IMAGE` in `scripts/deploy-cloud-run.sh` (or env vars) if yours differ.

---

## Phase 0 — Prerequisites

- [ ] Google Cloud project with billing enabled.
- [ ] `gcloud` CLI installed and authenticated (`gcloud auth login`, `gcloud config set project YOUR_PROJECT_ID`).
- [ ] Enable APIs: **Cloud Run**, **Artifact Registry**, **Secret Manager**, **Identity-Aware Proxy** (and **Cloud Build** if you build images in GCP).
- [ ] Decide **region** — **`YOUR_REGION`** (e.g. `us-central1`, `europe-west1`).
- [ ] Workspace admin buy-in for IAP access (who gets **IAP-secured Web App User**).

---

## Phase 1 — Single entrypoint in code (production server)

**Status:** Implemented (`backend/server.ts`, `npm run build:server` / `build:all`, `npm start`).

**Goal:** One Node process listens on `PORT`, serves `dist/`, and exposes existing API routes.

| Step | Task |
|------|------|
| 1.1 | Add `express.static` for the Vite output directory (`dist/`). |
| 1.2 | Keep existing routes: `GET /api/health`, `POST /api/docx-to-pdf`. |
| 1.3 | Add SPA fallback: `GET *` → `index.html` for non-API paths (after API routes). |
| 1.4 | Bind `const port = Number(process.env.PORT \|\| 8080)` and `app.listen(port, '0.0.0.0')`. |
| 1.5 | **TypeScript:** Do **not** use `node backend/server.ts` in production. Either compile `backend/server.ts` to JS in the image build, or bundle with esbuild; ensure **`import.meta.url`** / `fileURLToPath` for static paths if staying ESM. |
| 1.6 | Remove reliance on Vite dev proxy in production: frontend should call **`/api/...`** same-origin (default `VITE_DOCX_CONVERTER_URL=/api/docx-to-pdf` is already correct). |
| 1.7 | **Done:** Gemini runs **server-side** only (`backend/geminiAnalyze.ts`, routes `/api/gemini/*`); **`GEMINI_API_KEY`** is read at runtime (Secret Manager on Cloud Run, `.env` for `npm run dev:backend`). |

**Acceptance:** `docker run -p 8080:8080 -e ...` shows UI at `/` and `GET /api/health` returns JSON.

---

## Phase 2 — Dockerfile (multi-stage)

**Status:** Implemented (`Dockerfile`, `.dockerignore`). Local check: `docker build -t YOUR_PROJECT_ID .` then `docker run -p 8080:8080 -e PORT=8080 ...`.

**Apple Silicon (M1/M2/M3) → Cloud Run:** Cloud Run needs **`linux/amd64`**. A default local build is often **arm64**, which fails with *“must support amd64/linux”*. Build and push with:

```bash
docker build --platform linux/amd64 -t YOUR_PROJECT_ID .
```

Or: `npm run docker:build:cloudrun` (see `package.json`).

**Gemini:** Set **`GEMINI_API_KEY`** at **runtime** on Cloud Run (Secret Manager — see Phase 4). No build-arg required. Local: add `GEMINI_API_KEY` to `.env` and run **`npm run dev:full`** (or `dev:backend` + `dev`).

**Troubleshooting (401 “API keys are not supported by this API” on `aiplatform.googleapis.com`):** The `@google/genai` SDK turns on **Vertex** when env **`GOOGLE_GENAI_USE_VERTEXAI=true`**. Vertex does not accept a Gemini **API key**. Either remove that env var (and related `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` if you were only using them for Vertex), or deploy a build that uses Vertex with the runtime service account — see branch `feature/vertex-gemini`. Current `main` forces **`vertexai: false`** when using `GEMINI_API_KEY` so API-key mode works even if Vertex env vars are still set.

| Step | Task |
|------|------|
| 2.1 | **Stage `build`:** `npm ci`, copy source, `npm run build` → `dist/`. |
| 2.2 | Compile or bundle `backend/server` to runnable JS in build stage (recommended). |
| 2.3 | **Stage `runtime`:** `node:20-slim` (or distroless Node), `NODE_ENV=production`. |
| 2.4 | `npm ci --omit=dev` **or** copy only production `node_modules` + compiled server (avoid shipping full dev tree). |
| 2.5 | Copy `dist/` and compiled server artifacts into predictable paths (e.g. `/app/dist`, `/app/server`). |
| 2.6 | `EXPOSE 8080` (informational); Cloud Run sets `PORT`. |
| 2.7 | Add `.dockerignore`: `node_modules`, `dist`, `.git`, `.env`, `*.md` (keep README if you want). |

**Acceptance:** Image builds locally; container serves UI + API on one port.

---

## Phase 3 — Artifact Registry + Cloud Run deploy

| Step | Task |
|------|------|
| 3.1 | Create Artifact Registry Docker repository (e.g. same as **`YOUR_PROJECT_ID`** or another name — set **`REPO`** in the deploy script). |
| 3.2 | `gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG` (or build/push from CI). |
| 3.3 | Deploy Cloud Run service: image, region, **CPU/memory** as needed, **max instances**, **timeout** (DOCX + Graph may need 60–300s). |
| 3.4 | Initially allow unauthenticated **only for smoke test** in a dev project; lock down before production (see Phase 5). |

**Acceptance:** Service URL loads the app and health check passes.

### One-command deploy (local Docker → Artifact Registry → Cloud Run)

From repo root, after `gcloud auth login`, `gcloud config set project …` (or set **`PROJECT_ID`** in **`.env.deploy`**), and `gcloud auth configure-docker YOUR_REGION-docker.pkg.dev`:

**Config:** Copy **`.env.deploy.example`** → **`.env.deploy`** (gitignored) with at least `PROJECT_ID` and `REGION`. Optional: `REPO`, `SERVICE`, `LOCAL_IMAGE` — if omitted, they default to **`PROJECT_ID`**. The script does **not** load **`.env`** (app secrets + values that are unsafe to `source` in bash).

```bash
npm run deploy:cloud-run
# or: ./scripts/deploy-cloud-run.sh
```

Overrides: same variables as env vars without a file. Flags: `--build-only` (no push/deploy), `--no-build` (push/deploy existing local image). Extra deploy flags: `GCP_RUN_DEPLOY_EXTRA_ARGS='--timeout=300'`.

**Note:** `gcloud run deploy` **merges** with the latest service settings for options you omit (IAP, secrets, service account). Re-apply critical flags if your `gcloud` version behaves differently.

---

## Phase 4 — Secrets (Secret Manager)

| Step | Task |
|------|------|
| 4.1 | Create secrets: `m365-tenant-id`, `m365-client-id`, `m365-client-secret`, `m365-user-id`, **`gemini-api-key`** (maps to env **`GEMINI_API_KEY`** at runtime). |
| 4.2 | Grant the **Cloud Run service account** `secretmanager.secretAccessor` on those secrets. |
| 4.3 | Map secrets to env vars in Cloud Run (Console or `--set-secrets`). |
| 4.4 | Set non-secret env: `NODE_ENV=production`, `M365_UPLOAD_FOLDER`, etc. |

**Acceptance:** DOCX conversion works end-to-end against M365 from Cloud Run.

### Phase 4 — Command cheat sheet (Secret Manager → Cloud Run)

Your server reads **`M365_*`** for Graph (see `backend/server.ts`) and **`GEMINI_API_KEY`** for signature extraction (`backend/geminiAnalyze.ts`). Optional plain env: **`M365_UPLOAD_FOLDER`**, **`M365_GRAPH_BASE_URL`**.

1. **Enable the API** (once per project):

```bash
gcloud services enable secretmanager.googleapis.com
```

2. **Create secrets from your local `.env`** (same keys the app uses). Run from the **repo root** where `.env` lives.

   - **Safety:** `.env` must stay **gitignored** (this repo already lists `.env` in `.gitignore`). Do not commit it. Prefer a private machine; avoid screen-sharing while this runs.
   - **Format:** one line per key, `KEY=value` or `export KEY=value`. Optional double/single quotes around the value. Lines starting with `#` are ignored.
   - The snippet below **does not** `source` `.env` (so a malicious `.env` cannot run shell commands); it reads **M365** keys and **`GEMINI_API_KEY`**.

```bash
export ENV_FILE="${ENV_FILE:-.env}"

python3 <<'PY'
import os, re, subprocess, sys

env_path = os.environ.get("ENV_FILE", ".env")
pairs = [
    ("m365-tenant-id", "M365_TENANT_ID"),
    ("m365-client-id", "M365_CLIENT_ID"),
    ("m365-client-secret", "M365_CLIENT_SECRET"),
    ("m365-user-id", "M365_USER_ID"),
    ("gemini-api-key", "GEMINI_API_KEY"),
]

def load_value(path, key):
    try:
        f = open(path, encoding="utf-8")
    except OSError as e:
        print(e, file=sys.stderr)
        return None
    pattern = re.compile(
        r"^\s*(?:export\s+)?" + re.escape(key) + r"\s*=\s*(.*)\s*$"
    )
    with f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            m = pattern.match(line)
            if not m:
                continue
            val = m.group(1).strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            return val
    return None

def secret_exists(name):
    r = subprocess.run(
        ["gcloud", "secrets", "describe", name],
        capture_output=True,
    )
    return r.returncode == 0

def push_secret(name, value):
    cmd_create = [
        "gcloud", "secrets", "create", name,
        "--data-file=-",
        "--replication-policy=automatic",
    ]
    cmd_add = ["gcloud", "secrets", "versions", "add", name, "--data-file=-"]
    if secret_exists(name):
        subprocess.run(cmd_add, input=value.encode("utf-8"), check=True)
    else:
        subprocess.run(cmd_create, input=value.encode("utf-8"), check=True)

for gcp_name, env_key in pairs:
    v = load_value(env_path, env_key)
    if not v:
        print(f"Missing {env_key} in {env_path}", file=sys.stderr)
        sys.exit(1)
    print(f"Pushing {gcp_name} ← {env_key} …")
    push_secret(gcp_name, v)
print("Done.")
PY
```

To add a **new version** after changing `.env`, run the same block again (it uses `versions add` when the secret already exists).

**Alternative (Console):** Secret Manager → Create secret — paste values manually if you prefer not to run a script.

3. **Cloud Run service account** — default is the Compute default SA. Get **project number** and set the member:

```bash
export PROJECT_ID=$(gcloud config get-value project)
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
export RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
```

If you deploy with **`--service-account`** to a custom SA, use that email instead of `RUNTIME_SA`.

4. **Grant accessor** on each secret (repeat for each name):

```bash
for SECRET in m365-tenant-id m365-client-id m365-client-secret m365-user-id gemini-api-key; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor"
done
```

5. **Wire secrets into Cloud Run** as env vars (`SECRET_NAME:version`; `latest` is fine once stable):

```bash
export REGION=YOUR_REGION
export SERVICE=YOUR_PROJECT_ID

gcloud run services update "$SERVICE" --region "$REGION" \
  --set-secrets=M365_TENANT_ID=m365-tenant-id:latest,M365_CLIENT_ID=m365-client-id:latest,M365_CLIENT_SECRET=m365-client-secret:latest,M365_USER_ID=m365-user-id:latest,GEMINI_API_KEY=gemini-api-key:latest
```

Or on **first deploy**, add the same `--set-secrets=...` flag to `gcloud run deploy`.

6. **Non-secrets** (still env vars):

```bash
gcloud run services update "$SERVICE" --region "$REGION" \
  --set-env-vars NODE_ENV=production,M365_UPLOAD_FOLDER=SignaturePacketIDE-Temp
```

**Note:** Cloud Run sets **`PORT`** automatically — do not override with a fixed value unless you know what you’re doing.

### Dedicated runtime service account (recommended)

**Why not the default Compute Engine SA (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`)?** That account is **shared** by default with other workloads in the project and historically was often **over‑privileged**. A **dedicated** runtime SA limits blast radius and makes audits clearer.

**What to create:** e.g. `sig-packet-runner@YOUR_PROJECT_ID.iam.gserviceaccount.com` with:

| Permission | Scope |
|------------|--------|
| `roles/secretmanager.secretAccessor` | **Only** the secrets this app needs (`m365-*`, `gemini-api-key`) — per-secret IAM, not project-wide Editor. |
| `roles/logging.logWriter` | Project (so container logs reach Cloud Logging). |
| `roles/monitoring.metricWriter` | Project (metrics). |

**Automated setup (repo script):** from repo root, after secrets exist in Secret Manager:

```bash
chmod +x scripts/setup-cloud-run-runtime-sa.sh
export PROJECT_ID=YOUR_PROJECT_ID   # or rely on gcloud config
export REGION=YOUR_REGION
export SERVICE=YOUR_PROJECT_ID
./scripts/setup-cloud-run-runtime-sa.sh
```

Then follow the script’s printed **next steps**: grant **your user** `roles/iam.serviceAccountUser` on the new SA (so you can deploy Cloud Run with it), then:

```bash
gcloud run services update YOUR_PROJECT_ID --region YOUR_REGION \
  --service-account=sig-packet-runner@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

**Deploy / CI:** whichever principal runs `gcloud run deploy` needs **`roles/iam.serviceAccountUser`** on **`sig-packet-runner@...`** (in addition to normal Cloud Run deploy permissions).

**Cleanup (optional):** remove `secretmanager.secretAccessor` for **`PROJECT_NUMBER-compute@developer.gserviceaccount.com`** on each secret if nothing else in the project needs those secrets via the default SA.

**IAP:** unchanged — the IAP service agent still needs **`roles/run.invoker`** on the **Cloud Run service**; that is separate from the **runtime** SA.

---

## Phase 5 — IAP + Workspace-only access

| Step | Task |
|------|------|
| 5.1 | Cloud Run: **Require authentication** and enable **IAP** for the service ([docs](https://cloud.google.com/iap/docs/enabling-cloud-run)). |
| 5.2 | Remove public access: ensure only IAP-authenticated users (and invoker IAM as required by your setup) can reach the service. |
| 5.3 | In IAP (or Cloud Console IAM for the IAP resource), grant **IAP-secured Web App User** to Workspace **groups** (recommended) or users. |
| 5.4 | OAuth consent: use **Internal** app type if restricted to your Google Workspace org. |
| 5.5 | Test with a non-allowed account (should be blocked) and an allowed account (should reach the app). |

**Acceptance:** Only intended Workspace identities can open the app; direct anonymous access is denied.

---

## Phase 6 — Operations

| Step | Task |
|------|------|
| 6.1 | **Logging:** Use Cloud Logging; consider structured logs for conversion failures. Gemini extraction detail logs are **off by default**; set env **`DEBUG_GEMINI=1`** on the service only when debugging (logs party/signatory text). |
| 6.2 | **Cold starts:** If UX requires it, set **min instances** to 1 (extra monthly cost). |
| 6.3 | **CI/CD:** Cloud Build trigger on `main` → build → push → deploy (optional). |
| 6.4 | **Custom domain** (optional): Map domain to Cloud Run per Google’s custom domain docs. |

---

## Cost notes (indicative)

- Cloud Run scales to zero; light internal use often stays low.
- **No external load balancer** needed for IAP-on-Cloud-Run (avoids fixed LB cost).
- Secret Manager and Artifact Registry have small usage charges.
- **Min instances** avoids cold starts but adds baseline compute cost.

---

## Implementation order (recommended)

1. Phase 1 (Express static + SPA + PORT + compiled backend) — **blocks everything else**  
2. Phase 2 (Dockerfile) + local `docker run` validation  
3. Phase 3 (push image + deploy dev Cloud Run)  
4. Phase 4 (secrets + M365 smoke test)  
4b. **Optional:** dedicated runtime SA (`scripts/setup-cloud-run-runtime-sa.sh` + `--service-account`)  
5. Phase 5 (IAP + lock down)  
6. Phase 6 (polish)

---

## References

- [Configure IAP for Cloud Run](https://cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run)  
- [Enable IAP for Cloud Run](https://cloud.google.com/iap/docs/enabling-cloud-run)  
- [Cloud Run container runtime contract](https://cloud.google.com/run/docs/container-contract)  
- [Secret Manager with Cloud Run](https://cloud.google.com/run/docs/configuring/secrets)
