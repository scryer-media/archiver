import assert from 'node:assert/strict';
import {chooseDelivery,LARGE_DELIVERY_BYTES} from '../src/delivery.ts';
const base={mode:'extract',choice:'auto',format:'zip',inputNames:['input.zip'],inputBytes:10,inputCount:1,directoryCount:0,available:true,entries:[{name:'payload.bin',size:LARGE_DELIVERY_BYTES,isDirectory:false}]};
assert.equal(chooseDelivery(base).stream,true);
assert.equal(chooseDelivery({...base,entries:[{...base.entries[0],size:1024}]}).stream,false);
assert.equal(chooseDelivery({...base,choice:'download',entries:undefined}).blocked,true);
const several={...base,entries:[...base.entries,{name:'second.bin',size:1,isDirectory:false}]};
{const decision=chooseDelivery({...several,choice:'download'});assert.equal(decision.blocked,false);assert.equal(decision.stream,true);assert.equal(decision.zip,true,'several files download as one ZIP');}
assert.equal(chooseDelivery(several).stream,false,'with folder access, automatic delivery keeps several files in the tab');
{const decision=chooseDelivery({...several,folderAccess:false});assert.equal(decision.zip,true,'without folder access, several files download as one ZIP');assert.equal(decision.stream,true);}
{const decision=chooseDelivery({...several,folderAccess:false,available:false});assert.equal(decision.stream,false);assert.equal(decision.blocked,false,'no streamed downloads: automatic delivery falls back to the tab');}
assert.equal(chooseDelivery({...several,folderAccess:false,choice:'files'}).stream,false,'prepared files stay prepared');
assert.equal(chooseDelivery({...base,folderAccess:false,entries:[{name:'one.bin',size:1024,isDirectory:false}]}).zip,undefined,'one small file never needs a ZIP');
assert.equal(chooseDelivery({...base,available:false,choice:'download'}).blocked,true);
assert.equal(chooseDelivery({...base,available:false}).stream,false);
assert.equal(chooseDelivery({...base,available:false,choice:'files'}).reason,'Prepare files in browser storage, then choose where to save them.');
for(const name of ['input.tar.gz','input.tar.zst','input.tar.br','input.tgz']){assert.equal(chooseDelivery({...base,inputNames:[name],choice:'download'}).zip,true);assert.equal(chooseDelivery({...base,inputNames:[name]}).stream,false);}
for(const format of ['7z','par2','par3','tar.unknown'])assert.equal(chooseDelivery({...base,mode:'create',format,choice:'download'}).blocked,true);
for(const format of ['tar.gz','tar.br','tar.zstd']){const decision=chooseDelivery({...base,mode:'create',format,choice:'download',inputCount:2,directoryCount:1});assert.equal(decision.stream,true);assert.equal(decision.blocked,false);assert.match(decision.reason,/Temporary TAR storage/);}
for(const format of ['zip','tar','gz','zstd','br','xz','bz2','lzma','lz4','deflate','zlib'])assert.equal(chooseDelivery({...base,mode:'create',format,inputBytes:LARGE_DELIVERY_BYTES}).stream,true);
assert.equal(chooseDelivery({...base,mode:'create',format:'gz',inputCount:2,choice:'download'}).blocked,true);
assert.equal(chooseDelivery({...base,mode:'create',format:'gz',directoryCount:1,choice:'download'}).blocked,true);
const withFolders={...base,entries:[...base.entries,{name:'empty',size:0,isDirectory:true}]};assert.equal(chooseDelivery(withFolders).stream,false,'Auto delivery must not silently discard an empty directory');assert.equal(chooseDelivery({...withFolders,choice:'download'}).zip,true,'a download keeps empty folders inside a ZIP');
assert.equal(chooseDelivery({...base,choice:'files'}).stream,false);assert.equal(chooseDelivery({...base,mode:'create',format:'7z',choice:'auto'}).blocked,false);
for(const choice of ['auto','download','files'])assert.equal(chooseDelivery({...base,mode:'create',format:'tar',choice,maxInputFileBytes:9*1024**3}).blocked,false);
for(const choice of ['auto','download','files'])assert.equal(chooseDelivery({...base,mode:'create',format:'tar',choice,maxInputFileBytes:Number.MAX_SAFE_INTEGER+1}).blocked,true);
assert.equal(chooseDelivery({...base,choice:'download',inputNames:['payload.gz'],entries:undefined}).stream,true);assert.equal(chooseDelivery({...base,choice:'download',inputNames:['opaque.bin'],inputFormatHint:'br',entries:undefined}).stream,true);assert.equal(chooseDelivery({...base,inputNames:['payload.zst'],inputBytes:LARGE_DELIVERY_BYTES,entries:undefined}).stream,true);assert.equal(chooseDelivery({...base,choice:'download',entries:undefined}).requiresInspection,true);assert.equal(chooseDelivery({...base,choice:'download',inputNames:['input.tar.gz'],entries:undefined}).zip,true);
console.log('Delivery policy passed: truthful size-based auto mode, explicit no-fallback, seek/composite/many-file restrictions, folder preservation.');
// Recovery files need the finished archive, so a large ZIP with PAR2 is prepared rather than streamed.
for(const format of ['zip','tar','tar.gz','gz']){const decision=chooseDelivery({...base,mode:'create',format,inputBytes:LARGE_DELIVERY_BYTES,recovery:true});assert.equal(decision.stream,false,format);assert.equal(decision.blocked,false,format);assert.match(decision.reason,/Recovery files/);}
assert.equal(chooseDelivery({...base,mode:'create',format:'zip',choice:'download',recovery:true}).blocked,true);
