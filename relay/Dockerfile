FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["npx", "tsx", "src/index.ts"]
