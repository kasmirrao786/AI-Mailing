FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN rm -f test-frontend.js

ENV NODE_ENV=production
EXPOSE 3000

# Migrations run automatically on boot (see server.js), so no separate migrate step here.
CMD ["node", "server.js"]
