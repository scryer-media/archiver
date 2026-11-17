"""Source-only preflight regressions; no native build or source mutation."""
import importlib.util
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('unrar_preflight', ROOT / 'scripts/verify-unrar-source.py')
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)
BUNDLE = ROOT / 'engine/unrar-source'
ACTUAL = CHECK.verify(ROOT / 'engine/Cargo.toml', BUNDLE)
SOURCE = ACTUAL['crate'].parent.parent

class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='archive-unrar-preflight-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.engine = self.root / 'archive/engine/Cargo.toml'
        self.engine.parent.mkdir(parents=True)
        shutil.copyfile(ROOT / 'engine/Cargo.toml', self.engine)
        self.source = self.root / 'rarpar'
        for original in ACTUAL['files']:
            destination = self.source / original.relative_to(SOURCE)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, destination)
        self.bundle = self.root / 'bundle'
        self.bundle.mkdir()
        for name in ['source.json', 'required.patch']:
            shutil.copyfile(BUNDLE / name, self.bundle / name)

    def verify(self):
        return CHECK.verify(self.engine, self.bundle)

    def change(self, relative):
        path = self.source / relative
        path.write_bytes(path.read_bytes() + b'\nfixture mismatch\n')

    def test_current_actual_source_passes_without_changing_files(self):
        before = {path: (CHECK.digest(path), path.stat().st_mtime_ns) for path in ACTUAL['files']}
        result = CHECK.verify(ROOT / 'engine/Cargo.toml', BUNDLE)
        self.assertEqual(result['sourceFiles'], 76)
        self.assertEqual(result['workspaceFiles'], 2)
        self.assertEqual(before, {path: (CHECK.digest(path), path.stat().st_mtime_ns) for path in ACTUAL['files']})

    def test_isolated_matching_source_passes(self):
        self.assertEqual(self.verify()['crate'], (self.source / 'crates/unrar-rs').resolve())

    def test_source_mismatch_fails(self):
        self.change('crates/unrar-rs/src/archive/member.rs')
        with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
            self.verify()

    def test_license_mismatch_fails(self):
        self.change('crates/unrar-rs/LICENSE')
        with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
            self.verify()

    def test_workspace_lock_mismatch_fails(self):
        self.change('Cargo.lock')
        with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
            self.verify()

    def test_actual_manifest_path_is_checked_not_default_sibling(self):
        alternate = self.root / 'alternate'
        shutil.copytree(self.source, alternate)
        member = alternate / 'crates/unrar-rs/src/archive/member.rs'
        member.write_bytes(member.read_bytes() + b'\nwrong selected source\n')
        self.engine.write_text(self.engine.read_text().replace('../../rarpar/crates/unrar-rs', '../../alternate/crates/unrar-rs'))
        with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
            self.verify()

    def test_unlisted_rust_source_fails(self):
        (self.source / 'crates/unrar-rs/src/extra.rs').write_text('// fixture\n')
        with self.assertRaisesRegex(ValueError, 'inventory mismatch'):
            self.verify()

    def test_unexpected_build_script_fails(self):
        (self.source / 'crates/unrar-rs/build.rs').write_text('fn main() {}\n')
        with self.assertRaisesRegex(ValueError, 'Unexpected RAR dependency build script'):
            self.verify()

    def test_patch_mismatch_fails(self):
        patch = self.bundle / 'required.patch'
        patch.write_bytes(patch.read_bytes() + b'\nfixture mismatch\n')
        with self.assertRaisesRegex(ValueError, 'patch SHA-256 mismatch'):
            self.verify()

    def test_failed_cli_emits_no_success_or_cargo_tracking(self):
        self.change('crates/unrar-rs/LICENSE')
        result = subprocess.run(['python3', str(ROOT / 'scripts/verify-unrar-source.py'), '--engine-manifest', str(self.engine), '--cargo'], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertIn('RAR source preflight failed', result.stderr)

if __name__ == '__main__':
    unittest.main(verbosity=2)
