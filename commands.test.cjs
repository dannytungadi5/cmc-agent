const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
function run(args, mode='ok') {return spawnSync(process.execPath,['--require',path.join(__dirname,'mock.cjs'),path.join(__dirname,'cmc-agent.js'),...args,'--json'],{encoding:'utf8',env:{...process.env,CMC_TEST_MODE:mode,CMC_API_KEY:'fixture-key-not-real',CMC_CONFIG_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'cmc-test-'))}});}
for (const args of [['top','3'],['gainers','3'],['trending','3'],['ohlcv','BTC'],['compare','BTC,ETH'],['global'],['fng'],['map','BTC'],['dex','pairs','uniswap-v3','ethereum','3'],['dex','pair','ethereum','0x123']]) {
 test('fixture command '+args.join(' '),()=>{const r=run(args,'full');assert.equal(r.status,0,r.stderr);assert.ok(JSON.parse(r.stdout));});
}
for (const args of [['top'],['gainers'],['trending'],['global'],['fng'],['map','BTC'],['dex','pairs','x','y'],['dex','pair','x','y']]) {
 test('empty response rejects '+args.join(' '),()=>{const r=run(args,'empty');assert.notEqual(r.status,0);assert.equal(r.stdout,'');});
}
test('numeric success status accepted',()=>assert.equal(run(['price','BTC'],'numeric').status,0));
test('future quote rejected',()=>assert.notEqual(run(['price','BTC'],'future').status,0));
test('zero quote rejected',()=>assert.notEqual(run(['price','BTC'],'zero').status,0));
test('missing response timestamp rejected',()=>assert.notEqual(run(['price','BTC'],'notime').status,0));
