import assert from 'node:assert/strict';
import {archiveStem,groupArchives,volumeSetName,recoverySetName} from '../src/archive-groups.ts';
const archive=name=>/\.(7z(?:\.\d{3})?|zip|rar|r\d\d|tar|gz|tgz|zst|xz)$/i.test(name);
const file=(name,size=1)=>({name,size});
for(const name of ['Set.part01.rar','set.part2.rar','Set.rar','Set.r00','Set.7z.001','Set.zip','Set.par2','Set.vol00+01.par2','Set.part01.vol3-4.PAR2','Set.rev','Set.tar.gz'])assert.equal(archiveStem(name),'set',name);
assert.equal(archiveStem('Other.part01.rar'),'other');
const groups=groupArchives([file('Beta.zip',5),file('Alpha.part10.rar'),file('Alpha.part2.rar'),file('Alpha.part1.rar'),file('Alpha.par2'),file('Alpha.vol0+1.par2'),file('Orphan.par2'),file('Gamma.7z.002'),file('Gamma.7z.001')],archive);
assert.deepEqual(groups.map(group=>group.name),['Alpha.part1.rar','Beta.zip','Gamma.7z.001'],'one job per set; recovery-only sets dropped');
assert.deepEqual(groups[0].files.map(item=>item.name),['Alpha.part1.rar','Alpha.part2.rar','Alpha.part10.rar','Alpha.par2','Alpha.vol0+1.par2'],'volumes in numeric order, recovery last');
assert.equal(groups[0].volumes,3);assert.equal(groups[0].recovery,2);assert.equal(groups[1].size,5);
console.log(JSON.stringify({status:'PASS',groups:groups.length}));
// PAR2 sets are named after the archive a split set makes up.
for(const [name,set] of [['Movie.part01.rar','Movie.rar'],['Movie.part12.rar','Movie.rar'],['Movie.rar','Movie.rar'],['Movie.r00','Movie.rar'],['Movie.7z.001','Movie.7z'],['Movie.zip.002','Movie.zip'],['Movie.z01','Movie.zip'],['Movie.7z','Movie.7z'],['notes.bin','notes.bin'],['Movie.part01.exe','Movie.rar']])assert.equal(volumeSetName(name),set,name);
assert.equal(recoverySetName(['Movie.part01.rar','Movie.part02.rar','Movie.part03.rar']),'Movie.rar');
assert.equal(recoverySetName(['Movie.rar','Movie.r00','Movie.r01']),'Movie.rar');
assert.equal(recoverySetName(['dl/Movie.7z.001','dl/Movie.7z.002','dl/Movie.par2']),'Movie.7z');
assert.equal(recoverySetName(['a.7z.001','b.7z.001']),undefined);
assert.equal(recoverySetName(['photo.jpg','notes.txt']),undefined);
