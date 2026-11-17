import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const manifest=fileURLToPath(new URL('../engine/Cargo.toml',import.meta.url));
execFileSync('cargo',['nextest','run','--locked','--manifest-path',manifest,'-E','test(tar::tests::virtual_hundred_gibibyte_hole)'],{stdio:'inherit'});
