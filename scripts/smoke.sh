#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/docker-compose.yml"
INFRA_ENV="$ROOT_DIR/infra/.env"

if [[ ! -f "$INFRA_ENV" ]]; then
  echo "Missing infra/.env. Create it with: cp infra/.env.example infra/.env" >&2
  exit 1
fi

set -a
source "$INFRA_ENV"
set +a

docker compose -f "$COMPOSE_FILE" up -d

API_BASE_URL="${API_BASE_URL:-http://localhost:4000}"
LIVEKIT_HTTP_URL="${LIVEKIT_HTTP_URL:-http://localhost:7880}"
MINIO_HTTP_URL="${MINIO_HTTP_URL:-http://localhost:9000}"
API_DIR="$ROOT_DIR/apps/api"

wait_for_url() {
  local url="$1"
  local attempts=30
  local delay=1

  for ((i=1; i<=attempts; i++)); do
    if curl -fsS "$url" > /dev/null; then
      echo "OK: $url"
      return 0
    fi
    sleep "$delay"
  done

  echo "Failed to reach $url after $attempts attempts" >&2
  return 1
}

check_container() {
  local service="$1"
  local container_id
  container_id="$(docker compose -f "$COMPOSE_FILE" ps -q "$service")"
  if [[ -z "$container_id" ]]; then
    echo "Container for $service not found" >&2
    return 1
  fi

  local status health
  status="$(docker inspect -f '{{.State.Status}}' "$container_id")"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")"

  if [[ "$status" != "running" ]]; then
    echo "Container $service is not running (status: $status)" >&2
    return 1
  fi

  if [[ -n "$health" && "$health" != "healthy" ]]; then
    echo "Container $service is not healthy (health: $health)" >&2
    return 1
  fi

  echo "OK: $service container running${health:+, health=$health}"
}

for service in livekit redis minio livekit-egress; do
  check_container "$service"
done

wait_for_url "$API_BASE_URL/health"
wait_for_url "$API_BASE_URL/ready"
wait_for_url "$LIVEKIT_HTTP_URL/health"
wait_for_url "$MINIO_HTTP_URL/minio/health/ready"

if [[ -z "${S3_BUCKET:-}" || -z "${S3_ACCESS_KEY:-}" || -z "${S3_SECRET:-}" ]]; then
  echo "Missing S3_* values in infra/.env. Cannot check MinIO bucket." >&2
  exit 1
fi

API_DIR="$API_DIR" MINIO_HTTP_URL="$MINIO_HTTP_URL" node <<'NODE'
const path = require("path");
process.chdir(process.env.API_DIR);

let S3Client;
let HeadBucketCommand;
try {
  ({ S3Client, HeadBucketCommand } = require("@aws-sdk/client-s3"));
} catch (error) {
  console.error("Missing @aws-sdk/client-s3. Run pnpm install before smoke test.");
  process.exit(1);
}

const bucket = process.env.S3_BUCKET;
const endpoint = process.env.MINIO_HTTP_URL || process.env.S3_ENDPOINT;
const accessKeyId = process.env.S3_ACCESS_KEY;
const secretAccessKey = process.env.S3_SECRET;
const region = process.env.S3_REGION || "us-east-1";
const forcePathStyle = String(process.env.S3_FORCE_PATH_STYLE || "true") !== "false";

const client = new S3Client({
  region,
  endpoint,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey }
});

client
  .send(new HeadBucketCommand({ Bucket: bucket }))
  .then(() => {
    console.log(`OK: MinIO bucket ${bucket} exists`);
  })
  .catch((error) => {
    console.error(`MinIO bucket check failed: ${error.message}`);
    process.exit(1);
  });
NODE
