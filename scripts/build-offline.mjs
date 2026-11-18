import { readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { brotliCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';
import { engineVersion } from './engine-version.mjs';
import { offlineWorkerSource } from './offline-worker.mjs';
const outputDirectory=process.argv[2]||'dist';
if(!/^dist(?:-[a-z0-9-]+)?$/.test(outputDirectory))throw new Error('Expected a local dist output directory');
const nativeVersion = engineVersion(outputDirectory+'/engine');
await rename(outputDirectory+'/engine/archive-engine.js', `${outputDirectory}/engine/archive-engine-${nativeVersion}.js`);
await rename(outputDirectory+'/engine/archive_engine.wasm', `${outputDirectory}/engine/archive_engine-${nativeVersion}.wasm`);
// Each engine file also ships as a max-Brotli copy, which the Worker serves in its place. Browsers do not accept
// Brotli windows over 16 MiB (2^24), so that is the largest window used.
const compress=promisify(brotliCompress);
await Promise.all([`archive-engine-${nativeVersion}.js`,`archive_engine-${nativeVersion}.wasm`].map(async name=>{
 const path=`${outputDirectory}/engine/${name}`,bytes=await readFile(path);
 await writeFile(path+'.br',await compress(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:11,[constants.BROTLI_PARAM_LGWIN]:24,[constants.BROTLI_PARAM_SIZE_HINT]:bytes.length}}));
}));
const paths=[];
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=`${dir}/${entry.name}`;if(entry.isDirectory())await walk(path);else if(!['sw.js','_headers'].includes(entry.name)&&!entry.name.endsWith('.br'))paths.push('/'+path.slice(outputDirectory.length+1));}}
await walk(outputDirectory);
paths.sort();
// Brotli copies are another encoding of a listed file, so they are neither cached nor part of the cohort.
// Worker logic is part of the cache identity, so a logic-only update cannot
// populate or delete the cache still used by the active worker.
const version=createHash('sha256');
version.update(await readFile(new URL(import.meta.url)));
version.update(await readFile(new URL('./offline-worker.mjs',import.meta.url)));
// Hosting configuration is not served by Pages, but policy-only updates need a new cohort.
version.update(await readFile(outputDirectory+'/_headers'));
const assets=[];
for(const path of paths){const bytes=await readFile(outputDirectory+path);version.update(path);version.update(bytes);assets.push({path,sha256:createHash('sha256').update(bytes).digest('hex')});}
const index=assets.find(asset=>asset.path==='/index.html');if(!index)throw new Error('Offline application HTML is missing');
const cache='scryer-archive-'+version.digest('hex').slice(0,12);
await writeFile(outputDirectory+'/sw.js',offlineWorkerSource(cache,[{path:'/',sha256:index.sha256},...assets]));
