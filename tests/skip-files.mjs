import assert from 'node:assert/strict';
import {uselessFile,skipInventory} from '../engine/skip-files.ts';
for(const path of ['.DS_Store','photos/.DS_Store','photos/._IMG_1.jpg','__MACOSX/photos/IMG_1.jpg','Thumbs.db','a/THUMBS.DB','a/Desktop.ini','$RECYCLE.BIN/x','a/~$report.docx','.Trash-1000/x','a/.~lock.notes.odt#','@eaDir/IMG_1.jpg@SynoEAStream','a/.Spotlight-V100/store','Icon\r','a/.notes.pdf.icloud','.directory','a/.nfs0000000012345678'])
 assert.ok(uselessFile(path),path);
for(const path of ['photos/IMG_1.jpg','report.docx','.gitignore','.env','notes.icloud','._','~$','Trash/file','DS_Store','a/.Trash-x/file','desktop.ini.bak','thumbs.db.txt','__MACOSX.txt','src/.directory.ts'])
 assert.equal(uselessFile(path),undefined,path);
assert.ok(uselessFile('photos/__MACOSX',true),'a junk folder entry');
assert.equal(uselessFile('photos/__MACOSX',false),undefined,'a file merely named like a junk folder is kept');
assert.ok(skipInventory.every(rule=>rule.what&&rule.os));
