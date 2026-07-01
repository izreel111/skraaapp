# Apify base image with Node + Playwright + Chromium preinstalled.
FROM apify/actor-node-playwright-chrome:20

# Install dependencies (omit dev). Copy package files first for layer caching.
COPY --chown=myuser package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --no-optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version

# Copy the rest of the source.
COPY --chown=myuser . ./

CMD ["node", "src/main.js"]
