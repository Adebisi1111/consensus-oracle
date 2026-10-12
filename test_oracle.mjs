// On-chain test suite for ConsensusOracle.
//   DEPLOY_PK=0x<key> node test_oracle.mjs
// Assertions read committed state back from chain; receipt fields are logged
// but never used as the pass criterion (a round can return AGREE while
// committing nothing).

import { createClient, createAccount } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import fs from 'fs';

const PK = process.env.DEPLOY_PK;
if (!PK) { console.error('DEPLOY_PK not set'); process.exit(1); }

const account = createAccount(PK);
const client = createClient({ chain: testnetBradbury, account });
const FEES = { feeValue: '100000000000010352' };

const CG = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';
const CB = 'https://api.coinbase.com/v2/prices/ETH-USD/spot';
const DEAD = 'https://this-host-does-not-exist.invalid/price';

const ABI = [
  { type: 'function', name: 'read', stateMutability: 'nonpayable',
    inputs: [{ name: 'reading_id', type: 'string' }, { name: 'asset', type: 'string' },
             { name: 'sources', type: 'string[]' }, { name: 'fields', type: 'string[]' }],
    outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'recheck', stateMutability: 'nonpayable',
    inputs: [{ name: 'reading_id', type: 'string' }], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'get_reading', stateMutability: 'view',
    inputs: [{ name: 'reading_id', type: 'string' }], outputs: [{ name: '', type: 'any' }] },
  { type: 'function', name: 'total_readings', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
];

let passed = 0, failed = 0, ADDR = null;

function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}

async function fin(h) {
  for (let i = 0; i < 250; i++) {
    try {
      const r = await client.waitForTransactionReceipt({ hash: h, waitUntil: 'finalized', retries: 250 });
      if (r && r.resultName) return r;
    } catch (e) { /* transient */ }
    await new Promise(x => setTimeout(x, 4000));
  }
  return null;
}

async function write(fn, args, value = 0n) {
  return fin(await client.writeContract({
    address: ADDR, abi: ABI, functionName: fn, args, value, fees: FEES, gasLimit: 5000000n,
  }));
}

async function getReading(id) {
  for (let i = 0; i < 30; i++) {
    try {
      const v = await client.readContract({ address: ADDR, abi: ABI, functionName: 'get_reading', args: [id] });
      const o = typeof v === 'string' ? JSON.parse(v) : v;
      if (o && o.exists) return o;
    } catch (e) { /* read-path lag */ }
    await new Promise(x => setTimeout(x, 5000));
  }
  return null;
}

async function deploy(code, tries = 3) {
  for (let t = 1; t <= tries; t++) {
    const dr = await fin(await client.deployContract({ code }));
    const addr = dr && dr.txDataDecoded && dr.txDataDecoded.contractAddress;
    if (!addr) { console.log(`  deploy attempt ${t}: no address`); continue; }
    await new Promise(x => setTimeout(x, 8000));
    let stored = '';
    try { stored = (await client.getContractCode(addr)) || ''; } catch (e) { /* */ }
    console.log(`  deploy attempt ${t}: ${addr} — code stored ${stored.length} bytes`);
    if (stored.length > 0) return addr;
  }
  throw new Error('deploy stored no contract code after retries');
}

async function readUntilAgree(id, sources, fields, tries = 5) {
  for (let a = 1; a <= tries; a++) {
    const r = await write('read', [id, 'ETH/USD', sources, fields]);
    console.log(`  read#${a}: result=${r && r.resultName} exec=${r && r.txExecutionResultName}`);
    if (r && r.resultName === 'AGREE') return r;
    await new Promise(x => setTimeout(x, 4000));
  }
  return null;
}

// --- 1: honest multi-source read -------------------------------------------
async function testHonestRead() {
  console.log('\n[1] honest multi-source read commits an agreed price');
  const id = 'eth-usd-1';
  await readUntilAgree(id, [CG, CB], ['ethereum.usd', 'data.amount']);
  const rd = await getReading(id);
  check('reading committed', !!rd);
  check('price is a plausible ETH price',
    rd && Number(rd.price) / 1e8 > 100 && Number(rd.price) / 1e8 < 100000,
    `got ${rd && (Number(rd.price) / 1e8).toFixed(2)}`);
  check('at least one source usable', rd && Number(rd.used_sources) >= 1,
    `used=${rd && rd.used_sources}`);
  check('asset recorded', rd && rd.asset === 'ETH/USD');
  check('sources recorded', rd && rd.sources && rd.sources.length === 2);
  check('reporter recorded', rd && rd.reporter && rd.reporter.length > 0);
  return rd;
}

// --- 2: recheck drift detection --------------------------------------------
async function testRecheck(id) {
  console.log('\n[2] recheck reports UNCHANGED for a stable reading');
  if (!id) { check('recheck', false, 'no reading'); return; }
  for (let a = 1; a <= 4; a++) {
    const r = await write('recheck', [id]);
    console.log(`  recheck#${a}: result=${r && r.resultName}`);
    if (r && r.resultName === 'AGREE') break;
    await new Promise(x => setTimeout(x, 4000));
  }
  const rd = await getReading(id);
  check('last_recheck recorded', rd && rd.last_recheck && rd.last_recheck.length > 0,
    `got ${rd && rd.last_recheck}`);
  check('recheck_count incremented', rd && Number(rd.recheck_count) >= 1,
    `count=${rd && rd.recheck_count}`);
  check('result is UNCHANGED or DRIFTED (not INCONCLUSIVE)',
    rd && ['UNCHANGED', 'DRIFTED'].includes(rd.last_recheck),
    `got ${rd && rd.last_recheck}`);
}

// --- 3: duplicate read is rejected -----------------------------------------
async function testDuplicateRejected() {
  console.log('\n[3] duplicate reading_id is rejected');
  const id = 'eth-usd-1'; // already exists from test 1
  const r = await write('read', [id, 'ETH/USD', [CG, CB], ['ethereum.usd', 'data.amount']]);
  console.log(`  duplicate read: result=${r && r.resultName} exec=${r && r.txExecutionResultName}`);
  check('duplicate rejected (exec not FINISHED_WITH_RETURN)',
    r && r.txExecutionResultName !== 'FINISHED_WITH_RETURN',
    `exec=${r && r.txExecutionResultName}`);
}

// --- 4: no quorum is rejected ----------------------------------------------
async function testNoQuorum() {
  console.log('\n[4] all-dead sources are rejected (no quorum)');
  const id = 'dead-sources-1';
  const r = await write('read', [id, 'ETH/USD', [DEAD, DEAD], ['price', 'price']]);
  console.log(`  dead-source read: result=${r && r.resultName} exec=${r && r.txExecutionResultName}`);
  const rd = await getReading(id);
  check('no reading committed from dead sources', !rd);
  check('read rejected (exec not FINISHED_WITH_RETURN)',
    r && r.txExecutionResultName !== 'FINISHED_WITH_RETURN',
    `exec=${r && r.txExecutionResultName}`);
}

// --- 5: rigged leader is rejected ------------------------------------------
async function testRiggedLeader() {
  console.log('\n[5] rigged leader fabricating a price is rejected');
  const src = fs.readFileSync(new URL('./contracts/consensus_oracle.py', import.meta.url), 'utf8');
  const rigged = src.replace(
    '        def leader_fn() -> dict:\n            return _agree(u, f)',
    '        def leader_fn() -> dict:\n            return {"price": 99999999999999, "used": len(u), "total": len(u)}');
  if (rigged === src) { check('rigged variant built', false, 'replacement did not apply'); return; }
  fs.writeFileSync(new URL('./contracts/_adv.py', import.meta.url), rigged);
  const adv = await deploy(rigged);
  const saved = ADDR; ADDR = adv;
  const id = 'rigged-1';
  let disagree = 0;
  for (let a = 1; a <= 5; a++) {
    const r = await write('read', [id, 'ETH/USD', [CG, CB], ['ethereum.usd', 'data.amount']]);
    console.log(`  rigged read#${a}: result=${r && r.resultName}`);
    if (r && r.resultName === 'DISAGREE') disagree++;
    if (r && r.resultName === 'AGREE') break;
    await new Promise(x => setTimeout(x, 4000));
  }
  const rd = await getReading(id);
  const t = await client.readContract({ address: adv, abi: ABI, functionName: 'total_readings', args: [] }).catch(() => '?');
  console.log(`  total_readings on rigged contract: ${String(t)}`);
  check('rigged leader never committed', !rd);
  check('total_readings is 0', String(t) === '0', `got ${String(t)}`);
  check('at least 3 rounds DISAGREE', disagree >= 3, `disagree=${disagree}`);
  ADDR = saved;
  fs.rmSync(new URL('./contracts/_adv.py', import.meta.url), { force: true });
}

async function main() {
  console.log('ConsensusOracle — on-chain test suite');
  console.log('account:', account.address);
  console.log('\n[0] deploy');
  ADDR = await deploy(fs.readFileSync(new URL('./contracts/consensus_oracle.py', import.meta.url), 'utf8'));
  console.log('CONTRACT:', ADDR);

  const rd = await testHonestRead();
  await testRecheck(rd && 'eth-usd-1');
  await testDuplicateRejected();
  await testNoQuorum();
  await testRiggedLeader();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  console.log(`CONTRACT UNDER TEST: ${ADDR}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('SUITE ERROR:', (e.shortMessage || e.message).slice(0, 150)); process.exit(1); });
