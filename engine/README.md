# Local archive engine

Build with `sh engine/build.sh` from the application root, after preparing the exact adjacent sources below. No sibling source is modified by the build. The engine uses `--locked`; its separate stream-codec path dependencies remain explicit in `Cargo.toml`.

The 7z library uses the published registry package `sevenz-turbo =0.30.3`, not a Git source or adjacent checkout. `Cargo.lock` records registry checksums and the separate transitive LZMA/BZip2 versions. Changing those sources or versions is outside the local bootstrap workflow.

## Reproduce the local build

Prerequisites: Node.js 22.18 or newer, Python 3.11 or newer, Rust **1.97.1** with `wasm32-unknown-emscripten`, a C compiler, CMake, Emscripten and `patch`. The tested native toolchain used Emscripten **7.0.0-git**, CMake **4.3.2** and Python **3.15.2**. These describe the existing environment; the build does not install or upgrade tools. Different toolchain versions can change output bytes. Ensure `rustc --version` reports 1.97.1 and `emcc --version` identifies the intended Emscripten before building; the script uses the active Rustup compiler rather than installing a toolchain.

Use a fresh parent directory containing this application as `archive` and sibling `rarpar`, `lzma-turbo` and `bzip2-turbo` directories. Never overwrite or reset an existing sibling. First follow [the RAR source bootstrap](unrar-source/README.md): it checks out the recorded base and applies the exact required patch without changing dependency sources. For the other two siblings, use the repository URLs and exact commits in `local-sources.json`. For example, from the application root with neither sibling present:

```sh
python3 - <<'PREPARE'
import json, pathlib, subprocess
manifest = json.loads(pathlib.Path('engine/local-sources.json').read_text())
repos = [repo for repo in manifest['repositories'] if repo['name'] != 'rarpar']
for repo in repos:
    target = pathlib.Path('..') / repo['name']
    if target.exists() or target.is_symlink():
        raise SystemExit('Refusing an existing sibling; use a fresh parent directory')
for repo in repos:
    target = pathlib.Path('..') / repo['name']
    subprocess.run(['git', 'clone', '--no-checkout', repo['url'], str(target)], check=True)
    subprocess.run(['git', '-C', str(target), 'checkout', '--detach', repo['commit']], check=True)
PREPARE
python3 scripts/verify-local-sources.py
python3 scripts/verify-unrar-source.py
sh engine/build.sh
npm ci
npm run check
npm run build
```

The all-local-source preflight checks six crates, including transitive `reedsolomon-rs`, their production source trees, package/build/license files and workspace manifests. It refuses drift and unrecorded local dependencies. The original RAR patch proof remains separately enforced. Tests and repository configuration are outside this source inventory; it is not a claim of a hermetic or bit-identical build on arbitrary machines. Cargo rerun tracking includes the source directories so additions also invalidate verification.

`engine/build.sh` explicitly downloads the size/SHA-256-verified libarchive source if missing, applies the hash-pinned adapters, and writes license notices. Cargo alone is cache-only: prepare the vendor source first with `python3 scripts/vendor-libarchive.py --fetch --notices`. No preparation step modifies sibling files. Existing local sources must pass both preflights; do not bypass them or automatically refresh hashes to accept unrelated edits.

From the application root, the routine native source checks are:

```sh
cargo fmt --manifest-path engine/Cargo.toml --check
cargo clippy --locked --manifest-path engine/Cargo.toml --all-targets --all-features -- -D warnings
cargo nextest run --locked --manifest-path engine/Cargo.toml --no-fail-fast
node tests/tar-native-library.mjs
```

The last command exercises the generated runtime in Node and uses Python for independent small-fixture decoding. Browser integration harnesses are separate, explicitly launched checks; they are not run by `npm test`. Native tests require the verified sibling and vendor sources, and Nextest must already be installed.

The Emscripten binary exposes `engine_run(JSON C string)`, `engine_free(result pointer)`, and `engine_heap_bytes()`. Paths refer to the worker filesystem. Results are JSON with entries, status, complete, message, or error. The TypeScript client owns workers and returns disk-backed output Blobs. `engine_heap_bytes` measures committed WebAssembly linear memory, not total browser memory.

## Archive and parity operations

- 7z: read/extract/create, AES-256 encrypted headers, solid creation, preserved relative paths. Creation codecs: Copy, LZMA, LZMA2, PPMd, BZip2, Zstandard, Brotli, LZ4 and DEFLATE. Filters: Delta, x86 BCJ, BCJ2, ARM, ARM64, Thumb, IA64, SPARC, PowerPC and RISC-V. Named crate constants without implemented codec dispatch, such as DEFLATE64, are not advertised as working codecs.
- RAR: reading/extraction including supported old formats, encrypted archives, solid sets, multipart sets and self-extracting wrappers; recovery-record and REV repair. RAR writing is unavailable under the unRAR restriction.
- PAR2: create, inspect through verification, verify and repair. Creation supports block size, recovery percentage/count, first exponent, and variable/uniform/limited recovery volumes.
- PAR3: new set creation and new 7z PAR3 sidecars are disabled at both application and native request boundaries. Reading, verification and repair retain the crate's existing input compatibility, including Cauchy and FFT sets.
- Existing PAR3 embedded archives can be inspected, verified, repaired or stripped through explicit compatibility operations. New embedded PAR3 protection is disabled along with new PAR3 set creation.
- Existing recovery carriers can still be restored through the explicit `rebuildParity` compatibility operation. Exact restoration needs a complete captured authenticated packet layout. An explicitly requested replacement is labeled `Replacement`, never claimed byte-exact restoration of an unknown original carrier.

Ordinary JSON operations are `list`, `extract`, `create`, `verify` and `repair`. Archive/parity `create` takes `format: 7z | par2`; standalone stream formats are described below. 7z creation accepts `protection: par2` to return the archive and its sidecars in one job. PAR3 inspect/verify/repair auto-detect selected `.par3` carriers. Compatibility operations are `verifyEmbedded`, `repairEmbedded`, `removeEmbedded`, and `rebuildParity`. Replacement is opt-in with `replacement: true`.

## Per-file creation plans

The application creation API accepts `fileOptions: [{name, codec, filter, level, dictionarySize, deltaDistance}]`. Names are the exact selected relative file paths; unknown or duplicate names fail before output starts. ZIP supports per-entry Store (`copy`) and DEFLATE, with DEFLATE levels 0–9. ZIP output remains sequential and supports the existing browser-download sink. Passwords remain archive-wide AES-256; ZIP has no header-encryption option.

Native 7z creation accepts the advertised codecs and filters for each file. With `solid: true`, only consecutive files with identical effective encoding plans share a block; changing a codec, filter, dictionary, level or Delta distance closes the previous group. Paths and source order are preserved. LZMA/LZMA2 levels are 0–9 and dictionaries are 64 KiB–8 MiB, further bounded by one thirty-second of the selected algorithm budget. DEFLATE/PPMd levels are 0–9, BZip2 1–9, Zstandard 1–22 and Brotli 0–11; Copy and LZ4 have no level setting. Dictionary tuning is exclusive to LZMA/LZMA2, and Delta distances 1–256 require the Delta filter. Inapplicable per-file options are rejected. For compatibility, the legacy global `deltaDistance` is ignored unless the global filter is Delta; newly selecting Delta for one file does not inherit an inactive global value. A codec override resets inherited tuning from the previous codec.

7z passwords apply to every file group. `encryptHeaders` defaults to true when a password is supplied and false without one; an explicit false keeps names visible while retaining file encryption. Header encoding uses an explicit archive-wide AES policy instead of inheriting the final file's pipeline. BCJ2 with encryption is refused. Per-file passwords are not supported. Native 7z output remains seekable OPFS output rather than a sequential browser-download writer.

## Standalone streams

Native creation/decompression supports Zstandard (`zstd`), Brotli (`br`), XZ (`xz`), BZip2 (`bz2`), LZMA-Alone (`lzma`), modern LZ4 frames (`lz4`), raw DEFLATE (`deflate`), zlib (`zlib`) and gzip (`gz`). A stream encodes one file. The application wraps multiple files in TAR before compression when a TAR stream is selected. Names preserve the source filename: `archive.tar` becomes `archive.tar.zst`, and decompression restores `archive.tar` for the TAR layer.

Magic detection covers Zstandard, XZ, BZip2, LZ4 frames and gzip. Brotli, LZMA-Alone, raw DEFLATE and zlib require a recognized suffix or explicit format. Stream listing decodes and validates the stream to count its output; it is not just a header probe. All decoded output passes an explicit byte quota before writes. Concatenated XZ, BZip2, Zstandard, gzip and LZ4 frames are supported. Brotli, LZMA-Alone, raw DEFLATE and zlib accept one stream and reject trailing/concatenated input. Truncation and checksum failures are errors. Legacy LZ4 block streams are not accepted by the strict frame validator.

Standalone BZip2 uses bzip2-turbo. XZ and LZMA-Alone use the local lzma-turbo stream APIs. XZ writes bounded blocks on the browser's single worker; it does not buffer a whole archive in the no-thread writer fallback. LZMA-Alone uses pull input/output callbacks with an explicit size header. The 7z dependency separately retains its compatible lzma-turbo version.

## Storage and memory

Input File objects mount read-only through WORKERFS and are read lazily with seeks. Immutable source reads use 4 MiB aligned windows with an 8 MiB aggregate retained-cache bound, reducing repeated Blob-read lifecycles while preserving exact EOF, partial reads and random seeks. Content-free counters accompany progress and final metrics. Output and repair scratch use an OPFS-backed filesystem with random-access pages, safe rename/unlink, shared hard-link identities and exclusive publication. Returned output Blobs reference slices of its backing File; they do not require a full decoded archive in the WebAssembly heap. The application retains output storage until the client releases it. Cancellation terminates the worker and removes its tracked temporary directory; crashes or forced tab closure can leave site data requiring cleanup.

The engine heap starts at 64 MiB, has a 16 MiB checked stack, and may grow to at most 1 GiB. The selected algorithm memory budget defaults to 256 MiB and accepts 32–512 MiB. PAR2 creation/repair and PAR3 shared allocation accounting use that budget. 7z decoding checks its codec-memory estimate before allocation; RAR bounds its dictionary/model allocation. Budgets are not whole-browser RSS guarantees: metadata, allocator overhead, I/O buffers and browser storage structures also consume memory.

REV uses the crate's fixed 64 MiB striped buffer and requires a selected budget of at least 64 MiB. RAR recovery-record repair retains reconstructed patches; a conservative assessment refuses patch storage above half the selected budget. A large archive with modest damage can be repaired, while heavy damage can require a larger budget. Removing that retained-patch constraint requires a new streaming patch callback API in unrar-rs.

There is no fixed 256 MiB input cap on disk-backed repair. Storage quota and actual allocation availability bound output/scratch. Without OPFS the application uses a bounded MEMFS fallback; that fallback is not suitable for large recovery. Hostile expansion, disk-full conditions and allocation limits must fail visibly. Passing a quota does not guarantee every archive below it can be processed.

Input files for multivolume RAR must be supplied in volume order, first volume first. Supply sidecars together with damaged source files. Repair operates on outputs and does not mutate selected input Files. Archive links, traversal paths, drive prefixes and duplicate normalized extraction paths are rejected. Legitimate RAR backslash separators are normalized before traversal checks.

See NOTICES.md and licenses/ for attribution and redistribution terms. Independent compatibility and browser test coverage is recorded under the application's tests directory.

## Current validation

The final TAR/native cohort passed 43 native tests, strict Clippy, 52 actual generated-runtime TAR cases and 44 separate patched-C proof cases. Browser native-link checks passed 20 operations. The creation aggregate passed 72 application cases; independent decoding covered all 60 positive outputs, with provenance retaining the initial 57 and three subsequent extension-decoder checks. These are recorded cohorts, not an assertion that a future rebuild has already passed.

Real 5 GB RAR, ZIP64 and 7z cases passed the retained exact-byte/hash checks described in the application README and `review-browser.md`. The earlier corrected 100 GB RAR retry crashed near 85.6 GB with a browser file-descriptor error; its evidence remains preserved. After the bounded input-read mitigation, a full Media-volume streamed download completed 100,000,000,000 bytes and independent native readback matched SHA-256 `60d93bc5247247ed89c1fb59f9e6489cc6a32ed853c539123544eaf9c7cfe7c6` and CRC32 `1a9588b7`. Runtime `311d6cf3b840bcc369e2` retained a 64 MiB WASM heap, 8 MiB read cache, and an explicit 200 GiB logical-write allowance; the run recorded 95,392 read calls versus 23,843 backing reads. Source/output identities and cleanup passed. Evidence: archive-100gb-rerun-cache-20261117/run-1794952550580/evidence.json. This establishes that tested full run, not the underlying cause of the earlier Chromium EBADF failure.

## Browser stream backend

Raw stream creation and extraction accept `streamBackend: "auto" | "native" | "wasm"`. Simple creation uses Automatic; Advanced exposes the selector. Support is detected by constructing the requested browser API separately for compression and decompression. GZIP, Zlib and raw Deflate passed real Chromium browser/WASM equivalence checks; this Chromium does not expose Brotli or Zstandard native streams, so Automatic uses WASM for them. XZ, BZip2, LZMA and LZ4 retain WASM. An explicit unavailable Browser choice fails rather than silently changing engines. Explicit compression tuning also selects WASM automatically, or fails clearly when Browser was requested.

Automatic native decompression uses only the ordinary prepared-output transaction. It does not introduce a new full-file stage for direct output: automatic folder/download extraction remains WASM. A browser codec rejection may retry with WASM only after the failed private stage is removed; cancellation, storage errors and source-read failures do not retry. Explicit Browser direct extraction never retries after output begins. Progress phases distinguish a retry, and completion still requires decoder EOF and successful downstream close. TAR.GZ creation packages TAR through the existing prepared path before applying the selected GZIP engine.

The expanded source-browser gate passed 23 cases on native runtime `0c91575453d4257640c2`, including unavailable-native Brotli/Zstandard/XZ/BZip2 fallback. Chromium rejected concatenated GZIP natively; Automatic proved exactly one WASM retry after removing the failed private stage and reproduced both members. Explicit Browser failed without retry. The gate binds source/runtime hashes before and after; a later TAR engine rebuild requires its own integration checks.
