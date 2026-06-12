PROTO_DIR := ../../proto
PROTO_FILE := $(PROTO_DIR)/meridian.proto
OUT_DIR := meridian/proto

.PHONY: proto test install clean

# Generate gRPC stubs from the shared contract into meridian/proto/.
proto:
	mkdir -p $(OUT_DIR)
	touch $(OUT_DIR)/__init__.py
	python -m grpc_tools.protoc \
		-I$(PROTO_DIR) \
		--python_out=$(OUT_DIR) \
		--grpc_python_out=$(OUT_DIR) \
		$(PROTO_FILE)
	# Rewrite the generated absolute import to a package-relative one so the
	# stubs import cleanly as meridian.proto.*
	sed -i 's/^import meridian_pb2 as/from . import meridian_pb2 as/' \
		$(OUT_DIR)/meridian_pb2_grpc.py

install:
	pip install -e .[dev]

test:
	pytest

clean:
	rm -rf $(OUT_DIR)/meridian_pb2.py $(OUT_DIR)/meridian_pb2_grpc.py
