# Build from the repo root:  docker build -f server/Dockerfile -t foglink .
FROM node:22-alpine AS web
WORKDIR /app
COPY data/roads data/roads
COPY sim/package.json sim/package-lock.json sim/
RUN cd sim && npm ci
COPY sim sim
RUN cd sim && npm run build

FROM golang:1.23-alpine AS relay
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/*.go ./
RUN CGO_ENABLED=0 go build -o /foglink-relay .

FROM gcr.io/distroless/static-debian12
COPY --from=relay /foglink-relay /foglink-relay
COPY --from=web /app/sim/dist /web
ENV FOGLINK_STATIC=/web
EXPOSE 8080
ENTRYPOINT ["/foglink-relay"]
