.DEFAULT_GOAL := check
.PHONY: check test build dev e2e
check:
	pnpm check
test:
	pnpm test
build:
	pnpm build
dev:
	pnpm dev
e2e:
	pnpm --filter @kitties/web e2e
