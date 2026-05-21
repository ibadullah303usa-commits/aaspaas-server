FROM node:18
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-noto-core \
    libvips-dev
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
