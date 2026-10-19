import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {zipSync} from 'fflate';
const manifest=JSON.parse(await fs.readFile('manifest.json','utf8'));
if(manifest.isDesktopOnly!==false)throw Error('Mobile support flag must be false.');
const files={};const sums=[];
for(const file of ['main.js','manifest.json','styles.css','THIRD-PARTY-NOTICES.md']){const data=new Uint8Array(await fs.readFile(file));files[`inkspace/${file}`]=data;sums.push(`${crypto.createHash('sha256').update(data).digest('hex')}  ${file}`);}
for(const file of ['INSTALL.md','README.md','VALIDATION.md','CHANGELOG.md'])files[file]=new Uint8Array(await fs.readFile(file));
const bundle=zipSync(files,{level:9});const output=path.resolve('..',`inkspace-${manifest.version}.zip`);await fs.writeFile(output,bundle);sums.push(`${crypto.createHash('sha256').update(bundle).digest('hex')}  ${path.basename(output)}`);await fs.writeFile(path.resolve('..','inkspace-SHA256SUMS.txt'),sums.join('\n')+'\n');
console.log(`Packaged ${output} (${bundle.length} bytes, ${Object.keys(files).length} files).`);
