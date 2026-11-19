// Звірка з банком (core/recon.js): рух рахунків із записів CRM, залишки на дату, звірка з заданим вхідним залишком CRM.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Rc = require('../core/recon.js');

// запис CRM: date — північ за Києвом (UTC+3 улітку), payments — [рахунок, операція, сума]
const rec = (id, kyiv, pays, extra) => ({
  id, date: `${kyiv}T00:00:00+03:00`, comment: 'запис ' + id, task_payment_id: null, deleted_at: null,
  payments: pays.map(([invoice_id, operation, amount], i) => ({ id: id * 10 + i, invoice_id, operation, amount, deleted_at: null })), ...extra,
});

const RECORDS = [
  rec(1, '2026-10-01', [[33, 1, 1000]]),                  // дохід
  rec(2, '2026-10-02', [[33, 2, 250.5]]),                 // витрата
  rec(3, '2026-10-03', [[33, 4, 100], [69, 3, 100]]),     // переказ 33 → 69
  rec(4, '2026-10-05', [[33, 2, 49.5]]),
  rec(5, '2026-10-06', [[33, 2, 999]], { deleted_at: '2026-10-07T10:00:00Z' }), // видалений — не рахується
  rec(6, '2026-10-07', [[69, 6, 50], [36, 5, 1.2]]),      // обмін 69 → 36
];

test('cashflowByAccount: знак за операцією, переказ і обмін — на обох рахунках, видалені пропускаються', () => {
  const m = Rc.cashflowByAccount(RECORDS);
  assert.deepEqual(m.get(33).map(x => [x.id, x.date, x.amount]), [[1, '2026-10-01', 1000], [2, '2026-10-02', -250.5], [3, '2026-10-03', -100], [4, '2026-10-05', -49.5]]);
  assert.deepEqual(m.get(69).map(x => [x.id, x.amount]), [[3, 100], [6, -50]]);
  assert.deepEqual(m.get(36).map(x => [x.id, x.amount]), [[6, 1.2]]);
  // той самий результат, що й cashflowItems для одного рахунку
  assert.deepEqual(m.get(33), Rc.cashflowItems(RECORDS, 33));
});

test('crmBalanceAt: поточний залишок мінус рух після дати', () => {
  const items = Rc.cashflowByAccount(RECORDS).get(33);
  // зараз 600 (1000 − 250.5 − 100 − 49.5), на кінець 02.10 — без переказу й витрати 05.10
  assert.deepEqual(Rc.crmBalanceAt(600, items, '2026-10-02'), { value: 749.5, after: -149.5 });
  assert.deepEqual(Rc.crmBalanceAt(600, items, '2026-10-05'), { value: 600, after: 0 });
  assert.deepEqual(Rc.crmBalanceAt('600.00', items, '2026-09-30'), { value: 0, after: 600 }); // до першого запису — нуль
  assert.deepEqual(Rc.crmBalanceAt(10, [], '2026-10-01'), { value: 10, after: 0 });
});

const PRIVAT = {
  source: 'bank_api', client: 'ПРИКЛАД', from: '2026-10-01', to: '2026-10-05', fetched_at: '06.10.2026 09:00', bank: 'privat',
  accounts: [{
    acc: 'UA000000000000000000000000001', ccy: 'UAH', name: 'ТОВ ПРИКЛАД', bank: 'privat', client: 'ПРИКЛАД', opening: 5000, closing: 5600.5, warnings: [],
    transactions: [
      { DAT_OD: '01.10.2026', TIM_P: '10:00', SUM: '1000.00', TRANTYPE: 'C', OSND: 'оплата', PR_PR: 'r' },
      { DAT_OD: '02.10.2026', TIM_P: '11:00', SUM: '250,50', TRANTYPE: 'D', OSND: 'витрата', PR_PR: 'r' },
      { DAT_OD: '03.10.2026', TIM_P: '12:00', SUM: '77.00', TRANTYPE: 'D', OSND: 'сторно', PR_PR: 'x' }, // не проведена
      { DAT_OD: '05.10.2026', TIM_P: '09:00', SUM: '149.00', TRANTYPE: 'D', OSND: 'витрата', PR_PR: 'r' },
    ],
  }],
};

test('bankBalanceAt: вхідний + рух до дати; на останній день — вихідний залишок виписки; поза випискою — null', () => {
  const [b] = Rc.bankAccounts(PRIVAT, 'test.json');
  assert.equal(b.fileFrom, '2026-10-01');
  assert.deepEqual(Rc.bankBalanceAt(b, '2026-10-01'), { value: 6000, note: 'вхідний залишок виписки + рух до 2026-10-01' });
  assert.equal(Rc.bankBalanceAt(b, '2026-10-03').value, 5749.5);
  // 5000 + 1000 − 250.5 − 149 = 5600.5 = вихідний — без попередження
  assert.deepEqual(Rc.bankBalanceAt(b, '2026-10-05'), { value: 5600.5, note: 'вихідний залишок виписки', warn: '' });
  assert.equal(Rc.bankBalanceAt(b, '2026-09-30').value, null);
  assert.match(Rc.bankBalanceAt(b, '2026-10-06').note, /лише до 2026-10-05/);
  // вихідний не сходиться з рухом — значення банку, але з попередженням
  const bad = { ...b, closing: 5700 };
  assert.match(Rc.bankBalanceAt(bad, '2026-10-05').warn, /≠ вихідний 5700/);
  // без вхідного залишку: лише вихідний на останній день
  const noOpen = { ...b, opening: null };
  assert.equal(Rc.bankBalanceAt(noOpen, '2026-10-03').value, null);
  assert.equal(Rc.bankBalanceAt(noOpen, '2026-10-05').value, 5600.5);
});

test('bankBalanceAt для моно: суми в копійках, дата за Києвом', () => {
  const t = s => Math.floor(new Date(s).getTime() / 1000);
  const json = { source: 'bank_api', client: 'ФОП Хоменко', from: '2026-10-01', to: '2026-10-02', bank: 'mono', accounts: [{
    acc: 'UA000000000000000000000000002', ccy: 'UAH', name: 'Хоменко ФОП', bank: 'mono', opening: 100, closing: 130, warnings: [],
    transactions: [{ id: 'a', time: t('2026-10-01T23:30:00+03:00'), amount: 5000, description: 'оплата' }, { id: 'b', time: t('2026-10-02T08:00:00+03:00'), amount: -2000, description: 'витрата' }],
  }] };
  const [b] = Rc.bankAccounts(json, 'mono.json');
  assert.deepEqual(b.rows.map(x => [x.date, x.amount]), [['2026-10-01', 50], ['2026-10-02', -20]]);
  assert.equal(Rc.bankBalanceAt(b, '2026-10-01').value, 150);
  assert.equal(Rc.bankBalanceAt(b, '2026-10-02').value, 130);
});

test('reconcile: заданий вхідний залишок CRM замість суми записів до періоду', () => {
  const [b] = Rc.bankAccounts(PRIVAT, 'test.json');
  const cf = Rc.cashflowByAccount(RECORDS).get(33);
  const plain = Rc.reconcile(b, cf, '2026-10-01', '2026-10-05');
  assert.equal(plain.cOpen, 0); // записів до 01.10 немає
  const R = Rc.reconcile(b, cf, '2026-10-01', '2026-10-05', { cOpen: 5000 });
  assert.equal(R.cOpen, 5000);
  assert.equal(R.dOpen, 0);
  // у CRM переказ 100 і витрата 49.5 замість банківських 149 → вихідний CRM 5600 проти 5600.5
  assert.equal(R.cClose, 5600);
  assert.equal(R.bClose, 5600.5);
  assert.equal(R.dClose, -0.5);
  assert.deepEqual(R.bOnly.map(x => x.amount), [-149]);
  assert.deepEqual(R.cOnly.map(x => x.amount).sort((a, b) => a - b), [-100, -49.5]);
});

test('periodRecon: залишки й обороти за період, кількість операцій за кожною сумою', () => {
  const [b] = Rc.bankAccounts(PRIVAT, 'test.json');
  // CRM: ті самі операції, але 149 внесено двома записами (100 + 49.5) — суми не 1:1
  const cf = Rc.cashflowByAccount(RECORDS).get(33);
  const R = Rc.periodRecon(b, cf, 600 + 5000, '2026-10-01', '2026-10-05');
  assert.equal(R.covered, true);
  assert.deepEqual(R.crm, { open: 5000, close: 5600, cred: 1000, deb: 400, n: 4 });
  assert.deepEqual(R.bank, { open: 5000, close: 5600.5, cred: 1000, deb: 399.5, n: 3 });
  assert.deepEqual(R.diff, { open: 0, close: -0.5, cred: 0, deb: 0.5, n: 1 });
  assert.equal(R.ok, false);
  assert.equal(R.distinct, 5);
  // 1000 і −250.5 сходяться за кількістю; −149 є лише в банку, −100 і −49.5 — лише в CRM
  assert.deepEqual(R.amounts.map(x => [x.amount, x.nB, x.nC, x.d]), [[-149, 1, 0, -1], [-100, 0, 1, 1], [-49.5, 0, 1, 1]]);
});

test('periodRecon: однакові суми рахуються штуками; запис CRM з іншою датою — у підказці near', () => {
  const json = { ...PRIVAT, accounts: [{ ...PRIVAT.accounts[0], opening: 0, closing: 300, transactions: [
    { DAT_OD: '01.10.2026', SUM: '100.00', TRANTYPE: 'C', PR_PR: 'r' },
    { DAT_OD: '02.10.2026', SUM: '100.00', TRANTYPE: 'C', PR_PR: 'r' },
    { DAT_OD: '05.10.2026', SUM: '100.00', TRANTYPE: 'C', PR_PR: 'r' },
  ] }] };
  const [b] = Rc.bankAccounts(json, 'x.json');
  // у CRM два записи по 100 у періоді й третій — 06.10 (уже після періоду)
  const recs = [rec(1, '2026-10-01', [[33, 1, 100]]), rec(2, '2026-10-03', [[33, 1, 100]]), rec(3, '2026-10-06', [[33, 1, 100]])];
  const cf = Rc.cashflowByAccount(recs).get(33);
  const R = Rc.periodRecon(b, cf, 300, '2026-10-01', '2026-10-05');
  assert.deepEqual(R.amounts.map(x => [x.amount, x.nB, x.nC]), [[100, 3, 2]]);
  assert.deepEqual(R.amounts[0].near.map(x => [x.id, x.date]), [[3, '2026-10-06']]);
  assert.equal(R.diff.cred, -100);
  assert.equal(R.diff.close, -100); // CRM на кінець 05.10: 300 − запис 06.10 = 200, банк — 300
});

test('periodRecon: виписка не покриває період — обороти не порівнюються; ручний залишок банку', () => {
  const [b] = Rc.bankAccounts(PRIVAT, 'test.json'); // 01.10–05.10
  const cf = Rc.cashflowByAccount(RECORDS).get(33);
  const R = Rc.periodRecon(b, cf, 5600, '2026-09-28', '2026-10-05');
  assert.equal(R.covered, false);
  assert.equal(R.bank.open, null);
  assert.equal(R.bank.cred, null);
  assert.equal(R.diff.close, -0.5);
  assert.equal(R.ok, false);
  assert.match(R.warnings.join(' '), /не покриває період/);
  const M = Rc.periodRecon(null, cf, 5600, '2026-10-01', '2026-10-05', 5600);
  assert.equal(M.source, 'manual');
  assert.deepEqual(M.diff, { open: null, close: 0, cred: null, deb: null, n: null });
  assert.equal(M.ok, true);
  const N = Rc.periodRecon(null, cf, 5600, '2026-10-01', '2026-10-05');
  assert.equal(N.bank, null);
  assert.equal(N.ok, false);
});

test('countByAmount: підказка про іншу дату — лише коли в банку операцій більше', () => {
  const B = [{ date: '2026-10-02', amount: -50 }];
  const C = [{ date: '2026-10-02', amount: -50, id: 1 }, { date: '2026-10-03', amount: -50, id: 2 }];
  const outside = [...C, { date: '2026-10-07', amount: -50, id: 3 }];
  const r = Rc.countByAmount(B, C, outside, '2026-10-01', '2026-10-05');
  assert.deepEqual(r.mismatched.map(x => [x.amount, x.nB, x.nC, x.near.length]), [[-50, 1, 2, 0]]);
  const r2 = Rc.countByAmount([...B, { date: '2026-10-04', amount: -50 }, { date: '2026-10-05', amount: -50 }], C, outside, '2026-10-01', '2026-10-05');
  assert.deepEqual(r2.mismatched.map(x => [x.nB, x.nC, x.near.map(n => n.id)]), [[3, 2, [3]]]);
});

test('matchAccounts: службові рахунки, один рахунок банку на рахунок CRM, збережений вибір, різниця в одну літеру', () => {
  const accounts = [
    { id: 70, name: 'ФОП Мартиненко Святослав Олександрович Приват', currency_id: 1 },
    { id: 91, name: 'corpCard №6 ФОП Мартиненко_UAH_7850', currency_id: 1 },
    { id: 43, name: '1 UAH Житенська Універсал FOP', currency_id: 1 },
    { id: 2, name: '2 Євр Маркет Приват ТОВ', currency_id: 1 },
  ];
  const ccy = { 1: 'UAH', 3: 'EUR' };
  const bank = (iban, owner, extra) => ({ bank: 'privat', client: 'ФОП Мартиненко', owner, ccy: 'UAH', iban, rows: [], closing: 0, ...extra });
  const banks = [
    bank('UA..901034', 'Мас.вип.Мартиненко Святослав Олександрович ФОП'),
    bank('UA..903149', 'Мартиненко Святослав Олександрович ФОП', { closing: 5 }),
    bank('UA..908414', 'Мартиненко Святослав Олександрович ФОП', { rows: [{ date: '2026-10-22', amount: 1 }], closing: 1 }),
    bank('UA..907500', 'РКО.Мас.вип.Мартиненко Святослав Олександрович ФОП'),
    { bank: 'mono', client: 'ФОП Житинська', owner: 'Житинська Емілія ФОП', ccy: 'UAH', iban: 'UA..019928', rows: [], closing: 0 },
    { bank: 'privat', client: 'Маркет', owner: 'СЕРВІС МАРКЕТ ТОВ', ccy: 'EUR', iban: 'UA..140255', rows: [], closing: 0 },
    { bank: 'privat', client: 'Маркет', owner: 'СЕРВІС МАРКЕТ ТОВ', ccy: 'EUR', iban: 'UA..104366', rows: [], closing: 0 },
  ];
  const r = Rc.matchAccounts(banks, accounts, ccy, {});
  assert.deepEqual(r.map(x => x.cfId), [null, null, 70, null, 43, 2, null]);
  assert.match(r[0].note, /службовий/);
  assert.match(r[1].note, /ще один рахунок банку/);
  assert.match(r[2].note, /з 2 рахунків банку/);
  // вибір людини: «не звіряти» (0) для основного, інший рахунок — до 70; автоматичні дублікати 70 знімаються
  const s = Rc.matchAccounts(banks, accounts, ccy, { 'UA..908414': 0, 'UA..903149': 70 });
  assert.deepEqual(s.map(x => [x.cfId, x.fixed]).slice(1, 3), [[70, true], [null, true]]);
  assert.deepEqual(s.map(x => x.cfId), [null, 70, null, null, 43, 2, null]);
  // валюта, якої немає серед рахунків CRM (CZK), — «не знайдено», а не «кілька збігів»; порожній такий рахунок (03.11.2026: валютні рахунки
  // Моно Житинської) — «звіряти нічого», без «виберіть»
  const cz = { bank: 'privat', client: 'Маркет', owner: 'СЕРВІС МАРКЕТ', ccy: 'CZK', iban: 'UA..472485', rows: [], closing: 0 };
  const z = Rc.matchAccounts([cz, { ...cz, iban: 'UA..145719', closing: 12.5 }], [...accounts, { id: 1, name: '1 ГРН Маркет Приват ТОВ', currency_id: 1 }], ccy, {});
  assert.deepEqual(z.map(x => x.cfId), [null, null]);
  assert.match(z[0].note, /у CRM такого рахунку немає; операцій і залишку теж немає — звіряти нічого/);
  assert.equal(z[0].empty, true);
  assert.match(z[1].note, /не знайдено — виберіть/);
  assert.ok(!z[1].empty);
});

test('маркетолог за контрагентом (rules.json → counterparty_marketers); не проведені банком операції — окремо', () => {
  const list = [{ counterparty: 'Власич Оксана', marketer_id: 195, marketer: 'Євген Сливко' }, { counterparty: 'без id', marketer: 'X' }];
  assert.deepEqual(Rc.cptyMarketer(list, 'ФОП ВЛАСИЧ ОКСАНА Володимирівна · Оплата за рекламні послуги'), { id: 195, name: 'Євген Сливко', cpty: 'Власич Оксана' });
  assert.equal(Rc.cptyMarketer(list, 'ФОП Власицька Оксана'), null);
  assert.equal(Rc.cptyMarketer(list, 'без id'), null, 'без marketer_id — не береться');
  assert.equal(Rc.cptyMarketer(null, 'Власич Оксана'), null);
  const [b] = Rc.bankAccounts({ client: 'X', from: '2026-10-01', to: '2026-10-05', accounts: [{ acc: 'UA1', ccy: 'UAH', name: 'ТОВ X', opening: 100, closing: 90, transactions: [
    { DAT_OD: '02.10.2026', TIM_P: '10:00', SUM: '10.00', TRANTYPE: 'D', AUT_CNTR_NAM: 'ТОВ А', OSND: 'Оплата', REF: 'R1', PR_PR: 'r' },
    { DAT_OD: '03.10.2026', TIM_P: '11:00', SUM: '55.00', TRANTYPE: 'D', AUT_CNTR_NAM: 'ТОВ Б', OSND: 'Сторно', REF: 'R2', PR_PR: 'n' }] }] }, 'f.json');
  assert.deepEqual(b.rows.map(x => x.amount), [-10]);
  assert.deepEqual(b.skipped.map(x => [x.date, x.amount, x.cpty]), [['2026-10-03', -55, 'ТОВ Б']]);
  assert.match(b.skipped[0].why, /банк не провів операцію \(статус n/);
  assert.match(b.warnings.join(' '), /Пропущено 1 транзакц/);
});

test('matchAccounts: той самий рахунок банку з двох виписок (за день і за місяць) — один рахунок, не «ще один»', () => {
  const accounts = [{ id: 68, name: 'ФОП Хоменко Приват ГРН', currency_id: 1 }];
  const acc = (iban, fileFrom, rows) => ({ bank: 'privat', client: 'ФОП Хоменко', owner: 'Хоменко Всеволод Сергійович ФОП', ccy: 'UAH', iban, fileFrom, fileTo: '2026-10-26', rows, closing: 100 });
  const banks = [acc('UA675531', '2026-10-26', [{}]), acc('UA693617', '2026-10-26', []), acc('UA675531', '2026-10-01', [{}, {}]), acc('UA693617', '2026-10-01', [])];
  const res = Rc.matchAccounts(banks, accounts, { 1: 'UAH' }, {});
  assert.deepEqual(res.map(r => r.cfId), [68, null, 68, null], 'обидва файли рахунку …675531 — до «ФОП Хоменко Приват ГРН»');
  assert.deepEqual(res.map(r => !!r.second), [false, true, false, true]);
  assert.match(res[0].note, /з 2 рахунків банку/);
});

// ---------- перекази між своїми рахунками ----------
const ACCS = [
  { id: 5, name: 'ФОП Хоменко Приват ГРН' }, { id: 1, name: '1 ГРН Маркет Приват ТОВ' }, { id: 33, name: '1 UAH ПРИКЛАД Приват ТОВ' },
  { id: 89, name: 'corpCard_ФОП Хоменко_UAH_3462' }, { id: 90, name: 'corpCard №5 ФОП Мазовецька_UAH_2044' },
  { id: 84, name: 'corpCard UAH Маркет ТОВ' }, { id: 87, name: 'corpCard UAH_1665 Маркет ТОВ' }, { id: 88, name: 'corpCard UAH_1665 стара' },
];
// виписка Привату одного рахунку: [дата, сума, призначення, IBAN контрагента, назва контрагента]
const privatOf = (acc, rows, opening, closing) => Rc.bankAccounts({ source: 'bank_api', client: 'X', from: '2026-10-01', to: '2026-10-05', fetched_at: '06.10.2026', accounts: [{ acc, ccy: 'UAH', name: 'Хоменко Всеволод Сергійович ФОП', client: 'ФОП Хоменко', opening, closing,
  transactions: rows.map(([d, s, p, cp, cpn]) => ({ DAT_OD: d, SUM: String(Math.abs(s)), TRANTYPE: s < 0 ? 'D' : 'C', PR_PR: 'r', OSND: p, AUT_CNTR_ACC: cp || '', AUT_CNTR_NAM: cpn || '' })) }] }, 'x.json')[0];

test('номер корп. картки: з призначення виписки, з назви corpCard і з коментарів поповнень; неоднозначний — не береться', () => {
  assert.deepEqual(['4246 **** **** 3462 08.10.2026 FACEBK', '5169 **** **** 7850 12.10', '426703******1234 x', 'Переказ на корп. картку', 'рахунок 12345678'].map(Rc.cardTail), ['3462', '7850', '1234', null, null]);
  const items = new Map([[90, [{ opc: 3, comment: 'Сидоричев Андрій: бюджет, поповнення корп картки 7365 23.10 12:22' }, { opc: 2, comment: 'Facebook картка 9999' }]]]);
  // 1665 — у назвах двох рахунків, тож не визначається; 7365 — нова картка Мазовецької з коментаря поповнення; 9999 — з витрати, не з поповнення
  assert.deepEqual(Rc.cardTails(ACCS, items), { 3462: 89, 2044: 90, 7365: 90 });
});

test('рахунок разом з corpCard: поповнення картки — рух усередині групи, покупки з виписки сходяться з витратами corpCard', () => {
  const b = privatOf('UA_FOP', [['02.10.2026', -1011.26, '4246 **** **** 3462 01.10.2026 FACEBK *A', 'UA_FX'], ['03.10.2026', -1009.46, '4246 **** **** 3462 02.10.2026 FACEBK *B', 'UA_FX'],
    ['04.10.2026', 3000, 'Оплата послуг', 'UA_CLIENT']], 10000, 10979.28);
  const items = Rc.cashflowByAccount([
    rec(1, '2026-10-01', [[5, 4, 5000], [89, 3, 5000]], { comment: 'поповнення корп картки 3462' }), // у банку цього немає
    rec(2, '2026-10-02', [[89, 2, 1011.26]]), rec(3, '2026-10-03', [[89, 2, 1009.46]]), rec(4, '2026-10-04', [[5, 1, 3000]]),
  ]);
  // окремо рахунок ФОП не сходиться: у CRM переказ 5000, у банку — покупки
  assert.equal(Rc.periodRecon(b, items.get(5), 8000, '2026-10-01', '2026-10-05').ok, false);
  const cf = Rc.groupItems(items, [5, 89]);
  assert.deepEqual(cf.map(x => x.id).sort(), [2, 3, 4]);
  const dir = Rc.ownDirectory([b], ACCS, items, {});
  const R = Rc.periodRecon(b, cf, 8000 + 2979.28, '2026-10-01', '2026-10-05', undefined, { dir, group: new Set([5, 89]), owner: b.owner });
  assert.equal(R.ok, true);
  assert.deepEqual(R.amounts, []);
  assert.equal(R.own.missing.size, 0);
});

test('переказ між своїми: є в CRM — сходиться; немає — пропозиція й не «розбіжність»; записано витратою — підказка', () => {
  const b = privatOf('UA_FOP', [['02.10.2026', -5600, 'Сплата за ліцензійний договір', 'UA_SRV', 'ТОВ ПРИКЛАД СЕРВІС'], ['03.10.2026', -26200, 'Сплата за ліцензійний договір', 'UA_SRV', 'ТОВ ПРИКЛАД СЕРВІС'],
    ['04.10.2026', -100, 'Комісія банку', 'UA_BANK']], 50000, 18100);
  const srv = { iban: 'UA_SRV', cfId: 33, rows: [] };
  const recs = [rec(1, '2026-10-02', [[5, 4, 5600], [33, 3, 5600]]), rec(2, '2026-10-04', [[5, 2, 100]])];
  const dir = Rc.ownDirectory([b, srv], ACCS, new Map(), {});
  const own = { dir, group: new Set([5]), owner: b.owner };
  let R = Rc.periodRecon(b, Rc.cashflowByAccount(recs).get(5), 50000 - 5700, '2026-10-01', '2026-10-05', undefined, own);
  assert.deepEqual(R.own.xfers.map(x => [x.row.amount, x.peer, x.state]), [[-5600, 33, 'ok'], [-26200, 33, 'missing']]);
  assert.deepEqual(R.amounts, [], 'відсутній переказ — не в сумах, що не сходяться');
  assert.equal(R.ok, false);
  assert.equal(R.xferOnly, true, 'після створення переказу рахунок зійдеться');
  // переказ 26 200 записано в CRM як витрату — не пропонується; підказка про тип
  R = Rc.periodRecon(b, Rc.cashflowByAccount(recs.concat([rec(3, '2026-10-03', [[5, 2, 26200]])])).get(5), 50000 - 31900, '2026-10-01', '2026-10-05', undefined, own);
  assert.deepEqual(R.own.xfers.map(x => x.state), ['ok', 'type']);
  assert.equal(R.own.missing.size, 0);
  assert.equal(R.ok, true);
});

test('свій рахунок без виписки (Універсал ТОВ … 0873): платіж від нього — переказ між своїми за 4 цифрами IBAN і назвою, а не дохід', () => {
  // 12.11.2026: роялті Маркет (Універсал …0873, API немає) → ПРИКЛАД 5608 показувалось у «Внести в CRM» надходженням «виберіть статтю»
  const accs = ACCS.concat([{ id: 60, name: 'Універсал ТОВ СЕРВІС МАРКЕТ 0873' }, { id: 61, name: 'Універсал ТОВ ПРИКЛАД СЕРВІС 0679' },
    { id: 62, name: 'Універсал ТОВ СЕРВІС МАРКЕТ 0873 (видалити)' }]);
  const MKT = 'ТОВ "СЕРВІС МАРКЕТ"', ROY = 'Оплата за ліцензійне використання програмного продукту (роялті) згідно ліцензійного договору Без ПДВ';
  const b = privatOf('UA_SRV5689', [['02.10.2026', 208000, ROY, 'UA003220010000026000100890873', MKT], ['02.10.2026', 3000, ROY, 'UA003220010000026000100890873', MKT],
    ['03.10.2026', 500, 'Оплата послуг', 'UA003220010000026000200220873', 'ТОВ "ІНША ФІРМА"'], // ті самі 4 цифри, чужа назва — не наш
    ['03.10.2026', 700, ROY, 'UA003220010000026000300894444', MKT]], 0, 212200); // наша назва, інші цифри — не цей рахунок
  const dir = Rc.ownDirectory([b], accs, new Map(), {});
  const own = { dir, group: new Set([33]), owner: b.owner };
  const recs = [rec(1, '2026-10-02', [[60, 4, 208000], [33, 3, 208000]])];
  const R = Rc.periodRecon(b, Rc.cashflowByAccount(recs).get(33), 208000, '2026-10-01', '2026-10-05', undefined, own);
  assert.deepEqual(R.own.xfers.map(x => [x.row.amount, x.peer, x.state]), [[208000, 60, 'ok'], [3000, 60, 'missing']]);
  assert.deepEqual(R.missing.bank.filter(x => R.kinds.get(x) !== 'own').map(x => x.amount).sort((p, q) => p - q), [500, 700]);
  // рахунок 0873 з власною випискою — як і раніше, за IBAN з виписки (підказка за назвою не потрібна й не заважає)
  const dir2 = Rc.ownDirectory([b, { iban: 'UA003220010000026000100890873', cfId: 60, rows: [] }], accs, new Map(), {});
  assert.equal(dir2.byTail.has('0873'), false);
});

test('продаж валюти («Гривнi вiд продажу 495.00 EUR по курсу 50.57») — переказ з валютного рахунку тієї самої фірми, а не дохід', () => {
  // 12.11.2026: +25 032,15 на гривневому рахунку Маркет пропонувалось надходженням «Інші доходи»; банк пише латинські «i»
  const SELL = 'Гривнi вiд продажу 495.00 EUR по курсу 50.57';
  const b = privatOf('UA_MKT_UAH', [['02.10.2026', 25032.15, SELL, 'UA_BANK_FX', 'Продаж UAH клiєнтiв'], ['02.10.2026', 4000, 'Гривнi вiд продажу 100.00 GBP по курсу 40', 'UA_BANK_FX', 'Продаж UAH клiєнтiв'],
    ['02.10.2026', -37.77, 'Списання комiсiї за продаж валюти згiдно договору, сума продажу 495.00 EUR, по курсу 50.57', 'UA_BANK', 'Ком.за в/о']], 0, 28994.38);
  const eur = { iban: 'UA_MKT_EUR', cfId: 2, ccy: 'EUR', owner: b.owner, rows: [] }, usd = { iban: 'UA_MKT_USD', cfId: 30, ccy: 'USD', owner: b.owner, rows: [] };
  const other = { iban: 'UA_SRV_EUR', cfId: 40, ccy: 'EUR', owner: 'ТОВ ПРИКЛАД СЕРВІС', rows: [] };
  const dir = Rc.ownDirectory([b, eur, usd, other], ACCS, new Map(), {});
  const own = { dir, group: new Set([1]), owner: b.owner };
  const recs = [rec(1, '2026-10-02', [[2, 4, 25032.15], [1, 3, 25032.15]])];
  const R = Rc.periodRecon(b, Rc.cashflowByAccount(recs).get(1), 25032.15, '2026-10-01', '2026-10-05', undefined, own);
  assert.deepEqual(R.own.xfers.map(x => [x.row.amount, x.peer, x.state]), [[25032.15, 2, 'ok']]); // EUR цієї фірми, не ПРИКЛАД і не USD
  assert.deepEqual(R.own.maybe.map(x => x.row.amount), [4000]); // рахунку GBP серед виписок немає — «виберіть рахунок», не дохід
  assert.ok(!R.own.kinds.get(b.rows.find(x => x.amount < 0))); // комісія за продаж — витрата, як і була
  assert.deepEqual(R.missing.bank.filter(x => R.kinds.get(x) !== 'own').map(x => x.amount), [-37.77]); // у «Внести в CRM» — лише комісія
});

test('схоже на переказ: лише без запису з такою сумою; «не переказ» і корп. картки — не перекази; особиста картка власника — витрата', () => {
  const b = privatOf('UA_FOP', [['02.10.2026', -1350, '5363 **** **** 3912 Переказ власних коштів', 'UA_CARD4014', 'ХОМЕНКО ВСЕВОЛОД СЕРГІЙОВИЧ'],
    ['03.10.2026', -900, 'Переказ на картку', 'UA_P2', 'Хоменко Всеволод'], ['03.10.2026', -700, 'Переказ на картку', 'UA_P3', 'Парамончук Віталій'],
    ['03.10.2026', -500, 'Переказ на картку', 'UA_P4', 'ФОП Хоменко Всеволод Сергійович'], ['04.10.2026', -400, '4246 **** **** 3462 FACEBK', 'UA_FX']], 10000, 6150);
  const dir = Rc.ownDirectory([b], ACCS, new Map(), {});
  const own = { dir, group: new Set([5]), owner: b.owner };
  let R = Rc.periodRecon(b, [], 10000, '2026-10-01', '2026-10-05', undefined, own);
  // «на картку» рахунку ФОП власника (виписки цього рахунку немає) — схоже на переказ між своїми; чужій людині й покупка корп. карткою — ні
  assert.deepEqual(R.own.maybe.map(m => m.row.amount), [-500]);
  // самому власникові-людині (Моно «Переказ на картку», Приват «… **** 3912 Переказ власних коштів») — особиста картка: витрата, без «куди»
  assert.deepEqual(b.rows.map(x => (R.own.kinds.get(x) || {}).kind || null), ['card', 'card', null, 'maybe', null]);
  assert.match(R.own.kinds.get(b.rows[1]).why, /особисту картку власника ФОП \(Хоменко Всеволод\)/);
  assert.deepEqual(R.missing.bank.map(x => x.amount).sort((p, q) => p - q), [-1350, -900, -700, -500, -400]);
  assert.deepEqual([...R.kinds.values()], ['debit', 'debit', 'debit', 'own', 'debit']);
  // у CRM є витрата 1350 (переказ на особисту картку власника — 59/55) — звірено
  R = Rc.periodRecon(b, Rc.cashflowByAccount([rec(1, '2026-10-02', [[5, 2, 1350]])]).get(5), 10000, '2026-10-01', '2026-10-05', undefined, own);
  assert.deepEqual(R.own.maybe.map(m => m.row.amount), [-500]);
  assert.equal(R.pairs.get(b.rows[0]).id, 1);
  // вибір людини: UA_P2 і UA_P4 — «не переказ між рахунками CRM»; UA_CARD4014 — рахунок corpCard 90 (вибір людини сильніший за «особисту картку»)
  const dir2 = Rc.ownDirectory([b], ACCS, new Map(), { UA_P2: 0, UA_P4: 0, UA_CARD4014: 90 });
  R = Rc.periodRecon(b, [], 10000, '2026-10-01', '2026-10-05', undefined, { dir: dir2, group: new Set([5]), owner: b.owner });
  assert.deepEqual(R.own.maybe, []);
  assert.equal(R.own.kinds.get(b.rows[1]), undefined, '«не переказ» — звичайна витрата');
  assert.deepEqual(R.own.xfers.map(x => [x.row.amount, x.peer, x.state]), [[-1350, 90, 'missing']]);
});

test('«що звіряти»: надходження, списання, перекази між рахунками — обороти й суми лише свого типу; залишки не порівнюються', () => {
  const b = privatOf('UA_FOP', [['02.10.2026', 3000, 'Оплата послуг', 'UA_CLIENT', 'ТОВ КЛІЄНТ'], ['02.10.2026', -5600, 'Сплата за ліцензійний договір', 'UA_SRV', 'ТОВ ПРИКЛАД СЕРВІС'],
    ['03.10.2026', -120, 'Комісія банку', 'UA_BANK'], ['04.10.2026', -2500, 'Оплата за рекламу', 'UA_ADS', 'ТОВ РЕКЛАМА'], ['04.10.2026', -700, 'Переказ коштів', 'UA_OTHER', 'ТОВ МАРКЕТ']], 10000, 4080);
  const srv = { iban: 'UA_SRV', cfId: 33, rows: [] };
  // у CRM немає витрати 2 500; 700 записано переказом на рахунок 1 (контрагента немає серед наших IBAN — тип береться з CRM)
  const cf = Rc.cashflowByAccount([rec(1, '2026-10-02', [[5, 1, 3000]]), rec(2, '2026-10-02', [[5, 4, 5600], [33, 3, 5600]]), rec(3, '2026-10-03', [[5, 2, 120]]),
    rec(4, '2026-10-04', [[5, 4, 700], [1, 3, 700]])]).get(5);
  const dir = Rc.ownDirectory([b, srv], ACCS, new Map(), {});
  const run = kind => Rc.periodRecon(b, cf, 6580, '2026-10-01', '2026-10-05', undefined, { dir, group: new Set([5]), owner: b.owner, kind });
  let R = run('all');
  assert.deepEqual([...R.kinds.values()], ['credit', 'own', 'debit', 'debit', 'own']);
  assert.deepEqual(R.missing.bank.map(x => x.amount), [-2500]);
  assert.deepEqual(R.missing.crm, []);
  assert.equal(R.ok, false);
  R = run('credit');
  assert.deepEqual([R.crm.cred, R.crm.deb, R.crm.n, R.bank.cred, R.bank.deb, R.bank.n], [3000, 0, 1, 3000, 0, 1]);
  assert.equal(R.ok, true, 'надходження сходяться, хоча залишок на кінець — ні');
  assert.notEqual(R.diff.close, 0);
  R = run('debit');
  assert.deepEqual([R.crm.deb, R.crm.n, R.bank.deb, R.bank.n], [120, 1, 2620, 2]);
  assert.deepEqual(R.amounts.map(x => [x.amount, x.nB, x.nC]), [[-2500, 1, 0]]);
  assert.deepEqual(R.missing.bank.map(x => x.amount), [-2500]);
  assert.equal(R.ok, false);
  R = run('own');
  assert.deepEqual([R.crm.deb, R.crm.n, R.bank.deb, R.bank.n], [6300, 2, 6300, 2]);
  assert.equal(R.ok, true);
  // переказ між своїми, записаний у CRM витратою: з фільтром «списання» — не «немає в банку», а різний тип
  const cfT = Rc.cashflowByAccount([rec(1, '2026-10-02', [[5, 1, 3000]]), rec(2, '2026-10-02', [[5, 2, 5600]]), rec(3, '2026-10-03', [[5, 2, 120]]),
    rec(4, '2026-10-04', [[5, 4, 700], [1, 3, 700]])]).get(5);
  R = Rc.periodRecon(b, cfT, 6580, '2026-10-01', '2026-10-05', undefined, { dir, group: new Set([5]), owner: b.owner, kind: 'debit' });
  assert.deepEqual(R.cross.map(p => [p.bank.amount, p.crm.id]), [[-5600, 2]]);
  assert.deepEqual(R.amounts.map(x => x.amount), [-2500], '5 600 — не в «сумах, що не сходяться»');
  assert.equal(R.ok, false, 'різниця в типі лишається розбіжністю');
  // без виписки — з фільтром не сходиться ніколи (залишок, введений вручну, не порівнюється)
  assert.equal(Rc.periodRecon(null, cf, 6580, '2026-10-01', '2026-10-05', 6580, { kind: 'credit' }).ok, false);
});

test('покупки карткою: банк провів пізніше — не розбіжність; у CRM за останні дні виписки — «ще не проведено банком»', () => {
  // покупка 02.10 проведена банком 04.10 (у CRM — 02.10, до періоду); покупки 05.10 банк ще не провів (виписка — по 05.10)
  const b = privatOf('UA_FOP', [['04.10.2026', -4026.94, '4246 **** **** 7365 02.10.2026 17:03:51 Цифровi товари: FACEBK *Y1, Dublin', 'UA_FX', 'USD валютна позицiя (Compass)']], 10000, 5973.06);
  const items = Rc.cashflowByAccount([rec(1, '2026-10-02', [[90, 2, 4026.94]]), rec(2, '2026-10-05', [[90, 2, 4072.94]]), rec(3, '2026-10-05', [[90, 2, 275.23]])]);
  const cf = Rc.groupItems(items, [5, 90]), dir = Rc.ownDirectory([b], ACCS, items, {});
  const run = kind => Rc.periodRecon(b, cf, 1624.89, '2026-10-04', '2026-10-05', undefined, { dir, group: new Set([5, 90]), owner: b.owner, kind, cards: [90] });
  let R = run('all');
  assert.deepEqual(R.timing.map(t => [t.kind, t.crm.id]), [['later', 1], ['pending', 2], ['pending', 3]]);
  assert.deepEqual(R.amounts, [], 'пояснені — не «суми, що не сходяться»');
  assert.deepEqual(R.missing.bank, []);
  assert.equal(R.ok, false);
  assert.equal(R.timingOk, true);
  assert.deepEqual(R.adj, { open: 0, close: 0, cred: 0, deb: 0 });
  R = run('debit');
  assert.equal(R.timingOk, true);
  assert.equal(Rc.cardDate('5169 **** **** 7850 25.10.2026 02:29:20 Цифровi товари'), '2026-10-25');
  // без corpCard у групі запис CRM не «чекає банку», а лишається розбіжністю
  R = Rc.periodRecon(b, cf, 1624.89, '2026-10-04', '2026-10-05', undefined, { dir, group: new Set([5, 90]), owner: b.owner, kind: 'all', cards: [] });
  assert.deepEqual(R.timing.map(t => t.kind), ['later']);
  assert.equal(R.amounts.length, 2);
  assert.notEqual(R.timingOk, true);
});

test('одна операція банку = кілька записів CRM: переказ на картку власника, з неї — дві виплати', () => {
  const b = privatOf('UA_FOP', [['03.10.2026', -21348.72, 'Переказ на картку', 'UA_P2', 'Хоменко Всеволод'], ['03.10.2026', -1060.28, 'Переказ на картку', 'UA_P2', 'Хоменко Всеволод']], 30000, 7590.99);
  const cf = Rc.cashflowByAccount([rec(1, '2026-10-03', [[5, 2, 12939.72]]), rec(2, '2026-10-03', [[5, 2, 8409]]), rec(3, '2026-10-03', [[5, 2, 1060.28]])]).get(5);
  const dir = Rc.ownDirectory([b], ACCS, new Map(), {});
  const run = kind => Rc.periodRecon(b, cf, 7590.99 + 1000, '2026-10-01', '2026-10-05', undefined, { dir, group: new Set([5]), owner: b.owner, kind });
  let R = run('all');
  assert.deepEqual(R.multi.map(g => [g.bank.map(x => x.amount), g.crm.map(c => c.id).sort()]), [[[-21348.72], [1, 2]]]);
  assert.deepEqual(R.own.maybe, [], 'у CRM це виплати — не питати «куди переказ»');
  assert.deepEqual(R.amounts, []);
  R = run('debit');
  assert.deepEqual([R.crm.deb, R.bank.deb], [22409, 22409]);
  assert.equal(R.ok, true);
  assert.equal(Rc.subsetSum(-2135, [{ amount: -1000 }, { amount: -1100 }, { amount: -36 }], 5), null, 'немає точної комбінації — немає пари');
});

test('missingRows: пари за сумою, спершу найближчі за датою', () => {
  const B = [{ date: '2026-10-01', amount: -100 }, { date: '2026-10-20', amount: -100 }, { date: '2026-10-05', amount: 40 }];
  const C = [{ date: '2026-10-19', amount: -100, id: 1 }, { date: '2026-10-07', amount: -40, id: 2 }];
  const m = Rc.missingRows(B, C);
  assert.deepEqual(m.bank.map(x => [x.date, x.amount]), [['2026-10-01', -100], ['2026-10-05', 40]]);
  assert.deepEqual(m.crm.map(c => c.id), [2]);
});

test('переказ між своїми є в CRM з іншою датою (до ±5 днів поза періодом) — не пропонується, лишається підказка «з іншою датою»', () => {
  const b = privatOf('UA_FOP', [['04.10.2026', -1350, 'Переказ власних коштів', 'UA_CARD', 'ХОМЕНКО ВСЕВОЛОД']], 10000, 8650);
  const dir = Rc.ownDirectory([b], ACCS, new Map(), { UA_CARD: 90 });
  const cf = Rc.cashflowByAccount([rec(1, '2026-10-08', [[5, 4, 1350], [90, 3, 1350]])]).get(5);
  const R = Rc.periodRecon(b, cf, 8650, '2026-10-01', '2026-10-05', undefined, { dir, group: new Set([5]), owner: b.owner });
  assert.deepEqual(R.own.xfers.map(x => [x.state, x.item && x.item.id]), [['near', 1]]);
  assert.equal(R.own.missing.size, 0);
  assert.deepEqual(R.amounts.map(x => [x.amount, x.d, x.near.map(n => n.date)]), [[-1350, -1, ['2026-10-08']]]);
});

// ---------- ЗП через транзитний рахунок («Ціл-ві зарах.»): у банку один переказ, у CRM — записи по людях ----------
const TRANSIT = 'Ціл-ві зарах.СЕРВІС МАРКЕТ ТОВ';
// запис ЗП: стаття «Комісії відділу продажів» (47/31) чи «Менеджмент (ЗП)» (51/38)
const salRec = (id, kyiv, amount, o) => rec(id, kyiv, [[5, 2, amount]], { payments: [{ id: id * 10, invoice_id: 5, operation: 2, amount, pnl_category_id: o === 38 ? 51 : 47, pnl_operation_id: o || 31, deleted_at: null }] });
const isSal = c => /\/(31|38)$/.test(c.art || '');

test('ЗП через транзитний рахунок: не «схоже на переказ», записи ЗП не складаються у випадкову суму, решта — підсумком', () => {
  const b = privatOf('UA_FIRMB', [['02.10.2026', -1234.5, 'Заробітна плата за вересень 2026', 'UA_TRANSIT', TRANSIT], ['03.10.2026', -310, 'Заробітна плата за жовтень 2026', 'UA_TRANSIT', TRANSIT],
    ['03.10.2026', -8000, 'ПЕРЕКАЗ ВЛАСНИХ КОШТІВ Без ПДВ.', 'UA_X', 'СЕРВІС МАРКЕТ ТОВ'],
    ['03.10.2026', -238.89, 'Сплата ПДФО за жовтень 2026', 'UA_TAX', 'ГОЛОВНЕ УДКСУ У М.КИЄВІ'], ['03.10.2026', -238.89, 'Сплата військового збору за жовтень 2026', 'UA_TAX', 'ГОЛОВНЕ УДКСУ У М.КИЄВІ'],
    ['04.10.2026', -50, 'Комісія банку', 'UA_BANK']], 20000, 9927.72);
  const transit = { iban: 'UA_TRANSIT', cfId: null, owner: TRANSIT, rows: [] };
  const cf = Rc.cashflowByAccount([salRec(1, '2026-10-02', 700), salRec(2, '2026-10-02', 534.5), salRec(3, '2026-10-03', 2000), salRec(4, '2026-10-03', 5000), salRec(5, '2026-10-03', 1000, 38),
    salRec(7, '2026-10-03', 477.78, 38), rec(6, '2026-10-04', [[5, 2, 50]])]).get(5);
  const dir = Rc.ownDirectory([b, transit], ACCS, new Map(), {});
  assert.deepEqual([...dir.pay], ['UA_TRANSIT']);
  const R = Rc.periodRecon(b, cf, 20000 - 9812.28, '2026-10-01', '2026-10-05', undefined, { dir, group: new Set([5]), owner: b.owner, salary: isSal });
  assert.deepEqual(b.rows.slice(0, 2).map(x => R.own.kinds.get(x).kind), ['pay', 'pay']);
  assert.deepEqual(R.own.maybe.map(m => m.row.amount), [-8000], 'перекази на транзитний рахунок — не «виберіть рахунок куди»');
  assert.deepEqual([R.kinds.get(b.rows[0]), R.kinds.get(b.rows[1])], ['debit', 'debit']);
  // переказ на транзит = два записи ЗП; податки на ЗП = один запис ЗП; 8 000 не «складено» з трьох записів ЗП (2 000 + 5 000 + 1 000)
  assert.deepEqual(R.multi.map(g => [g.bank.map(x => x.amount), g.crm.map(c => c.id).sort()]), [[[-1234.5], [1, 2]], [[-238.89, -238.89], [7]]]);
  assert.deepEqual([R.pay.bank.map(x => x.amount), R.pay.crm.map(c => c.id)], [[-310], [3, 4, 5]]);
  assert.deepEqual(R.amounts.map(x => [x.amount, x.nB, x.nC]), [[-8000, 1, 0]], 'ЗП не в «сумах, що не сходяться»');
  assert.deepEqual(R.missing.bank.map(x => x.amount), [-8000]);
  assert.deepEqual(R.missing.crm, []);
});

test('ЗП через транзитний рахунок без його виписки (за назвою контрагента): лише різниця ЗП — «сходиться, крім ЗП»', () => {
  const b = privatOf('UA_FIRMB', [['02.10.2026', -1234.5, 'Заробітна плата за вересень 2026', 'UA_TRANSIT', TRANSIT], ['03.10.2026', -310, 'Заробітна плата за жовтень 2026', 'UA_TRANSIT', TRANSIT],
    ['04.10.2026', -50, 'Комісія банку', 'UA_BANK']], 20000, 18405.5);
  const cf = Rc.cashflowByAccount([salRec(1, '2026-10-02', 700), salRec(2, '2026-10-02', 534.5), salRec(3, '2026-10-03', 2000), salRec(4, '2026-10-03', 5000), rec(6, '2026-10-04', [[5, 2, 50]])]).get(5);
  const dir = Rc.ownDirectory([b], ACCS, new Map(), {});
  const run = (kind, extra) => Rc.periodRecon(b, cf, 20000 - 8284.5, '2026-10-01', '2026-10-05', undefined, { dir, group: new Set([5]), owner: b.owner, salary: isSal, kind, ...extra });
  let R = run('all');
  assert.deepEqual(R.own.maybe, []);
  assert.deepEqual([R.pay.bank.map(x => x.amount), R.pay.crm.map(c => c.id)], [[-310], [3, 4]]);
  assert.deepEqual(R.amounts, []);
  assert.deepEqual([R.ok, R.diff.deb, R.diff.close], [false, 6690, -6690], 'різниця ЗП лишається в оборотах і залишку');
  assert.equal(R.timingOk, true);
  assert.deepEqual(R.adj, { open: 0, close: 0, cred: 0, deb: 0 });
  R = run('debit');
  assert.equal(R.timingOk, true);
  R = run('credit');
  assert.equal(R.pay, null, 'надходжень ЗП немає');
  assert.equal(R.ok, true);
  // людина сама вибрала для транзитного рахунку рахунок CRM — тоді це переказ між рахунками
  const mine = Rc.ownDirectory([b], ACCS, new Map(), { UA_TRANSIT: 90 });
  assert.deepEqual(Rc.ownKind(b.rows[0], mine, new Set([5]), b.owner), { kind: 'own', peer: 90 });
});

test('рахунок, що платить ЗП через транзит (бачили раніше): записи ЗП у день без переказу — теж підсумком', () => {
  const b = privatOf('UA_FIRMB', [['04.10.2026', -50, 'Комісія банку', 'UA_BANK']], 20000, 19950);
  const cf = Rc.cashflowByAccount([salRec(3, '2026-10-04', 2000), rec(6, '2026-10-04', [[5, 2, 50]])]).get(5);
  const dir = Rc.ownDirectory([b], ACCS, new Map(), {});
  const run = payroll => Rc.periodRecon(b, cf, 20000 - 2050, '2026-10-01', '2026-10-05', undefined, { dir, group: new Set([5]), owner: b.owner, salary: isSal, payroll });
  assert.deepEqual(run(false).amounts.map(x => [x.amount, x.d]), [[-2000, 1]], 'без ознаки — звичайна розбіжність');
  const R = run(true);
  assert.deepEqual([R.pay.bank, R.pay.crm.map(c => c.id), R.amounts, R.timingOk], [[], [3], [], true]);
  assert.equal(Rc.payRow({ cpty: 'Мас.вип.ТОВ ПРИКЛАД СЕРВІС' }, dir), true);
  assert.equal(Rc.payRow({ cpty: 'РКО ЗП ТОВ ПРИКЛАД СЕРВІС' }, dir), false, 'РКО — не транзит ЗП');
});

test('картки з довідника rules.json: перевипущена картка (номер не в назві) і неоднозначний номер — за довідником', () => {
  assert.deepEqual(Rc.cardTails(ACCS, null), { 3462: 89, 2044: 90 }, 'без довідника: 1665 — у двох назвах, 7365 — ніде');
  assert.deepEqual(Rc.cardTails(ACCS, null, [{ last4: '7365', account_id: 90 }, { last4: '1665', account_id: 87 }, { last4: '12', account_id: 5 }]), { 3462: 89, 2044: 90, 7365: 90, 1665: 87 });
  const b = privatOf('UA_MOL', [['03.10.2026', -500, '4246 **** **** 7365 02.10.2026 10:00:00 Цифровi товари: FACEBK *Z, FACEBOOK.COM', 'UA_FX', 'USD валютна позицiя (Compass)']], 10000, 9500);
  assert.equal(Rc.ownDirectory([b], ACCS, new Map(), {}, [{ last4: '7365', account_id: 90 }]).cards['7365'], 90);
});

test('нові назви рахунків CRM (30.10.2026): за 4 цифрами IBAN, валюта словом, корп. картки «корп. картка …», технічні рахунки банку', () => {
  const accs = [[1, 'Приват ТОВ СЕРВІС МАРКЕТ 8112', 1], [97, 'Приват ТОВ СЕРВІС МАРКЕТ 1437', 1], [2, 'Приват євро ТОВ СЕРВІС МАРКЕТ 0115', 1],
    [74, '1 ГРН Маркет Приват ТОВ (видалити)', 5], [83, 'ФОП Мазовецька Корнелія Олександрівна Приват', 1], [90, 'корп. картка 7365 ФОП Мазовецька Корнелія Олександрівна', 1],
    [94, 'майбутня корп карта ФОП Мазовецька Корнелія Олександрівна', 1],
    [89, 'корп. картка 3462 ФОП Хоменко Всеволод Сергійович', 1], [95, 'corp card 9450 PRYKLAD MARKET INC. Chase', 2], [84, 'корп. картка ТОВ СЕРВІС МАРКЕТ', 1],
    [48, 'НеАктуальний ФОП Тихоненко Олексій Олександрович Приват євро', 1], [14, 'НеАктуальний ФОП Тихоненко Олексій Олександрович Приват', 1]].map(([id, name, currency_id]) => ({ id, name, currency_id }));
  const ccy = { 1: 'UAH', 2: 'USD', 3: 'EUR', 5: 'PLN' };
  const bank = (iban, owner, c) => ({ bank: 'privat', iban, owner, client: owner, ccy: c, rows: [{ date: '2026-10-01', amount: 1 }], closing: 1 });
  const banks = [bank('UA003052990000026000400468112', 'СЕРВІС МАРКЕТ ТОВ', 'UAH'), bank('UA003052990000026000500471437', 'СЕРВІС МАРКЕТ ТОВ', 'UAH'),
    bank('UA003052990000026000600470115', 'СЕРВІС МАРКЕТ ТОВ', 'EUR'), bank('UA003052990000026000700551235', 'МАЗОВЕЦЬКА КОРНЕЛІЯ ОЛЕКСАНДРІВНА ФОП', 'UAH'),
    bank('UA003052990000026030800340292', 'СЕРВІС МАРКЕТ ТОВ', 'EUR'), bank('UA003052990000035700900492336', 'СЕРВІС МАРКЕТ ТОВ', 'UAH'),
    bank('UA003052990000026001000226666', 'ТИХОНЕНКО ОЛЕКСІЙ ОЛЕКСАНДРОВИЧ ФОП', 'EUR')];
  const m = Rc.matchAccounts(banks, accs, ccy, {});
  assert.deepEqual(m.map(r => r.cfId), [1, 97, 2, 83, null, null, 48], 'цифри IBAN у назві; ФОП — за прізвищем; корп. картка 7365 — не рахунок банку; «євро» — валюта EUR');
  assert.match(m[4].note, /^розподільчий валютний рахунок/);
  assert.match(m[5].note, /^технічний рахунок банку для комісій/);
  assert.ok(m[4].service && m[5].service);
  assert.deepEqual([Rc.balOf('UA003052990000026030800340292'), Rc.balOf('UA003052990000035700900492336'), Rc.balOf('UA003052990000026000400468112'), Rc.balOf('')], ['2603', '3570', '2600', null]);
  assert.deepEqual(accs.filter(Rc.isCorp).map(a => a.id), [90, 94, 89, 95, 84], '«майбутня корп карта» — теж рахунок картки');
  assert.deepEqual(Rc.cardTails(accs, null), { 7365: 90, 3462: 89, 9450: 95 });
});

test('картку перейменували в CRM з номером (02.11.2026): запам\'ятане в браузері не перебиває назву, rules.json — перебиває', () => {
  const accs = [[84, 'корп. картка 4079 ТОВ СЕРВІС МАРКЕТ'], [101, 'корп. картка 5802 ТОВ СЕРВІС МАРКЕТ'],
    [90, 'корп. картка 7365 ФОП Мазовецька Корнелія Олександрівна'], [94, 'майбутня корп карта ФОП Мазовецька Корнелія Олександрівна']].map(([id, name]) => ({ id, name, currency_id: 1 }));
  const local = [{ last4: '4079', account_id: 84, local: true }, { last4: '5802', account_id: 84, local: true }, { last4: '1111', account_id: 94, local: true }];
  // 5802 колись запам'ятали на 84 (картки 5802 у CRM ще не було, а 84 була без номера) — тепер 84 — це 4079, а 5802 — свій рахунок
  assert.deepEqual(Rc.cardTails(accs, null, [{ last4: '7365', account_id: 90 }, ...local]), { 4079: 84, 5802: 101, 7365: 90, 1111: 94 });
  assert.deepEqual(local.map(c => Rc.staleLocalCard(c, accs)), [true, true, false], '4079 і 5802 — уже з назв; 1111 на рахунку без номера — лишається');
  assert.equal(Rc.cardTails(accs, null, [{ last4: '5802', account_id: 84 }])['5802'], 84, 'картка з rules.json сильніша за назву');
  assert.deepEqual(accs.map(Rc.nameTail), ['4079', '5802', '7365', '']);
  // нові рахунки карток 02.11.2026: «корп.картка» без пробілу; той самий номер у двох назвах — не береться
  const more = accs.concat([{ id: 102, name: 'корп.картка 4323 ФОП Хоменко Всеволод Сергійович', currency_id: 1 }, { id: 103, name: 'корп. картка 4270 ФОП Мазовецька Корнелія Олександрівна', currency_id: 1 },
    { id: 104, name: 'корп картка 4270 ФОП Мазовецька Корнелія Олександрівна', currency_id: 1 }]);
  const t2 = Rc.cardTails(more, null, []);
  assert.equal(t2['4323'], 102);
  assert.equal(t2['4270'], undefined, '4270 у двох назвах — лінтер не вгадує');
  assert.equal(Rc.ownerOf('корп.картка 4323 ФОП Хоменко Всеволод Сергійович'), 'ФОП Хоменко');
  // старий рахунок позначили «неактуальний» — береться діючий
  const off = more.map(a => (a.id === 103 ? { ...a, name: 'неактуальна корп. картка 4270 ФОП Мазовецька Корнелія Олександрівна' } : a));
  assert.equal(Rc.cardTails(off, null, [])['4270'], 104);
});

test('власник рахунку з назви CRM; корп. картки власника — лише діючі (уточнення 30.10.2026)', () => {
  const names = ['ФОП Мазовецька Корнелія Олександрівна Приват', 'корп. картка 7365 ФОП Мазовецька Корнелія Олександрівна', 'Приват ТОВ СЕРВІС МАРКЕТ 8112',
    'корп. картка 1665 ТОВ СЕРВІС МАРКЕТ', 'Приват долар ТОВ ПРИКЛАД СЕРВІС 6561', 'corp card 9450 PRYKLAD MARKET INC. Chase',
    'PRYKLAD MARKET INC. Credit Union', 'corpCard №6 ФОП Мартиненко_UAH_7850', '1 ГРН Маркет Приват ТОВ (видалити)', '1 ГРН Польша ФОП', 'Каса'];
  assert.deepEqual(names.map(Rc.ownerOf), ['ФОП Мазовецька', 'ФОП Мазовецька', 'ТОВ СЕРВІС МАРКЕТ', 'ТОВ СЕРВІС МАРКЕТ', 'ТОВ ПРИКЛАД СЕРВІС',
    'PRYKLAD MARKET INC', 'PRYKLAD MARKET INC', 'ФОП Мартиненко', null, null, null]);
  const accs = [[1, 'Приват ТОВ СЕРВІС МАРКЕТ 8112'], [33, 'Приват ТОВ ПРИКЛАД СЕРВІС 5608'], [83, 'ФОП Мазовецька Корнелія Олександрівна Приват'],
    [84, 'корп. картка ТОВ СЕРВІС МАРКЕТ'], [87, 'корп. картка 1665 ТОВ СЕРВІС МАРКЕТ'], [89, 'корп. картка 3462 ФОП Хоменко Всеволод Сергійович'],
    [90, 'корп. картка 7365 ФОП Мазовецька Корнелія Олександрівна'], [94, 'майбутня корп карта ФОП Мазовецька Корнелія Олександрівна'], [72, '1 ГРН Польша ФОП']].map(([id, name]) => ({ id, name }));
  const ids = id => (Rc.ownerCards(accs.find(a => a.id === id), accs) || null);
  assert.deepEqual(ids(83).map(a => a.id), [90], 'ФОП Мазовецька — лише 7365; «майбутня корп карта» не поповнюється');
  assert.deepEqual(ids(1).map(a => a.id), [84, 87]);
  assert.deepEqual(ids(33), [], 'у ПРИКЛАД корп. карток немає');
  assert.equal(ids(72), null, 'власника не видно з назви — обмеження немає');
});
test('тримач корп. картки на дату; людину названо в тексті (будь-який порядок і відмінок); картка за тримачем', () => {
  const card = { last4: '7365', account_id: 90, holders: [{ name: 'Татоян Артем' }, { from: '2026-10-28', name: 'Симонович Сергій' }, { from: '2026-10-23', name: 'Сидоричев Андрій' }] };
  assert.deepEqual(['2026-10-22', '2026-10-23', '2026-10-27', '2026-11-04'].map(d => Rc.holderOf(card, d).name), ['Татоян Артем', 'Сидоричев Андрій', 'Сидоричев Андрій', 'Симонович Сергій']);
  assert.equal(Rc.holderOf({ holders: [{ from: '2026-11-04', name: 'Сидоричев Андрій' }] }, '2026-11-03'), null, 'до дати «з» картку ще ніхто не тримав');
  assert.equal(Rc.personIn('Сидоричев Андрій', 'Андрій Сидоричев: поповнення корп картки'), true);
  assert.equal(Rc.personIn('Сидоричев Андрій', 'поповнення корп карти для Андрія Сидоричева'), true);
  assert.equal(Rc.personIn('Сидоричев Андрій', 'Сидоричев: поповнення'), false, 'лише прізвище — не досить');
  assert.equal(Rc.personIn('Сидорук Тарас', 'Сидорук Інесса Артемівна'), false);
  const cards = [card, { last4: '4546', account_id: 104, holders: [{ from: '2026-11-04', name: 'Сидоричев Андрій' }] }];
  assert.deepEqual(Rc.holderCard(cards, 'Андрій Сидоричев: поповнення корп картки', '2026-11-04'), { id: 104, last4: '4546', name: 'Сидоричев Андрій', from: '2026-11-04' });
  assert.deepEqual(Rc.holderCard(cards, 'Андрій Сидоричев: поповнення корп картки', '2026-10-24'), { id: 90, last4: '7365', name: 'Сидоричев Андрій', from: '2026-10-23' });
  assert.equal(Rc.holderCard(cards, 'Андрій Сидоричев', '2026-11-04', id => id !== 104), null, 'картка не годиться (інший власник)');
  assert.deepEqual(Rc.holderCard([...cards, { last4: '1111', account_id: 5, holders: [{ name: 'Сидоричев Андрій' }] }], 'Андрій Сидоричев', '2026-11-04'), { ambig: ['4546', '1111'] });
  assert.equal(Rc.holderCard(cards, 'Тимур Ларіоненко: реінвест за 03.11 на корп картку', '2026-11-04'), null);
  assert.equal(Rc.holderCard(null, 'Андрій Сидоричев', '2026-11-04'), null);
});
// ---------- 07.11.2026: огляд звірки ----------
test('Приват віддав операцію двічі: дубль за ID (без ID — за референсом) пропускається; вхідний + рух ≠ вихідний — «Виписка неповна» на будь-який період', () => {
  const t = (ID, REF, d, s, p) => ({ ID, REF, REFN: REF ? '1' : '', DAT_OD: d, TIM_P: '13:14', SUM: String(Math.abs(s)), TRANTYPE: s < 0 ? 'D' : 'C', PR_PR: 'r', OSND: p, AUT_CNTR_NAM: 'ФОП Постачальник' });
  const json = (closing, rows) => ({ client: 'ПРИКЛАД', from: '2026-09-27', to: '2026-09-30', accounts: [{ acc: 'UA_9953', ccy: 'UAH', name: 'ТОВ ПРИКЛАД', opening: 10000, closing, transactions: rows }] });
  const rows = [t('X1', 'R1', '28.09.2026', -5000, 'Оплата за послуги'), t('X1', 'R1', '28.09.2026', -5000, 'Оплата за послуги'),
    t('', 'R2', '28.09.2026', 100, 'Повернення'), t('', 'R2', '28.09.2026', 100, 'Повернення'),
    t('', '', '29.09.2026', -1, 'Комісія'), t('', '', '29.09.2026', -1, 'Комісія')]; // без ID і референсу — дві різні комісії
  let [b] = Rc.bankAccounts(json(5098, rows), 'f.json');
  assert.deepEqual(b.rows.map(x => x.amount), [-5000, 100, -1, -1]);
  assert.match(b.warnings.join(' '), /^Банк віддав операцію двічі — дубль пропущено \(2 шт\.: 28\.09\.2026 −5000, 28\.09\.2026 \+100\)/);
  assert.ok(!b.warnings.some(w => /Виписка неповна/.test(w)), 'після пропуску дублів виписка сходиться');
  const cf = [{ id: 501, date: '2026-09-28', amount: -5000, opc: 2, comment: 'Постачальник', acc: 1 }, { id: 502, date: '2026-09-28', amount: 100, opc: 1, comment: '', acc: 1 },
    { id: 503, date: '2026-09-29', amount: -1, opc: 2, comment: '', acc: 1 }, { id: 504, date: '2026-09-29', amount: -1, opc: 2, comment: '', acc: 1 }];
  let R = Rc.periodRecon(b, cf, 5098, '2026-09-28', '2026-09-28');
  assert.deepEqual([R.missing.bank.length, R.diff.close], [0, 0], 'дубль не пропонується внести в CRM вдруге');
  // банк пропустив операцію (−42 346): попередження файлу — і на період, що закінчується раніше за останній день виписки
  [b] = Rc.bankAccounts(json(5098 - 42346, rows), 'f.json');
  assert.ok(b.warnings.includes('Виписка неповна: вхідний + рух ≠ вихідний на 42346 грн — вивантажте заново.'));
  R = Rc.periodRecon(b, cf, 5098, '2026-09-27', '2026-09-30');
  assert.ok(!R.warnings.some(w => /у виписці вхідний/.test(w)), 'на останній день те саме двічі не кажемо');
  const [usd] = Rc.bankAccounts({ from: '2026-09-27', to: '2026-09-30', accounts: [{ acc: 'UA_USD', ccy: 'USD', name: 'ТОВ ПРИКЛАД', opening: 10, closing: 5, transactions: [] }] }, 'u.json');
  assert.ok(usd.warnings.includes('Виписка неповна: вхідний + рух ≠ вихідний на 5 USD — вивантажте заново.'));
  const [noClose] = Rc.bankAccounts({ from: '2026-09-27', to: '2026-09-30', accounts: [{ acc: 'UA_N', ccy: 'UAH', name: 'ТОВ ПРИКЛАД', opening: 10, closing: null, transactions: [] }] }, 'n.json');
  assert.deepEqual(noClose.warnings, [], 'без вихідного залишку перевіряти нічого');
});

test('технічні рахунки банку (2603, 3570) і РКО — не «наші рахунки» для переказів; транзитні ЗП і зіставлені людиною — лишаються', () => {
  const TECH = 'UA003052990000035700900492336', DISTR = 'UA003052990000026030800340292';
  const b = privatOf('UA_FIRMB', [['03.10.2026', -408.39, 'Погашення простроченої заборгованостi за РКО, згiдно з вiдкритою офертою', TECH, 'СЕРВІС МАРКЕТ ТОВ'],
    ['03.10.2026', 21.63, 'Розподіл невикористаної переплати по РКО', 'UA_RKO', 'РКО ЗП ТОВ ПРИКЛАД СЕРВІС'], ['04.10.2026', 495, 'From Alex Sampleson', DISTR, 'СЕРВІС МАРКЕТ ТОВ']], 10000, 10108.24);
  const svc = (iban, owner, cfId) => ({ iban, owner, cfId: cfId || null, rows: [] });
  const banks = [b, svc(TECH, 'СЕРВІС МАРКЕТ ТОВ'), svc(DISTR, 'СЕРВІС МАРКЕТ ТОВ'), svc('UA_RKO', 'РКО ЗП ТОВ ПРИКЛАД СЕРВІС'),
    svc('UA_TRANSIT', TRANSIT), svc('UA_MAPPED3570', 'РКО ТОВ X', 33)];
  const dir = Rc.ownDirectory(banks, ACCS, new Map(), {});
  assert.deepEqual([TECH, DISTR, 'UA_RKO', 'UA_TRANSIT', 'UA_MAPPED3570', 'UA_FIRMB'].map(k => dir.byKey.has(k)), [false, false, false, true, true, true]);
  assert.ok(dir.pay.has('UA_TRANSIT'));
  const R = Rc.periodRecon(b, [], 10000, '2026-10-01', '2026-10-05', undefined, { dir, group: new Set([1]), owner: b.owner });
  assert.deepEqual(R.own.maybe, [], 'плата банку за РКО — не «схоже на переказ між своїми»');
  assert.deepEqual([...R.kinds.values()], ['debit', 'credit', 'credit']);
  assert.deepEqual(R.missing.bank.map(x => x.amount), [-408.39, 21.63, 495], 'пропонується внести в CRM');
});

test('переказ власних коштів на особистий рахунок власника ФОП (2620, без номера картки) — як на особисту картку: витрата', () => {
  const dir = { byKey: new Map(), pay: new Set(), cards: {} }, owner = 'МАЗОВЕЦЬКА КОРНЕЛІЯ ОЛЕКСАНДРІВНА ФОП ФОП Мазовецька';
  const x = (cpIban, cpty, purpose) => ({ date: '2026-10-23', amount: -31800, cpIban, cpty, purpose });
  const k = Rc.ownKind(x('UA003052990000026201100568246', 'МАЗОВЕЦЬКА КОРНЕЛІЯ ОЛЕКСАНДРІВНА', 'Переказ власних коштів'), dir, new Set([83]), owner);
  assert.deepEqual(k, { kind: 'card', why: 'переказ на особистий рахунок власника ФОП (МАЗОВЕЦЬКА КОРНЕЛІЯ ОЛЕКСАНДРІВНА)' });
  assert.equal(Rc.ownKind(x('UA003052990000026001200568246', 'МАЗОВЕЦЬКА КОРНЕЛІЯ ОЛЕКСАНДРІВНА', 'Переказ власних коштів'), dir, new Set([83]), owner).kind, 'maybe', '2600 — рахунок ФОП, не особистий');
  assert.equal(Rc.ownKind(x('UA003052990000026201100568246', 'ПАРАМОНЧУК ВІТАЛІЙ', 'Переказ власних коштів'), dir, new Set([83]), owner).kind, 'maybe', 'не власник');
  assert.equal(Rc.ownKind(x('UA003052990000026201100568246', 'МАЗОВЕЦЬКА КОРНЕЛІЯ ОЛЕКСАНДРІВНА', 'Повернення позики'), dir, new Set([83]), owner), null);
});

test('поповнення корп. картки, у CRM — переказ на рахунок картки (R-NP-CORPCARD-01), а картка звіряється разом з рахунком, з якого списує: той самий рахунок «куди»', () => {
  const b = privatOf('UA_8112', [['03.10.2026', -3000, 'Переказ на корп. картку', 'UA_8296', 'СЕРВІС МАРКЕТ ТОВ']], 10000, 7000);
  const dir = Rc.ownDirectory([b, { iban: 'UA_8296', cfId: 98, rows: [] }], ACCS, new Map(), {});
  const into = new Map([[84, 98]]);
  const run = (recs, into) => Rc.periodRecon(b, Rc.cashflowByAccount(recs).get(1), 7000, '2026-10-01', '2026-10-05', undefined, { dir, group: new Set([1]), owner: b.owner, into });
  let R = run([rec(1, '2026-10-03', [[1, 4, 3000], [84, 3, 3000]])], into);
  assert.deepEqual(R.own.xfers.map(x => [x.state, x.peer, x.item && x.item.id]), [['ok', 98, 1]]);
  assert.equal(R.ok, true);
  assert.deepEqual(run([rec(1, '2026-10-03', [[1, 4, 3000], [84, 3, 3000]])]).own.xfers.map(x => x.state), ['peer'], 'без into — як раніше');
  R = run([rec(1, '2026-10-08', [[1, 4, 3000], [84, 3, 3000]])], into);
  assert.deepEqual(R.own.xfers.map(x => [x.state, x.item && x.item.id]), [['near', 1]], 'з іншою датою — підказка, не пропозиція');
  R = run([rec(1, '2026-10-03', [[1, 4, 3000], [89, 3, 3000]])], into);
  assert.deepEqual(R.own.xfers.map(x => x.state), ['peer'], 'переказ на іншу картку — і далі «з іншим рахунком»');
});

test('multiPairs: ±3 дні й через межу місяця та року; спершу сума, далі дата', () => {
  const x = { date: '2026-12-30', amount: -300 };
  const C = d => [{ date: d, amount: -100, id: 1 }, { date: d, amount: -200, id: 2 }];
  assert.equal(Rc.multiPairs([x], C('2027-01-02')).length, 1);
  assert.equal(Rc.multiPairs([x], C('2027-01-03')).length, 0);
  assert.equal(Rc.multiPairs([{ date: '2026-11-01', amount: -300 }], C('2026-10-29')).length, 1);
  assert.equal(Rc.multiPairs([{ date: '2026-10-29', amount: 300 }], C('2026-10-29')).length, 0, 'інший знак');
});

// ---------- звірка жовтня 2026 (08.11.2026): те, що вже є в CRM, не має бути «немає в CRM» ----------
const r2 = Rc.r2;
// виписка за весь жовтень (privatOf — за 01–05.10)
const privatOct = (...a) => Object.assign(privatOf(...a), { fileTo: '2026-10-31' });
const buy1785 = (booked, when, s, code) => [booked, -s, `4246 **** **** 1665 ${when} Цифровi товари: FACEBK *${code}, FACEBOOK.COM`, 'UA_FX', 'USD валютна позицiя (Compass, ISS1)'];

test('покупки корп. картки за день — один запис CRM: усі покупки дня або частина; покупка не «складається» з комісією в податок', () => {
  const rows = [
    buy1785('07.10.2026', '05.10.2026 14:38:00', 514, 'A1'), buy1785('07.10.2026', '05.10.2026 18:35:00', 1011.31, 'A2'), buy1785('07.10.2026', '05.10.2026 08:26:00', 1386.43, 'A3'),
    ...[1692, 444, 1680, 444, 1692, 444, 444].map((s, i) => buy1785('09.10.2026', `07.10.2026 1${i}:00:00`, s, 'B' + i)),
    ['02.10.2026', -3, 'Комісія за проведення платежу від 02.10.2026', 'UA_BANK', 'ЗА ДЕБЕТУВАННЯ РАХУНКУ(UAH)'],
    buy1785('03.10.2026', '02.10.2026 10:51:40', 142, 'C1'),
  ];
  const b = privatOct('UA_8112', rows, 100000, r2(100000 - 2911.74 - 6840 - 3 - 142));
  const items = Rc.cashflowByAccount([
    rec(1, '2026-10-05', [[87, 2, 2911.74]], { comment: 'Facebook, 1011.31+514,00+1386.43 = 2 911,74 Сергій Симонович' }),
    rec(2, '2026-10-07', [[87, 2, 6840]], { comment: 'Facebook , Сергій Симонович -1692,00 -1692,00 -444,00 -444,00 -444,00 -444,00 -1680,00' }),
    rec(3, '2026-10-05', [[1, 2, 145]], { comment: 'Податки по зп за "Купівля номеру е-сім для менеджера"' }),
  ]);
  const cf = Rc.groupItems(items, [1, 87]);
  const dir = Rc.ownDirectory([b], ACCS, items, {}, [{ last4: '1665', account_id: 87 }]);
  const R = Rc.periodRecon(b, cf, 100000 - 9896.74, '2026-10-01', '2026-10-10', undefined, { dir, group: new Set([1, 87]), owner: b.owner, cards: [87] });
  assert.deepEqual(R.multi.map(g => [g.why, g.crm.map(c => c.id), g.bank.length]), [['card-day', [2], 7], ['card-day', [1], 3]]);
  assert.deepEqual(R.missing.bank.map(x => x.amount).sort((p, q) => p - q), [-142, -3], 'покупка 142 і комісія 3 — не «податок 145»');
  assert.deepEqual(R.missing.crm.map(c => c.id), [3]);
  // без довідника карток — як раніше: 7 покупок одним записом не зводяться (більше 5)
  const R0 = Rc.periodRecon(b, cf, 100000 - 9896.74, '2026-10-01', '2026-10-10', undefined, { dir: Rc.ownDirectory([b], ACCS, items, {}), group: new Set([1, 87]), owner: b.owner, cards: [87] });
  assert.equal(R0.multi.filter(g => g.why === 'card-day').length, 0);
});

test('LiqPay: лід (брутто) + «Комісія LiqPay» з тим самим LIQPAY ID = зарахування в банку; без комісії — як було', () => {
  const L = (d, s, id) => [d, s, `LIQPAY ID ${id} SOID 21ad0000 PBK i70000000904 DATE 2026-10-01 TYPE acquiring`, 'UA_LIQ', 'Платежi через LiqPay'];
  const b = privatOct('UA_8112', [L('01.10.2026', 393.81, 2934000808), L('17.10.2026', 394.8, 2942000000), L('18.10.2026', 98.7, 2942000908)], 0, 887.31);
  const recs = [
    rec(1, '2026-10-01', [[1, 1, 399]], { comment: 'Оплата за доступ до програмного продукту Сервіс (Акаунт #2207)' }),
    rec(2, '2026-10-01', [[1, 2, 5.19]], { comment: 'Комісія LiqPay 16:21: оплата 399.00, зараховано 393.81 (Оплата за доступ до програмного продукту Конс), LIQPAY ID 2934000808' }),
    rec(3, '2026-10-17', [[1, 1, 400]], { comment: 'Оплата за доступ (Акаунт #2295)' }),
    rec(4, '2026-10-17', [[1, 1, 400]], { comment: 'Оплата за доступ (Акаунт #2296)' }),
    rec(5, '2026-10-17', [[1, 2, 5.2]], { comment: 'Комісія LiqPay 5.20: оплата 400.00 (запис 4 «Оплата за доступ (Акаунт #2296)»), зараховано 394.80 — LiqPay 17.10.2026 15:36' }),
    rec(6, '2026-10-18', [[1, 1, 100]], { comment: 'Оплата 100' }),
  ];
  const cf = Rc.cashflowByAccount(recs).get(1);
  const R = Rc.periodRecon(b, cf, 1288.61, '2026-10-01', '2026-10-31', undefined, { dir: Rc.ownDirectory([b], ACCS, new Map(), {}), group: new Set([1]), owner: b.owner });
  assert.deepEqual(R.multi.map(g => [g.why, g.bank.map(x => x.amount), g.crm.map(c => c.id)]), [['liqpay', [393.81], [1, 2]], ['liqpay', [394.8], [4, 5]]]);
  assert.deepEqual(R.missing.bank.map(x => x.amount), [98.7]);
  assert.deepEqual(R.missing.crm.map(c => c.id).sort(), [3, 6]);
});

test('податки із ЗП за день: ВЗ + ПДФО з банку = податки по людях у CRM; ЄСВ 1,00 — окремо; ЗП через транзит за день', () => {
  const T = (s, p) => ['13.10.2026', -s, p, 'UA_TAX', 'ГОЛОВНЕ УДКСУ У М.КИЄВІ'];
  const b = privatOct('UA_8112', [T(5187.72, 'Сплата військового збору за жовтень 2026'), T(5187.72, 'Сплата ПДФО за жовтень 2026'), T(1, 'Сплата ЄСВ за жовтень 2026'),
    ['14.10.2026', -76289, 'Заробітна плата за жовтень 2026', 'UA_TRANSIT', TRANSIT]], 100000, r2(100000 - 10376.44 - 76289));
  const tax = [[1, 3177.78], [2, 3177.78], [3, 2444.44], [4, 1575.44]].map(([id, s]) => rec(id, '2026-10-13', [[5, 2, s]], { comment: `Податки 10 % з … — людина ${id}` }));
  const sal = [10000, 12000, 13000, 15000, 15289, 11000].map((s, i) => salRec(10 + i, '2026-10-14', s));
  const cf = Rc.cashflowByAccount([...tax, ...sal]).get(5);
  const transit = { iban: 'UA_TRANSIT', cfId: null, owner: TRANSIT, rows: [] };
  const R = Rc.periodRecon(b, cf, 100000 - 86664.44, '2026-10-01', '2026-10-31', undefined, { dir: Rc.ownDirectory([b, transit], ACCS, new Map(), {}), group: new Set([5]), owner: b.owner, salary: isSal });
  assert.deepEqual(R.multi.map(g => [g.why, g.bank.length, g.crm.length]), [['tax-day', 2, 4], ['pay-day', 1, 6]]);
  assert.deepEqual(R.missing.bank.map(x => x.amount), [-1], 'ЄСВ 1,00 у CRM немає');
  assert.equal(R.pay, null);
});

test('платіж і його повернення (той самий контрагент) — разом 0, у CRM не вносяться', () => {
  const T = 'ФОП Троянівська Катерина Геннадіївна';
  const b = privatOct('UA_FOP', [['02.10.2026', -1440, 'Сплата за товари', 'UA_T', T], ['02.10.2026', -1440, 'Сплата за товари', 'UA_T', T],
    ['02.10.2026', 1440, 'Повернення помилково перерахованих коштів від ФОП Хоменко', 'UA_T', T], ['03.10.2026', 500, 'Повернення', 'UA_OTHER', 'ТОВ ІНШИЙ']], 5000, 4060);
  const cf = Rc.cashflowByAccount([rec(1, '2026-10-02', [[5, 2, 1440]], { comment: 'ФОП Троянівська: Купівля 4 номерів е-сім по UK' })]).get(5);
  const R = Rc.periodRecon(b, cf, 3560, '2026-10-01', '2026-10-05', undefined, { dir: Rc.ownDirectory([b], ACCS, new Map(), {}), group: new Set([5]), owner: b.owner });
  assert.deepEqual(R.multi.map(g => [g.why, g.bank.map(x => x.amount), g.crm.length]), [['refund', [-1440, 1440], 0]]);
  assert.deepEqual(R.missing.bank.map(x => x.amount), [500], 'повернення без свого платежу — і далі «немає в CRM»');
});

test('multiPairs: переказ на особисту картку = до 10 записів того дня; замовлення одного ліда — разом; кандидати — найближчі за датою', () => {
  // 30.10 Хоменко: 28 799 на свою картку = 7 виводів з балансу + технічний переказ 847
  const x = { date: '2026-10-30', amount: -28799, cpty: 'ХОМЕНКО ВСЕВОЛОД СЕРГІЙОВИЧ', purpose: '5363 **** **** 3912 Переказ власних коштів' };
  const C = [1957, 8233, 2470, 1282, 4910, 4200, 4900, 847].map((s, i) => ({ id: i + 1, date: '2026-10-30', amount: -s, opc: i === 7 ? 4 : 2, comment: 'вивід' }));
  const noise = Array.from({ length: 25 }, (_, i) => ({ id: 100 + i, date: '2026-10-28', amount: -(300 + i * 7), opc: 2, comment: 'інше' }));
  assert.deepEqual(Rc.multiPairs([x], [...noise, ...C], null, { kindOf: () => 'card' }).map(g => g.crm.map(c => c.id).sort((a, b) => a - b)), [[1, 2, 3, 4, 5, 6, 7, 8]]);
  assert.equal(Rc.multiPairs([x], C).length, 0, 'без ознаки «особиста картка» — не більше 5 записів');
  // лід 265416: 6 замовлень 09.10 (20 533 × 5 + 20 535) = дві оплати банку (100 000 + 23 200)
  const L = [20533, 20533, 20533, 20533, 20533, 20535].map((s, i) => ({ id: 10 + i, date: '2026-10-09', amount: s, opc: 1, comment: `Лід: 265416. Замовлення: 2656${i}` }));
  const B = [{ date: '2026-10-09', amount: 100000, cpty: 'Пивоваренко Емілія' }, { date: '2026-10-09', amount: 23200, cpty: 'Бутенко Надія' }];
  assert.deepEqual(Rc.multiPairs(B, L).map(g => [g.bank.length, g.crm.length]), [[2, 6]]);
  // 30 кандидатів за ±3 дні: потрібні два записи того самого дня — останні в списку, а не серед перших 18
  const many = Array.from({ length: 30 }, (_, i) => ({ id: 200 + i, date: `2026-10-1${2 + (i % 3)}`, amount: -(100 + i), opc: 2, comment: 'x' }));
  const two = [{ id: 1, date: '2026-10-15', amount: -1588.89, opc: 2, comment: 'a' }, { id: 2, date: '2026-10-15', amount: -1588.89, opc: 2, comment: 'b' }];
  assert.deepEqual(Rc.multiPairs([{ date: '2026-10-15', amount: -3177.78 }], [...many, ...two]).map(g => g.crm.map(c => c.id)), [[1, 2]]);
});

test('пари 1:1 спершу за ±3 дні: чужий запис з тією самою сумою не «з\'їдає» групу (Цимбал 30 000 + 15 000, Пилипенко 35 000)', () => {
  const b = privatOct('UA_FOP', [['14.10.2026', 30000, 'Сплата за ....', 'UA_1', 'Цимбал Надія Михайлівна'], ['14.10.2026', 15000, 'Сплата за ....', 'UA_1', 'Цимбал Надія Михайлівна'],
    ['22.10.2026', 35000, 'Адвокатский до судовий супровід', 'UA_2', 'Пилипенко Вікторія Володимирівна']], 0, 80000);
  const cf = Rc.cashflowByAccount([rec(1, '2026-10-14', [[5, 1, 45000]], { comment: 'Лід: 269143. Замовлення: 26747' }),
    rec(2, '2026-10-22', [[5, 1, 30000]], { comment: 'Лід: 268966. Замовлення: 27191. Клієнт: Пилипенко Микола Миколайович' }),
    rec(3, '2026-10-22', [[5, 1, 5000]], { comment: 'Лід: 268966. Замовлення: 27038. Клієнт: Пилипенко Микола Миколайович' })]).get(5);
  const R = Rc.periodRecon(b, cf, 80000, '2026-10-01', '2026-10-31', undefined, { dir: Rc.ownDirectory([b], ACCS, new Map(), {}), group: new Set([5]), owner: b.owner });
  assert.equal(R.pairs.size, 0);
  assert.deepEqual(R.multi.map(g => [g.bank.map(x => x.amount), g.crm.map(c => c.id).sort()]), [[[35000], [2, 3]], [[30000, 15000], [1]]]);
  assert.deepEqual([R.missing.bank, R.missing.crm, R.ok], [[], [], true]);
});

test('кошти броніків (rules.json → reference.bronik_accounts): рух — поза звіркою, переказ між своїми звіряється; 1.5 % — розрахунковий запис', () => {
  const b = privatOct('UA_4431', [
    ['02.10.2026', 129650, 'Сплата за користування веб-порталом "Сервіс", Казачкіна Анна Миколаївна', 'UA_C1', 'Транз.рахунок платежi_ DN, DG, DZ'],
    ['05.10.2026', -111535.7, 'Заробітна плата за вересень 2026', 'UA_TRANSIT', 'Ціл-ві зарах.ТОВ ПРИКЛАД СЕРВІС'],
    ['05.10.2026', -6196.42, 'Сплата військового збору за вересень 2026', 'UA_TAX', 'ГОЛОВНЕ УДКСУ У М.КИЄВІ'],
    ['05.10.2026', -6196.42, 'Сплата ПДФО за вересень 2026', 'UA_TAX', 'ГОЛОВНЕ УДКСУ У М.КИЄВІ'],
    ['05.10.2026', -1, 'Сплата ЄСВ за вересень 2026', 'UA_TAX2', 'ГОЛОВНЕ УПРАВЛІННЯ ДПС У М.КИЄВІ'],
    ['05.10.2026', -3803, 'Переказ власних коштів Без ПДВ.', 'UA_5608', 'ТОВ ПРИКЛАД СЕРВІС'],
  ], 11477.89, r2(11477.89 + 129650 - 111535.7 - 12392.84 - 1 - 3803));
  const dir = Rc.ownDirectory([b, { iban: 'UA_5608', cfId: 33, rows: [] }, { iban: 'UA_TRANSIT', cfId: null, owner: 'Ціл-ві зарах.ТОВ ПРИКЛАД СЕРВІС', rows: [] }], ACCS, new Map(), {});
  const items = Rc.cashflowByAccount([rec(1, '2026-10-05', [[38, 4, 3803], [33, 3, 3803]], { comment: 'Переказ між рахунками: 4431 → 5608' })]);
  const skip = (x, k) => (k === 'own' ? null : x.amount > 0 ? 'кошти броніків' : k === 'pay' ? 'ЗП броніків' : Rc.PAY_TAX.test(x.purpose) ? 'податки за броніків' : null);
  const R = Rc.periodRecon(b, items.get(38), -8361262.31, '2026-10-01', '2026-10-31', undefined, { dir, group: new Set([38]), owner: b.owner, skip });
  assert.deepEqual(R.ruled.map(o => [o.row.amount, o.why]), [[129650, 'кошти броніків'], [-111535.7, 'ЗП броніків'], [-6196.42, 'податки за броніків'], [-6196.42, 'податки за броніків'], [-1, 'податки за броніків']]);
  assert.deepEqual([R.missing.bank, R.missing.crm, R.pay, R.amounts], [[], [], null, []]);
  assert.deepEqual(R.own.xfers.map(x => x.state), ['ok']);
  // 5608: запис «1.5% від бронювання» без руху в банку — розрахунковий, не «немає в банку»
  const b33 = privatOct('UA_5608', [['20.10.2026', 100, 'Оплата послуг', 'UA_CL', 'ТОВ КЛІЄНТ']], 1000, 1100);
  const cf33 = Rc.cashflowByAccount([rec(2, '2026-10-02', [[33, 1, 1944.75]], { comment: '1.5% від бронювання 19:03: 129 650.00 × 1.5 % — надходження 02.10 на «6 UAH B2B ПРИКЛАД» від Казачкіна Анна' }),
    rec(3, '2026-10-20', [[33, 1, 100]])]).get(33);
  const calc = c => (c.opc === 1 && /1[.,]5\s*%\s*від\s*бронюван/iu.test(c.comment) ? 'розрахунковий запис' : null);
  // повернення з транзиту ЗП (невдала виплата броніку) — «ЗП броніків», а не їхні кошти (порядок, як у панелі: спершу pay)
  const skipP = (x, k) => (k === 'own' ? null : k === 'pay' ? 'ЗП броніків' : x.amount > 0 ? 'кошти броніків' : Rc.PAY_TAX.test(x.purpose) ? 'податки за броніків' : null);
  const bR = privatOct('UA_4431', [['06.10.2026', 2000, 'Повернення коштів: невірний номер картки', 'UA_TRANSIT', 'Ціл-ві зарах.ТОВ ПРИКЛАД СЕРВІС']], 0, 2000);
  const RR = Rc.periodRecon(bR, [], 2000, '2026-10-01', '2026-10-31', undefined, { dir: Rc.ownDirectory([bR, { iban: 'UA_TRANSIT', cfId: null, owner: 'Ціл-ві зарах.ТОВ ПРИКЛАД СЕРВІС', rows: [] }], ACCS, new Map(), {}), group: new Set([38]), owner: bR.owner, skip: skipP });
  assert.deepEqual(RR.ruled.map(o => [o.row.amount, o.why]), [[2000, 'ЗП броніків']]);
  const R33 = Rc.periodRecon(b33, cf33, 3044.75, '2026-10-01', '2026-10-31', undefined, { dir: Rc.ownDirectory([b33], ACCS, new Map(), {}), group: new Set([33]), owner: b33.owner, calc });
  assert.deepEqual([R33.calc.map(o => o.crm.id), R33.missing.crm, R33.amounts, R33.ok, R33.timingOk, R33.adjWhy], [[2], [], [], false, true, ['calc']]);
});

test('рахунок броніків: «схоже на переказ між своїми» (рахунок «куди» не завантажено) — звіряється з переказом CRM, а не «кошти броніків»', () => {
  const b = privatOct('UA_4431', [['10.10.2026', 50000, 'Переказ власних коштів Без ПДВ.', 'UA_0679_NOT_LOADED', 'ТОВ ПРИКЛАД СЕРВІС']], 0, 50000);
  const dir = Rc.ownDirectory([b], ACCS, new Map(), {});
  const skip = (x, k) => (k === 'own' ? null : k === 'pay' ? 'ЗП броніків' : x.amount > 0 ? 'кошти броніків' : null);
  const run = recs => Rc.periodRecon(b, Rc.cashflowByAccount(recs).get(38) || [], 50000, '2026-10-01', '2026-10-31', undefined, { dir, group: new Set([38]), owner: b.owner, skip });
  let R = run([rec(7, '2026-10-10', [[39, 4, 50000], [38, 3, 50000]], { comment: 'Переказ між рахунками: 0679 → 4431' })]);
  assert.equal(R.own.kinds.get(b.rows[0]).kind, 'maybe');
  assert.deepEqual([R.ruled, R.missing.crm, R.amounts, R.pairs.get(b.rows[0]).id], [[], [], [], 7]);
  R = run([]);
  assert.deepEqual([R.ruled, R.own.maybe.map(m => m.row.amount)], [[], [50000]], 'без запису — «виберіть рахунок куди», а не поза звіркою');
});

test('«бракує переказів між своїми» — і коли решта різниці пояснена (LiqPay: лід + комісія), а не «розбіжність»', () => {
  const b = privatOct('UA_8112', [['01.10.2026', 393.81, 'LIQPAY ID 2934000808 SOID 21ad0000 DATE 2026-10-01 TYPE acquiring', 'UA_LIQ', 'Платежi через LiqPay'],
    ['02.10.2026', -5600, 'Сплата за ліцензійний договір', 'UA_SRV', 'ТОВ ПРИКЛАД СЕРВІС']], 10000, r2(10000 + 393.81 - 5600));
  const dir = Rc.ownDirectory([b, { iban: 'UA_SRV', cfId: 33, rows: [] }], ACCS, new Map(), {});
  const cf = Rc.cashflowByAccount([rec(1, '2026-10-01', [[1, 1, 399]], { comment: 'Оплата за доступ (Акаунт #2207)' }),
    rec(2, '2026-10-01', [[1, 2, 5.19]], { comment: 'Комісія LiqPay 16:21: оплата 399.00, зараховано 393.81, LIQPAY ID 2934000808' })]).get(1);
  const R = Rc.periodRecon(b, cf, r2(10000 + 393.81), '2026-10-01', '2026-10-31', undefined, { dir, group: new Set([1]), owner: b.owner });
  assert.deepEqual([R.own.missing.size, R.adjWhy, R.timingOk, R.xferOnly], [1, ['liqpay'], false, true]);
});
test('маркетолог за контрагентом: ФОП Привільна і Пивоварьов (реінвест) — з rules.json, і як у виписці, і як у погодженнях (16.11.2026)', () => {
  const list = require('../rules/rules.json').reference.counterparty_marketers;
  const R0 = require('../core/recon.js');
  const id = t => (R0.cptyMarketer(list, t) || {}).id;
  assert.equal(id('ПРИВІЛЬНА МАРІЯ АНДРІЇВНА Сплата за послуги програмування зг рах від 12.11.2026'), 208);
  assert.equal(id('ФОП Привільна — реінвест за 12.11 на ФОП Україна'), 208);
  assert.equal(id('ПИВОВАРЬОВ РАДИСЛАВ ІГОРОВИЧ Оплата за послуги'), 136);
  assert.equal(id('ФОП Пивоваренко Р.: реінвест за 10.11 на ФОП, Гугл'), 136);
  assert.equal(id('ФОП Власич Оксана Володимирівна'), 195);
  assert.equal(id('ФОП Іваненко Петро'), undefined);
});
// ---------- огляд 16.11.2026 ----------
test('огляд 16.11: покупка карткою поза періодом, що має свою пару там, не «пояснює» зайвий запис періоду і покупку без запису', () => {
  const BUY = (booked, when, s) => [booked, -s, `4246 **** **** 7365 ${when} 10:00:00 Цифровi товари: FACEBK *Z, Dublin`, 'UA_FX', 'USD валютна позицiя (Compass)'];
  // «after»: зайвий запис 03.10 (операції банку не було) і запис 04.10; банк провів 05.10 покупку від 04.10 — вона належить запису 04.10
  let b = Object.assign(privatOf('UA_FOP', [BUY('05.10.2026', '04.10.2026', 500)], 10000, 9500), { fileTo: '2026-10-10' });
  let items = Rc.cashflowByAccount([rec(1, '2026-10-03', [[90, 2, 500]]), rec(2, '2026-10-04', [[90, 2, 500]])]);
  let cf = Rc.groupItems(items, [5, 90]), dir = Rc.ownDirectory([b], ACCS, items, {});
  let R = Rc.periodRecon(b, cf, 9000, '2026-10-01', '2026-10-03', undefined, { dir, group: new Set([5, 90]), owner: b.owner, cards: [90] });
  assert.deepEqual(R.timing, []);
  assert.deepEqual(R.missing.crm.map(c => c.id), [1]);
  assert.notEqual(R.timingOk, true);
  // без запису 04.10 покупка від 04.10, проведена 05.10, — і далі пояснення запису 03.10 (±1 день), як було
  items = Rc.cashflowByAccount([rec(1, '2026-10-03', [[90, 2, 500]])]);
  R = Rc.periodRecon(b, Rc.groupItems(items, [5, 90]), 9500, '2026-10-01', '2026-10-03', undefined, { dir, group: new Set([5, 90]), owner: b.owner, cards: [90] });
  assert.deepEqual(R.timing.map(t => [t.kind, t.crm.id]), [['after', 1]]);
  // запис періоду з датою покупки сильніший за запис наступного дня з тією самою сумою (операція банку одна)
  b = Object.assign(privatOf('UA_FOP', [BUY('05.10.2026', '03.10.2026', 500)], 10000, 9500), { fileTo: '2026-10-10' });
  items = Rc.cashflowByAccount([rec(1, '2026-10-03', [[90, 2, 500]]), rec(2, '2026-10-04', [[90, 2, 500]])]);
  R = Rc.periodRecon(b, Rc.groupItems(items, [5, 90]), 9000, '2026-10-01', '2026-10-03', undefined, { dir, group: new Set([5, 90]), owner: b.owner, cards: [90] });
  assert.deepEqual(R.timing.map(t => [t.kind, t.crm.id]), [['after', 1]]);
  // «later»: покупка 02.10, проведена 02.10, має запис 02.10; друга така сама, проведена 03.10, у CRM не внесена — «немає в CRM»
  b = privatOf('UA_FOP', [BUY('02.10.2026', '02.10.2026', 444), BUY('03.10.2026', '02.10.2026', 444)], 10000, 9112);
  items = Rc.cashflowByAccount([rec(1, '2026-10-02', [[90, 2, 444]])]);
  cf = Rc.groupItems(items, [5, 90]); dir = Rc.ownDirectory([b], ACCS, items, {});
  R = Rc.periodRecon(b, cf, 9556, '2026-10-03', '2026-10-05', undefined, { dir, group: new Set([5, 90]), owner: b.owner, cards: [90] });
  assert.deepEqual(R.timing, []);
  assert.deepEqual(R.missing.bank.map(x => [x.date, x.amount]), [['2026-10-03', -444]]);
});

test('огляд 16.11: день податків із ЗП, що сходиться цілим, береться до пар 1:1 — чужа операція з тією самою сумою не забирає запис «Податки … з …»', () => {
  const T = (s, p) => ['10.10.2026', -s, p, 'UA_TAX', 'ГОЛОВНЕ УДКСУ У М.КИЄВІ'];
  const b = privatOct('UA_8112', [T(450, 'Сплата військового збору за жовтень 2026'), T(5400, 'Сплата ПДФО за жовтень 2026'),
    ['11.10.2026', -2000, 'Оплата за послуги зг. рах. 15', 'UA_SUP', 'ТОВ ПОСТАЧАЛЬНИК']], 100000, 92150);
  const tax = [[1, 2000], [2, 2000], [3, 1850]].map(([id, s]) => rec(id, '2026-10-10', [[5, 2, s]], { comment: `Податки 10 % з ЗП — людина ${id}` }));
  const own = { dir: Rc.ownDirectory([b], ACCS, new Map(), {}), group: new Set([5]), owner: b.owner };
  let R = Rc.periodRecon(b, Rc.cashflowByAccount(tax).get(5), 94150, '2026-10-01', '2026-10-31', undefined, own);
  assert.deepEqual(R.multi.map(g => [g.why, g.bank.map(x => x.amount), g.crm.map(c => c.id)]), [['tax-day', [-450, -5400], [1, 2, 3]]]);
  assert.deepEqual(R.missing.bank.map(x => x.amount), [-2000], 'немає в CRM — лише оплата постачальнику');
  assert.deepEqual(R.missing.crm, []);
  // податок, внесений цілими платежами (запис на кожен платіж), — і далі пари 1:1, не група: пари потрібні «Внести в CRM»
  const whole = [rec(1, '2026-10-10', [[5, 2, 450]], { comment: 'Сплата військового збору за жовтень 2026' }), rec(2, '2026-10-10', [[5, 2, 5400]], { comment: 'Сплата ПДФО за жовтень 2026' })];
  R = Rc.periodRecon(b, Rc.cashflowByAccount(whole).get(5), 94150, '2026-10-01', '2026-10-31', undefined, own);
  assert.deepEqual([R.multi.length, R.pairs.size], [0, 2]);
});

test('огляд 16.11: продаж валюти, внесений у CRM «обміном» (операції 5/6) між тими самими рахунками, — сходиться, а не «переказ з іншим рахунком»', () => {
  const SELL = 'Гривнi вiд продажу 37000.00 USD по курсу 44.83';
  const b = privatOf('UA_MKT_UAH', [['02.10.2026', 1658710, SELL, 'UA_BANK_FX', 'Продаж UAH клiєнтiв']], 0, 1658710);
  const usd = { iban: 'UA_MKT_USD', cfId: 30, ccy: 'USD', owner: b.owner, rows: [] };
  const own = { dir: Rc.ownDirectory([b, usd], ACCS, new Map(), {}), group: new Set([1]), owner: b.owner };
  let R = Rc.periodRecon(b, Rc.cashflowByAccount([rec(1, '2026-10-02', [[30, 6, 37000], [1, 5, 1658710]])]).get(1), 1658710, '2026-10-01', '2026-10-05', undefined, own);
  assert.deepEqual(R.own.xfers.map(x => [x.row.amount, x.peer, x.state, x.item.op]), [[1658710, 30, 'ok', 'обмін (вхід)']]);
  assert.equal(R.ok, true);
  // обмін з іншим рахунком — і далі «з іншим рахунком»; обмін у зворотному напрямку — не цей рух
  R = Rc.periodRecon(b, Rc.cashflowByAccount([rec(1, '2026-10-02', [[40, 6, 37000], [1, 5, 1658710]])]).get(1), 1658710, '2026-10-01', '2026-10-05', undefined, own);
  assert.deepEqual(R.own.xfers.map(x => x.state), ['peer']);
});

test('огляд 16.11: «запис іншого типу» для переказу між своїми — лише поруч за датою (±3 дні, найближчий); автоматичний запис позначено', () => {
  const b = privatOct('UA_FOP', [['29.10.2026', -5000, 'Переказ власних коштів', 'UA_SRV', 'ТОВ ПРИКЛАД СЕРВІС']], 50000, 45000);
  const own = { dir: Rc.ownDirectory([b, { iban: 'UA_SRV', cfId: 33, rows: [] }], ACCS, new Map(), {}), group: new Set([5]), owner: b.owner };
  const run = recs => Rc.periodRecon(b, Rc.cashflowByAccount(recs).get(5), 45000, '2026-10-01', '2026-10-31', undefined, own);
  // витрата 5 000 від 02.10 (вивід з балансу, автоматичний запис) — не той самий рух, що переказ 29.10
  let R = run([rec(7, '2026-10-02', [[5, 2, 5000]], { comment: 'Підтвердження виведення коштів з балансу — Петренко', is_manual: false })]);
  assert.deepEqual(R.own.xfers.map(x => x.state), ['missing']);
  assert.deepEqual(R.missing.crm.map(c => [c.id, c.auto]), [[7, true]]);
  // поруч — так, і з двох береться найближчий
  R = run([rec(7, '2026-10-02', [[5, 2, 5000]]), rec(8, '2026-10-26', [[5, 2, 5000]], { is_manual: true }), rec(9, '2026-10-28', [[5, 2, 5000]], { is_manual: true })]);
  assert.deepEqual(R.own.xfers.map(x => [x.state, x.item.id, x.item.auto]), [['type', 9, undefined]]);
  // ручний запис, дата якого = час створення до секунди, — автоматичний (як у «Статтях і проєктах»)
  const a = Rc.cashflowByAccount([{ ...rec(1, '2026-10-02', [[5, 2, 1]]), is_manual: true, date: '2026-10-02T09:13:27.000000Z', created_at: '2026-10-02T09:13:27.000000Z' }]).get(5)[0];
  assert.equal(a.auto, true);
});

test('огляд 16.11: гроші надійшли й того ж дня повернуті платникові (те саме призначення або «повернення») — разом 0; переказ власникові — ні', () => {
  const P = 'За послуги адвоката Сервіс від Музичук Ю.С.';
  const b = privatOct('UA_FOP', [['17.10.2026', 60000, P, 'UA_STO', 'СТО ТЕХНО ДНІПРО ТОВ'], ['17.10.2026', -60000, P, 'UA_STO', 'СТО ТЕХНО ДНІПРО ТОВ'],
    ['20.10.2026', 700, 'Оплата послуг', 'UA_K', 'Коваль Іван'], ['21.10.2026', -700, 'Повернення коштів Коваль І.', 'UA_K', 'Коваль Іван'],
    ['22.10.2026', 900, 'Оплата послуг', 'UA_Z', 'Зубченко Олег'], ['23.10.2026', -900, 'Оплата за товар', 'UA_Z', 'Зубченко Олег'], // інше призначення — не повернення
    ['24.10.2026', 300, 'Переказ на картку', 'UA_P2', 'Хоменко Всеволод'], ['24.10.2026', -300, 'Переказ на картку', 'UA_P2', 'Хоменко Всеволод']], 5000, 5000);
  const R = Rc.periodRecon(b, [], 5000, '2026-10-01', '2026-10-31', undefined, { dir: Rc.ownDirectory([b], ACCS, new Map(), {}), group: new Set([5]), owner: b.owner });
  assert.deepEqual(R.multi.map(g => [g.why, g.bank.map(x => x.amount), g.crm.length]), [['refund', [60000, -60000], 0], ['refund', [700, -700], 0]]);
  assert.deepEqual(R.missing.bank.map(x => x.amount).sort((p, q) => p - q), [-900, -300, 300, 900]);
});

test('картку тримають двоє (holders[].also, 2804 з 18.11.2026): поповнення від будь-кого з них — на цю картку; до 18.11 — ні', () => {
  const R0 = require('../core/recon.js');
  const cards = require('../rules/rules.json').reference.cards;
  const hc = (text, date) => R0.holderCard(cards, text, date, null);
  assert.deepEqual([hc('Ігор Шелега: поповнення корп картки', '2026-11-19').last4, hc('поповнення корп картки для Тимура Ларіоненка', '2026-11-19').last4], ['2804', '2804']);
  assert.equal(hc('Тимур Ларіоненко: реінвест на корп картку', '2026-11-19').name, 'Ларіоненко Тимур');
  assert.equal(hc('Ігор Шелега: поповнення корп картки', '2026-11-17'), null);
  assert.deepEqual([hc('Дмитро Миколаївський: поповнення корп картки', '2026-11-19').ambig.sort(), hc('Марія Буца: дотування на корп картку', '2026-11-19').last4], [['3462', '5802'], '4323']);
});