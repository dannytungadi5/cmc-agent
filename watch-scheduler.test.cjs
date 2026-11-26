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
function addRule(dir, mode, ruleArgs) {
  const r = run(['watch','add',...ruleArgs],mode,dir);
  assert.equal(r.status,0,r.stderr);
}

test('single-shot watch run exits 2 when a rule fires',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmc-test-'));
  addRule(dir,'ok',['BTC','--below','200']);
  const r=run(['watch','run'],'ok',dir);
  assert.equal(r.status,2,r.stderr);
  assert.match(r.stdout,/ALERT/);
});

test('single-shot watch run --json exits 2 and reports fired',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmc-test-'));
  addRule(dir,'ok',['BTC','--below','200']);
  const r=run(['watch','run','--json'],'ok',dir);
  assert.equal(r.status,2,r.stderr);
  assert.equal(JSON.parse(r.stdout).fired.length,1);
});

test('single-shot watch run exits 0 when nothing fires',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmc-test-'));
  addRule(dir,'ok',['BTC','--above','200']);
  const r=run(['watch','run','--json'],'ok',dir);
  assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).fired.length,0);
});

test('scheduler loop emits one JSON document per cycle and edge-triggers',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmc-test-'));
  addRule(dir,'full',['BTC','--below','200']);
  const r=run(['watch','run','--every','1','--max','3','--json'],'full',dir);
  assert.equal(r.status,2,r.stderr);
  const lines=r.stdout.trim().split('\n').map(l=>JSON.parse(l));
  assert.equal(lines.length,3);
  assert.deepEqual(lines.map(l=>l.cycle),[1,2,3]);
  assert.equal(lines[0].new_alerts.length,1);
  assert.equal(lines[1].new_alerts.length,0);
  assert.equal(lines[1].active_rules.length,1);
  assert.equal(lines[2].new_alerts.length,0);
  assert.equal(lines[2].cleared.length,0);
});

test('scheduler loop reports cleared after the condition resets',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmc-test-'));
  addRule(dir,'flip',['BTC','--above','250']);
  // flip mode prices per fetch: 100 (cycle 1, no fire), 300 (cycle 2, fires), 100 (cycle 3, clears)
  const r=run(['watch','run','--every','1','--max','3','--json'],'flip',dir);
  assert.equal(r.status,2,r.stderr);
  const lines=r.stdout.trim().split('\n').map(l=>JSON.parse(l));
  assert.equal(lines.length,3);
  assert.equal(lines[0].fired.length,0);
  assert.equal(lines[1].new_alerts.length,1);
  assert.equal(lines[2].new_alerts.length,0);
  assert.equal(lines[2].cleared.length,1);
  assert.equal(lines[2].active_rules.length,0);
});

for (const bad of [['watch','run','--every','0'],['watch','run','--every','abc'],['watch','run','--every','86401'],['watch','run','--max','2'],['watch','run','--every','1','--max','0']]) {
  test('reject scheduler flags '+bad.slice(2).join(' '),()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmc-test-'));
    addRule(dir,'ok',['BTC','--above','1']);
    const r=run(bad,'ok',dir);
    assert.equal(r.status,1);
    assert.equal(r.stdout,'');
  });
}
