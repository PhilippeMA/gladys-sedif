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
# Chromium (the portal has no API, see src/sedif/portal.js), and Playwright
# does not support musl.
#
# Why PLAYWRIGHT'S Chromium and not the distro package: they are not
# interchangeable. Playwright pins itself to one exact browser build (1.62
# expects Chromium 151); Debian bookworm ships a much older one, built with
# different flags. Pairing the two dies at launch — "chrome_crashpad_handler:
# --database is required", then SIGTRAP and "Target page, context or browser
# has been closed". So the image installs the browser that matches the
# `playwright-core` in package.json; `--with-deps` pulls in the system
# libraries and fonts it needs.
#
# `--no-shell` keeps the FULL browser rather than the lighter headless shell:
# the portal is a Salesforce app, and the full build in new-headless mode is
# the closest thing to what a real visitor runs. Worth the extra megabytes.
# -----------------------------------------------------------------------------

FROM node:24-bookworm-slim

# dumb-init: correct SIGTERM handling for a graceful shutdown.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install the PROD dependencies first (better build cache).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Browsers outside the default per-user cache: the build runs as root, the
# container runs as `node`, and ~/.cache would not be the same directory.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright-core install --with-deps --no-shell chromium \
  && rm -rf /var/lib/apt/lists/* \
  && chmod -R a+rX /ms-playwright

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./

ENV NODE_ENV=production
# Chromium writes a throw-away profile at every launch, and Playwright derives
# its location from TMPDIR. The default (/tmp) belongs to the read-only rootfs,
# so point it — and everything else Chromium expects to own — at the volume.
# `ensureStateDir()` sets TMPDIR again at runtime, for a hand-started container.
ENV TMPDIR=/data/chromium \
    HOME=/data \
    XDG_CONFIG_HOME=/data/chromium \
    XDG_CACHE_HOME=/data/chromium

# The only writable location allowed at runtime.
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
