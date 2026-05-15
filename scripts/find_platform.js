const fs = require('fs');
const path = require('path');
const dir = path.resolve('node_modules');
const hits = [];
function walk(d){
  let entries;
  try{ entries = fs.readdirSync(d); } catch { return; }
  for(const name of entries){
    const p = path.join(d,name);
    let stat;
    try{ stat = fs.statSync(p); } catch { continue; }
    if(stat.isDirectory()) walk(p);
    else {
      try{
        const s = fs.readFileSync(p,'utf8');
        if(s.includes("platform: 'browser'") || s.includes('platform: "browser"') || s.includes("platform: 'node'") || s.includes('platform: "node"') ) hits.push(p);
      } catch {}
    }
  }
}
walk(dir);
console.log(hits.join('\n'));
