# Engine dependency notices

This engine uses local archive, recovery and streaming codec crates and their transitive dependencies. This table includes the resolved build graph; target-specific build dependencies may not appear in the browser binary. Complete license texts are in `licenses/`.

RAR reading and recovery use unrar-rs, distributed under Apache-2.0 plus the unRAR restriction. The RAR engine is not used to create RAR archives. See its complete LICENSE.

Standalone BZip2 uses bzip2-turbo, whose codec is LGPL-2.1-or-later and compatibility adapters MIT. Standalone LZMA/XZ use lzma-turbo. Local dependencies remain separate source packages; the build script and source are provided for rebuilding the browser engine.

| Package | Version | Declared license |
| --- | --- | --- |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| aes | 0.9.4 | MIT OR Apache-2.0 |
| alloc-no-stdlib | 3.0.0 | BSD-3-Clause |
| alloc-stdlib | 0.3.0 | BSD-3-Clause |
| ambient-authority | 0.0.2 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| arrayvec | 0.7.8 | MIT OR Apache-2.0 |
| autocfg | 1.5.1 | Apache-2.0 OR MIT |
| bitflags | 2.13.2 | MIT OR Apache-2.0 |
| blake2s_simd | 1.0.5 | MIT |
| blake3 | 1.8.7 | CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception |
| block-buffer | 0.12.1 | MIT OR Apache-2.0 |
| block-padding | 0.4.2 | MIT OR Apache-2.0 |
| brotli | 9.1.3 | BSD-3-Clause AND MIT |
| brotli-decompressor | 6.3.2 | BSD-3-Clause/MIT |
| bumpalo | 3.20.4 | MIT OR Apache-2.0 |
| bytes | 1.12.1 | MIT |
| bzip2 | 0.6.1 | MIT OR Apache-2.0 |
| bzip2-turbo | 0.2.1 | LGPL-2.1-or-later AND MIT |
| cap-primitives | 4.0.3 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| cap-std | 4.0.3 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| cbc | 0.2.1 | MIT OR Apache-2.0 |
| cc | 1.11.2 | MIT OR Apache-2.0 |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 |
| cipher | 0.5.2 | MIT OR Apache-2.0 |
| cmov | 0.5.4 | Apache-2.0 OR MIT |
| constant_time_eq | 0.4.2 | CC0-1.0 OR MIT-0 OR Apache-2.0 |
| cpubits | 0.1.1 | MIT OR Apache-2.0 |
| cpufeatures | 0.3.1 | MIT OR Apache-2.0 |
| crc-turbo | 1.11.0 | (MIT OR Apache-2.0) AND Zlib |
| crc32fast | 1.5.5 | MIT OR Apache-2.0 |
| crossbeam-deque | 0.8.8 | MIT OR Apache-2.0 |
| crossbeam-epoch | 0.9.21 | MIT OR Apache-2.0 |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 |
| crypto-common | 0.2.2 | MIT OR Apache-2.0 |
| ctutils | 0.4.8 | Apache-2.0 OR MIT |
| digest | 0.10.7 | MIT OR Apache-2.0 |
| digest | 0.11.3 | MIT OR Apache-2.0 |
| either | 1.19.0 | MIT OR Apache-2.0 |
| errno | 0.3.15 | MIT OR Apache-2.0 |
| fastrand | 2.5.0 | Apache-2.0 OR MIT |
| filetime | 0.2.29 | MIT/Apache-2.0 |
| find-msvc-tools | 0.1.15 | MIT OR Apache-2.0 |
| flate2 | 1.1.11 | MIT OR Apache-2.0 |
| fs-set-times | 0.20.3 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| futures-core | 0.3.34 | MIT OR Apache-2.0 |
| futures-task | 0.3.34 | MIT OR Apache-2.0 |
| futures-util | 0.3.34 | MIT OR Apache-2.0 |
| generic-array | 0.14.7 | MIT |
| getrandom | 0.4.3 | MIT OR Apache-2.0 |
| hmac | 0.13.0 | MIT OR Apache-2.0 |
| hybrid-array | 0.4.15 | MIT OR Apache-2.0 |
| inout | 0.2.6 | MIT OR Apache-2.0 |
| io-extras | 0.19.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| io-lifetimes | 2.0.4 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| io-lifetimes | 3.0.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| ipnet | 2.12.2 | MIT OR Apache-2.0 |
| itoa | 1.0.19 | MIT OR Apache-2.0 |
| jobserver | 0.1.35 | MIT OR Apache-2.0 |
| js-sys | 0.3.107 | MIT OR Apache-2.0 |
| libbz2-rs-sys | 0.2.6 | bzip2-1.0.6 |
| libc | 0.2.191 | MIT OR Apache-2.0 |
| linux-raw-sys | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| lz4_flex | 0.14.2 | MIT |
| lzma-turbo | 0.10.3 | Apache-2.0 |
| lzma-turbo | 0.12.0 | Apache-2.0 |
| maybe-owned | 0.3.4 | MIT OR Apache-2.0 |
| md-5 | 0.11.0 | MIT OR Apache-2.0 |
| memchr | 2.8.3 | Unlicense OR MIT |
| memmap2 | 0.9.12 | MIT OR Apache-2.0 |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 |
| num-traits | 0.2.19 | MIT OR Apache-2.0 |
| once_cell | 1.21.4 | MIT OR Apache-2.0 |
| par2-rs | 0.12.1 | Apache-2.0 |
| par3-rs | 0.8.3 | Apache-2.0 |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT |
| pkg-config | 0.3.34 | MIT OR Apache-2.0 |
| ppmd-turbo | 0.2.2 | Apache-2.0 |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 |
| quote | 1.0.47 | MIT OR Apache-2.0 |
| r-efi | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later |
| rayon | 1.12.0 | MIT OR Apache-2.0 |
| rayon-core | 1.13.0 | MIT OR Apache-2.0 |
| reedsolomon-rs | 0.4.11 | Apache-2.0 |
| rmp | 0.8.15 | MIT |
| rmp-serde | 1.3.1 | MIT |
| rustix | 1.1.6 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| rustix-linux-procfs | 0.1.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| rustversion | 1.0.23 | MIT OR Apache-2.0 |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde_core | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 |
| serde_json | 1.0.154 | MIT OR Apache-2.0 |
| sevenz-turbo | 0.29.0 | Apache-2.0 |
| sha2 | 0.11.1 | MIT OR Apache-2.0 |
| shlex | 2.0.1 | MIT OR Apache-2.0 |
| simd-adler32 | 0.3.10 | MIT |
| slab | 0.4.12 | MIT |
| spin | 0.10.1 | MIT |
| subtle | 2.6.1 | BSD-3-Clause |
| syn | 2.0.119 | MIT OR Apache-2.0 |
| syn | 3.0.10 | MIT OR Apache-2.0 |
| tempfile | 3.27.0 | MIT OR Apache-2.0 |
| thiserror | 2.0.21 | MIT OR Apache-2.0 |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 |
| tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT |
| tracing | 0.1.44 | MIT |
| tracing-core | 0.1.36 | MIT |
| twox-hash | 2.1.5 | MIT |
| typenum | 1.20.1 | MIT OR Apache-2.0 |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| unicode-normalization | 0.1.26 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| unrar-rs | 0.16.4 | See license file |
| version_check | 0.9.5 | MIT/Apache-2.0 |
| wasm-bindgen | 0.2.130 | MIT OR Apache-2.0 |
| wasm-bindgen-macro | 0.2.130 | MIT OR Apache-2.0 |
| wasm-bindgen-macro-support | 0.2.130 | MIT OR Apache-2.0 |
| wasm-bindgen-shared | 0.2.130 | MIT OR Apache-2.0 |
| windows-link | 0.2.1 | MIT OR Apache-2.0 |
| windows-sys | 0.59.0 | MIT OR Apache-2.0 |
| windows-sys | 0.60.2 | MIT OR Apache-2.0 |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 |
| windows-targets | 0.52.6 | MIT OR Apache-2.0 |
| windows-targets | 0.53.5 | MIT OR Apache-2.0 |
| windows_aarch64_gnullvm | 0.52.6 | MIT OR Apache-2.0 |
| windows_aarch64_gnullvm | 0.53.1 | MIT OR Apache-2.0 |
| windows_aarch64_msvc | 0.52.6 | MIT OR Apache-2.0 |
| windows_aarch64_msvc | 0.53.1 | MIT OR Apache-2.0 |
| windows_i686_gnu | 0.52.6 | MIT OR Apache-2.0 |
| windows_i686_gnu | 0.53.1 | MIT OR Apache-2.0 |
| windows_i686_gnullvm | 0.52.6 | MIT OR Apache-2.0 |
| windows_i686_gnullvm | 0.53.1 | MIT OR Apache-2.0 |
| windows_i686_msvc | 0.52.6 | MIT OR Apache-2.0 |
| windows_i686_msvc | 0.53.1 | MIT OR Apache-2.0 |
| windows_x86_64_gnu | 0.52.6 | MIT OR Apache-2.0 |
| windows_x86_64_gnu | 0.53.1 | MIT OR Apache-2.0 |
| windows_x86_64_gnullvm | 0.52.6 | MIT OR Apache-2.0 |
| windows_x86_64_gnullvm | 0.53.1 | MIT OR Apache-2.0 |
| windows_x86_64_msvc | 0.52.6 | MIT OR Apache-2.0 |
| windows_x86_64_msvc | 0.53.1 | MIT OR Apache-2.0 |
| winx | 0.36.4 | Apache-2.0 WITH LLVM-exception |
| zeroize | 1.9.1 | Apache-2.0 OR MIT |
| zeroize_derive | 1.5.0 | Apache-2.0 OR MIT |
| zlib-rs | 0.6.8 | Zlib |
| zmij | 1.0.23 | MIT |
| zstd | 0.14.4 | BSD-3-Clause |
| zstd-safe | 8.3.0 | BSD-3-Clause |
| zstd-sys | 2.1.3+zstd.1.5.7 | BSD-3-Clause AND BSD-2-Clause |
