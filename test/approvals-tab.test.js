// Вкладка «Погодження»: рядки реєстру проходять rules.json — поповнення корп. картки стає переказом на corpCard,
// стаття й проєкт — за правилами з режимом fix (ui/approvals-tab.js → applyRules).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const A = require('../ui/approvals-tab.js');

const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules', 'rules.json'), 'utf8'));
const INV = {
  1: { name: '1 ГРН Маркет Приват ТОВ', currency_id: 1 }, 70: { name: 'ФОП Мартиненко Святослав Олександрович Приват', currency_id: 1 },
  79: { name: 'ФОП Сидорук Інесса Артемівна Універсал', currency_id: 1 }, 83: { name: '1 UAH Мазовецька Приват ФОП', currency_id: 1 },
  84: { name: 'corpCard UAH Маркет ТОВ', currency_id: 1 }, 87: { name: 'corpCard UAH_1665 Маркет ТОВ', currency_id: 1 },
  91: { name: 'corpCard №6 ФОП Мартиненко_UAH_7850', currency_id: 1 }, 93: { name: 'corpCard №8 ФОП Сидорук, Mono біла _UAH_4365', currency_id: 1 },
};
const infra = doc.reference.articles.find(a => a.name === 'Інфраструктура');
const PNL = [{ name: 'Переказ між рахунками', cat: 0, op: 0 }, { name: 'Інші витрати', cat: 59, op: 55 }, { name: 'Інфраструктура', cat: infra.category_id, op: infra.operation_id }];
const row = (o) => ({ key: 'r' + Math.random(), date: '22-10-2026', amount: 20000, invoice_id: 70, pnl_category_id: 59, pnl_operation_id: 55, category: 'Інші витрати', project_id: 1, location_id: 1, ...o });
const hist = new Map([['79|артем татоян', new Map([[84, 3], [93, 1]])], ['79|*', new Map([[93, 9], [84, 3]])], ['70|*', new Map([[91, 20]])]]);

test('поповнення корп. картки з рахунку ФОП — переказ; рахунок «куди» за номером картки, отримувачем або єдиною карткою рахунку', () => {
  const rows = [
    row({ recipient: 'Тимур Ларіоненко', content: 'реінвест за 21.10 на корп.картку на США Паспорт і Іміграцію', comment: 'Тимур Ларіоненко: реінвест за 21.10 на корп.картку на США Паспорт і Іміграцію' }),
    row({ recipient: 'Андрій Сидоричев', content: 'поповненя корп карти на тестування Андрій Сидоричев на Україну 20 000 грн 4000000000004365', invoice_id: 83 }),
    row({ recipient: 'Артем Татоян', content: 'Поповнення корп карти для Артема Контентцентра', invoice_id: 79 }),
    row({ recipient: 'Хтось Новий', content: 'Поповнення корп картки для тестування', invoice_id: 1 }),
  ];
  const sum = A.applyRules(rows, INV, PNL, doc, hist);
  assert.deepEqual(rows.map(r => [r.transfer, r.to_invoice_id || null, r.pnl_category_id, r.category]), [
    [true, 91, 0, 'Переказ між рахунками'],   // з Мартиненка поповнюють лише картку №6
    [true, 93, 0, 'Переказ між рахунками'],   // повний номер …4365 — corpCard №8
    [true, 93, 0, 'Переказ між рахунками'],   // Татояну з ФОП Сидорук — на її картку: з 30.10.2026 лише картка власника рахунку (раніше за історією — corpCard Маркет)
    [true, null, 0, 'Переказ між рахунками'], // Маркет: три картки, історії немає — вибрати в реєстрі
  ]);
  assert.deepEqual({ transfers: sum.transfers, target: sum.target }, { transfers: 4, target: 3 });
  assert.match(rows[0].edited.join(), /R-NP-CORPCARD-01.*rules\.json/);
  assert.match(rows[3].edited.join(), /виберіть рахунок «куди»/);
  assert.equal(rows[0].marketer_id, null);
});

test('витрата з самого рахунку corpCard, комісія, уже переказ і внесені рядки — не чіпаються', () => {
  const rows = [
    row({ content: 'Поповнення корпоративної картки 1665', invoice_id: 87 }),
    row({ content: 'Комісія за поповнення корп картки' }),
    row({ content: 'поповнення корп картки', transfer: true, to_invoice_id: 91, pnl_category_id: 0, pnl_operation_id: 0 }),
    row({ content: 'поповнення корп картки', done: 'внесено' }),
  ];
  const before = JSON.stringify(rows);
  const sum = A.applyRules(rows, INV, PNL, doc, null);
  assert.equal(JSON.stringify(rows), before);
  assert.equal(sum.transfers, 0);
});

test('стаття за правилом з режимом fix; немає статті в довіднику реєстру — лише примітка', () => {
  const rows = [row({ recipient: 'Хостинг', content: 'Оплата серверів Hetzner за жовтень' })];
  const sum = A.applyRules(rows, INV, PNL, doc, null);
  assert.deepEqual([rows[0].pnl_category_id, rows[0].pnl_operation_id, rows[0].category], [infra.category_id, infra.operation_id, 'Інфраструктура']);
  assert.equal(sum.category, 1);
  assert.match(rows[0].edited.join(), /R-INFRA-01/);
  const r2 = [row({ content: 'Оплата серверів Hetzner за жовтень' })];
  const s2 = A.applyRules(r2, INV, PNL.slice(0, 2), doc, null);
  assert.equal(r2[0].category, 'Інші витрати');
  assert.match(s2.notes.join(), /немає в довіднику реєстру/);
});

test('маркетолог за контрагентом (ФОП Власич → Сливко): лише для статті з маркетологом і якщо реєстр його не дав', () => {
  const P2 = PNL.concat([{ name: 'Реінвест', cat: 20, op: 30, need: true }]);
  const verb = { recipient: 'ФОП Власич Оксана Володимирівна', content: 'Оплата за рекламні послуги зг рах від 03.11.2026', pnl_category_id: 20, pnl_operation_id: 30, category: 'Реінвест', marketer_id: null, marketer: '' };
  const rows = [row(verb), row({ ...verb, marketer_id: 208, marketer: 'Привільна Марія' }), row({ ...verb, pnl_category_id: 59, pnl_operation_id: 55, category: 'Інші витрати' }), row({ ...verb, recipient: 'ФОП Інший' })];
  const sum = A.applyRules(rows, INV, P2, doc, null);
  assert.deepEqual(rows.map(r => [r.marketer_id, r.marketer]), [[195, 'Євген Сливко'], [208, 'Привільна Марія'], [null, ''], [null, '']]);
  assert.equal(sum.marketer, 1);
  assert.match(rows[0].edited.join(), /маркетолог «Євген Сливко» — за контрагентом «Власич Оксана» \(rules\.json\)/);
  // стаття без позначки в «Довіднику», але CRM вимагає маркетолога (marketer_add_balance → needMk реєстру) — так само, як вирішує реєстр
  const P3 = PNL.concat([{ name: 'Реінвест', cat: 20, op: 30, need: false }]);
  const r3 = [row(verb)];
  A.applyRules(r3, INV, P3, doc, null);
  assert.equal(r3[0].marketer_id, null, 'без needMk — як раніше');
  const r4 = [row(verb)];
  A.applyRules(r4, INV, P3, doc, null, { '20:30': true });
  assert.deepEqual([r4[0].marketer_id, r4[0].marketer], [195, 'Євген Сливко']);
});

test('дата «по»: лише погодження до неї включно — решта рядків не перевіряється й не вноситься', () => {
  const rows = [{ key: 'a', date: '27-10-2026 00:00' }, { key: 'b', date: '28-10-2026 00:00' }, { key: 'c', date: '27-10-2026 09:15' }, { key: 'd', date: '29-10-2026 00:00' }];
  assert.equal(A.cutByDate(rows, ''), null, 'без «по» — усі рядки');
  assert.equal(rows.length, 4);
  assert.deepEqual(A.cutByDate(rows, '2026-10-27'), { to: '2026-10-27', kept: 2, dropped: 2 });
  assert.deepEqual(rows.map(r => r.key), ['a', 'c'], 'рядки прибрано на місці — реєстр бачить лише їх');
});

test('довідник карток rules.json: поповнення картки — на її рахунок (ID 90 «корп. картка 7365 …»), не на «майбутня корп карта»', () => {
  // 30.10.2026: ID 90 перейменовано з «…2044» на «корп. картка 7365 …», ID 94 — «майбутня корп карта …» (картки ще немає)
  const inv = { ...INV, 90: { name: 'корп. картка 7365 ФОП Мазовецька Корнелія Олександрівна', currency_id: 1 }, 94: { name: 'майбутня корп карта ФОП Мазовецька Корнелія Олександрівна', currency_id: 1 } };
  const rows = [row({ recipient: 'Сергій Симонович', content: 'поповнення корп картки 7365 на тестування', invoice_id: 1 })];
  A.applyRules(rows, inv, PNL, doc, null);
  assert.deepEqual([rows[0].transfer, rows[0].to_invoice_id], [true, 90]);
  assert.match(rows[0].edited.join(), /номер картки 7365/);
});

// рахунки CRM з назвами від 30.10.2026
const NEW = { 1: 'Приват ТОВ СЕРВІС МАРКЕТ 8112', 33: 'Приват ТОВ ПРИКЛАД СЕРВІС 5608', 68: 'ФОП Хоменко Всеволод Сергійович Приват',
  83: 'ФОП Мазовецька Корнелія Олександрівна Приват', 84: 'корп. картка ТОВ СЕРВІС МАРКЕТ', 87: 'корп. картка 1665 ТОВ СЕРВІС МАРКЕТ',
  88: 'корп. картка 2474 ТОВ СЕРВІС МАРКЕТ', 89: 'корп. картка 3462 ФОП Хоменко Всеволод Сергійович', 90: 'корп. картка 7365 ФОП Мазовецька Корнелія Олександрівна',
  94: 'майбутня корп карта ФОП Мазовецька Корнелія Олександрівна' };
const INV2 = Object.fromEntries(Object.entries(NEW).map(([id, name]) => [id, { id: Number(id), name, currency_id: 1 }]));

test('поповнення корп. картки — лише на картку власника рахунку «з»: підказка «Корпоративних карток» з карткою ТОВ для ФОП Мазовецька замінюється', () => {
  const xferRow = o => row({ transfer: true, pnl_category_id: 0, pnl_operation_id: 0, category: 'Переказ між рахунками', ...o });
  const rows = [
    // як на знімку 30.10.2026: платять з ФОП Мазовецька, реєстр підказав картку ТОВ (аркуш «Корпоративні картки», «татоян» → 84)
    xferRow({ invoice_id: 83, amount: 10000, recipient: 'Артем Татоян', comment: 'Артем Татоян: Поповнення на тестування, на корп картку для фб 20000грн - промоут', to_invoice_id: 84, toAuto: true, toSuggest: { invoice_id: 84 } }),
    row({ invoice_id: 68, content: 'поповнення корп картки для реклами' }),
    row({ invoice_id: 68, content: 'поповнення корп картки 7365' }),                         // номер картки іншого власника
    row({ invoice_id: 1, content: 'поповнення корп картки 1665' }),
    row({ invoice_id: 1, content: 'поповнення корп картки' }),                              // у ТОВ кілька карток — вибрати
    row({ invoice_id: 33, content: 'поповнення корп картки' }),                             // у ПРИКЛАД карток немає
    xferRow({ invoice_id: 83, comment: 'на корп картку', to_invoice_id: 94 }),              // «майбутня корп карта» — картки ще немає
    xferRow({ invoice_id: 83, comment: 'на корп картку', to_invoice_id: 90 }),              // уже правильна — не чіпається
  ];
  const sum = A.applyRules(rows, INV2, PNL, doc, null);
  assert.deepEqual(rows.map(r => r.to_invoice_id || null), [90, 89, null, 87, null, null, 90, 90]);
  assert.deepEqual([rows[0].toAuto, rows[0].toSuggest], [true, null], 'підпис «за аркушем «Корпоративні картки»» — лише для картки від реєстру');
  // 22.10.2026 картку 7365 тримав Татоян (rules.json → holders), а погодження — від нього: картка за тримачем
  assert.match(rows[0].edited.join(), /«корп\. картка ТОВ СЕРВІС МАРКЕТ» — картка іншого власника.*стало «корп\. картка 7365 ФОП Мазовецька Корнелія Олександрівна» \(картку 7365 тримає Татоян Артем\)/);
  assert.match(rows[2].edited.join(), /номер картки 7365 — це картка «корп\. картка 7365 ФОП Мазовецька Корнелія Олександрівна» іншого власника, а платять з «ФОП Хоменко/);
  assert.match(rows[4].edited.join(), /у ТОВ СЕРВІС МАРКЕТ 3 діючі корп\. картки \(ID 84, 1665, 2474\) — виберіть картку/);
  assert.match(rows[6].edited.join(), /цієї картки немає або рахунок неактуальний; стало «корп\. картка 7365/);
  assert.equal(rows[7].edited, undefined);
  assert.equal(sum.owner, 2);
  // правило вимкнено (reference.card_topup.same_owner = false) — підказка реєстру лишається
  const off = JSON.parse(JSON.stringify(doc));
  off.reference.card_topup = { same_owner: false };
  const r2 = [xferRow({ invoice_id: 83, comment: 'на корп картку', to_invoice_id: 84, toAuto: true, toSuggest: { invoice_id: 84 } })];
  A.applyRules(r2, INV2, PNL, off, null);
  assert.equal(r2[0].to_invoice_id, 84);
  // рахунок «куди», вибраний вручну в редакторі чи таблиці реєстру (латка REGISTRY_TO)
  assert.equal(A.ownerBad(83, 90, INV2, doc), '');
  assert.match(A.ownerBad(83, 84, INV2, doc), /з «ФОП Мазовецька Корнелія Олександрівна Приват» — лише на картку ФОП Мазовецька/);
  assert.match(A.ownerBad(83, 94, INV2, doc), /цієї картки ще немає/);
  assert.match(A.ownerBad(33, 84, INV2, doc), /немає корп\. картки ТОВ ПРИКЛАД СЕРВІС/);
  assert.equal(A.ownerBad(83, 68, INV2, doc), '', 'переказ не на корп. картку — без обмежень');
  assert.equal(A.ownerBad(83, 84, INV2, off), '', 'правило вимкнено');
  // підказка «куди», коли рядок стає переказом у таблиці реєстру (латка REGISTRY_TO)
  assert.deepEqual(A.ownerSuggest({ invoice_id: 83, comment: 'Татоян: на корп картку' }, { invoice_id: 84, name: 'x' }, INV2, doc), { invoice_id: 90, name: NEW[90], why: 'єдина картка ФОП Мазовецька' });
  assert.deepEqual(A.ownerSuggest({ invoice_id: 1, comment: 'Татоян: на корп картку' }, { invoice_id: 84, name: 'x' }, INV2, doc), { invoice_id: 84, name: 'x' });
  assert.equal(A.ownerSuggest({ invoice_id: 33, comment: 'на корп картку' }, { invoice_id: 84 }, INV2, doc), null);
});

test('дві діючі картки власника (04.11.2026): картку визначає номер, тримач (rules.json) чи отримувач, а не «з цього рахунку завжди одна картка»', () => {
  const inv = { 1: INV[1], 70: INV[70], 83: { name: 'ФОП Мазовецька Корнелія Олександрівна Приват', currency_id: 1 },
    90: { name: 'корп. картка 7365 ФОП Мазовецька Корнелія Олександрівна', currency_id: 1 }, 103: { name: 'корп. картка 0274 ФОП Мазовецька Корнелія Олександрівна', currency_id: 1 },
    91: { name: 'корп. картка 7850 ФОП Мартиненко Святослав Олександрович', currency_id: 1 }, 104: { name: 'корп. картка 4546 ФОП Мартиненко Святослав Олександрович', currency_id: 1 } };
  // до 04.11 з рахунку Мартиненка поповнювали лише 7850 (усе — від Ларіоненка); Сидоричев поповнював 7365, коли тримав її (23–27.10)
  const h = new Map([['70|*', new Map([[91, 20]])], ['70|тимур ларіоненко', new Map([[91, 20]])], ['83|андрій сидоричев', new Map([[90, 3]])]]);
  const day = '04-11-2026';
  const rows = [
    row({ date: day, recipient: 'Андрій Сидоричев', content: 'поповнення корп картки на тестування США' }),        // тримач 4546 з 04.11 (rules.json)
    row({ date: day, recipient: 'Тимур Ларіоненко', content: 'реінвест за 03.11 на корп картку - США' }),          // як попередні поповнення від нього
    row({ date: day, recipient: 'Хтось Новий', content: 'поповнення корп картки на тестування' }),                  // нічим не визначено — вибрати
    row({ date: day, recipient: 'Хтось Новий', content: 'поповнення корп картки 4546' }),                           // номер у тексті
    row({ date: '03-11-2026', recipient: 'Андрій Сидоричев', content: 'поповнення корп картки на тестування' }),   // 03.11 він 4546 ще не тримав
    row({ date: day, invoice_id: 83, recipient: 'Андрій Сидоричев', content: 'поповнення корп картки' }),          // 7365 тепер тримає Симонович — історія не підставляє
  ];
  const sum = A.applyRules(rows, inv, PNL, doc, h);
  assert.deepEqual(rows.map(r => [r.transfer, r.to_invoice_id || null]), [[true, 104], [true, null], [true, null], [true, 104], [true, null], [true, null]]); // 17.11.2026: 7850 тримає Симонович — історія Ларіоненка її більше не підставляє
  assert.equal(sum.target, 2);
  assert.match(rows[0].edited.join(), /«корп\. картка 4546 ФОП Мартиненко Святослав Олександрович» \(картку 4546 тримає Сидоричев Андрій \(з 04\.11\.2026\)\)/);
  assert.match(rows[1].edited.join(), /2 діючі корп\. картки \(7850, 4546\) — виберіть картку/); // до 17.11.2026 — «як попередні поповнення від цього отримувача»
  assert.match(rows[2].edited.join(), /у ФОП Мартиненко 2 діючі корп\. картки \(7850, 4546\) — виберіть картку; з номером картки в погодженні/);
  assert.match(rows[5].edited.join(), /у ФОП Мазовецька 2 діючі корп\. картки \(7365, 0274\)/);
  // підказка реєстру (аркуш «Корпоративні картки»: людина → картка) поступається тримачу; картка, яку тримає інша людина, — не підставляється
  assert.deepEqual(A.ownerSuggest({ invoice_id: 70, date: day, recipient: 'Андрій Сидоричев', comment: 'Андрій Сидоричев: поповнення корп картки' }, { invoice_id: 91, name: 'x' }, inv, doc),
    { invoice_id: 104, name: inv[104].name, why: 'картку 4546 тримає Сидоричев Андрій (з 04.11.2026)' });
  assert.deepEqual(A.ownerSuggest({ invoice_id: 70, date: day, recipient: 'Тимур Ларіоненко', comment: 'Тимур Ларіоненко: реінвест' }, { invoice_id: 91, name: 'x' }, inv, doc), null); // 17.11.2026: 7850 тримає Симонович — підказка для іншої людини не підставляється
  assert.equal(A.ownerSuggest({ invoice_id: 83, date: day, recipient: 'Андрій Сидоричев', comment: 'Андрій Сидоричев: на корп картку' }, { invoice_id: 90, name: 'x' }, inv, doc), null);
  const r7 = [row({ date: day, invoice_id: 83, recipient: 'Андрій Сидоричев', content: 'поповнення корп картки', toSuggest: { invoice_id: 90 } })];
  A.applyRules(r7, inv, PNL, doc, null);
  assert.deepEqual([r7[0].to_invoice_id, r7[0].toSuggest], [null, null], 'підказку реєстру з карткою Симоновича відкинуто');
});

test('«Довідник» реєстру: рахунку немає (клітинка AA5 «Куди (переказ)») — оновити рахунки дією ref і повторити запис; статті й маркетологи — без змін', async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  try {
    const crm = Object.keys(NEW).map(Number).concat([2, 3, 30, 32]).map(id => ({ id, name: NEW[id] || `рахунок ${id}`, currency_id: 1 }));
    const users = [{ id: 208, name: 'Привільна Марія', role: { name: 'Маркетолог' } }, { id: 1249, name: 'Роман Веніамінов', role: { name: 'Таргет' } },
      { id: 301, name: 'Колишній Маркетолог', role: { name: 'Маркетолог' }, is_working: false }, { id: 5, name: 'Бухгалтерка', role: { name: 'Бухгалтер' } }];
    const apiOf = us => ({ get: async p => (p === 'invoice?get_all=1' ? crm : p === 'user/?all=true' ? us : assert.fail(p)) });
    const api = apiOf(users);
    const posts = [], said = [];
    const post = async b => { posts.push(JSON.parse(JSON.stringify(b))); return { ok: true, accounts: b.accounts.length, pnl: 34, marketers: b.marketers.length }; };
    const say = (m, t) => said.push([t || '', m]);
    const R2 = [{ id: 208, name: 'Привільна Марія [208]' }, { id: 1361, name: 'Симонович Сергій [1361]' }];
    const ref = A.registryRef({ api, live: true });
    const ERR = 'Дані, введені в клітинку AA5, не відповідають установленим для неї правилам перевірки даних.';
    const p = { action: 'edit', rowKey: '29.10.2026#h1', fields: { period: '', transfer_to: 90, transfer_name: 'стара назва' } };
    assert.equal(await ref.refused(p, ERR, post, say, false, { invoices: {} }, 'https://script.google.com/macros/s/x/exec', R2), true);
    assert.equal(posts.length, 1);
    assert.deepEqual(Object.keys(posts[0]), ['action', 'accounts', 'pnl', 'marketers']);
    assert.deepEqual([posts[0].action, posts[0].pnl, posts[0].marketers], ['ref', [], [[208, 'Привільна Марія'], [1361, 'Симонович Сергій']]]);
    assert.deepEqual(posts[0].accounts.find(a => a[0] === 90), [90, NEW[90], 1]);
    assert.equal(p.fields.transfer_name, NEW[90], 'запис повторюється зі свіжою назвою');
    assert.match(said.map(s => s[1]).join('\n'), /стовпець «Куди \(переказ\)» аркуша «Реєстр», клітинка AA5[\s\S]*рахунки оновлено з кешфлоу — 14 \(статті й маркетологи — без змін\) — записую ще раз/);
    // повтор знову не прийнято — пояснення, без нового оновлення
    assert.equal(await ref.refused(p, ERR, post, say, true, null, '', R2), false);
    assert.equal(posts.length, 1);
    assert.match(said[said.length - 1][1], /знову не прийняв/);
    // інша клітинка («Стаття», P) і запис без рахунків — не про «Довідник» рахунків
    assert.equal(await ref.refused(p, 'Дані, введені в клітинку P5, не відповідають установленим для неї правилам перевірки даних.', post, say, false, null, '', R2), false);
    assert.equal(await ref.refused({ action: 'edit', fields: { comment: 'x' } }, ERR, post, say, false, null, '', R2), false);
    // прив'язка рахунку банку: «рахунку 95 немає в довіднику реєстру» — теж оновлення (а щойно оновлений «Довідник» — без повтору)
    assert.equal(await ref.refused({ action: 'bankmap', items: [{ iban: 'UA1', acc: 95 }] }, 'рахунку 95 немає в довіднику реєстру — натисніть «Оновити довідник у реєстрі»', post, say, false, null, '', R2), false);
    assert.match(said[said.length - 1][1], /щойно оновлено/);
    // маркетологів реєстр ще не віддав (результати з черги — на початку перевірки): з кешфлоу, як кнопкою ⚙; без них «Довідник» не чіпаємо
    // (дія ref замінила б маркетологів порожнім списком)
    assert.equal(await A.registryRef({ api: apiOf([]), live: true }).refused(p, ERR, post, say, false, null, '', []), false);
    assert.equal(posts.length, 1);
    assert.equal(await A.registryRef({ api, live: true }).refused(p, ERR, post, say, false, null, '', []), true);
    assert.deepEqual(posts[1].marketers, [[208, 'Привільна Марія'], [1249, 'Роман Веніамінов']]);
    assert.match(said[said.length - 1][1], /маркетологи — з кешфлоу, як кнопкою ⚙/);
    posts.splice(1);
    // перегляд (пробний режим) — нічого
    assert.equal(await A.registryRef({ api, live: false }).refused(p, ERR, post, say, false, null, '', R2), false);

    // «1. Отримати й перевірити»: реєстр не віддав свій список рахунків — «Довідник» оновлюється, лише коли рахунки кешфлоу змінилися
    const ref2 = A.registryRef({ api, live: true }), url = 'https://script.google.com/macros/s/y/exec';
    const O = { invoices: Object.fromEntries(crm.map(a => [a.id, a])) };
    await ref2.accounts(O, post, say, url, R2);
    assert.equal(posts.length, 2);
    await ref2.accounts(O, post, say, url, R2);
    assert.equal(posts.length, 2, 'ті самі рахунки — без запиту');
    O.invoices[94] = { id: 94, name: 'корп. картка 9999 ФОП Мазовецька Корнелія Олександрівна', currency_id: 1 };
    await ref2.accounts(O, post, say, url, R2);
    assert.equal(posts.length, 3, 'перейменований рахунок — оновлення');
    await A.registryRef({ api, live: true }).accounts(O, post, say, '', R2);
    await A.registryRef({ api, live: false }).accounts(O, post, say, url + '2', R2);
    assert.equal(posts.length, 3, 'без посилання на реєстр і в пробному режимі — нічого');
  } finally { delete globalThis.localStorage; }
});

test('закриті в CRM місяці: погодження з таким періодом — з періодом першого відкритого місяця, дата та сама', () => {
  const rows = [{ key: 'a', date: '03-11-2026 00:00', period: '01-10-2026' }, { key: 'b', date: '28-10-2026 00:00', period: '01-10-2026' },
    { key: 'c', date: '04-11-2026 00:00', period: '01-11-2026' }, { key: 'd', date: '30-09-2026 00:00', period: '01-09-2026', done: 'внесено' }];
  assert.deepEqual(A.moveClosed(rows, '2026-10'), { moved: 2, from: ['10.2026'], to: '11.2026' });
  assert.deepEqual(rows.map(r => r.period), ['01-11-2026', '01-11-2026', '01-11-2026', '01-09-2026']);
  assert.deepEqual([rows[0].date, rows[0].periodManual, rows[0].periodSrc], ['03-11-2026 00:00', true, '10.2026 закрито в кешфлоу']);
  assert.equal(rows[2].periodManual, undefined, 'відкритий місяць не чіпається');
  assert.deepEqual(A.moveClosed(rows, null), { moved: 0, from: [], to: null });
});
test('той самий текст погодження й запису кешфлоу: скопійовані клітинки (табуляція, «хто погодив»); інша дата в тексті чи інший запис — ні', () => {
  const reg = 'Дмитро Миколаївський: поповенння на тестування на фб, на корпоративну Карту (Україна і США)';
  assert.equal(A.sameText(reg, 'Дмитро Миколаївський\tпоповенння на тестування на фб, на корпоративну Карту (Україна і США)'), true);
  assert.equal(A.sameText('Артем Татоян: Поповнення на тестування, на корп картку для фб 20000грн - промоут',
    'Артем Татоян\tТарас\tПоповнення на тестування, на корп картку для фб 20000грн - промоут'), true);
  assert.equal(A.sameText('Тимур Ларіоненко: реінвест за 28.10 на корп картку, США', 'Тимур Ларіоненко: реінвест за 29.10 на корп картку, США'), false);
  assert.equal(A.sameText(reg, 'Facebook 29.10 Миколаївський Дмитро (тест США): 758.82 UAH, корп. картка 3462, залишок 6337.59'), false);
  assert.equal(A.sameText('ЗП', 'ЗП'), false);
});

test('«можливий дубль» (30.10.2026): 7 000 Миколаївському в погодженні з рахунку Хоменка, у кешфлоу ID 25472 — з рахунку Мазовецької → та сама виплата, не створювати', () => {
  const text = 'Дмитро Миколаївський: поповенння на тестування на фб, на корпоративну Карту (Україна і США)';
  const crm = 'Дмитро Миколаївський\tпоповенння на тестування на фб, на корпоративну Карту (Україна і США)';
  const row = { comment: text, invoice_id: 68, amount: 7000 };
  const f = { id: 25472, invoice_id: 70, day: '29-10-2026', comment: crm, taken: false };
  assert.equal(A.sameDup(row, [f], [row]), f);
  // запис уже прив'язаний до іншого рядка — не цей
  assert.equal(A.sameDup(row, [{ ...f, taken: true }], [row]), null);
  // у цій самій перевірці є рядок з рахунком запису й тим самим текстом і сумою — запис його, а цей рядок справді інша виплата
  const twin = { comment: text, invoice_id: 70, amount: 7000 };
  assert.equal(A.sameDup(row, [f], [row, twin]), null);
  // інший текст (інша виплата з тією самою сумою) — як і раніше «можливий дубль» на ваш вибір
  assert.equal(A.sameDup(row, [{ ...f, comment: 'Сидоричев Андрій: реінвест за 29.10 на корп картку, Україна' }], [row]), null);
});
test('перевірка дублів наперед: той самий запит, що робить реєстр (дата ± dupDays, та сама сума)', () => {
  const b = e => String(e).padStart(2, '0'), k = e => b(e.getDate()) + '-' + b(e.getMonth() + 1) + '-' + e.getFullYear();
  const v = e => { const t = /^(\d{2})-(\d{2})-(\d{4})/.exec(e); return new Date(+t[3], +t[2] - 1, +t[1]); }; // як у коді реєстру
  assert.equal(A.dupUrl({ date: '30-10-2026 12:00', amount: 7000 }, 3, k, v), '/api/invoice-payment?date_from=27-10-2026&date_to=02-11-2026&amount_from=7000&amount_to=7000&per_page=100');
  assert.equal(A.dupUrl({ date: '01-11-2026 09:30', amount: 4587.16 }, 0, k, v), '/api/invoice-payment?date_from=01-11-2026&date_to=01-11-2026&amount_from=4587.16&amount_to=4587.16&per_page=100');
});

test('пул запитів: не більше n одночасно, у порядку списку, без повторів; збій — null (тоді реєстр спитає сам)', async () => {
  let active = 0, peak = 0;
  const calls = [];
  const get = url => { calls.push(url); active++; peak = Math.max(peak, active); return new Promise((res, rej) => setTimeout(() => { active--; if (url === 'bad') rej(new Error('мережа')); else res({ url }); }, 5)); };
  const map = A.pool(['a', 'b', 'a', 'bad', 'c', 'd', 'e'], get, 2);
  assert.equal(map.size, 6);
  await Promise.all(map.values());
  assert.equal(peak, 2);
  assert.deepEqual(calls, ['a', 'b', 'bad', 'c', 'd', 'e']);
  assert.equal(await map.get('bad'), null);
  assert.deepEqual(await map.get('a'), { url: 'a' });
});
test('«Потрібна правка в реєстрі» → рядки таблиці без позначки: стаття й рахунок з реєстру, якщо є; інакше — обрати; податки й не знайдені — у списку', () => {
  const R = '«перевірити» — перевірте в реєстрі статтю й суму, поставте «так» або «ні»';
  const notReady = [
    { key: '02.11.2026#h1', recipient: '', amountText: '145 000,00 грн.', reason: R },
    { key: '02.11.2026#h2', recipient: 'Хоменко', amountText: '18 852,00 грн.', reason: R },
    { key: '30.10.2026#h3', recipient: 'Дмитро', amountText: '7 000,00 грн.', reason: R },
    { key: '30.10.2026#h4', recipient: 'Без суми', amountText: '', reason: 'немає суми' },
    { key: '02.11.2026#h5_tax', recipient: 'ДПС', amountText: '', reason: 'рядка виплати до цих податків у реєстрі немає' },
    { key: '02.11.2026#h6', recipient: 'Немає у bank', amountText: '1,00', reason: R },
    { key: '02.11.2026#h7', recipient: 'Уже в таблиці', amountText: '1,00', reason: R },
  ];
  const b = (key, o) => ({ key, date: '2026-11-02', recipient: '', comment: '', action: 'перевірити', status: '', id: 0, acc: null, cur: 'UAH', amount: null, amounts: [], textAmount: null, category: '', transfer: false, toAcc: null, tax: false, source: 'Готівка', ...o });
  const bank = [
    b('02.11.2026#h1', { amounts: [145000], textAmount: 145000 }),
    b('02.11.2026#h2', { recipient: 'Хоменко', comment: 'Хоменко: ЗП жовтень', acc: 68, amount: 18852, amounts: [18852], textAmount: 18852, category: 'ЗП відділу продажів [55:47]', source: 'ФОП Хоменко приват' }),
    b('30.10.2026#h3', { date: '2026-10-30', recipient: 'Дмитро', acc: 83, amount: 7000, amounts: [7000], category: 'Переказ між рахунками [0:0]', transfer: true, toAcc: 90 }),
    b('30.10.2026#h4', { date: '2026-10-30', recipient: 'Без суми', action: 'так', category: 'Нема такої статті' }),
    b('02.11.2026#h5_tax', { tax: true }),
    b('02.11.2026#h7', {}),
  ];
  const pnl = [{ id: '55:47', name: 'ЗП відділу продажів [55:47]', cat: 55, op: 47, need: false }, { id: '0:0', name: 'Переказ між рахунками [0:0]', cat: 0, op: 0, need: false }];
  const invoices = { 68: { id: 68, name: 'ФОП Хоменко Приват', currency_id: 1 }, 83: { id: 83, name: 'ФОП Мазовецька Приват', currency_id: 1 }, 90: { id: 90, name: 'корп. картка 7365', currency_id: 1 } };
  const { rows, left } = A.fromNotReady(notReady, bank, { invoices, pnl, prevDay: 5, time: '12:00', have: new Set(['02.11.2026#h7']) });
  assert.deepEqual(rows.map(r => r.key), ['02.11.2026#h1', '02.11.2026#h2', '30.10.2026#h3', '30.10.2026#h4']);
  assert.deepEqual(left.map(r => r.key), ['02.11.2026#h5_tax', '02.11.2026#h6', '02.11.2026#h7']);
  const [h1, h2, h3, h4] = rows;
  // без рахунку й статті — обрати; касовий метод (07.11.2026): 02.11 — листопад, навіть якщо реєстр передав «з 1 по 5 число»; позначки немає
  assert.deepEqual([h1.needAccount, h1.invoice_id, h1.rowAmount, h1.needCategory, h1.check, h1.date, h1.period], [true, null, 145000, true, true, '02-11-2026 12:00', '01-11-2026']);
  assert.match(h1.checkNote, /«перевірити».*вибране запишеться в реєстр/);
  // рахунок і стаття з реєстру
  assert.deepEqual([h2.invoice_id, h2.suggest.invoice_id, h2.amountUah, h2.category, h2.pnl_category_id, h2.pnl_operation_id, h2.needCategory, h2.comment],
    [68, 68, 18852, 'ЗП відділу продажів [55:47]', 55, 47, false, 'Хоменко: ЗП жовтень']);
  // переказ: «куди» з реєстру, без статті P&L
  assert.deepEqual([h3.transfer, h3.to_invoice_id, h3.needCategory, h3.pnl_category_id, h3.period], [true, 90, false, null, '01-10-2026']);
  // статті з реєстру немає в «Довіднику» — обрати; причина Apps Script — у примітці
  assert.deepEqual([h4.needCategory, h4.badCategory, h4.rowAmount], [true, 'Нема такої статті', null]);
  assert.match(h4.checkNote, /немає суми/);
});
test('касовий метод (07.11.2026): період — місяць дати оплати; «з 1 по 5 число» й «Період» з погоджень не діють, змінений у панелі — діє', () => {
  const r = (key, date, period, o) => ({ key, date, period, periodManual: false, periodSrc: '', ...o });
  const rows = [
    r('a', '03-11-2026 12:00', '01-10-2026'),                                            // реєстр: «з 1 по 5 число» → жовтень
    r('b', '15-11-2026 12:00', '01-10-2026', { periodManual: true, periodSrc: 'з погоджень' }), // «Період» 10.2026 зі стовпця погоджень
    r('c', '20-11-2026 12:00', '01-12-2026', { periodManual: true, periodSrc: 'вручну' }), // змінено в панелі кешфлоу — лишається
    r('d', '10-11-2026 12:00', '01-11-2026'),                                            // уже місяць оплати
    r('e', '02-11-2026 12:00', '01-10-2026', { done: true }),                              // уже внесено — не чіпаємо
  ];
  assert.deepEqual(A.cashPeriod(rows), { changed: 2 });
  assert.deepEqual(rows.map(x => [x.key, x.period, x.periodSrc]), [['a', '01-11-2026', ''], ['b', '01-11-2026', ''], ['c', '01-12-2026', 'вручну'], ['d', '01-11-2026', ''], ['e', '01-10-2026', '']]);
  assert.equal(rows[1].periodManual, false);
  // закритий місяць оплати — далі переносить moveClosed (період першого відкритого, дата та сама)
  const z = [r('z', '30-10-2026 12:00', '01-10-2026')];
  A.cashPeriod(z);
  assert.deepEqual(A.moveClosed(z, '2026-10'), { moved: 1, from: ['10.2026'], to: '11.2026' });
  assert.equal(z[0].period, '01-11-2026');
});
test('підказка «та сама виплата двічі» (30.10.2026): податки з рядка виплати й окреме «податки із зп вище» — той самий отримувач, сума й дата', () => {
  const a = { key: '02.11.2026#ha2be47c', date: '02-11-2026 12:00', recipient: 'Сидорук Тарас', rowAmount: 909.78, amount: null, category: 'Комісії відділу продажів [47:31]',
    comment: 'Податки 10 % з 9 097,78 (на руки 8 188,00) — Сидорук Тарас: % менеджера Сидорук за період з 05-11.10', state: 'потрібен рахунок' };
  const b = { key: '02.11.2026#h4cac9139', date: '02-11-2026 12:00', recipient: 'Сидорук Тарас', rowAmount: 909.78, amount: null, category: '',
    comment: 'Сидорук Тарас: податки із зп вище: 8 188,00 / 0,9 × 10 %', state: 'потрібен рахунок' };
  const other = { key: '02.11.2026#h217ca1c6', date: '02-11-2026 12:00', recipient: 'Сидорук Тарас', rowAmount: 1000, comment: 'Кращий діалог', state: 'потрібен рахунок' };
  const rows = [a, b, other];
  assert.match(A.twinNote(a, rows), /^у цьому пакеті ще рядок «Сидорук Тарас: податки із зп вище: 8 188,00 \/ 0,9 × 10 %» на 909,78 тієї ж дати — схоже на ті самі податки: вносьте один/);
  assert.match(A.twinNote(b, rows), /«Податки 10 % з 9 097,78 \(на руки 8 188,00\) — Сидорук Тарас: % менеджер…» на 909,78/);
  assert.equal(A.twinNote(other, rows), '');
  // другий уже «не вносити» чи внесено, прив'язано — підказки немає
  assert.equal(A.twinNote(a, [a, { ...b, done: 'не вноситься' }, other]), '');
  assert.equal(A.twinNote(a, [a, { ...b, state: 'вже є' }]), '');
  // інша дата чи інший отримувач — не та сама виплата
  assert.equal(A.twinNote(a, [a, { ...b, date: '03-11-2026 12:00' }]), '');
  assert.equal(A.twinNote(a, [a, { ...b, recipient: 'Хоменко' }]), '');
  // без «податки» в тексті — «ту саму виплату»
  assert.match(A.twinNote({ ...other, rowAmount: 500 }, [{ ...other, rowAmount: 500 }, { ...other, key: 'x', rowAmount: 500, comment: 'аванс' }]), /схоже на ту саму виплату/);
});