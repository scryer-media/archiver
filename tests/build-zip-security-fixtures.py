#!/usr/bin/env python3
"""Build harmless ZIP migration regressions using only the standard library."""
import argparse
import hashlib
import io
import json
import struct
import zipfile
from pathlib import Path

PAYLOAD = b"bounded regression payload\n" * 64

class Sequential(io.BytesIO):
    def seekable(self):
        return False
    def seek(self, *args):
        raise io.UnsupportedOperation("sequential")

def archive(names=("payload.bin",), method=zipfile.ZIP_STORED, descriptor=False, symlink=False):
    target = Sequential() if descriptor else io.BytesIO()
    with zipfile.ZipFile(target, "w", compression=method) as writer:
        for name in names:
            entry = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            entry.compress_type = method
            entry.create_system = 3
            entry.external_attr = ((0o120777 if symlink else 0o100644) << 16)
            writer.writestr(entry, PAYLOAD)
    return target.getvalue()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("/private/tmp/archive-zip-migration/security"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    cases = []
    def emit(name, data, expectation, category, reason):
        path = args.output / (name + ".zip")
        if path.exists():
            if path.read_bytes() != data:
                raise RuntimeError("Refusing to overwrite differing fixture: " + name)
        else:
            path.write_bytes(data)
        cases.append(dict(id=name, archive=path.name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), expectation=expectation, category=category, reason=reason))
    base = archive()
    central = base.index(b"PK\x01\x02")
    def patch(name, offset, fmt, value, category="header-consistency"):
        data = bytearray(base)
        struct.pack_into(fmt, data, offset, value)
        emit(name, bytes(data), "reject", category, "Mutated field conflicts with pristine counterpart")
    for method, name in ((zipfile.ZIP_STORED, "stored"), (zipfile.ZIP_DEFLATED, "deflate")):
        for descriptor in (False, True):
            emit(name + ("-descriptor" if descriptor else ""), archive(method=method, descriptor=descriptor), "accept", "compatibility", "Exact full payload hash required")
    data = bytearray(base)
    data[30:41] = b"renamed.bin"
    emit("local-name-conflict", bytes(data), "reject", "header-consistency", "Equal-length harmless local/central filename conflict")
    patch("local-method-conflict", 8, "<H", 8)
    patch("local-encrypted-flag-conflict", 6, "<H", 1)
    patch("local-utf8-flag-conflict", 6, "<H", 0x800)
    patch("local-size-conflict", 22, "<I", len(PAYLOAD) + 1)
    patch("local-packed-size-conflict", 18, "<I", len(PAYLOAD) + 1)
    patch("local-crc-conflict", 14, "<I", 0)
    patch("central-size-underdeclared", central + 24, "<I", 1)
    patch("central-size-overdeclared", central + 24, "<I", 0xffffffff)
    patch("central-crc-conflict", central + 16, "<I", 0)
    patch("central-local-offset-outside", central + 42, "<I", len(base) + 4096)
    for name, member in (("parent-path", "../outside.bin"), ("absolute-path", "/outside.bin"), ("drive-path", "C:/outside.bin"), ("backslash-parent", "..\\outside.bin")):
        emit(name, archive((member,)), "reject", "destination-preflight", "Unsafe destination path; zero output mutations required")
    for name, members in (("case-alias", ("File.bin", "file.bin")), ("unicode-alias", ("r\u00e9sum\u00e9.bin", "re\u0301sume\u0301.bin")), ("file-parent-conflict", ("parent", "parent/child.bin"))):
        emit(name, archive(members), "reject", "destination-preflight", "Canonical identity or file/ancestor collision; zero output mutations required")
    emit("symlink", archive(("link.bin",), symlink=True), "reject", "destination-preflight", "Unix symlink mode; never materialize")
    emit("truncated-eocd", base[:-9], "reject", "structure", "Incomplete end record")
    emit("truncated-body", base[:30 + 11 + 12], "reject", "structure", "Incomplete payload and absent directory")
    descriptor = archive(descriptor=True)
    descriptor_at = descriptor.index(b"PK\x07\x08")
    damaged = bytearray(descriptor)
    struct.pack_into("<I", damaged, descriptor_at + 4, 0)
    emit("descriptor-crc-conflict", bytes(damaged), "reject", "integrity", "Descriptor CRC conflicts with directory and actual content")
    damaged = bytearray(base)
    damaged[30 + 11 + 5] ^= 1
    emit("body-corruption", bytes(damaged), "reject", "integrity", "Headers agree but stored content checksum fails")
    # Validate accepted controls independently, consuming every byte to force CRC checks.
    for case in cases:
        if case["expectation"] == "accept":
            with zipfile.ZipFile(args.output / case["archive"]) as reader:
                assert reader.namelist() == ["payload.bin"]
                assert reader.read("payload.bin") == PAYLOAD
    manifest = dict(schema=1, generator="python-stdlib", payload=dict(bytes=len(PAYLOAD), sha256=hashlib.sha256(PAYLOAD).hexdigest()), cases=cases, notes=["Reject may occur during list, extraction preflight, or full integrity read as category dictates.", "Destination cases require application canonical registry; parser acceptance alone is not a failure.", "Descriptor controls deliberately have zero local CRC/sizes, which must remain accepted.", "AES interoperability uses retained independently created encrypted fixtures; no custom cryptography here.", "Small fixtures do not establish offsets beyond 4 GiB; retain actual large ZIP64 regression."])
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(dict(manifest=str(args.output / "manifest.json"), cases=len(cases), totalBytes=sum(case["bytes"] for case in cases))))

if __name__ == "__main__":
    main()
