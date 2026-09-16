FROM node:25.6.0-slim

RUN apt update && apt install -y ffmpeg procps curl

WORKDIR /home/node/app

USER node

CMD [ "npm", "run", "start:worker" ]
