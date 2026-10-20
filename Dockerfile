# The image tag must match the "playwright" version pinned in package.json
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    NO_SANDBOX=true

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
RUN mkdir -p screenshots && chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
