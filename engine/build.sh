#!/bin/sh
set -eu
cd "$(dirname "$0")"
python3 ../scripts/verify-local-sources.py
python3 ../scripts/vendor-libarchive.py --fetch --notices
export RUSTC="$(rustup which rustc)"
export RUSTFLAGS="--remap-path-prefix=$HOME=/workspace"
cargo rustc --locked --release --target wasm32-unknown-emscripten --bin archive-engine -- \
 -C link-arg=-sMODULARIZE=1 -C link-arg=-sEXPORT_ES6=1 \
 -C link-arg=-sEXPORT_NAME=createArchiveModule -C link-arg=-sALLOW_MEMORY_GROWTH=1 \
 -C link-arg=-sINITIAL_MEMORY=67108864 -C link-arg=-sSTACK_SIZE=16777216 -C link-arg=-g2 -C link-arg=-sSTACK_OVERFLOW_CHECK=2 -C link-arg=-sMAXIMUM_MEMORY=1073741824 \
 -C 'link-arg=-sEXPORTED_FUNCTIONS=[_main,_engine_run,_engine_free,_engine_heap_bytes,_malloc,_free]' \
 -C 'link-arg=-sEXPORTED_RUNTIME_METHODS=[ccall,FS,WORKERFS,UTF8ToString]' \
 -C link-arg=-lworkerfs.js
mkdir -p ../public/engine
cp target/wasm32-unknown-emscripten/release/archive-engine.js ../public/engine/archive-engine.js
cp target/wasm32-unknown-emscripten/release/archive_engine.wasm ../public/engine/archive_engine.wasm
sh ../scripts/optimize-engine.sh ../public/engine/archive_engine.wasm
