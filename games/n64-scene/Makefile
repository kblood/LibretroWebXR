BUILD_DIR = build
include $(N64_INST)/include/n64.mk

all: lwx-n64-scene.z64

$(BUILD_DIR)/lwx-n64-scene.elf: $(BUILD_DIR)/main.o
lwx-n64-scene.z64: N64_ROM_TITLE = "LWX N64 Orbit Cubes"

clean:
	rm -rf $(BUILD_DIR) lwx-n64-scene.z64

.PHONY: all clean
