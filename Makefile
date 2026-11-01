# kitties: build, verification and cross-compilation.
#
# VERSION can be overridden: make VERSION=v1.0.0 dist
VERSION  ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
# OAUTH_APPS are the apps the connections sign in through when the person has none of their
# own: "spotify=<client id>,facebook=<id>:<secret>,..." (see internal/oauth: Builtin).
OAUTH_APPS ?=
# UPDATE_PUBKEY is the public key the releases are signed with (kitties release-key makes the pair):
# a gateway built with it only installs an update whose SHA256SUMS are signed by it.
UPDATE_PUBKEY ?=
LDFLAGS  := -s -w -X main.version=$(VERSION) -X 'github.com/madkoding/kitties/internal/oauth.builtin=$(OAUTH_APPS)' -X 'github.com/madkoding/kitties/internal/selfupdate.builtinKey=$(UPDATE_PUBKEY)'
GO       ?= go
DIST     := dist
PKGS     := ./internal/... ./cmd/...
# WEB=0 builds without the web interface inside (no Node needed): the gateway then serves its
# small built-in page.
WEB      ?= 1
IMAGE    ?= ghcr.io/madkoding/kitty-desktop:latest

# Every platform the binary is built for. Android (arm64) runs the CLI and the gateway under
# Termux; the containers live wherever Docker does.
PLATFORMS := linux/amd64 linux/arm64 linux/arm android/arm64 \
             windows/amd64 windows/arm64 darwin/amd64 darwin/arm64

.DEFAULT_GOAL := help
.PHONY: help build dist test vet fmt fmt-check check image run clean frontend web desktop desktop-check e2e demo android

help: ## Show this list of commands
	@printf '\nkitties: what you can run here\n\n'
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@printf '\n'

build: $(if $(filter 1,$(WEB)),web) ## Build kitties for this computer (result: dist/kitties)
	@mkdir -p $(DIST)
	@$(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(DIST)/kitties ./cmd/kitties && echo "built $(DIST)/kitties ($(VERSION))"

dist: $(if $(filter 1,$(WEB)),web) ## Build kitties for every supported system
	@mkdir -p $(DIST)
	@for p in $(PLATFORMS); do \
		os=$${p%/*}; arch=$${p#*/}; ext=""; \
		[ "$$os" = "windows" ] && ext=".exe"; \
		GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" \
			-o $(DIST)/kitties-$$os-$$arch$$ext ./cmd/kitties || exit 1; \
		printf '  %-16s ok\n' "$$os/$$arch"; \
	done

test: ## Run the tests with the race detector
	@$(GO) test -count=1 -race $(PKGS)

vet: ## Static analysis
	@$(GO) vet ./...

fmt: ## Format the Go files
	@gofmt -w -l .

fmt-check: ## Fail if any Go file is unformatted
	@out="$$(gofmt -l .)"; if [ -n "$$out" ]; then echo "unformatted:"; echo "$$out"; exit 1; fi

check: fmt-check vet test ## Everything CI checks, in one go

frontend: ## Build the desktop app's page (desktop/frontend/dist)
	@cd desktop/frontend && npm ci --no-audit --no-fund && npm run typecheck && npm run build

web: frontend ## Copy the built page into the binary's embed folder (the web interface of the gateway)
	@find internal/web/dist -mindepth 1 ! -name placeholder.txt -delete
	@cp -r desktop/frontend/dist/. internal/web/dist/
	@echo "web interface ready in internal/web/dist"

desktop-check: frontend ## Vet and test the Wails app (needs the page built)
	@cd desktop && $(GO) vet ./... && $(GO) test -count=1 ./...

e2e: frontend ## Drive the desktop app end to end in a browser and rewrite docs/screenshots
	@cd desktop/frontend && npm run e2e

android: frontend ## Build the Android app (android/app/build/outputs/apk/release), with the Android SDK
	@cd android && ./gradlew --no-daemon assembleRelease

desktop: frontend ## Build the native app with the Wails CLI (wails build)
	@cd desktop && wails build

demo: build ## Try the interface with no key and no Docker (a scripted brain, a drawn desktop)
	@$(DIST)/kitties -demo gateway

image: ## Build the kitty-desktop container image (Xvfb + browser)
	@docker build -t $(IMAGE) -f docker/kitty-desktop/Dockerfile .

run: build ## Start the gateway with the local kitties.yaml
	@$(DIST)/kitties gateway

clean: ## Remove the build output
	@rm -rf $(DIST)
