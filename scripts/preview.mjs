// Local development only. Production files run directly from the router SSD.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const trials = process.argv.includes('--trials');
const root = path.resolve(trials ? 'dist' : 'web');
const allowedOrigins = new Set(['http://192.168.0.1', 'http://192.168.0.1:8000']);
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
const server = http.createServer(async (req,res) => {
  if (allowedOrigins.has(req.headers.origin)) res.setHeader('Access-Control-Allow-Origin',req.headers.origin);
  res.setHeader('Cache-Control','no-store');
  try {
    const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if (pathname === '/deploy-manifest') {
      const assets=['index.html','style.css','core.js','config.js','app.js','storage.js','favicon.svg'];
      const names = trials ? ['index.html',...['guest','supabase'].flatMap(folder=>assets.map(name=>folder+'/'+name)),'supabase/setup.sql'] : [...assets];
      const files = await Promise.all(names.map(async name=>({name,content:await fs.readFile(path.join(root,name),'utf8')})));
      res.setHeader('Content-Type',mime['.json']); return res.end(JSON.stringify(files));
    }
    const filename = path.resolve(root,'.'+(pathname === '/'?'/index.html':pathname));
    if (!filename.startsWith(root+path.sep)) { res.writeHead(403); return res.end(); }
    const body = await fs.readFile(filename);
    res.setHeader('Content-Type',mime[path.extname(filename)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(8787,'127.0.0.1',()=>console.log('Development preview: http://127.0.0.1:8787'));
