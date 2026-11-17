# Required local RAR reader source

The application retains its existing relative `unrar-rs` path dependency. This
bundle reconstructs the required local source without substituting a dependency
source, modifying a dirty checkout, or publishing a crate.

Base commit: `be8e5aceff738bd618a540143def08b3e745aae1`.
Patch SHA-256: `c282c07e26827a4bdbd5cacf390b598631266f5aedc614ce71d1e37c57fd7c7e`.

`required.patch` combines the pre-existing 64-bit segment-length correction with
the additive bounded, integrity-checked link-target reader and typed redirection
accessor. It includes their regression tests. It changes only
`crates/unrar-rs/src/archive/member.rs`; it adds no RAR creation support.
The original Apache-2.0/unRAR restriction notice remains unchanged.

## Verify the dependency the application actually builds

From the application root:

```sh
python3 scripts/verify-unrar-source.py
```

The read-only preflight parses `engine/Cargo.toml`, resolves its declared
`unrar-rs` path, and checks that selected checkout against the patch, source,
package, license and workspace hashes. It also refuses unlisted Rust modules and
an unexpected dependency build script. It never applies patches or changes files.
Both `engine/build.sh` and Cargo's build hook run it before native build
preparation; there is no skip flag. Cargo tracks the selected source directory,
so a later source change invalidates the previous successful check.

## Prepare a fresh adjacent checkout for an application build

Start in a fresh application checkout with no existing `../rarpar` path. If a
sibling already exists, stop and obtain the application in a separate parent
workspace instead. Never reset, rename or overwrite that existing sibling.
The other engine sibling prerequisites remain as documented in `engine/README.md`.

```sh
set -eu
if [ -e ../rarpar ] || [ -L ../rarpar ]; then
  echo 'An adjacent RAR checkout already exists; use a separate fresh workspace.' >&2
  exit 1
fi
python3 - <<'PYPATCH'
import hashlib, json, pathlib
bundle = pathlib.Path('engine/unrar-source')
manifest = json.loads((bundle / 'source.json').read_text())
if hashlib.sha256((bundle / manifest['patch']['file']).read_bytes()).hexdigest() != manifest['patch']['sha256']:
    raise SystemExit('Required patch SHA-256 mismatch')
PYPATCH
task_patch="$(pwd)/engine/unrar-source/required.patch"
git clone --no-checkout https://github.com/scryer-media/rarpar ../rarpar
git -C ../rarpar checkout --detach be8e5aceff738bd618a540143def08b3e745aae1
git -C ../rarpar apply --check "$task_patch"
git -C ../rarpar apply "$task_patch"
python3 scripts/verify-unrar-source.py
sh engine/build.sh
```

This prepares the existing relative dependency location; it does not change the
application's dependency path, version or features. If verification fails, retain
the diagnostic and inspect the mismatch. Do not bypass it or automatically alter
the source. The source-only regression command is:

```sh
python3 tests/unrar-source-preflight.py
```

## Reconstruct in an isolated validation worktree

Ensure the exact base commit is available in the RAR repository. From that
repository root, with the application checkout adjacent as `archive`:

```sh
task_patch="$(pwd)/../archive/engine/unrar-source/required.patch"
git worktree add --detach .worktrees/archive-unrar-source be8e5aceff738bd618a540143def08b3e745aae1
git -C .worktrees/archive-unrar-source apply --check "$task_patch"
git -C .worktrees/archive-unrar-source apply "$task_patch"
cd .worktrees/archive-unrar-source
python3 - ../../../archive/engine/unrar-source/source.json <<'PYVERIFY'
import hashlib, json, pathlib, sys
manifest_path = pathlib.Path(sys.argv[1])
manifest = json.loads(manifest_path.read_text())
patch = manifest_path.parent / manifest['patch']['file']
assert hashlib.sha256(patch.read_bytes()).hexdigest() == manifest['patch']['sha256']
for group in ['sourceSHA256', 'workspaceSHA256']:
    for name, expected in manifest[group].items():
        assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == expected, name
print('PASS: exact source, workspace manifests, lockfile and patch')
PYVERIFY
```

The verification is read-only and can also run from an already prepared checkout.
Do not apply the patch twice. Do not reset or overwrite a checkout containing
other changes. A clean, dedicated adjacent checkout prepared at this base with
this patch supplies the application's existing relative path; the validation
worktree alone does not redirect the application's build.

`source.json` records exact hashes for 76 source/package/license files and the
workspace manifest/lockfile. `validation.json` records successful reconstruction
in `.worktrees/archive-unrar-source-proof-20261117`: source hashes and patch diff
matched the required checkout exactly, while the original checkout was unchanged.
This is source reconstruction evidence, not an additional broad runtime test run.

No version, commit, tag, push or publication is part of this bundle. Any future
upstream handoff remains subject to that repository's versioning, licensing and
signed-history rules.
