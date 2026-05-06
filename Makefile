# Fink playground — standard repo targets
#
# Build pipeline: wasm-pack (Rust→WASM) + esbuild (TS→JS) → build/
# Dependencies: node deps.mjs (npm + cargo + fink git tag)

.PHONY: deps-check deps-update deps-install clean build dev test release

deps-check:
	node deps.mjs check

deps-update:
	node deps.mjs update

deps-install:
	node deps.mjs install

clean:
	rm -rf build crate/pkg src/fink.js

build:
	NODE_ENV=production node build.mjs

dev:
	node build.mjs && npx servor build index.html 3000 --reload

test:
	@echo "no tests yet"

release:
	tar -czf playground.tar.gz -C build .
	npx semantic-release
