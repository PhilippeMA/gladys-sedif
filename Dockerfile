# -----------------------------------------------------------------------------
# Integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the CI workflow
#
# Why Debian and not the template's Alpine: this integration drives a real
# Chromium (the portal has no API, see src/sedif/portal.js), and Chromium is
# packaged for both amd64 and arm64 on Debian while Alpine's build is musl-only
# and unsupported by Playwright. We install the DISTRO Chromium and use
# `playwright-core`, so nothing is downloaded at install or at run time.
# -----------------------------------------------------------------------------

FROM node:24-bookworm-slim

# chromium        : the browser the portal is driven with
# fonts-liberation: without a font, Lightning pages render as empty boxes and
#                   the text-based selectors never match
# dumb-init       : correct SIGTERM handling for a graceful shutdown
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    dumb-init \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install the PROD dependencies first (better build cache).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./

ENV NODE_ENV=production
# playwright-core ships no browser of its own: point it at the distro one.
ENV CHROMIUM_PATH=/usr/bin/chromium
# Chromium needs a writable scratch space for the throw-away profile Playwright
# creates at each launch, and /data is the only writable mount of the sandbox.
# `ensureStateDir()` sets this at runtime too, for a container started by hand.
ENV TMPDIR=/data/chromium

# The only writable location allowed at runtime.
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
