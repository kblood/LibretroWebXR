# LWX PSX Test Disc -- PSn00bSDK CMake build (mirrors the SDK's own
# template project; see /opt/psn00bsdk/share/psn00bsdk/template inside the
# luksamuk/psxtoolchain Docker image this is built with).
cmake_minimum_required(VERSION 3.21)

project(
	LWX-PSX-TestDisc
	LANGUAGES    C ASM
	VERSION      1.0.0
	DESCRIPTION  "LWX PSX Test Disc -- CC0 PSn00bSDK homebrew for LibretroWebXR"
)

psn00bsdk_add_executable(psxtest GPREL main.c)

psn00bsdk_add_cd_image(
	iso      # Target name
	psxtest  # Output file name (= psxtest.bin + psxtest.cue)
	iso.xml  # Path to config file
	DEPENDS psxtest system.cnf
)
