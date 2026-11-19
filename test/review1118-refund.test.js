// 18.11.2026 — «Зіставлення ШІ» і «Внести в CRM»: повернення коштів клієнту (за зразком випадку 12.11.2026; імена вигадані).
// У банку: −6 000,00 з «ФОП Хоменко … Приват» Гурському, «Часткове повернення коштів зг. заяви…». У реєстрі: погодження Гурському з
// того самого рахунку, але «Вносити» = «ні» (повернень реєстр не вносить), і погодження «Дмитро Кобзар» 6 000,00 з рахунку іншого ФОП.
// До виправлення «Внести в CRM» блокувало операцію: «є погодження «Дмитро Кобзар» … — вносьте його у вкладці «Погодження»».
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, withApprovals, tx, bankJson } = require('./lib/panel-harness.js');
const plain = s => String(s).replace(/[  ]/g, ' ');

const ACC = [{ id: 68, name: 'ФОП Хоменко Всеволод Сергійович Приват', currency_id: 1, balance: 100000, deleted_at: null },
  { id: 83, name: 'ФОП Мазовецька Корнелія Олександрівна Приват', currency_id: 1, balance: 0, deleted_at: null }];
const bank = () => bankJson([{ acc: 'UA000000000000000000000001234', ccy: 'UAH', name: 'ФОП Хоменко Всеволод Сергійович', client: 'ФОП Хоменко', opening: 100000, closing: 94000,
  transactions: [tx('12.10.2026', -6000, 'Часткове повернення коштiв зг. заяви вiд 05.10.2026', 'UA_G', 'Гурський Олександр Олексійович')] }]);
const KUSH = { key: '06.10.2026#k', acc: 83, date: '2026-10-06', amount: 6000, recipient: 'Дмитро Кобзар', content: 'Вивід в адмінці як виконавець з кабінету', id: 0, action: 'так', status: '' };
const GUB = { key: '12.10.2026#g', acc: 68, date: '2026-10-12', amount: 6000, recipient: 'Гурський Олександр Олексійович', content: 'повернення коштів згідно заяви, ІПН …', id: 0, action: 'ні', status: '' };

test('повернення клієнту: погодження є, але реєстр його не вносить («ні») — операцію не блоковано, вносять у «Внести в CRM»; чуже погодження з тією самою сумою не береться', async () => {
  const r = await run({ accounts: ACC, records: [], banks: [bank()], open: [68] });
  assert.deepEqual(r.errors, []);
  await withApprovals(r, [KUSH, GUB]);
  const T = r.S.lastMt;
  assert.deepEqual(T.res.rows.map(m => [m.bank.amount, m.ap.map(a => a.key), !!m.off, m.other]), [[6000, ['12.10.2026#g'], true, false]]);
  assert.deepEqual(T.res.free.ap.map(a => a.key), ['06.10.2026#k']);
  assert.equal(r.S.lastRecs.length, 1);
  const p = r.S.lastRecs[0];
  assert.equal(plain(p.block || ''), '', 'операцію можна внести тут');
  assert.ok(p.rule.reasons.map(plain).includes('погодження «Гурський Олександр Олексійович» 6 000,00 від 12.10.2026 є, але реєстр його не вносить («Вносити» = «ні») — внесіть тут'), p.rule.reasons.join('; '));
  const t = plain(r.txt), mt = t.slice(t.indexOf('Зіставлення ШІ за'));
  assert.ok(mt.includes('реєстр не вносить — внесіть у «Внести в CRM»'), mt.slice(0, 900));
  assert.ok(!mt.includes('з них не все в CRM') && !mt.includes('внесіть у «Погодженні»'), 'пара з «ні» — не проблема');
  assert.ok(!t.includes('є погодження «Дмитро Кобзар»'), 'чуже погодження не блокує операцію');
});

test('повернення клієнту без свого погодження: «Дмитро Кобзар» з іншого рахунку — інша людина, сама сума не пара; операція лишається до внесення', async () => {
  const r = await run({ accounts: ACC, records: [], banks: [bank()] });
  await withApprovals(r, [KUSH]);
  // до виправлення: пара 1:1 з іншого рахунку лише за сумою → «є погодження «Дмитро Кобзар» 6 000,00 … — вносьте його у вкладці «Погодження»»
  assert.deepEqual(r.S.lastMt.res.rows, []);
  assert.equal(plain(r.S.lastRecs[0].block || ''), '');
  assert.ok(plain(r.txt).includes('у банку без погодження: 1'));
});
