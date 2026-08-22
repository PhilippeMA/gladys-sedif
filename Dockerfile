# -----------------------------------------------------------------------------
# Integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the CI workflow
#
# There is nothing to install beyond Node. This image used to carry a full
# Chromium — about 500 MB, and 42 seconds just to start on the home server this
# was first deployed to — because the portal was driven through its web pages.
# It is now read through its own API (src/sedif/api.js): a handful of HTTP
# requests, no browser, no system libraries.
# -----------------------------------------------------------------------------

FROM node:24-alpine

# dumb-init: handles signals (SIGTERM) correctly for a graceful shutdown.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install the PROD dependencies first (better build cache).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Then the integration code.
COPY index.js ./
COPY src ./src
# The intermediate certificate the portal forgets to send. Without it Node
# rejects a perfectly good connection with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
COPY certs ./certs
COPY gladys-assistant-integration.json ./

ENV NODE_ENV=production

# The only writable location allowed at runtime.
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
