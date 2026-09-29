# Build stage
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Prune to the runtime dependency set.
#
# --omit=peer matters as much as --production here. drizzle-orm declares 28
# peerDependencies — every driver it supports — and valibot declares typescript;
# all optional, and package managers install optional peers by default. That
# alone was pulling PGlite and the TypeScript compiler into the runtime image,
# ~50 MB of things the server never imports, and it looked like --production
# being ignored. Nothing here needs a peer resolved: the drivers we actually use
# are direct dependencies.
RUN rm -rf node_modules && bun install --frozen-lockfile --production --omit=peer

# Runtime stage
FROM oven/bun:1.3
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle ./drizzle
# Volume mount points, owned by the unprivileged user the image ships with. A
# named volume takes its ownership from the image's directory the first time it
# is mounted — so a mount point missing here comes up root-owned. That is what
# happened to /data/tiles: every tile write failed silently and each map pan
# re-fetched from the tile server, which OSM's usage policy asks you not to do.
RUN mkdir -p /data/blobs /data/tiles && chown -R bun:bun /data/blobs /data/tiles /app
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
	CMD bun -e "fetch('http://localhost:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", "build/index.js"]
