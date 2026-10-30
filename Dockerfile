# Servidor de conexão (sinalização) do Ponte.
# Use atrás de um proxy com HTTPS (Caddy, Nginx, Traefik). Veja docs/IMPLANTACAO.md.
FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 TRUST_PROXY=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY public ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/index.js"]
