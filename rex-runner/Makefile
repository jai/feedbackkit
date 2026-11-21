BIN := rex-runner
INSTALL_DIR ?= $(HOME)/.local/bin

.PHONY: build test fmt vet install clean

build:
	go build -o bin/$(BIN) ./cmd/rex-runner

test:
	go test -race -count=1 ./...

fmt:
	gofmt -w .

vet:
	go vet ./...

install: build
	mkdir -p $(INSTALL_DIR)
	install -m 0755 bin/$(BIN) $(INSTALL_DIR)/$(BIN)

clean:
	rm -rf bin
