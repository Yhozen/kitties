FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS page
WORKDIR /src/desktop/frontend
COPY desktop/frontend/package.json desktop/frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY desktop/frontend/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.26-alpine@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS binary
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
COPY configs ./configs
COPY souls ./souls
COPY --from=page /src/desktop/frontend/dist/ internal/web/dist/
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build -trimpath -ldflags "-s -w" -o /out/kitties ./cmd/kitties

FROM alpine:3.23@sha256:ff7f0c727dd796aa36787bfcd9a64bf35a6ce72a73451b3359fde849b6703d63
RUN apk add --no-cache ca-certificates openssh-client restic tzdata zstd \
 && adduser -D -u 10001 kitties \
 && mkdir -p /var/lib/kitties /etc/kitties \
 && chown kitties:kitties /var/lib/kitties
COPY --from=binary /out/kitties /usr/local/bin/kitties
COPY deploy/cloudflare/default.yaml /etc/kitties/default.yaml
ARG KITTIES_IMAGE_REVISION=5
LABEL org.opencontainers.image.revision=$KITTIES_IMAGE_REVISION
USER kitties
EXPOSE 7488
ENTRYPOINT ["kitties", "gateway"]
