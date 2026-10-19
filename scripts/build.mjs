import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
const manifest=JSON.parse(await fs.readFile('manifest.json','utf8'));
const result=await esbuild.build({entryPoints:['src/main.ts'],bundle:true,format:'cjs',target:'es2020',platform:'browser',external:['obsidian','electron','@codemirror/state','@codemirror/view','@codemirror/commands','@codemirror/language','@codemirror/lang-markdown'],outfile:'main.js',minify:true,sourcemap:false,legalComments:'inline',metafile:true,banner:{js:`/* Inkspace ${manifest.version} — early prototype. Real iPad validation required. */`}});
await fs.mkdir('dist',{recursive:true});
for(const file of ['main.js','manifest.json','styles.css'])await fs.copyFile(file,path.join('dist',file));
await fs.writeFile('dist/build-meta.json',JSON.stringify(result.metafile,null,2));
console.log(`Built mobile-compatible plugin: ${(await fs.stat('main.js')).size} bytes.`);
