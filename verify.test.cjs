const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
function run(args, mode='full') {return spawnSync(process.execPath,['--require',path.join(__dirname,'mock.cjs'),path.join(__dirname,'cmc-agent.js'),...args,'--json'],{encoding:'utf8',env:{...process.env,CMC_TEST_MODE:mode,CMC_API_KEY:'fixture-key-not-real',CMC_CONFIG_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'cmc-test-'))}});}

test('verify BTC full fixture is fully trusted',()=>{
  const r=run(['verify','BTC'],'full');
  assert.equal(r.status,0,r.stderr);
  const v=JSON.parse(r.stdout);
  assert.equal(v.symbol,'BTC');
  assert.equal(v.trust_score,100);
  assert.equal(v.verdict,'TRUSTED');
  assert.equal(v.checks.length,6);
});
test('verify reports every check with points, max and detail',()=>{
  const v=JSON.parse(run(['verify','BTC'],'full').stdout);
  for(const c of v.checks){assert.ok(c.name);assert.ok(Number.isFinite(c.points));assert.ok(Number.isFinite(c.max));assert.ok(c.detail);}
  assert.deepEqual(v.context.endpoints,['/v2/cryptocurrency/quotes/latest','/v1/cryptocurrency/map','/v2/cryptocurrency/ohlcv/latest']);
  assert.ok(v.note.includes('Not financial advice'));
});
test('symbol collisions reduce resolution clarity',()=>{
  const v=JSON.parse(run(['verify','BTC'],'collision').stdout);
  const c=v.checks.find(c=>c.name==='resolution_clarity');
  assert.equal(c.points,16);
  assert.match(c.detail,/2 active matches/);
  assert.equal(v.context.active_symbol_matches,2);
});
test('depegged stablecoin is unreliable regardless of other checks',()=>{
  const r=run(['verify','USDT'],'depeg');
  assert.equal(r.status,0,r.stderr);
  const v=JSON.parse(r.stdout);
  assert.equal(v.verdict,'UNRELIABLE');
  assert.equal(v.checks.find(c=>c.name==='stablecoin_peg').points,0);
  assert.ok(v.checks.some(c=>c.name==='verdict_cap'));
});
test('verify fails closed on empty response',()=>{
  const r=run(['verify','BTC'],'empty');
  assert.notEqual(r.status,0);
  assert.equal(r.stdout,'');
});
test('verify fails closed when the network throws',()=>{
  const r=run(['verify','BTC'],'network');
  assert.notEqual(r.status,0);
  assert.doesNotMatch(r.stderr,/fixture-key-not-real/);
});
test('verify requires a symbol',()=>assert.notEqual(run(['verify'],'full').status,0));
