#!/usr/bin/env bash
# Build the app, build a linux/amd64 Docker image, push to Artifact Registry, deploy Cloud Run.
#
# Defaults match this repo’s usual GCP layout; override with env vars or flags.
#
# Usage:
#   ./scripts/deploy-cloud-run.sh              # full pipeline
#   ./scripts/deploy-cloud-run.sh --build-only # npm + docker build only (no push/deploy)
#   ./scripts/deploy-cloud-run.sh --no-build   # reuse existing local image: tag, push, deploy
#
# Configuration (pick one):
#   1) File: copy `.env.deploy.example` → `.env.deploy` (gitignored) with PROJECT_ID and REGION.
#   2) Shell: export PROJECT_ID=… REGION=… before running (optional REPO, SERVICE, LOCAL_IMAGE).
#   3) gcloud: leave PROJECT_ID unset; script uses `gcloud config get-value project`.
#
# Do NOT point this script at `.env` — that file has app secrets and values that are unsafe to `source` in bash.
#
# Environment (optional):
#   PROJECT_ID, REGION, REPO, SERVICE, LOCAL_IMAGE, IMAGE_TAG
#   GCP_RUN_DEPLOY_EXTRA_ARGS — extra args for `gcloud run deploy` (space-separated)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env.deploy ]]; then
  echo "==> Loading .env.deploy"
  set -a
  # shellcheck disable=SC1091
  source .env.deploy
  set +a
fi

BUILD_ONLY=false
NO_BUILD=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-only) BUILD_ONLY=true ;;
    --no-build)   NO_BUILD=true ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (use --help)" >&2
      exit 1
      ;;
  esac
  shift
done

if [[ "$BUILD_ONLY" == true && "$NO_BUILD" == true ]]; then
  echo "Cannot use --build-only and --no-build together." >&2
  exit 1
fi

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Set PROJECT_ID in .env.deploy, or: export PROJECT_ID=…, or: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

# Same string as project ID is a common convention; override in .env.deploy if needed.
REPO="${REPO:-$PROJECT_ID}"
SERVICE="${SERVICE:-$PROJECT_ID}"
LOCAL_IMAGE="${LOCAL_IMAGE:-$PROJECT_ID}"

REGISTRY_HOST="${REGION}-docker.pkg.dev"
REMOTE_IMAGE="${REGISTRY_HOST}/${PROJECT_ID}/${REPO}/app:${IMAGE_TAG}"

echo "==> Project:  $PROJECT_ID"
echo "==> Region:   $REGION"
echo "==> Service:  $SERVICE"
echo "==> Push to:  $REMOTE_IMAGE"
echo

if [[ "$NO_BUILD" != true ]]; then
  echo "==> npm run build:all"
  npm run build:all

  echo "==> docker build (linux/amd64)"
  docker build --platform linux/amd64 -t "$LOCAL_IMAGE" .
else
  echo "==> Skipping npm/docker build (--no-build)"
fi

if [[ "$BUILD_ONLY" == true ]]; then
  echo "==> Done (--build-only)."
  exit 0
fi

echo "==> docker tag + push"
docker tag "$LOCAL_IMAGE" "$REMOTE_IMAGE"
docker push "$REMOTE_IMAGE"

echo "==> gcloud run deploy"
# shellcheck disable=SC2086
gcloud run deploy "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$REMOTE_IMAGE" \
  ${GCP_RUN_DEPLOY_EXTRA_ARGS:-}

echo
echo "==> Deploy finished. Service URL:"
gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)'
