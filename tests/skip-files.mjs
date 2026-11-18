import assert from 'node:assert/strict';
import {uselessFile,skipRule,skipInventory,skipKinds} from '../engine/skip-files.ts';
const all=new Set(skipKinds),only=kind=>new Set([kind]);
// Garbage: on by default.
for(const path of ['.DS_Store','photos/.DS_Store','photos/._IMG_1.jpg','__MACOSX/photos/IMG_1.jpg','Thumbs.db','a/THUMBS.DB','a/Desktop.ini','$RECYCLE.BIN/x','a/~$report.docx','.Trash-1000/x','a/.~lock.notes.odt#','@eaDir/IMG_1.jpg@SynoEAStream','a/.Spotlight-V100/store','Icon\r','a/.notes.pdf.icloud','.directory','a/.nfs0000000012345678'])
 assert.equal(uselessFile(path)?.kind,'garbage',path);
for(const path of ['photos/IMG_1.jpg','report.docx','.gitignore','.env','notes.icloud','._','~$','Trash/file','DS_Store','a/.Trash-x/file','desktop.ini.bak','thumbs.db.txt','__MACOSX.txt','src/.directory.ts','node_modules/a/index.js','.git/HEAD'])
 assert.equal(uselessFile(path),undefined,path);
assert.ok(uselessFile('photos/__MACOSX',true),'a junk folder entry');
assert.equal(uselessFile('photos/__MACOSX',false),undefined,'a file merely named like a junk folder is kept');
// Version control: only when chosen.
for(const path of ['repo/.git/HEAD','repo/.git/objects/ab/cdef','sub/.git','.gitignore','a/.gitattributes','.gitmodules','repo/.hg/store/data','.hgignore','proj/.svn/entries','proj/CVS/Root','.cvsignore','b/.bzr/branch','_darcs/patches/x','.jj/repo/store','.pijul/x','.fslckout'])
 assert.equal(skipRule(path,false,only('vcs'))?.kind,'vcs',path);
for(const path of ['notes/git.txt','gitignore','src/svn.rs','CVS.txt','docs/.github/workflows/ci.yml','.env'])
 assert.equal(skipRule(path,false,only('vcs')),undefined,path);
assert.ok(skipRule('repo/.git',true,only('vcs')));
// Regenerable: build output, dependencies and caches across languages.
for(const path of ['web/node_modules/react/index.js','app/.next/cache/x','py/__pycache__/m.cpython-312.pyc','py/m.pyc','py/.venv/bin/python','py/.pytest_cache/v','pkg/foo.egg-info/PKG-INFO','rs/target/debug/app','java/build/classes/A.class','A.class','kt/.gradle/8.0/x','cs/obj/project.assets.json','cs/bin/Debug/net8.0/app.dll','cs/bin/Release/app.dll','c/CMakeFiles/x','c/cmake-build-debug/x','c/main.o','go/vendor/github.com/x/y.go','zig/zig-out/bin/app','zig/.zig-cache/h','ios/Pods/Alamofire/x.swift','ios/DerivedData/x','swift/.build/debug/x','dart/.dart_tool/x','ex/_build/dev/lib','ex/deps/plug/mix.exs','erl/x.beam','hs/.stack-work/x','hs/dist-newstyle/x','elm/elm-stuff/x','r/.Rproj.user/x','tf/.terraform/providers/x','js/coverage/lcov.info','js/dist/app.js','js/.eslintcache','ts/tsconfig.tsbuildinfo','npm-debug.log','nim/nimcache/x','lua/lua_modules/x','ml/_opam/x','clj/.cpcache/x'])
 assert.equal(skipRule(path,false,only('regenerable'))?.kind,'regenerable',path);
for(const path of ['tools/bin/deploy.sh','bin/run','lib/helper.rb','env/settings.txt','packages/app/src/index.ts','src/build.rs','build.gradle','dist.txt','src/target.ts','notes.obj.txt','model.obj','Dockerfile','package.json','Cargo.lock','.Rdata','vendor.txt'])
 assert.equal(skipRule(path,false,only('regenerable')),undefined,path);
// Kinds stay separate and combine.
assert.equal(skipRule('repo/.git/HEAD',false,only('garbage')),undefined);
assert.equal(skipRule('web/node_modules/x.js',false,only('vcs')),undefined);
assert.equal(skipRule('web/node_modules/x.js',false,new Set()),undefined);
assert.equal(skipRule('repo/.git/node_modules/x',false,all)?.kind,'vcs','the outermost matching folder names the reason');
assert.ok(skipInventory.every(rule=>rule.what&&rule.from&&skipKinds.includes(rule.kind)));
assert.ok(new Set(skipInventory.filter(rule=>rule.kind==='regenerable').map(rule=>rule.from)).size>=25,'regenerable rules cover at least 25 languages and toolchains');
