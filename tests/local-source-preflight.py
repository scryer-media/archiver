"""Small isolated regressions for the read-only local dependency verifier."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
import sys
sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('local_sources', ROOT / 'scripts/verify-local-sources.py')
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

class LocalSources(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='archive-local-source-test-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.engine = self.root / 'app/engine/Cargo.toml'
        self.engine.parent.mkdir(parents=True)
        self.engine.write_text('[dependencies]\na = { path = "../../library/a" }\n')
        self.repo = self.root / 'library'
        self.repo.mkdir()
        (self.repo / 'Cargo.toml').write_text('[workspace]\nmembers=["a","b"]\n')
        (self.repo / 'Cargo.lock').write_text('version=4\n')
        packages=[]
        for name in ['a','b']:
            crate=self.repo/name
            (crate/'src').mkdir(parents=True)
            (crate/'src/lib.rs').write_text('pub fn value() {}\n')
            text='[package]\nname="'+name+'"\nversion="0.1.0"\n'
            if name=='a':text+='[dependencies]\nb={path="../b"}\n'
            (crate/'Cargo.toml').write_text(text)
            packages.append({'name':name,'path':'../../library/'+name,'repository':'library','files':check.inventory(crate)})
        self.manifest=self.root/'sources.json'
        self.manifest.write_text(json.dumps({'schema':1,'directDependencies':{'a':{'path':'../../library/a'}},'repositories':[{'name':'library','workspaceFiles':{n:check.digest(self.repo/n) for n in ['Cargo.toml','Cargo.lock']}}],'packages':packages}))
    def verify(self):return check.verify(self.engine,self.manifest)
    def test_matching_closure_is_read_only(self):
        before={p:(p.read_bytes(),p.stat().st_mtime_ns) for p in self.repo.rglob('*') if p.is_file()}
        self.assertEqual(self.verify()['packages'],2)
        self.assertEqual(before,{p:(p.read_bytes(),p.stat().st_mtime_ns) for p in before})
    def test_transitive_source_drift_rejected(self):
        (self.repo/'b/src/lib.rs').write_text('changed')
        with self.assertRaisesRegex(ValueError,'SHA-256 mismatch'):self.verify()
    def test_unlisted_assembly_rejected(self):
        (self.repo/'a/src/extra.S').write_text('fixture')
        with self.assertRaisesRegex(ValueError,'inventory mismatch'):self.verify()
    def test_unlisted_build_script_rejected(self):
        (self.repo/'a/build.rs').write_text('fn main() {}')
        with self.assertRaisesRegex(ValueError,'inventory mismatch'):self.verify()
    def test_removed_source_rejected(self):
        (self.repo/'a/src/lib.rs').unlink()
        with self.assertRaisesRegex(ValueError,'inventory mismatch'):self.verify()
    def test_workspace_drift_rejected(self):
        (self.repo/'Cargo.toml').write_text('changed')
        with self.assertRaisesRegex(ValueError,'workspace SHA-256 mismatch'):self.verify()
    def test_changed_dependency_features_rejected(self):
        self.engine.write_text(self.engine.read_text().replace('path = "../../library/a"','path = "../../library/a", features=["new"]'))
        with self.assertRaisesRegex(ValueError,'declarations changed'):self.verify()
    def test_unrecorded_transitive_crate_rejected(self):
        data=json.loads(self.manifest.read_text());data['packages']=data['packages'][:1];self.manifest.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError,'Unrecorded local dependency'):self.verify()
    def test_escaping_source_symlink_rejected(self):
        outside=self.root/'outside.rs';outside.write_text('outside')
        target=self.repo/'a/src/lib.rs';target.unlink();target.symlink_to(outside)
        with self.assertRaisesRegex(ValueError,'escapes'):self.verify()
    def test_actual_sources_match(self):
        self.assertEqual(check.verify(ROOT/'engine/Cargo.toml',ROOT/'engine/local-sources.json')['packages'],5)

if __name__=='__main__':unittest.main(verbosity=2)
