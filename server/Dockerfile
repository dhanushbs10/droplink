FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
# Compile ahead of time. Previously the container ran `npx tsx`, where tsx is a
# devDependency: any --omit=dev/prune would make npx silently download and run it
# from the public registry at start-up, and the running artifact would not be
# the one that was reviewed.
RUN npm ci

COPY server ./server
COPY src/lib/types/protocol.ts ./src/lib/types/protocol.ts
COPY tsconfig.json ./

RUN npx --no-install tsc server/index.ts \
      --outDir dist --module commonjs --target es2022 \
      --moduleResolution node --esModuleInterop --skipLibCheck
RUN npm prune --omit=dev

# Drop privileges: the previous image ran as root.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SIGNALING_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
