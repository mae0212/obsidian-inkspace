import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
await fs.mkdir('work/tests',{recursive:true});
const files=(await fs.readdir('tests')).filter(f=>f.endsWith('.test.ts'));
const outputs=[];
for(const file of files){const out=`work/tests/${file.replace('.ts','.cjs')}`;await esbuild.build({entryPoints:[`tests/${file}`],bundle:true,platform:'node',format:'cjs',target:'node20',outfile:out,plugins:[{name:'obsidian-test-types',setup(build){build.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'stub'}));build.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export class TFile{}; export class ItemView{}; export async function loadPdfJs(){throw new Error("Not used in unit tests")}; export function normalizePath(s){return s.replaceAll("\\\\","/").replace(/\\/{2,}/g,"/");}',loader:'js'}));}}]});outputs.push(out);}
const run=spawnSync(process.execPath,['--test',...outputs],{stdio:'inherit'});process.exitCode=run.status??1;
