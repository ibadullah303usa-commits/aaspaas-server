FROM node:18
RUN apt-get install -y ffmpeg fonts-noto-core fonts-noto-extra
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
