import {readFileSync} from 'node:fs';
import {parseHeaders} from './parse-headers.mjs';
// One static-host rule is also applied as real HTTP headers by local preview and by the Worker.
export function productionHeaders(){return parseHeaders(readFileSync(new URL('../public/_headers',import.meta.url),'utf8'));}
