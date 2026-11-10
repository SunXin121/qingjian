# syntax=docker/dockerfile:1
# Build stages run on the native build platform and cross-compile, so multi-arch
# images don't need to emulate npm / go under QEMU.

# ---- frontend (architecture independent) ----
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- backend (embeds the frontend) ----
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS server
ARG TARGETOS TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY web/embed.go ./web/embed.go
COPY --from=web /src/web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/qingjian ./cmd/qingjian

# ---- runtime ----
FROM alpine:3.22
RUN apk add --no-cache tzdata ca-certificates
ENV TZ=Asia/Shanghai \
    QINGJIAN_ADDR=:8080 \
    QINGJIAN_DATA=/data
COPY --from=server /out/qingjian /usr/local/bin/qingjian
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["qingjian"]
