# The kitties gateway as a server: the binary with the web interface inside, and the docker
# client it uses to run each kitty's container. Build from the repository root:
#   docker build -f docker/gateway/Dockerfile -t kitties .

# The page and the binary are built on the builder's own platform, whatever the image is for:
# the page is the same everywhere, and Go cross-compiles. Under emulation (arm64 on an amd64
# runner) npm could hang for the whole job.
FROM --platform=$BUILDPLATFORM node:24-alpine AS page
WORKDIR /src/desktop/frontend
COPY desktop/frontend/package.json desktop/frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY desktop/frontend/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS binary
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
COPY configs ./configs
COPY souls ./souls
RUN mkdir -p internal/web/dist && find internal/web/dist -mindepth 1 ! -name placeholder.txt -delete
COPY --from=page /src/desktop/frontend/dist/ internal/web/dist/
ARG VERSION=dev
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/kitties ./cmd/kitties

FROM alpine:3.23
# docker-cli: the gateway starts a container per kitty through the host's docker socket.
RUN apk add --no-cache docker-cli ca-certificates tzdata \
 && adduser -D -u 10001 kitties
COPY --from=binary /out/kitties /usr/local/bin/kitties
ENV KITTIES_DATA_DIR=/var/lib/kitties \
    KITTIES_LISTEN=0.0.0.0:7488
VOLUME /var/lib/kitties
EXPOSE 7488
# Not root, except to reach the docker socket: compose adds the socket's group (see deploy/).
USER kitties
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:7488/v1/health >/dev/null || exit 1
ENTRYPOINT ["kitties"]
CMD ["gateway"]
