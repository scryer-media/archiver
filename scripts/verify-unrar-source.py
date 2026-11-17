#!/usr/bin/env python3
"""Read-only verification of the exact RAR reader selected by the engine manifest."""
import argparse
import hashlib
import json
import pathlib
import sys
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[1]

def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

def verify(engine_manifest, bundle):
    engine_manifest = pathlib.Path(engine_manifest).resolve(strict=True)
    bundle = pathlib.Path(bundle).resolve(strict=True)
    manifest = json.loads((bundle / 'source.json').read_text())
    cargo = tomllib.loads(engine_manifest.read_text())
    dependency = cargo.get('dependencies', {}).get('unrar-rs')
    if not isinstance(dependency, dict) or not isinstance(dependency.get('path'), str):
        raise ValueError('unrar-rs must use the declared local path dependency')
    if any(key in dependency for key in ['git', 'registry', 'workspace']):
        raise ValueError('unrar-rs dependency source does not match the local-source contract')
    crate = (engine_manifest.parent / dependency['path']).resolve(strict=True)
    source = crate.parent.parent
    if crate.relative_to(source).as_posix() != 'crates/unrar-rs':
        raise ValueError('unrar-rs path must resolve to the required crates/unrar-rs layout')
    patch = bundle / manifest['patch']['file']
    if patch.resolve().parent != bundle or digest(patch) != manifest['patch']['sha256']:
        raise ValueError('required RAR source patch SHA-256 mismatch')
    verified = []
    for group in ['sourceSHA256', 'workspaceSHA256']:
        for name, expected in manifest[group].items():
            relative = pathlib.Path(name)
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('Invalid relative source manifest path')
            path = source / relative
            if not path.resolve(strict=True).is_relative_to(source):
                raise ValueError('Required RAR source escapes its selected checkout')
            if digest(path) != expected:
                raise ValueError('Required RAR source SHA-256 mismatch: ' + name)
            verified.append(path)
    expected_rust = {name for name in manifest['sourceSHA256'] if name.startswith('crates/unrar-rs/src/') and name.endswith('.rs')}
    actual_rust = {path.relative_to(source).as_posix() for path in (crate / 'src').rglob('*.rs')}
    if actual_rust != expected_rust:
        raise ValueError('Required RAR source file inventory mismatch')
    if (crate / 'build.rs').exists() and 'crates/unrar-rs/build.rs' not in manifest['sourceSHA256']:
        raise ValueError('Unexpected RAR dependency build script')
    return {'engineManifest': engine_manifest, 'crate': crate, 'files': verified, 'sourceFiles': len(manifest['sourceSHA256']), 'workspaceFiles': len(manifest['workspaceSHA256'])}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-manifest', type=pathlib.Path, default=ROOT / 'engine/Cargo.toml')
    parser.add_argument('--cargo', action='store_true', help='emit build-script file tracking after successful verification')
    args = parser.parse_args()
    try:
        result = verify(args.engine_manifest, ROOT / 'engine/unrar-source')
    except (OSError, ValueError, KeyError, TypeError) as error:
        print('RAR source preflight failed: ' + str(error), file=sys.stderr)
        print('Prepare the exact adjacent checkout using engine/unrar-source/README.md; no source was modified.', file=sys.stderr)
        return 1
    if args.cargo:
        for path in [result['engineManifest'], result['crate'], *result['files']]:
            print('cargo:rerun-if-changed=' + str(path))
    else:
        print('PASS: actual engine dependency verified (' + str(result['sourceFiles']) + ' source/license files, ' + str(result['workspaceFiles']) + ' workspace files)')
    return 0

if __name__ == '__main__':
    sys.exit(main())
