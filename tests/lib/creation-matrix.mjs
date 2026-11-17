export const codecs=['copy','lzma','lzma2','ppmd','bzip2','zstd','deflate','lz4','brotli'];
export const filters=['delta','x86','arm','arm64','thumb','ia64','sparc','ppc','riscv','bcj2'];
export const streams=['gz','bz2','xz','zstd','br','lzma','lz4','deflate','zlib'];
const password='creation-fixture-password';
const archive=(id,options,extra={})=>({id,family:options.format,kind:'archive',options,...extra});
const recovery=(id,options)=>({id,family:options.format,kind:'recovery',seed:'protected',options:{blockSize:262144,recoveryBlocks:8,...options}});
export const apiCases=[
 archive('zip-plain',{format:'zip'}),archive('zip-aes',{format:'zip',password}),
 archive('zip64-entry-count',{format:'zip'},{many:true,expectedGenerated:{kind:'indexed-byte-files',count:65536,prefix:'f',digits:5,modulus:251}}),
 ...codecs.map(codec=>archive('7z-codec-'+codec,{format:'7z',codec})),
 ...filters.map(filter=>archive('7z-filter-'+filter,{format:'7z',codec:'lzma2',filter,deltaDistance:1})),
 archive('7z-delta-256',{format:'7z',codec:'lzma2',filter:'delta',deltaDistance:256}),
 archive('7z-solid',{format:'7z',codec:'lzma2',solid:true}),
 archive('7z-encrypted-headers',{format:'7z',codec:'lzma2',password,headerEncryption:true}),
 archive('7z-solid-encrypted',{format:'7z',codec:'lzma2',solid:true,password,headerEncryption:true}),
 archive('7z-x86-encrypted',{format:'7z',codec:'lzma2',filter:'x86',password,headerEncryption:true}),
 archive('tar-multi',{format:'tar'}),
 ...streams.map(format=>archive('stream-'+format,{format},{seed:'single'})),
 ...streams.map(format=>archive('tar-'+format,{format:'tar.'+format})),
 recovery('par2-variable',{format:'par2',volumeScheme:'variable',volumeCount:2}),
 recovery('par2-uniform',{format:'par2',volumeScheme:'uniform',volumeCount:2}),
 ...['par2'].map(protection=>({...archive('7z-with-'+protection,{format:'7z',codec:'lzma2',protection,blockSize:262144,recoveryBlocks:8}),kind:'combined'})),
];
export const negativeCases=[
 {id:'reject-unknown-format',options:{format:'unknown-fixture-format'}},
 {id:'reject-unknown-codec',options:{format:'7z',codec:'unknown-fixture-codec'}},
 {id:'reject-unknown-filter',options:{format:'7z',filter:'unknown-fixture-filter'}},
 {id:'reject-delta-zero',options:{format:'7z',filter:'delta',deltaDistance:0}},
 {id:'reject-delta-overflow',options:{format:'7z',filter:'delta',deltaDistance:257}},
 {id:'reject-bcj2-password',options:{format:'7z',filter:'bcj2',password}},
 {id:'reject-multiple-gzip',options:{format:'gz'}},
 {id:'reject-multiple-zstd',options:{format:'zstd'}},
 {id:'reject-stream-password',seed:'single',options:{format:'xz',password}},
 {id:'reject-tar-password',options:{format:'tar',password}},
 {id:'reject-duplicate-path',mutation:'duplicate',options:{format:'zip'}},
 {id:'reject-traversal-path',mutation:'traversal',options:{format:'zip'}},
];
export const uiCases=[
 archive('ui-zip-plain',{format:'zip'}),archive('ui-zip-aes',{format:'zip',password}),
 archive('ui-7z-solid-encrypted',{format:'7z',codec:'lzma2',solid:true,password,headerEncryption:true}),
 ...['gz','bz2','xz','zstd'].map(format=>archive('ui-stream-'+format,{format},{seed:'single',delivery:'download'})),
 archive('ui-tar-multi',{format:'tar'},{delivery:'download'}),archive('ui-tar-xz',{format:'tar.xz'}),
 recovery('ui-par2-existing',{format:'par2',volumeScheme:'variable',volumeCount:2}),
 ...['par2'].map(protection=>({...archive('ui-7z-with-'+protection,{format:'7z',codec:'lzma2',protection,blockSize:262144,recoveryBlocks:8}),kind:'combined'})),
];
export const creationPlan={apiCases,negativeCases,uiCases,limits:['PAR3 creation is excluded; existing PAR3 read, verify and repair remain available.','Filter coverage uses LZMA2 plus selected encrypted combinations, not every Cartesian combination.','No app option forces small ZIP64; the automatic 65536-entry app case exercises ZIP64 creation.','Standalone compression requires one file and does not silently wrap TAR.','7z Zstandard/LZ4/Brotli independent decoding depends on installed CLI support.','Small fixture coverage does not resolve the failed 100 GB attempt.']};
