#!/usr/bin/env python3
"""Prepare the pinned, verified TAR library; Cargo never downloads sources."""
import argparse, hashlib, json, pathlib, subprocess, tarfile, tempfile, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[1]
def sha(data): return hashlib.sha256(data).hexdigest()
def prepare(fetch=False):
    spec = json.loads((ROOT / 'engine/libarchive/source.json').read_text())
    identity = sha(json.dumps(spec, sort_keys=True).encode())[:24]
    base = ROOT / '.cache/vendor'
    destination = base / ('libarchive-' + spec['version'] + '-' + identity)
    for patch in spec['patches']:
        if sha((ROOT / 'engine/libarchive' / patch['file']).read_bytes()) != patch['sha256']:
            raise RuntimeError('TAR patch hash does not match the reviewed manifest')
    marker = destination / '.verified-source.json'
    if marker.is_file():
        if json.loads(marker.read_text()) != spec:
            raise RuntimeError('TAR source cache provenance does not match the pinned manifest')
        return destination
    archive = base / ('libarchive-' + spec['version'] + '.tar.xz')
    if not archive.is_file():
        if not fetch: raise RuntimeError('TAR source cache missing; run scripts/vendor-libarchive.py --fetch')
        base.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(spec['url'], timeout=60) as response:
            data = response.read(spec['bytes'] + 1)
        if len(data) != spec['bytes'] or sha(data) != spec['sha256']:
            raise RuntimeError('Downloaded TAR library failed size/SHA256 verification')
        archive.write_bytes(data)
    if archive.stat().st_size != spec['bytes'] or sha(archive.read_bytes()) != spec['sha256']:
        raise RuntimeError('Cached TAR library failed size/SHA256 verification')
    with tempfile.TemporaryDirectory(prefix='libarchive-', dir=base) as temporary:
        directory = pathlib.Path(temporary)
        with tarfile.open(archive) as source:
            source.extractall(directory, filter='data')
        extracted = directory / ('libarchive-' + spec['version'])
        for patch in spec['patches']:
            subprocess.run(['patch', '-p1', '--batch', '--forward', '-i', str(ROOT / 'engine/libarchive' / patch['file'])], cwd=extracted, check=True, stdout=subprocess.DEVNULL)
        (extracted / '.verified-source.json').write_text(json.dumps(spec, sort_keys=True))
        extracted.rename(destination)
    return destination
def notices(source):
    directory = ROOT / 'public/licenses'
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'libarchive-COPYING.txt').write_bytes((source / 'COPYING').read_bytes())
    spec = json.loads((ROOT / 'engine/libarchive/source.json').read_text())
    spec['integration'] = 'TAR-only reader/PAX writer; no external filters or host unpack APIs'
    spec['patchDirectory'] = 'engine/libarchive'
    (directory / 'libarchive-source.json').write_text(json.dumps(spec, indent=2) + '\n')
if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--fetch', action='store_true'); parser.add_argument('--notices', action='store_true')
    options = parser.parse_args(); source = prepare(options.fetch)
    if options.notices: notices(source)
    print(source)
