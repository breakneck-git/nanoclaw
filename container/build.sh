#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"

# Build with the runtime the host will run containers with. The rule
# (CONTAINER_RUNTIME from env/.env, else Apple container on macOS, docker
# elsewhere) lives in src/container-runtime.ts — ask it, don't copy it.
if [ -z "${CONTAINER_RUNTIME:-}" ]; then
  if [ ! -f ../dist/container-runtime.js ]; then
    echo "dist/ is missing — run 'npm run build' first (or set CONTAINER_RUNTIME)." >&2
    exit 1
  fi
  CONTAINER_RUNTIME="$(cd .. && LOG_LEVEL=silent node --input-type=module -e \
    "const m = await import('./dist/container-runtime.js'); console.log(m.CONTAINER_RUNTIME_BIN);")"
fi

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

# A rebuild leaves the previous image untagged; with Apple container each one
# keeps a ~2.4 GB unpacked snapshot. Drop dangling images only — tagged ones
# (node, alpine, the new build) stay. Failure here must not fail the build.
if [ "${CONTAINER_RUNTIME}" = "docker" ]; then
  docker image prune -f || true
else
  ${CONTAINER_RUNTIME} image prune || true
fi

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
