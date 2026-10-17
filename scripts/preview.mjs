import * as esbuild from 'esbuild';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
await esbuild.build({entryPoints:['preview/main.ts'],bundle:true,format:'iife',target:'es2020',outfile:'preview/bundle.js',sourcemap:true});
const root=process.cwd();const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.pdf':'application/pdf'};
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');const rel=url.pathname==='/'?'preview/index.html':decodeURIComponent(url.pathname).replace(/^\//,'');const full=path.resolve(root,rel);if(!full.startsWith(root+path.sep))throw Error('Invalid path');const data=await fs.readFile(full);res.writeHead(200,{'Content-Type':mime[path.extname(full)]??'application/octet-stream','Cache-Control':'no-store'});res.end(data);}catch{res.writeHead(404);res.end('Not found');}});
server.listen(Number(process.env.PORT??4173),'127.0.0.1',()=>console.log('Inkspace editor preview: http://127.0.0.1:4173'));
