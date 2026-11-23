const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const commands=[['price','btc','--json'],['top','3','--json'],['gainers','3','--json'],['losers','3','--json'],['trending','3','--json'],['ohlcv','BTC','--json'],['compare','BTC,ETH','--json'],['global','--json'],['fng','--json'],['map','BTC','--json'],['dex','pairs','uniswap-v3','ethereum','2','--json'],['ask','top 3 trending','--json'],['ask','global market','--json'],['ask','fear and greed','--json'],['ask','top 3','--json']];
const results=[];
for(const args of commands){const r=spawnSync(process.execPath,['cmc-agent.js',...args,'--trace'],{encoding:'utf8',timeout:20000});let parsed;try{parsed=JSON.parse(r.stdout);}catch{};const record={args,exit:r.status,valid_json:!!parsed,stdout:parsed??r.stdout,stderr:r.stderr};results.push(record);console.log(args.join(' ')+': '+r.status+(parsed?' JSON OK':''));}
const pairs=results.find(r=>r.args[0]==='dex')?.stdout;
if(Array.isArray(pairs)&&pairs[0]?.contract_address){const args=['dex','pair','ethereum',pairs[0].contract_address,'--json','--trace'];const r=spawnSync(process.execPath,['cmc-agent.js',...args],{encoding:'utf8',timeout:20000});let parsed;try{parsed=JSON.parse(r.stdout);}catch{}results.push({args,exit:r.status,valid_json:!!parsed,stdout:parsed??r.stdout,stderr:r.stderr});console.log('dex pair: '+r.status);}
fs.writeFileSync(path.join('evidence','live-sweep.json'),JSON.stringify({recorded_at:new Date().toISOString(),results},null,2));
if(results.some(r=>r.exit!==0||!r.valid_json))process.exitCode=1;
