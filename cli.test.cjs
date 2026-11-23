const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname);
function run(args, mode='ok', dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmc-test-'))) {
  return spawnSync(process.execPath,['--require',path.join(__dirname,'mock.cjs'),path.join(root,'cmc-agent.js'),...args],{encoding:'utf8',env:{...process.env,CMC_API_KEY:'fixture-key-not-real',CMC_TEST_MODE:mode,CMC_CONFIG_DIR:dir}});
}
function json(args,mode) { const r=run(args,mode); assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout); }
test('lowercase prices normalize and preserve identity and timestamp',()=>{const r=json(['price','btc','--json']);assert.equal(r[0].symbol,'BTC');assert.equal(r[0].id,1);assert.ok(r[0].last_updated);});
test('ask JSON is one parseable document with trace',()=>{const r=json(['ask','price of bitcoin','--json']);assert.equal(r.tools.length,1);assert.equal(r.tools[0].outcome,'success');assert.ok(r.answer.includes('Bitcoin'));});
test('partial quote result fails closed',()=>{const r=run(['price','BTC,ETH','--json']);assert.notEqual(r.status,0);assert.equal(r.stdout,'');assert.match(r.stderr,/ETH/);});
for(const n of ['0','-1','101','NaN','1.2']) test('reject count '+n,()=>assert.notEqual(run(['top',n]).status,0));
for(const n of ['NaN','Infinity','-1','0']) test('reject threshold '+n,()=>assert.notEqual(run(['watch','add','BTC','--above',n]).status,0));
test('reject multiple thresholds',()=>assert.notEqual(run(['watch','add','BTC','--above','10','--below','5']).status,0));
test('corrupt watchlist is not overwritten',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmc-test-'));const f=path.join(dir,'watchlist.json');fs.writeFileSync(f,'broken');assert.notEqual(run(['watch','add','BTC','--above','10'],'ok',dir).status,0);assert.equal(fs.readFileSync(f,'utf8'),'broken');});
test('null move cannot fire an alert',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmc-test-'));assert.equal(run(['watch','add','BTC','--change24h','1'],'ok',dir).status,0);const r=run(['watch','run','--json'],'null',dir);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).fired.length,0);assert.equal(JSON.parse(r.stdout).unavailable.length,1);});
for(const mode of ['apierror','http','badjson','missing','network','stale']) test('fail closed '+mode,()=>{const r=run(['price','BTC','--json'],mode);assert.notEqual(r.status,0);assert.equal(r.stdout,'');assert.doesNotMatch(r.stderr,/fixture-key-not-real/);});
test('losers request ascending server-side order',()=>{const r=run(['losers','2','--json','--trace']);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stderr).tools[0].params.sort_dir,'asc');});
test('ask trending uses the trending endpoint',()=>assert.match(json(['ask','top 2 trending','--json']).tools[0].endpoint,/trending\/latest/));
test('unsupported ask fails without hallucinated answer',()=>assert.notEqual(run(['ask','should I buy bitcoin?','--json']).status,0));
