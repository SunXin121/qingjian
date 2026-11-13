.PHONY: build web server dev-server dev-web test lint clean

build: web server

web:
	cd web && npm ci --no-audit --no-fund && npm run build

server:
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$$(git describe --tags --always --dirty 2>/dev/null || echo dev)" -o bin/qingjian ./cmd/qingjian

# 开发：终端 1 运行 make dev-server，终端 2 运行 make dev-web，然后打开 http://localhost:5173
dev-server:
	QINGJIAN_ADMIN_PASSWORD=$${QINGJIAN_ADMIN_PASSWORD:-dev} QINGJIAN_DATA=./data go run ./cmd/qingjian

dev-web:
	cd web && npm run copy-assets && npm run dev

test:
	go test ./cmd/... ./internal/... ./web
	cd web && npm test

lint:
	test -z "$$(gofmt -l cmd internal)"
	go vet ./cmd/... ./internal/... ./web
	cd web && npm run typecheck && npm run lint

clean:
	rm -rf bin web/dist/assets web/dist/index.html web/dist/excalidraw-assets
