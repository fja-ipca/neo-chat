FROM node:20-slim

WORKDIR /app

# Instalar dependências primeiro para cache do Docker
COPY package*.json ./
RUN npm install

# Copiar os restantes ficheiros
COPY . .

# Fazer o build do frontend Vite e do backend esbuild
RUN npm run build

# O porto a expor
EXPOSE 3000

ENV NODE_ENV=production

# Executar a aplicação
CMD ["npm", "run", "start"]
