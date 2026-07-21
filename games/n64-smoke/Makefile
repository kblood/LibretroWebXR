BUILD_DIR = build
include $(N64_INST)/include/n64.mk

all: lwx-n64-smoke.z64

$(BUILD_DIR)/lwx-n64-smoke.elf: $(BUILD_DIR)/main.o
lwx-n64-smoke.z64: N64_ROM_TITLE = "LWX N64 Smoke"

clean:
	rm -rf $(BUILD_DIR) lwx-n64-smoke.z64

.PHONY: all clean
