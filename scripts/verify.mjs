import {spawnSync} from 'node:child_process';
for(const args of [['node_modules/typescript/bin/tsc','--noEmit'],['scripts/test.mjs'],['scripts/build.mjs']]){const result=spawnSync(process.execPath,args,{stdio:'inherit'});if(result.status!==0)process.exit(result.status??1);}
console.log('All type, unit/integration, and production-build gates passed.');
