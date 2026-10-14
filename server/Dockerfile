# hsn-api server image. Build from this directory:  docker build -t hsn-api .
# Deployment guide: ../docs/guides/deployment.md
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    HSN_HOST=0.0.0.0 \
    HSN_PORT=3000 \
    HSN_DB_PATH=/var/lib/hsn/hsn.db \
    HSN_STATE_HWM_FILE=/var/lib/hsn-state/hwm.json

WORKDIR /app

# All dependencies, dev included: the operator scripts (bootstrap-admins, import-dataset,
# create-key, verify-audit, ...) run with tsx inside the container.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY data ./data
RUN npm run build

# Database and restore-detection sidecar live in separate directories (mount a volume on each).
RUN mkdir -p /var/lib/hsn /var/lib/hsn-state && chown node:node /var/lib/hsn /var/lib/hsn-state
USER node

EXPOSE 3000
# The server does not create the parent directories of HSN_DB_PATH or HSN_STATE_HWM_FILE itself.
CMD ["sh", "-c", "mkdir -p \"$(dirname \"$HSN_DB_PATH\")\" \"$(dirname \"$HSN_STATE_HWM_FILE\")\" && exec node dist/main.js"]
