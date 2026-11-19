// 18.11.2026: покупки HeyGen корп. карткою — Татояна, проєкт США (rules.json → reference.vendor_people), хоч би хто тримав картку
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, bankJson, tx } = require('./lib/panel-harness.js');

test('покупка HeyGen корп. карткою: у коментарі — Татоян Артем (а не тримач картки), проєкт — США; інша покупка тією ж карткою — як раніше', async () => {
  const acc = [{ id: 83, name: 'ФОП Мазовецька Корнелія Олександрівна Приват', currency_id: 1, balance: 0, deleted_at: null },
    { id: 90, name: 'корп. картка 7365 ФОП Мазовецька Корнелія Олександрівна', currency_id: 1, balance: 0, deleted_at: null }];
  const bank = bankJson([{ acc: 'UA003052990000026000700551235', ccy: 'UAH', name: 'ФОП Мазовецька Корнелія Олександрівна', client: 'ФОП Мазовецька', opening: 30000, closing: 30000 - 21100.92 - 500,
    transactions: [tx('30.10.2026', -21100.92, '4246 **** **** 7365 30.10.2026 17:52:07 Цифровi товари: HEYGEN TECHNOLOGY INC., HEYGEN.COM'),
      tx('30.10.2026', -500, '4246 **** **** 7365 30.10.2026 18:10:00 Цифровi товари: NOTION LABS, NOTION.SO')] }]);
  const r = await run({ accounts: acc, records: [], banks: [bank], projects: { 'Україна': 1, 'США': 4 } });
  assert.deepEqual(r.errors, []);
  const h = r.S.lastRecs.find(p => p.amount === 21100.92), n = r.S.lastRecs.find(p => p.amount === 500);
  assert.ok(h && n, JSON.stringify(r.S.lastRecs.map(p => [p.acc, p.amount])));
  assert.equal(h.acc, 90);
  // до виправлення: «… Симонович Сергій: …» (тримач картки 7365 з 28.10) і проєкт рахунку
  assert.match(r.S.rp.get(h.key).comment, /^Heygen.* 30\.10 17:52 Татоян Артем: 21100\.92 UAH, корп\. картка 7365$/);
  assert.equal(r.S.rp.get(h.key).proj, 4);
  assert.match(r.S.rp.get(n.key).comment, /Симонович Сергій/);
  assert.notEqual(r.S.rp.get(n.key).proj, 4);
});