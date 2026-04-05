#!/usr/bin/env bash
# Create a dedicated Cloud Run *runtime* service account with least-privilege access
# to Signature Packet IDE secrets. Idempotent for IAM bindings (gcloud may warn on duplicates).
#
# Usage:
#   export PROJECT_ID=your-project-id   # optional; defaults to gcloud config
#   export REGION=us-central1
#   export SERVICE=signature-packet-ide
#   ./scripts/setup-cloud-run-runtime-sa.sh
#
# After this script:
#   1) Grant yourself (or your deployer) permission to attach this SA to Cloud Run:
#        gcloud iam service-accounts add-iam-policy-binding RUNTIME_SA_EMAIL \
#          --member="user:you@yourdomain.com" --role="roles/iam.serviceAccountUser"
#   2) Point Cloud Run at the new SA:
#        gcloud run services update "$SERVICE" --region "$REGION" \
#          --service-account="$RUNTIME_SA_EMAIL"
#   3) Optional: remove secretAccessor from the old default compute SA on each secret
#      (Console or gcloud secrets remove-iam-policy-binding).

set -euo pipefail

SA_NAME="${SA_NAME:-sig-packet-runner}"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-signature-packet-ide}"

if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Set PROJECT_ID or run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

RUNTIME_SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

SECRETS=(
  m365-tenant-id
  m365-client-id
  m365-client-secret
  m365-user-id
  gemini-api-key
)

echo "Project:     $PROJECT_ID"
echo "Runtime SA:  $RUNTIME_SA"
echo "Cloud Run:   $SERVICE ($REGION)"
echo

if ! gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" &>/dev/null; then
  gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="Signature Packet IDE (Cloud Run runtime)"
  echo "Created service account."
else
  echo "Service account already exists."
fi

echo "Granting secretmanager.secretAccessor on each secret..."
for SECRET in "${SECRETS[@]}"; do
  if gcloud secrets describe "$SECRET" --project="$PROJECT_ID" &>/dev/null; then
    gcloud secrets add-iam-policy-binding "$SECRET" \
      --project="$PROJECT_ID" \
      --member="serviceAccount:${RUNTIME_SA}" \
      --role="roles/secretmanager.secretAccessor" \
      2>/dev/null || true
    echo "  - $SECRET"
  else
    echo "  (skip) $SECRET — not found in project"
  fi
done

echo "Granting logging + monitoring (recommended for Cloud Run)..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/logging.logWriter" 2>/dev/null || true

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/monitoring.metricWriter" 2>/dev/null || true

echo
echo "=== Next steps (run as your user) ==="
echo
echo "1) Allow YOUR account to deploy Cloud Run using this SA (one-time):"
echo "   gcloud iam service-accounts add-iam-policy-binding ${RUNTIME_SA} \\"
echo "     --project=\"${PROJECT_ID}\" \\"
echo "     --member=\"user:you@yourcompany.com\" \\"
echo "     --role=\"roles/iam.serviceAccountUser\""
echo "   (Use your real Google sign-in email, or a CI service account member.)"
echo
echo "2) Attach the runtime SA to the service:"
echo "   gcloud run services update \"${SERVICE}\" --region \"${REGION}\" \\"
echo "     --project=\"${PROJECT_ID}\" \\"
echo "     --service-account=\"${RUNTIME_SA}\""
echo
echo "3) Optional cleanup: remove roles/secretmanager.secretAccessor for the old"
echo "   \${PROJECT_NUMBER}-compute@developer.gserviceaccount.com on each secret"
echo "   if you no longer need the default SA to read them."
