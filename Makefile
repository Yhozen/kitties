.DEFAULT_GOAL := check
.PHONY: check build dev
check:
	pnpm check
build:
	pnpm build
dev:
	pnpm dev
