cmake_minimum_required(VERSION 3.18)
project(n64_jit_spike)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
	set(CMAKE_BUILD_TYPE Release)
endif()

# Reuse the already-checked-out Play--CodeGen (Jitter) + Framework deps from
# the PSX/PS2 JIT work instead of vendoring a copy - same host tree this
# project already builds against for the shipping PS2/PSX cores.
set(PLAY_ROOT "$ENV{HOME}/play-build/Play-")

add_subdirectory(${PLAY_ROOT}/deps/CodeGen ${CMAKE_CURRENT_BINARY_DIR}/CodeGen)

add_executable(test_vr4300_jit
	vr4300_play_backend.cpp
	test_vr4300_jit.cpp
)
target_include_directories(test_vr4300_jit PRIVATE ${PLAY_ROOT}/deps/CodeGen/include)
target_link_libraries(test_vr4300_jit PRIVATE CodeGen)
