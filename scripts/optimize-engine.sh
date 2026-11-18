#!/bin/sh
# Runs the engine's WASM through Binaryen. The engine uses legacy WebAssembly exceptions and has no
# target-features section, so its features are named here; Binaryen only uses features it is given.
# -O4 is Binaryen's strongest speed level; -g keeps function names for readable traces, since speed matters more than size.
set -eu
wasm=${1:?usage: optimize-engine.sh path/to/archive_engine.wasm}
command -v wasm-opt >/dev/null 2>&1 || { echo 'wasm-opt (Binaryen) is required: brew install binaryen' >&2; exit 1; }
wasm-opt -O4 -g \
 --enable-exception-handling --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
 "$wasm" -o "$wasm.opt"
mv "$wasm.opt" "$wasm"
