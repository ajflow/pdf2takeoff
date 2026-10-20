import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, sep } from 'node:path';
const root=dirname(fileURLToPath(import.meta.url));
const types={'.html':'text/html','.json':'application/json','.png':'image/png','.pdf':'application/pdf','.csv':'text/csv'};
const server=createServer(async(req,res)=>{
  try{const url=new URL(req.url,'http://localhost');const file=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/review.html':url.pathname));
    if(!file.startsWith(root+sep)){res.writeHead(403);res.end();return;}
    const body=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]??'text/plain','Cache-Control':'no-store'});res.end(body);
  }catch{res.writeHead(404);res.end('Not found. Run the experiment first.');}
});
server.listen(5174,'127.0.0.1',()=>console.log('Legend review: http://127.0.0.1:5174'));
