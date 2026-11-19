// Огляд 16.11.2026 — «Звірка з банком» цілою панеллю (test/lib/panel-harness.js): застереження «Внести в CRM» (позика, зняття готівки
// в касі, повернення нашого платежу, «Оплата частинами») і «Записи з неправильним типом» (лише запис поруч за датою, не автоматичний,
// не зарплатний; перед зміною запис перечитується).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, rec, tx, bankJson } = require('./lib/panel-harness.js');
const BP = require('../ui/bank-panel.js');

const FOP = [{ id: 5, name: 'ФОП Хоменко Всеволод Приват 1234', currency_id: 1, balance: 100000, deleted_at: null }];
const fopBank = (txs, sum) => bankJson([{ acc: 'UA000000000000000000000001234', ccy: 'UAH', name: 'ФОП Хоменко Всеволод Сергійович', client: 'ФОП Хоменко', opening: 100000 - sum, closing: 100000, transactions: txs }]);

test('«Внести в CRM»: позика, зняття готівки в касі банку, повернення нашого платежу — із застереженням; «Оплата частинами» — не створюється', async () => {
  const txs = [
    tx('10.10.2026', 100000, 'надання повортної фінансовой допомоги від 10.10.2026р. Без ПДВ.', 'UA_S', 'Сушенко Микола Сергійович ФОП'),
    tx('11.10.2026', -30000, 'Повернення поворотної фінансової допомоги зг. дог. 1 від 10.10.2026', 'UA_S', 'Сушенко Микола Сергійович ФОП'),
    tx('12.10.2026', -40000, 'Видача 4246 **** **** 1421 {{DABR=K1M0}}', 'UA003052990000010021300331322', 'Каса Приватбанку Вакулюк З Є'),
    tx('13.10.2026', 38700, 'Повернення помилково сплачених коштів', 'UA_G', 'Горобченко Дмитро Григорович'),
    tx('14.10.2026', 1233.15, 'Оплата частинами.Сума договору:1279.20 грн. Замовлення_77 Договір: 5', 'UA_OCH', 'Розрахунки  "Оплата Частинами"'),
    tx('15.10.2026', 2500, 'Оплата юридичної допомоги частинами, перший платіж', 'UA_P', 'Петренко Іван Іванович'),
    tx('16.10.2026', -800, 'Оплата за послуги зв\'язку {{X=1}}', 'UA_T', 'ТОВ ТЕЛЕКОМ')];
  const r = await run({ accounts: FOP, records: [], banks: [fopBank(txs, 100000 - 30000 - 40000 + 38700 + 1233.15 + 2500 - 800)], open: [5], create: true });
  assert.deepEqual(r.errors, []);
  const by = a => r.S.lastRecs.find(p => p.amount === a);
  // позика — обидва напрямки: застереження, запис не блокується (вирішує людина), у масове позначення не йде
  assert.match(by(100000).payroll, /поворотну фінансову допомогу \(позику\)/);
  assert.match(by(30000).payroll, /позику/);
  assert.equal(by(100000).block, '');
  // зняття готівки: застереження, коментар без касира й «{{…}}»
  assert.match(by(40000).payroll, /зняття готівки в касі банку/);
  assert.equal(by(40000).comment, 'Зняття готівки в касі банку, картка *1421');
  assert.match(by(38700).payroll, /повернення нашого платежу/);
  // «Оплата частинами» банку — як еквайринг: не пропонується; звичайна оплата клієнта зі словом «частинами» — як була
  assert.match(by(1233.15).block, /еквайрингу чи платіжної системи/);
  assert.deepEqual([by(2500).block, by(2500).payroll], ['', '']);
  // службова мітка банку в коментар не потрапляє й у звичайної операції
  assert.equal(by(800).comment, 'ТОВ ТЕЛЕКОМ: Оплата за послуги зв\'язку');
  assert.equal(by(800).payroll, '');
  for (const t of ['схоже на поворотну фінансову допомогу (позику)', 'зняття готівки в касі банку: це не оплата контрагенту', 'схоже на повернення нашого платежу']) assert.ok(r.txt.includes(t), t);
});

// «Записи з неправильним типом»: рахунки 1 → 2, у виписках обох — переказ 5 000 від 29.10
const IB1 = 'UA000000000000000000000008112', IB2 = 'UA000000000000000000000007777', MKT = 'ТОВ СЕРВІС МАРКЕТ';
const ACC2 = () => [{ id: 1, name: 'Приват ТОВ СЕРВІС МАРКЕТ 8112', currency_id: 1, balance: 95000, deleted_at: null },
  { id: 2, name: 'Приват ТОВ СЕРВІС МАРКЕТ 7777', currency_id: 1, balance: 5000, deleted_at: null }];
const BANK2 = () => [bankJson([
  { acc: IB1, ccy: 'UAH', name: 'ТОВ', client: 'ТОВ Маркет', opening: 100000, closing: 95000, transactions: [tx('29.10.2026', -5000, 'Переказ власних коштів', IB2, MKT)] },
  { acc: IB2, ccy: 'UAH', name: 'ТОВ', client: 'ТОВ Маркет', opening: 0, closing: 5000, transactions: [tx('29.10.2026', 5000, 'Переказ власних коштів', IB1, MKT)] }])];
const man = (r, extra) => Object.assign(r, { is_manual: true }, extra);
const AUTO = (id, day) => Object.assign(rec(id, day, [[1, 2, 5000]], 'Підтвердження виведення коштів з балансу — Петренко'), { is_manual: false, date: `${day}T09:13:27.000000Z`, created_at: `${day}T09:13:27.000000Z` });

test('«Записи з неправильним типом»: автоматичний запис з тією самою сумою за 27 днів до переказу — не пропонується; переказ — «немає в CRM»', async () => {
  const r = await run({ accounts: ACC2(), records: [AUTO(7, '2026-10-02')], banks: BANK2(), create: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.S.lastTypes, []);
  assert.ok(!r.txt.includes('Записи з неправильним типом'));
  assert.deepEqual(r.S.lastProps.map(p => [p.amount, p.date]), [[5000, '2026-10-29']], 'переказ пропонується створити');
});

test('«Записи з неправильним типом»: запис поруч за датою — автоматичний і зарплатний лише з поясненням, ручний — можна змінити', async () => {
  let r = await run({ accounts: ACC2(), records: [AUTO(7, '2026-10-28')], banks: BANK2(), create: true });
  assert.deepEqual(r.S.lastTypes.map(p => [p.item.id, /створено автоматично/.test(p.block)]), [[7, true]]);
  assert.ok(!/data-ton(?! disabled)[^>]* checked/.test(r.out) && /data-ton disabled/.test(r.out), 'галочку поставити не можна');
  const sal = man(rec(8, '2026-10-29', [[1, 2, 5000]], 'ЗП за жовтень'));
  Object.assign(sal.payments[0], { pnl_category_id: 51, pnl_operation_id: 38 });
  r = await run({ accounts: ACC2(), records: [sal], banks: BANK2(), create: true });
  assert.deepEqual(r.S.lastTypes.map(p => [p.item.id, /зарплатна стаття/.test(p.block)]), [[8, true]]);
  r = await run({ accounts: ACC2(), records: [man(rec(9, '2026-10-30', [[1, 2, 5000]], 'переказ на 7777'))], banks: BANK2(), create: true });
  assert.deepEqual(r.S.lastTypes.map(p => [p.item.id, p.block]), [[9, '']]);
});

/* «Змінити позначені» з імітацією запису за ID і PUT (у спільному стенді їх немає): mount панелі отримує api з get('invoice-payment/ID') і put. */
async function runPut(records, change) {
  const mount = BP.mount, puts = [];
  BP.mount = (el, opts) => {
    const get = opts.api.get;
    opts.api.get = async p => { const m = /^invoice-payment\/(\d+)$/.exec(p); if (!m) return get(p); const x = records.find(q => q.id === Number(m[1])); if (!x) throw Object.assign(new Error('nf'), { status: 404 }); return JSON.parse(JSON.stringify(x)); };
    opts.api.put = async (p, body) => {
      puts.push({ path: p, body });
      const x = records.find(q => q.id === Number(p.split('/')[1])), amt = x.payments[0].amount;
      x.payments = [{ id: 1, invoice_id: Number(body.invoice_from), operation: 4, amount: amt, deleted_at: null }, { id: 2, invoice_id: Number(body.invoice_to), operation: 3, amount: amt, deleted_at: null }];
      return { status: 200, json: {} };
    };
    // посилання «Повернути як було» панель шукає в примітках після зміни (у стенді querySelectorAll порожній)
    const P = mount(el, opts), notes = el.querySelector('[data-b="notes"]');
    notes.querySelectorAll = s => [notes.querySelector(s)];
    return P;
  };
  try {
    const r = await run({ accounts: ACC2(), records, banks: BANK2(), create: true });
    assert.deepEqual(r.S.lastTypes.map(p => p.block), ['']);
    r.S.tp.get(r.S.lastTypes[0].key).on = true;
    if (change) change(records); // зміна в CRM — уже після звірки
    await r.click('tchange');
    return { r, puts };
  } finally { BP.mount = mount; }
}

test('«Змінити позначені»: ручний запис поруч за датою стає переказом; якщо після звірки він став автоматичним чи змінив дату — пропуск без PUT', async () => {
  let recs = [man(rec(9, '2026-10-30', [[1, 2, 5000]], 'переказ на 7777'))];
  let o = await runPut(recs);
  assert.equal(o.puts.length, 1);
  assert.deepEqual(recs[0].payments.map(x => [x.invoice_id, x.operation, x.amount]), [[1, 4, 5000], [2, 3, 5000]]);
  recs = [man(rec(9, '2026-10-30', [[1, 2, 5000]], 'переказ на 7777'))];
  o = await runPut(recs, list => { list[0].is_manual = false; });
  assert.equal(o.puts.length, 0);
  assert.match(o.r.files.map(f => f.data).join('\n'), /запис автоматичний або з ліда/);
  recs = [man(rec(9, '2026-10-30', [[1, 2, 5000]], 'переказ на 7777'))];
  o = await runPut(recs, list => { list[0].date = '2026-10-12T12:00:00+03:00'; });
  assert.equal(o.puts.length, 0);
  assert.match(o.r.files.map(f => f.data).join('\n'), /дату запису змінили після звірки/);
});
