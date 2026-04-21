FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV NOVA_MANAGED_BACKEND=1
ENV PORT=10000

EXPOSE 10000

CMD ["npm", "start"]
