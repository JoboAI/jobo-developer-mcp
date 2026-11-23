FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENV JOBO_API_URL=https://connect.jobo.world
# The public base URL: it goes into the Server Card and into the setup snippet a
# lookup prints when the API key is missing. No OAuth here, so unlike the
# job-search server this is not an audience, only an address.
ENV MCP_PUBLIC_URL=https://dev-mcp.jobo.world
ENV PORT=3003

EXPOSE 3003

CMD ["node", "dist/index.js"]
