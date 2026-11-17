cmake_minimum_required(VERSION 3.16)
project(archive_tar_core C)
if(NOT DEFINED LIBARCHIVE_SOURCE)
  message(FATAL_ERROR "LIBARCHIVE_SOURCE must name the verified source cache")
endif()
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
foreach(option OPENSSL MD LIBB2 LZ4 LZO LZMA ZSTD ZLIB BZip2 LIBXML2 BSDXML EXPAT WIN32_XMLLITE PCREPOSIX PCRE2POSIX LIBGCC CNG MBEDTLS NETTLE TAR CPIO CAT UNZIP XATTR ACL ICONV TEST COVERAGE INSTALL)
  set(ENABLE_${option} OFF CACHE BOOL "" FORCE)
endforeach()
add_subdirectory("${LIBARCHIVE_SOURCE}" upstream EXCLUDE_FROM_ALL)
# Only upstream source objects use the job allocator. The shim itself uses libc.
target_compile_definitions(archive_static PRIVATE ARCHIVE_TAR_BUDGET_REMAP)
target_compile_options(archive_static PRIVATE -include "${CMAKE_CURRENT_SOURCE_DIR}/budget.h")
add_library(archive_tar_bridge OBJECT bridge.c budget.c)
target_include_directories(archive_tar_bridge PRIVATE "${LIBARCHIVE_SOURCE}/libarchive")
set_property(TARGET archive_tar_bridge PROPERTY C_STANDARD 11)
set_property(TARGET archive_tar_bridge PROPERTY POSITION_INDEPENDENT_CODE ON)
target_sources(archive_static PRIVATE $<TARGET_OBJECTS:archive_tar_bridge>)
set_property(TARGET archive_static PROPERTY POSITION_INDEPENDENT_CODE ON)
set_target_properties(archive_static PROPERTIES ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")
# C paths are independent of Rust's remap flags, including __FILE__ strings.
if(NOT CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  message(FATAL_ERROR "TAR build requires a compiler supporting neutral path maps")
endif()
foreach(target archive_static archive_tar_bridge)
  target_compile_options(${target} PRIVATE
    "-ffile-prefix-map=${LIBARCHIVE_SOURCE}=/vendor/libarchive"
    "-fdebug-prefix-map=${LIBARCHIVE_SOURCE}=/vendor/libarchive"
    "-ffile-prefix-map=${CMAKE_CURRENT_SOURCE_DIR}=/workspace/engine/libarchive"
    "-fdebug-prefix-map=${CMAKE_CURRENT_SOURCE_DIR}=/workspace/engine/libarchive"
    "-ffile-prefix-map=${CMAKE_BINARY_DIR}=/build"
    "-fdebug-prefix-map=${CMAKE_BINARY_DIR}=/build")
endforeach()
