FROM node:20-alpine

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

# Executar a aplicação
CMD ["npm", "run", "start"]
