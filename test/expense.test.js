const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Point store.js at a throwaway directory before requiring expense.js, since
// store.js resolves DATA_DIR at require-time.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-splitbot-test-'));

const {
  parseExpenseCommand,
  addExpense,
  recordPayment,
  computeBalances,
  simplifyDebts,
} = require('../expense');

const GROUP = 'group@g.us';
const P1 = '1@s.whatsapp.net';
const P2 = '2@s.whatsapp.net';
const P3 = '3@s.whatsapp.net';

test('parseExpenseCommand splits equally between payer and mentioned people', () => {
  const { amount, description, shares } = parseExpenseCommand(
    '/expense 300 dinner @2 @3',
    [P2, P3],
    P1
  );
  assert.equal(amount, 300);
  assert.equal(description, 'dinner');
  const byJid = Object.fromEntries(shares.map((s) => [s.jid, s.amount]));
  assert.equal(byJid[P1], 100);
  assert.equal(byJid[P2], 100);
  assert.equal(byJid[P3], 100);
});

test('parseExpenseCommand rejects a non-positive amount', () => {
  assert.throws(() => parseExpenseCommand('/expense 0 dinner @2', [P2], P1));
});

test('computeBalances nets expenses to zero-sum', async () => {
  await addExpense(GROUP, P1, 300, 'dinner', [
    { jid: P1, amount: 100 },
    { jid: P2, amount: 100 },
    { jid: P3, amount: 100 },
  ]);
  const { net } = computeBalances(GROUP);
  assert.equal(net[P1], 200);
  assert.equal(net[P2], -100);
  assert.equal(net[P3], -100);
});

test('recordPayment settles debts and drops them from the settle list', async () => {
  await recordPayment(GROUP, P2, P1, 100);
  await recordPayment(GROUP, P3, P1, 100);
  const { net } = computeBalances(GROUP);
  assert.equal(net[P1], 0);
  assert.equal(net[P2], 0);
  assert.equal(net[P3], 0);
  assert.deepEqual(simplifyDebts(net), []);
});
