# SnapSurf MCP server in a container.
#
# Playwright's official image already carries Chromium and its system libraries for the
# exact Playwright version this package pins, so the daemon starts without a first-run
# download. The MCP transport is stdio: run with `docker run -i --rm snapsurf`, or point an
# MCP client at that command. The browser daemon binds 127.0.0.1 inside the container only.
FROM mcr.microsoft.com/playwright:v1.55.1

WORKDIR /app
ENV NODE_ENV=production

# Runtime dependencies only (playwright, esbuild), from the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts

# The runtime files of the package (see .dockerignore for what stays out).
COPY . .

ENTRYPOINT ["node", "mcp/server.mjs"]
