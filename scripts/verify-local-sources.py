#!/usr/bin/env python3
"""Read-only verification of every existing local engine dependency."""
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

def inventory(crate):
    crate = pathlib.Path(crate).resolve(strict=True)
    files = [path for path in (crate / 'src').rglob('*') if path.is_file() and path.name != '.DS_Store']
    files += [path for path in crate.iterdir() if path.is_file() and
              (path.name in ['Cargo.toml', 'build.rs', 'README.md', 'COPYING'] or path.name.startswith('LICENSE'))]
    for path in files:
        if not path.resolve(strict=True).is_relative_to(crate):
            raise ValueError('Local dependency source escapes its crate')
    return {path.relative_to(crate).as_posix(): digest(path) for path in sorted(files)}

def verify(engine_manifest, source_manifest):
    engine_manifest = pathlib.Path(engine_manifest).resolve(strict=True)
    spec = json.loads(pathlib.Path(source_manifest).read_text())
    if spec['schema'] != 1:
        raise ValueError('Unsupported local-source manifest schema')
    cargo = tomllib.loads(engine_manifest.read_text())
    direct = {name: value for name, value in cargo['dependencies'].items()
              if isinstance(value, dict) and 'path' in value}
    if direct != spec['directDependencies']:
        raise ValueError('Local dependency declarations changed')
    parent = engine_manifest.parent.parent.parent
    repositories = {}
    verified = [engine_manifest, pathlib.Path(source_manifest).resolve(strict=True)]
    for repo in spec['repositories']:
        name = repo['name']
        if pathlib.PurePosixPath(name).name != name or name in ['.', '..']:
            raise ValueError('Invalid local repository name')
        directory = (parent / name).resolve(strict=True)
        repositories[name] = directory
        for relative, expected in repo['workspaceFiles'].items():
            if relative not in ['Cargo.toml', 'Cargo.lock']:
                raise ValueError('Invalid workspace manifest path')
            path = directory / relative
            if not path.resolve(strict=True).is_relative_to(directory) or digest(path) != expected:
                raise ValueError('Local workspace SHA-256 mismatch: ' + name + '/' + relative)
            verified.append(path)
    packages = {}
    for package in spec['packages']:
        crate = (engine_manifest.parent / package['path']).resolve(strict=True)
        if not crate.is_relative_to(repositories[package['repository']]):
            raise ValueError('Local crate escapes its repository')
        if crate in packages:
            raise ValueError('Duplicate local crate')
        actual = inventory(crate)
        if actual.keys() != package['files'].keys():
            raise ValueError('Local source inventory mismatch: ' + package['name'])
        for relative, expected in package['files'].items():
            if actual[relative] != expected:
                raise ValueError('Local source SHA-256 mismatch: ' + package['name'] + '/' + relative)
            verified.append(crate / relative)
        parsed = tomllib.loads((crate / 'Cargo.toml').read_text())
        if parsed['package']['name'] != package['name']:
            raise ValueError('Local package name mismatch')
        packages[crate] = (parsed, repositories[package['repository']])
    pending = [(engine_manifest.parent / value['path']).resolve(strict=True) for value in direct.values()]
    seen = set()
    while pending:
        crate = pending.pop()
        if crate in seen:
            continue
        if crate not in packages:
            raise ValueError('Unrecorded local dependency')
        seen.add(crate)
        parsed, repository = packages[crate]
        workspace = tomllib.loads((repository / 'Cargo.toml').read_text()).get('workspace', {}).get('dependencies', {})
        tables = [parsed] + list(parsed.get('target', {}).values())
        for table in tables:
            for kind in ['dependencies', 'build-dependencies']:
                for name, value in table.get(kind, {}).items():
                    if not isinstance(value, dict):
                        continue
                    base = crate
                    if value.get('workspace'):
                        value = workspace.get(name, {})
                        base = repository
                    if isinstance(value, dict) and 'path' in value:
                        pending.append((base / value['path']).resolve(strict=True))
    if seen != packages.keys():
        raise ValueError('Local dependency closure changed')
    return {'files': verified, 'directories': list(packages), 'packages': len(packages)}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine-manifest', type=pathlib.Path, default=ROOT / 'engine/Cargo.toml')
    parser.add_argument('--source-manifest', type=pathlib.Path, default=ROOT / 'engine/local-sources.json')
    parser.add_argument('--cargo', action='store_true')
    args = parser.parse_args()
    try:
        result = verify(args.engine_manifest, args.source_manifest)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print('Local source preflight failed: ' + str(error), file=sys.stderr)
        return 1
    if args.cargo:
        for path in [*result['directories'], *result['files']]:
            print('cargo:rerun-if-changed=' + str(path))
    else:
        print('PASS: ' + str(result['packages']) + ' local dependency crates match recorded source')
    return 0

if __name__ == '__main__':
    sys.exit(main())
