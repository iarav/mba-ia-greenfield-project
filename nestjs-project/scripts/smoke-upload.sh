#!/usr/bin/env bash
# Smoke test for the Phase-03 upload pipeline.
#
# What it does:
#   1. Registers a user, reads the confirmation link from Mailpit, confirms
#      the account, and logs in.
#   2. Generates a short H.264 fixture with ffmpeg (unless one is provided).
#   3. Calls POST /videos to create a draft with presigned multipart parts.
#   4. Uploads every part with PUT to the presigned URLs (bytes go straight
#      to MinIO — the API never sees them).
#   5. Calls POST /videos/:id/complete with the collected ETags.
#   6. Polls /videos/:slug/metadata until the worker moves the status to
#      "ready" (or fails on "error").
#   7. Calls GET /videos/:slug and reports the presigned URL the browser
#      would follow.
#
# Requirements: docker compose stack up (`docker compose up -d` inside
# nestjs-project) plus curl, jq and ffmpeg on the host.
#
# Usage:
#   ./scripts/smoke-upload.sh                 # generates a ~2s fixture
#   ./scripts/smoke-upload.sh path/to/big.mp4 # tests a real file (10 GB ok)
#
# The script exits non-zero at the first failure and prints a clear step.

set -euo pipefail

API="${SMOKE_API_URL:-http://localhost:3000}"
MAILPIT="${SMOKE_MAILPIT_URL:-http://localhost:8025}"
PART_SIZE="${SMOKE_PART_SIZE:-$((100 * 1024 * 1024))}" # 100 MiB, matches the API default

log() { printf '\n▶ %s\n' "$*"; }
die() { printf '\n✖ %s\n' "$*" >&2; exit 1; }

for cmd in curl jq ffmpeg; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing dependency: $cmd"
done

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

if [[ $# -ge 1 ]]; then
  VIDEO_PATH="$1"
  [[ -f "$VIDEO_PATH" ]] || die "file not found: $VIDEO_PATH"
  log "using provided fixture: $VIDEO_PATH ($(du -h "$VIDEO_PATH" | cut -f1))"
else
  VIDEO_PATH="$TMPDIR/fixture.mp4"
  log "generating a 2s H.264 fixture with ffmpeg"
  ffmpeg -y -f lavfi -i color=c=black:s=320x240:d=2 \
    -f lavfi -i sine=frequency=1000:duration=2 \
    -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest \
    "$VIDEO_PATH" >/dev/null 2>&1
fi

FILE_SIZE=$(wc -c <"$VIDEO_PATH" | tr -d '[:space:]')
[[ "$FILE_SIZE" -gt 0 ]] || die "video file is empty"
log "fixture size: $FILE_SIZE bytes"

EMAIL="smoke_$(date +%s)_$$@example.com"
PASSWORD="password123"

log "registering $EMAIL"
curl -s -X POST "$API/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null

log "waiting for confirmation email in mailpit"
CONFIRM_TOKEN=""
for _ in $(seq 1 20); do
  MSG_ID=$(curl -s "$MAILPIT/api/v1/search?query=to%3A$EMAIL" \
    | jq -r '.messages[0].ID // empty')
  if [[ -n "$MSG_ID" ]]; then
    BODY=$(curl -s "$MAILPIT/api/v1/message/$MSG_ID" \
      | jq -r '.Text // .HTML')
    CONFIRM_TOKEN=$(printf '%s' "$BODY" | grep -oE 'token=[^"'"'"' &<)>]+' \
      | head -n1 | sed 's/^token=//')
    if [[ -n "$CONFIRM_TOKEN" ]]; then
      break
    fi
  fi
  sleep 0.5
done
[[ -n "$CONFIRM_TOKEN" ]] || die "could not read confirmation token from mailpit"

log "confirming account"
curl -s -f "$API/auth/confirm-email?token=$CONFIRM_TOKEN" >/dev/null

log "logging in"
LOGIN=$(curl -s -f -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
ACCESS_TOKEN=$(echo "$LOGIN" | jq -r '.access_token')
[[ -n "$ACCESS_TOKEN" && "$ACCESS_TOKEN" != "null" ]] || die "no access_token in login response"

log "POST /videos (creating draft)"
CREATE=$(curl -s -f -X POST "$API/videos" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d "{\"title\":\"smoke $EMAIL\",\"file_size\":$FILE_SIZE,\"part_size\":$PART_SIZE}")

VIDEO_ID=$(echo "$CREATE" | jq -r '.id')
SLUG=$(echo "$CREATE" | jq -r '.slug')
UPLOAD_ID=$(echo "$CREATE" | jq -r '.upload_id')
PARTS_COUNT=$(echo "$CREATE" | jq '.parts | length')
[[ "$VIDEO_ID" != "null" ]] || die "missing id in create response"
[[ "$PARTS_COUNT" -gt 0 ]] || die "no presigned parts returned"
log "draft created: id=$VIDEO_ID slug=$SLUG parts=$PARTS_COUNT"

log "uploading $PARTS_COUNT part(s) directly to MinIO"
ETAGS_JSON="[]"
for i in $(seq 0 $((PARTS_COUNT - 1))); do
  PART_NUMBER=$(echo "$CREATE" | jq -r ".parts[$i].part_number")
  PART_URL=$(echo "$CREATE" | jq -r ".parts[$i].url")

  OFFSET=$((i * PART_SIZE))
  CHUNK="$TMPDIR/part_$PART_NUMBER"
  # Portable slice: skip OFFSET bytes and read PART_SIZE bytes. Uses `tail
  # -c +N | head -c M`, which works on macOS BSD tools and GNU coreutils.
  tail -c "+$((OFFSET + 1))" "$VIDEO_PATH" | head -c "$PART_SIZE" >"$CHUNK"

  # Bad url unless we rewrite the internal host that presign uses when
  # signing (localhost is already the presign endpoint on this stack, so
  # the URL should already be reachable from the host).
  HEADERS_FILE="$TMPDIR/part_${PART_NUMBER}_headers.txt"
  curl -s -f -X PUT --data-binary "@$CHUNK" \
    -D "$HEADERS_FILE" "$PART_URL" >/dev/null

  ETAG=$(grep -i '^etag:' "$HEADERS_FILE" | head -n1 \
    | sed -E 's/[[:space:]]*$//; s/^[Ee][Tt][Aa][Gg]:[[:space:]]*//; s/\r$//; s/^"(.*)"$/\1/')
  [[ -n "$ETAG" ]] || die "no ETag returned for part $PART_NUMBER"

  ETAGS_JSON=$(jq -c ". + [{part_number: $PART_NUMBER, etag: \"$ETAG\"}]" <<<"$ETAGS_JSON")
  log "  part $PART_NUMBER uploaded (ETag: $ETAG)"
done

log "POST /videos/:id/complete"
curl -s -f -X POST "$API/videos/$VIDEO_ID/complete" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d "{\"upload_id\":\"$UPLOAD_ID\",\"parts\":$ETAGS_JSON}" \
  | jq '.'

log "waiting for the worker to move the video to ready"
STATUS="processing"
for _ in $(seq 1 60); do
  META=$(curl -s "$API/videos/$SLUG/metadata")
  STATUS=$(echo "$META" | jq -r '.status')
  case "$STATUS" in
    ready) log "video ready — $(echo "$META" | jq -c '{duration_seconds, metadata}')"; break;;
    error) die "worker set status=error: $(echo "$META" | jq -c '.')";;
    *) sleep 1;;
  esac
done
[[ "$STATUS" == "ready" ]] || die "timed out waiting for status=ready (last: $STATUS)"

log "GET /videos/$SLUG (streaming presigned redirect)"
LOCATION=$(curl -s -o /dev/null -D - "$API/videos/$SLUG" \
  | grep -i '^location:' | head -n1 | sed -E 's/^[Ll]ocation:[[:space:]]*//; s/\r$//')
[[ -n "$LOCATION" ]] || die "no Location header for streaming"
log "streaming Location: $LOCATION"

log "GET /videos/$SLUG?download=true"
DOWNLOAD_LOCATION=$(curl -s -o /dev/null -D - "$API/videos/$SLUG?download=true" \
  | grep -i '^location:' | head -n1 | sed -E 's/^[Ll]ocation:[[:space:]]*//; s/\r$//')
[[ -n "$DOWNLOAD_LOCATION" ]] || die "no Location header for download"
log "download Location: $DOWNLOAD_LOCATION"

log "OK — the full upload → process → stream pipeline works end-to-end."
