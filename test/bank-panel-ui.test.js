// «Звірка з банком» цілою панеллю (test/lib/panel-harness.js — імітована сторінка, без мережі): «Внести в CRM», рядок рахунку,
// «Зіставлення ШІ». Сценарії з перевірки виправлень 08.11.2026 — кожен падав на коді до виправлення.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, withApprovals, rec, tx, bankJson, draft } = require('./lib/panel-harness.js');
const plain = s => String(s).replace(/[\u00a0\u202f]/g, ' ');

// ТОВ платить ВЗ і ПДФО за день; у CRM податки ЗП — по людях («Податки 10 % з …» від реєстру)
const TOV = [{ id: 1, name: 'Приват ТОВ СЕРВІС МАРКЕТ 8112', currency_id: 1, balance: 0, deleted_at: null }];
const TAX = (s, p) => tx('13.10.2026', -s, p, 'UA_TAX', 'ГОЛОВНЕ УДКСУ У М.КИЄВІ');
async function taxDay(records) {
  const acc = [{ ...TOV[0], balance: Math.round((100000 - records.reduce((s, r) => s + r.payments[0].amount, 0)) * 100) / 100 }];
  const b = { acc: 'UA000000000000000000000008112', ccy: 'UAH', name: 'ТОВ СЕРВІС МАРКЕТ', client: 'ТОВ Маркет', opening: 100000, closing: Math.round((100000 - 1111.11 * 2) * 100) / 100,
    // 5 % + 5 % з двох однакових ЗП (на руки 10 000 кожному) — ВЗ і ПДФО дорівнюють податкам по людях однієї людини (10 % з 11 111,11)
    transactions: [TAX(1111.11, 'Сплата військового збору за вересень 2026'), TAX(1111.11, 'Сплата ПДФО за вересень 2026')] };
  const r = await run({ accounts: acc, records, banks: [bankJson([b])] });
  assert.deepEqual(r.errors, []);
  return r.S.lastRecs.filter(p => p.bankAcc === 1).map(p => ({ ...p, block: plain(p.block || '') }));
}
const PERSON_A = rec(11, '2026-10-13', [[1, 2, 1111.11]], 'Податки 10 % з 11 111,11 (на руки 10 000,00) — Іваненко Петро: зарплата за вересень');

test('«Внести в CRM»: запис податків по людях з тією самою сумою, що ВЗ дня, не знімає захисту від дубля (податки другої людини ще не внесено)', async () => {
  const props = await taxDay([PERSON_A]);
  assert.equal(props.length, 1, 'пропонується один податок — другий «у парі» із записом Іваненка');
  // до виправлення: block порожній — і ПДФО 1 111,11 пропонувався цілим, а потім реєстр вносив податки другої людини (дубль)
  assert.match(props[0].block, /уже є податки по людях: 1 запис на 1 111,11 \(у банку ВЗ \+ ПДФО за день — 2 222,22\)/);
});

test('«Внести в CRM»: два записи по людях — обидва в тексті захисту, навіть коли один має пару з ВЗ', async () => {
  const props = await taxDay([PERSON_A, rec(13, '2026-10-13', [[1, 2, 500]], 'Податки 10 % з 5 000,00 (на руки 4 500,00) — Сидоренко Олег: премія')]);
  assert.equal(props.length, 1);
  assert.match(props[0].block, /уже є податки по людях: 2 записи на 1 611,11/); // до виправлення — «1 запис на 500,00»
});

test('«Внести в CRM»: податок, внесений цілим платежем з виписки («Сплата ПДФО за …»), не блокує ВЗ того дня', async () => {
  const props = await taxDay([rec(12, '2026-10-13', [[1, 2, 1111.11]], 'ГОЛОВНЕ УДКСУ У М.КИЄВІ: Сплата ПДФО за вересень 2026')]);
  assert.equal(props.length, 1);
  assert.doesNotMatch(props[0].block, /податки по людях/);
});

test('«Внести в CRM»: податки по людях внесено сусідніми днями (без пари в банку) — платіж податку цілим не пропонується (жовтень 2026: 13.10)', async () => {
  // до виправлення (16.11.2026): захист бачив лише записи того самого дня — block порожній, і обидва платежі пропонувались цілими (дубль)
  const props = await taxDay([rec(21, '2026-10-12', [[1, 2, 700]], 'Податки 10 % з 7 000,00 (на руки 6 300,00) — Іваненко Петро: зарплата'),
    rec(22, '2026-10-14', [[1, 2, 900.5]], '450,25*2= 900,5 податки із зп 8100 Сидоренко Олег')]);
  assert.equal(props.length, 2);
  for (const p of props) assert.match(p.block, /поруч \(12\.10\.2026, 14\.10\.2026\) є податки по людях без пари в банку: 2 записи на 1 600,50/);
});

test('«Внести в CRM»: «% менеджера … (разом з податками)» і єдиний податок ФОП того дня — не податки по людях: платіж податку не блокується', async () => {
  // до виправлення: будь-яке «подат» у коментарі витрати того дня блокувало ВЗ і ПДФО як «уже є податки по людях»
  const props = await taxDay([rec(31, '2026-10-13', [[1, 2, 5000]], 'Таценко Артур % менеджера за період з 05.10-11.10 (разом з податками)'),
    rec(32, '2026-10-13', [[1, 2, 3200]], 'Єдиний податок за 3 квартал 2026 по ФОП Хоменко')]);
  assert.equal(props.length, 2);
  for (const p of props) assert.doesNotMatch(p.block, /податки по людях/);
});

test('рядок рахунку «бракує переказів між своїми» з рухом броніків: різниця — лише переказ, а не сира різниця з надходженнями броніків', async () => {
  const ACC = [{ id: 38, name: 'Приват ТОВ ПРИКЛАД СЕРВІС 4431 (колишній «6 UAH B2B ПРИКЛАД Приват ТОВ»)', currency_id: 1, balance: 0, deleted_at: null },
    { id: 33, name: 'Приват ТОВ ПРИКЛАД СЕРВІС 5608', currency_id: 1, balance: 1944.75, deleted_at: null }];
  const b4517 = { acc: 'UA000000000000000000000004431', ccy: 'UAH', name: 'ТОВ ПРИКЛАД СЕРВІС', client: 'ТОВ ПРИКЛАД', opening: 0, closing: 129650 - 3803,
    transactions: [tx('02.10.2026', 129650, 'Сплата за користування веб-порталом "Сервіс", Казачкіна Анна', 'UA_C1', 'Транз.рахунок платежi'),
      tx('05.10.2026', -3803, 'Переказ власних коштів Без ПДВ.', 'UA000000000000000000000005608', 'ТОВ ПРИКЛАД СЕРВІС')] };
  const b5689 = { acc: 'UA000000000000000000000005608', ccy: 'UAH', name: 'ТОВ ПРИКЛАД СЕРВІС', client: 'ТОВ ПРИКЛАД', opening: 0, closing: 3803,
    transactions: [tx('05.10.2026', 3803, 'Переказ власних коштів Без ПДВ.', 'UA000000000000000000000004431', 'ТОВ ПРИКЛАД СЕРВІС')] };
  const r = await run({ accounts: ACC, records: [rec(2, '2026-10-03', [[33, 1, 1944.75]], '1.5% від бронювання 19:03: 129 650.00 × 1.5 % — надходження 02.10')],
    banks: [bankJson([b4517, b5689])], open: [38, 33] });
  assert.deepEqual(r.errors, []);
  const row = r.S.lastAll.find(x => x.a.id === 38);
  assert.equal(row.status, 'xfer');
  const t = r.txt;
  assert.ok(t.includes('Без руху броніків бракує лише переказів між своїми (нижче) — після їх внесення рахунок зійдеться.'), t);
  assert.ok(t.includes('Різниця за період (CRM − банк): +3 803,00 — перекази між своїми, яких немає в CRM (нижче).'), t);
  // до виправлення: «Різниця за період (CRM − банк): -125 847,00 — через суми вище» (уся різниця з надходженнями броніків)
  assert.ok(!/Різниця за період \(CRM − банк\): -125 847,00/.test(t), t);
});

test('«Зіставлення ШІ»: операція вже є в CRM групою (20 000 + 10 000), а погодження в реєстрі без ID — «не вносьте вдруге», а не «внести у «Погодженні»»', async () => {
  const ACC = [{ id: 5, name: 'ФОП Хоменко Всеволод Приват 1234', currency_id: 1, balance: 70000, deleted_at: null }];
  const b = { acc: 'UA000000000000000000000001234', ccy: 'UAH', name: 'ФОП Хоменко Всеволод Сергійович', client: 'ФОП Хоменко', opening: 100000, closing: 70000,
    transactions: [tx('10.10.2026', -30000, 'Оплата послуг за жовтень', 'UA_I', 'ФОП Іваненко Петро')] };
  const r = await run({ accounts: ACC, records: [rec(2, '2026-10-10', [[5, 2, 20000]], 'ФОП Іваненко: послуги дизайну'), rec(3, '2026-10-10', [[5, 2, 10000]], 'ФОП Іваненко: послуги верстки')],
    banks: [bankJson([b])] });
  await withApprovals(r, [{ key: 'r2', acc: 5, date: '2026-10-09', amount: 30000, recipient: 'ФОП Іваненко', content: 'Послуги дизайну і верстки', id: 0, action: 'так', status: '' }]);
  const T = r.S.lastMt;
  assert.ok(T && T.res.rows.length === 1 && T.res.rows[0].ap[0].key === 'r2', 'погодження не зіставилось з операцією');
  assert.deepEqual(T.res.rows[0].bank.crmIds, [2, 3]);
  const t = r.txt, i = t.indexOf('Зіставлення ШІ за');
  assert.ok(i >= 0, 'розділу «Зіставлення ШІ» немає');
  const mt = t.slice(i);
  assert.ok(mt.includes('у CRM уже є, у реєстрі без ID: 1 — не вносьте вдруге'), mt.slice(0, 600));
  assert.ok(mt.includes('операція банку вже є в CRM (ID 2, 3)'), mt);
  // до виправлення: «з них не все в CRM: 1 — внести у «Погодженні»» і «Відкрити «Погодження»» — реєстр уніс би 30 000 вдруге
  assert.ok(!mt.includes('з них не все в CRM'), mt.slice(0, 600));
  assert.ok(!mt.includes('Відкрити «Погодження»'), mt);
});

// ---------- режим чернеток CRM (перемикач у шапці панелі, core/drafts.js; 14.11.2026) ----------
// у банку — оплата 30 000 з рахунку ФОП; у CRM запису немає, є лише чернетка (залишок рахунку CRM чернетки не містить: 100 000)
const D_ACC = [{ id: 5, name: 'ФОП Хоменко Всеволод Приват 1234', currency_id: 1, balance: 100000, deleted_at: null }];
const dBank = () => bankJson([{ acc: 'UA000000000000000000000001234', ccy: 'UAH', name: 'ФОП Хоменко Всеволод Сергійович', client: 'ФОП Хоменко', opening: 100000, closing: 70000,
  transactions: [tx('10.10.2026', -30000, 'Оплата послуг за жовтень', 'UA_I', 'ФОП Іваненко Петро')] }]);
// поля чернетки — рядками, як їх надсилає форма (так їх віддає CRM)
const dExp = (id, over) => draft(id, { operation: '2', amount: '30000.00', date: '10-10-2026 12:00', period: '01-10-2026', comment: 'ФОП Іваненко: послуги за жовтень', location_id: '1', project_id: '1',
  currency_id: '1', invoice_id: '5', pnl_category_id: '62', pnl_operation_id: '66', show_response_in_currency: '1', ...over });
const rowOf = (r, id) => r.S.lastAll.find(x => x.a.id === id);

test('чернетки вимкнено: операція банку, для якої в CRM є лише чернетка, — «немає в CRM», і жодного запиту до чернеток', async () => {
  const r = await run({ accounts: D_ACC, records: [], banks: [dBank()], drafts: [dExp(27231)], draftMode: false, open: [5] });
  assert.deepEqual(r.errors, []); // запит до чернеток імітація зустрічає помилкою — вона була б тут
  assert.deepEqual(r.draftCalls(), []);
  const row = rowOf(r, 5);
  assert.equal(row.status, 'bad');
  assert.equal(row.R.missing.bank.length, 1);
  assert.equal(row.a.balance, 100000);
  assert.equal(row.a.balanceLive, undefined);
  assert.deepEqual(r.S.lastRecs.map(p => [p.acc, p.amount, p.block || '']), [[5, 30000, '']], 'операцію пропонується внести');
  assert.equal(r.S.drafts, null);
  assert.ok(!r.notes.includes('Режим чернеток'), r.notes);
  assert.ok(!r.txt.includes('(чернетка)'), 'чернетки в таблиці не має бути');
  assert.ok(r.txt.includes('немає в CRM'));
});

test('чернетки увімкнено: операція банку зіставляється з чернеткою, залишок CRM — з її сумою, рахунок сходиться', async () => {
  const r = await run({ accounts: D_ACC, records: [], banks: [dBank()], drafts: [dExp(27231)], draftMode: true, open: [5] });
  assert.deepEqual(r.errors, []);
  assert.ok(r.draftCalls().length && r.draftCalls().every(c => c === 'GET invoice-payment-drafts?page=1&per_page=100'), r.draftCalls().join('; '));
  const row = rowOf(r, 5);
  assert.equal(row.R.missing.bank.length, 0, 'операція банку має пару — чернетку');
  assert.equal(row.R.missing.crm.length, 0);
  assert.deepEqual(r.S.lastRecs, [], 'вносити вдруге не пропонується');
  // CRM віддає залишок без чернетки (100 000), банк — 70 000: сходиться лише тому, що до залишку додано суму чернетки
  assert.equal(row.status, 'ok');
  assert.equal(row.a.balance, 70000);
  assert.equal(row.a.balanceLive, 100000);
  assert.deepEqual(r.S.drafts, { n: 1, used: 1, early: 0, empty: 0 });
  assert.ok(r.notes.includes('Режим чернеток: враховано чернеток CRM — 1. Вони звіряються як записи, а залишки CRM показано так, ніби чернетки вже проведено.'), r.notes);
  assert.ok(r.txt.includes('ID 27231 (чернетка) · ФОП Іваненко: послуги за жовтень'), 'у рядку операції немає позначки «(чернетка)»');
});

test('чернетки: перемикач у шапці перераховує звірку — увімкнули: чернетка врахована; вимкнули: знову «немає в CRM» і без нових запитів', async () => {
  const r = await run({ accounts: D_ACC, records: [], banks: [dBank()], drafts: [dExp(27231)], draftMode: false });
  assert.equal(rowOf(r, 5).status, 'bad');
  await r.setDrafts(true);
  assert.deepEqual(r.errorsNow, []);
  assert.equal(rowOf(r, 5).status, 'ok');
  assert.deepEqual(r.S.lastRecs, []);
  const n = r.draftCalls().length;
  assert.ok(n > 0);
  await r.setDrafts(false);
  assert.deepEqual(r.errorsNow, []);
  assert.equal(r.draftCalls().length, n, 'після вимкнення — жодного запиту до чернеток');
  assert.equal(rowOf(r, 5).status, 'bad');
  assert.equal(rowOf(r, 5).a.balance, 100000);
  assert.equal(r.S.lastRecs.length, 1);
  assert.ok(!r.notesNow.includes('Режим чернеток'), r.notesNow);
});

test('чернетки увімкнено: чернетка переказу між своїми рахунками зіставляється на обох рахунках', async () => {
  const ACC = [{ id: 71, name: 'Приват ФОП Хоменко Всеволод 1234', currency_id: 1, balance: 50000, deleted_at: null },
    { id: 72, name: 'Приват ФОП Хоменко Всеволод 5678', currency_id: 1, balance: 0, deleted_at: null }];
  const banks = () => [bankJson([
    { acc: 'UA000000000000000000000001234', ccy: 'UAH', name: 'ФОП Хоменко Всеволод Сергійович', client: 'ФОП Хоменко', opening: 50000, closing: 46197,
      transactions: [tx('05.10.2026', -3803, 'Переказ власних коштів Без ПДВ.', 'UA000000000000000000000005678', 'ФОП Хоменко Всеволод Сергійович')] },
    { acc: 'UA000000000000000000000005678', ccy: 'UAH', name: 'ФОП Хоменко Всеволод Сергійович', client: 'ФОП Хоменко', opening: 0, closing: 3803,
      transactions: [tx('05.10.2026', 3803, 'Переказ власних коштів Без ПДВ.', 'UA000000000000000000000001234', 'ФОП Хоменко Всеволод Сергійович')] }])];
  const DR = [draft(27232, { operation: '3', amount: '3803.00', date: '05-10-2026 10:00', period: '01-10-2026', comment: 'Переказ власних коштів', location_id: '1', project_id: '1', currency_id: '1', invoice_from: '71', invoice_to: '72' })];
  // без чернеток — переказу в CRM немає на обох рахунках (інакше тест нижче нічого б не доводив)
  const off = await run({ accounts: ACC, records: [], banks: banks(), drafts: DR, draftMode: false });
  assert.deepEqual(off.errors, []);
  assert.deepEqual(off.S.lastProps.map(p => [p.from, p.to, p.amount]), [[71, 72, 3803]]);
  assert.deepEqual([71, 72].map(id => rowOf(off, id).status), ['xfer', 'xfer']);

  const r = await run({ accounts: ACC, records: [], banks: banks(), drafts: DR, draftMode: true, open: [71, 72] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.S.lastProps, [], 'переказ не пропонується створити вдруге');
  assert.deepEqual(r.S.lastRecs, []);
  assert.deepEqual([71, 72].map(id => rowOf(r, id).status), ['ok', 'ok']);
  assert.deepEqual([71, 72].map(id => [rowOf(r, id).a.balance, rowOf(r, id).a.balanceLive]), [[46197, 50000], [3803, 0]]);
  assert.equal(r.txt.split('ID 27232 (чернетка)').length - 1, 2, 'чернетка має бути в рядках обох рахунків');
});

test('чернетки увімкнено: недозаповнена чернетка (без рахунку) не звіряється й не змінює залишок — про неї сказано в примітці', async () => {
  const r = await run({ accounts: D_ACC, records: [], banks: [dBank()], drafts: [dExp(27231, { invoice_id: '' })], draftMode: true, open: [5] });
  assert.deepEqual(r.errors, []);
  const row = rowOf(r, 5);
  assert.equal(row.status, 'bad');
  assert.equal(row.R.missing.bank.length, 1);
  assert.equal(row.a.balance, 100000);
  assert.equal(r.S.lastRecs.length, 1);
  assert.deepEqual(r.S.drafts, { n: 1, used: 0, early: 0, empty: 1 });
  assert.ok(r.notes.includes('Режим чернеток: враховано чернеток CRM — 0 з 1 (без рахунку, суми чи дати — 1, вони не звіряються).'), r.notes);
  assert.ok(!r.txt.includes('(чернетка)'));
});

// «Внести в CRM» → «Створити позначені»: вибір статті й галочка — як їх ставить людина (S.rp), далі — обробник самої кнопки
async function pickAndCreate(r) {
  assert.equal(r.S.lastRecs.length, 1);
  Object.assign(r.S.rp.get(r.S.lastRecs[0].key), { art: '62/66', ta: true, on: true });
  await r.click('rcreate');
  const j = r.files.filter(f => /^кешфлоу_записи_журнал_/.test(f.name));
  assert.equal(j.length, 1, 'журнал має зберегтися одним файлом');
  return JSON.parse(j[0].data);
}

test('чернетки увімкнено, «Створити позначені»: запит іде в чернетки (не в кешфлоу), створене перевіряється за чернеткою, у журналі draft: true', async () => {
  const r = await run({ accounts: D_ACC, records: [], banks: [dBank()], drafts: [], draftMode: true, create: true });
  assert.deepEqual(r.errors, []);
  const journal = await pickAndCreate(r);
  assert.deepEqual(r.posts.map(p => p.path), ['invoice-payment-drafts']);
  assert.ok(!r.calls.some(c => /^POST invoice-payment$/.test(c)));
  const f = r.posts[0].data;
  // чернетка — JSON з числами, як їх зберігає сам CRM: з рядками («5») вікно чернетки CRM лишало рахунок, статтю й проєкт порожніми (16.11.2026)
  assert.deepEqual([f.operation, f.amount, f.invoice_id, f.pnl_category_id, f.pnl_operation_id, f.date.slice(0, 10), f.period], [2, 30000, 5, 62, 66, '10-10-2026', '01-10-2026']);
  assert.ok(typeof f.location_id === 'number' && typeof f.project_id === 'number' && typeof f.currency_id === 'number', JSON.stringify(f));
  assert.ok(/у чернетках CRM/.test(r.dialogs[0].html) && /POST \/api\/invoice-payment-drafts/.test(r.dialogs[0].html), 'вікно підтвердження має казати про чернетки');
  assert.equal(journal.length, 1);
  assert.deepEqual([journal[0].result, journal[0].id, journal[0].draft, journal[0].note], ['ok', 27231, true, 'чернетку створено й перевірено']);
  assert.ok(r.calls.includes('GET invoice-payment-drafts/27231'), 'створене перечитується з чернеток');
  assert.ok(!r.calls.some(c => /^GET invoice-payment\/\d+/.test(c)), 'у кешфлоу чернетки немає — туди запиту не має бути');
  assert.deepEqual(JSON.parse(localStorage.getItem('cfl_rec_journal')).map(e => [e.id, e.draft]), [[27231, true]]);
  // після створення панель звіряє заново: операція вже має пару — нову чернетку
  assert.deepEqual(r.errorsNow, []);
  assert.deepEqual(r.S.lastRecs, []);
  assert.equal(rowOf(r, 5).status, 'ok');
});

test('чернетки увімкнено, «Створити позначені»: така чернетка вже є (з’явилась після звірки) — «вже є», вдруге не створюється', async () => {
  const r = await run({ accounts: D_ACC, records: [], banks: [dBank()], drafts: [], draftMode: true, create: true });
  assert.equal(r.S.lastRecs.length, 1);
  r.drafts.push(dExp(27240)); // ту саму операцію тим часом уніс у чернетки хтось інший (чи реєстр погоджень)
  const journal = await pickAndCreate(r);
  assert.deepEqual(r.posts, [], 'жодного POST');
  assert.deepEqual([journal[0].result, journal[0].id], ['вже є', 27240]);
  assert.match(journal[0].note, /вже є 1 запис\(и\) з цією сумою за ±3 дні \(ID 27240\)/);
  assert.equal(r.drafts.length, 1);
});
// ---------- за оглядом 14.11.2026 ----------
test('чернетки увімкнено: чернетка з рахунком і сумою, але без дати — не у звірці й НЕ в залишку (інакше залишок зсунувся б без видимої причини)', async () => {
  const r = await run({ accounts: D_ACC, records: [], banks: [dBank()], drafts: [dExp(27231, { date: '' })], draftMode: true });
  assert.deepEqual(r.errors, []);
  const row = rowOf(r, 5);
  assert.equal(row.a.balance, 100000); // до виправлення — 70 000: суму чернетки додано, а самої чернетки у звірці немає
  assert.equal(row.R.missing.bank.length, 1);
  assert.deepEqual(r.S.drafts, { n: 1, used: 0, early: 0, empty: 1 });
});

test('чернетки увімкнено: чернетка, давніша за період звірки, — лише в залишку, і про це сказано в примітці', async () => {
  const r = await run({ accounts: D_ACC, records: [], banks: [dBank()], drafts: [dExp(27231), dExp(27100, { date: '01-06-2026 12:00', amount: '500.00' })], draftMode: true });
  assert.deepEqual(r.errors, []);
  assert.equal(rowOf(r, 5).a.balance, 69500);
  assert.deepEqual(r.S.drafts, { n: 2, used: 1, early: 1, empty: 0 });
  assert.match(r.notes, /враховано чернеток CRM — 1 з 2 \(до \d\d\.\d\d\.2026 — 1: вони лише в залишках\)/);
});

test('«Закриття місяця»: місяць, де є непроведені чернетки, закривати не можна — окремий пункт зі списком', () => {
  const { closeReport } = require('../ui/bank-panel.js');
  const parts = { types: [], repoints: [], lint: { checked: 1, counts: {} }, reg: { open: [], check: [], from: '2026-10-01', to: '2026-10-31' }, wd: null };
  const no = closeReport([], parts);
  assert.equal(no.items.some(i => i.key === 'drafts'), false, 'без режиму чернеток пункту немає');
  const clean = closeReport([], { ...parts, drafts: [] }).items.find(i => i.key === 'drafts');
  assert.equal(clean.ok, true);
  const rep = closeReport([], { ...parts, drafts: [{ id: 27231, date: '2026-10-10', amount: 30000, name: 'ФОП Хоменко Приват' }] });
  const it = rep.items.find(i => i.key === 'drafts');
  assert.equal(it.ok, false);
  assert.equal(rep.verdict, 'not'); // до виправлення звірка з чернетками «сходилась», і висновок міг бути «можна закривати»
  assert.match(it.text, /непроведені чернетки: 1/);
  assert.match(it.list[0].replace(/[\u00a0\u202f]/g, ' '), /10\.10\.2026 · ФОП Хоменко Приват · 30 000,00 · ID 27231/);
});
// ---------- 16.11.2026: підписки юристів, «позначити всі тут» ----------
test('надходження з сумою тарифу — підписка юриста: стаття «Підписки юристів», коментар як у CRM, без «оплату клієнта вносять через лід»', async () => {
  const acc = [{ id: 5, name: 'ФОП Хоменко Всеволод Приват 1234', currency_id: 1, balance: 100000, deleted_at: null }];
  const bank = bankJson([{ acc: 'UA000000000000000000000001234', ccy: 'UAH', name: 'ФОП Хоменко Всеволод Сергійович', client: 'ФОП Хоменко', opening: 91901, closing: 100000,
    transactions: [
      tx('04.10.2026', 4199, 'Призначення: За послуги з використання програмного продукту Сервіс від Голованівської Наталії Миколаївни.', 'UA_G', 'Горобченко Оксана Романівна'),
      tx('05.10.2026', 1700, 'Оплата послуг', 'UA_Y', 'Якубенко Владислав Олександрович'),
      tx('06.10.2026', 2500, 'Оплата юридичних послуг', 'UA_P', 'Петренко Іван Іванович')] }]);
  const r = await run({ accounts: acc, records: [], banks: [bank], open: [5] });
  assert.deepEqual(r.errors, []);
  const by = a => r.S.lastRecs.find(p => p.amount === a);
  const a = by(4199), b = by(1700), c = by(2500);
  assert.deepEqual([a.sub.plan, a.sub.months, a.sub.sure, a.rule.art.art, a.rule.art.sure], ['PREMIUM', 1, true, '44/20', true]);
  assert.equal(a.comment, 'Підписка PREMIUM 1 міс. — Голованівської Наталії Миколаївни (платник Горобченко Оксана Романівна): переказ 04.10.2026 на «ФОП Хоменко Всеволод Приват 1234»');
  assert.equal(r.S.rp.get(a.key).art, '44/20');
  // лише сума (платник округлив 1 699 → 1 700), призначення не про продукт — підказка «перевірте»
  // (огляд 16.11.2026: круглі суми — зазвичай оплати замовлень) — статтю й коментар лінтер сам не ставить, застереження про лід лишається
  assert.deepEqual([b.sub.plan, b.sub.sure, b.rule.art || null, r.S.rp.get(b.key).art], ['PRO', false, null, '']);
  assert.ok(!b.comment.startsWith('Підписка'), b.comment);
  assert.ok(r.txt.includes('сума як у тарифі підписки юриста (PRO, 1 міс.), але призначення не про програмний продукт'));
  // звичайна оплата клієнта — як раніше
  assert.equal(c.sub, undefined);
  assert.ok(!c.rule.art);
  assert.ok(r.txt.includes('схоже на підписку юриста (PREMIUM, 1 міс.)'), 'пояснення про підписку');
  assert.equal(r.txt.split('оплату клієнта вносять через замовлення (лід)').length - 1, 2, 'застереження про лід — у звичайної оплати й у «лише сума тарифу»');
});

test('«Внести в CRM»: у рядку кожного рахунку — «позначити всі тут»; з одним рахунком кнопки немає (є спільна внизу)', async () => {
  const acc = [{ id: 5, name: 'ФОП Хоменко Всеволод Приват 1234', currency_id: 1, balance: 100000, deleted_at: null },
    { id: 6, name: 'ФОП Житинська Емілія Приват 5678', currency_id: 1, balance: 50000, deleted_at: null }];
  const mk = (iban, name, sum) => ({ acc: iban, ccy: 'UAH', name, client: name, opening: 100000, closing: 100000 + sum,
    transactions: [tx('10.10.2026', sum, 'Комісія за обслуговування рахунку', '', 'АТ КБ ПРИВАТБАНК')] });
  const two = await run({ accounts: acc, records: [], create: true, banks: [bankJson([mk('UA000000000000000000000001234', 'ФОП Хоменко Всеволод Сергійович', -100), mk('UA000000000000000000000005678', 'ФОП Житинська Емілія Юріївна', -200)])] });
  assert.deepEqual(two.errors, []);
  assert.equal(two.S.lastRecs.length, 2);
  assert.deepEqual([...two.out.matchAll(/data-rgall="(\d+)"/g)].map(m => +m[1]).sort(), [5, 6]);
  assert.ok(two.out.includes('позначити всі тут (1)'));
  const one = await run({ accounts: acc.slice(0, 1), records: [], create: true, banks: [bankJson([mk('UA000000000000000000000001234', 'ФОП Хоменко Всеволод Сергійович', -100)])] });
  assert.ok(!one.out.includes('data-rgall'), 'один рахунок — досить кнопки внизу');
});
test('реєстр погоджень перед читанням оновлюється з таблиці (дія pending), а вже потім читається (дія bank); не вдалось — попередження', async () => {
  // до виправлення (16.11.2026): лише action=bank — погоджень останніх днів «Звірка» не бачила, доки їх не оновили у вкладці «Погодження»
  const saved = [globalThis.fetch, localStorage.getItem('pogodzh_cfg_v1')];
  const seen = [];
  let fail = false;
  localStorage.setItem('pogodzh_cfg_v1', JSON.stringify({ url: 'https://example.invalid/exec', key: 'k' }));
  globalThis.fetch = async url => {
    const a = /action=(\w+)/.exec(String(url))[1];
    seen.push(a);
    if (a === 'pending') return { status: 200, json: async () => (fail ? { ok: true, rows: [], syncError: 'реєстр саме оновлюється з іншого запуску' } : { ok: true, rows: [] }) };
    return { status: 200, json: async () => ({ ok: true, rows: [], startDate: '2026-09-01' }) };
  };
  try {
    // run починає з порожнього сховища: налаштування реєстру — після нього, читання — з наступним перемальовуванням
    const go = async () => { const x = await run({ accounts: D_ACC, records: [], banks: [dBank()] }); localStorage.setItem('pogodzh_cfg_v1', JSON.stringify({ url: 'https://example.invalid/exec', key: 'k' })); await x.$('from').onchange(); await new Promise(res => setTimeout(res, 80)); return x; };
    const r = await go();
    assert.ok(seen.includes('bank'), seen.join(','));
    assert.equal(seen[0], 'pending', seen.join(','));
    assert.equal(seen.filter(a => a === 'pending').length, 1, 'оновлення — раз на 5 хвилин, а не на кожне читання');
    assert.ok(!r.notesNow.includes('не вдалося оновити'));
    fail = true; seen.length = 0;
    const r2 = await go();
    assert.deepEqual(seen.slice(0, 2), ['pending', 'bank']);
    assert.ok(r2.notesNow.includes('Реєстр погоджень не вдалося оновити') && r2.notesNow.includes('саме оновлюється'), r2.notesNow);
  } finally { globalThis.fetch = saved[0]; if (saved[1] === null) localStorage.removeItem('pogodzh_cfg_v1'); else localStorage.setItem('pogodzh_cfg_v1', saved[1]); }
});

// ---------- 16.11.2026: податки із ЗП ↔ пакет ЗП ↔ погодження; «% менеджера» через зарплатний проєкт у пакеті ----------
/* ТОВ платить ЗП одним переказом на транзит (pay) і тією самою хвилиною ВЗ = ПДФО = пакет / 18 та ЄСВ 1,00. У CRM уже є податок,
   колись внесений цілим платежем зі статтею «Розробка» (50/37) — до виправлення він ставав «історією» для всіх податків рахунку. */
const round2 = v => Math.round(v * 100) / 100;
async function payDay(pay, approvals) {
  const t = round2(pay / 18), TAXA = ['UA_TAX', 'ГОЛОВНЕ УДКСУ У М.КИЄВІ'];
  const txs = [tx('02.10.2026', -500, 'Сплата ПДФО за вересень 2026', ...TAXA),
    tx('13.10.2026', -t, 'Сплата військового збору за жовтень 2026', ...TAXA, '18:47'), tx('13.10.2026', -t, 'Сплата ПДФО за жовтень 2026', ...TAXA, '18:47'),
    tx('13.10.2026', -1, 'Сплата ЄСВ за жовтень 2026', 'UA_ESV', 'ГОЛОВНЕ УПРАВЛІННЯ ДПС У М.КИЄВІ', '18:47'),
    tx('13.10.2026', -pay, 'Заробітна плата за жовтень 2026', 'UA_TRANSIT', 'Ціл-ві зарах.СЕРВІС МАРКЕТ ТОВ', '18:48')];
  const old = rec(41, '2026-10-02', [[1, 2, 500]], 'ГОЛОВНЕ УДКСУ У М.КИЄВІ: Сплата ПДФО за вересень 2026');
  Object.assign(old.payments[0], { pnl_category_id: 50, pnl_operation_id: 37 });
  const r = await run({ accounts: [{ ...TOV[0], balance: 99500 }], records: [old], banks: [bankJson([{ acc: 'UA000000000000000000000008112', ccy: 'UAH', name: 'ТОВ СЕРВІС МАРКЕТ', client: 'ТОВ Маркет',
    opening: 100000, closing: round2(100000 - 500 - 2 * t - 1 - pay), transactions: txs }])] });
  assert.deepEqual(r.errors, []);
  if (approvals) await withApprovals(r, approvals);
  const P = () => r.S.lastRecs.filter(p => p.bankAcc === 1), tax = n => P().find(p => !p.payRow && p.taxName === n);
  return { r, P, tax, pay: () => P().find(p => p.payRow), art: p => r.S.rp.get(p.key).art, block: p => plain(p.block || '') };
}
const zpRow = (key, amount, recipient, category, o) => ({ key, acc: 1, date: '2026-10-13', amount, textAmount: amount, recipient, content: `${recipient}: з/п за жовтень`, id: 0, action: 'так', status: '', zp: true, category, ...o });
const zpTax = (key, amount, category) => ({ key: `${key}#tax`, acc: 1, date: '2026-10-13', amount: round2(amount / 9), recipient: '', content: 'податки із зп', id: 0, action: 'так', status: '', zp: true, tax: true, category });

test('податки із ЗП: пакет зіставлено з погодженнями — ВЗ і ПДФО не вносяться цілими (їх вносить «Погодження» по людях), ЄСВ — зі статтею погоджень; «Розробки» з історії немає', async () => {
  const SALES = 'ЗП відділу продажів [55:47]';
  const d = await payDay(70500, [zpRow('13.10.2026#h1', 70500, 'Марія Квітна', SALES), zpTax('13.10.2026#h1', 70500, SALES)]);
  assert.match(d.block(d.pay()), /є погодження «Марія Квітна» 70 500,00/);
  // до виправлення: block порожній, а стаття всіх трьох — «Розробка» (50/37) з єдиного запису «Сплата ПДФО…» в історії рахунку
  for (const n of ['ВЗ', 'ПДФО']) assert.match(d.block(d.tax(n)), /^податки цієї ЗП вносяться по людях у «Погодженні»: 1 рядок на 7 833,33 \(банк ВЗ \+ ПДФО — 7 833,34\)/, n);
  assert.equal(d.block(d.tax('ЄСВ')), '');
  assert.equal(d.art(d.tax('ЄСВ')), '55/47');
  assert.equal(d.tax('ЄСВ').rule.art.sure, false);
  assert.ok(d.P().every(p => d.art(p) !== '50/37' && !p.hist), 'стаття податку з історії рахунку не береться');
  // погодження пакета з різними статтями — ЄСВ без статті, з переліком; погодження не через зарплатний проєкт (рядків «податки» немає) — ВЗ і ПДФО не блокуються
  const MKT = 'ЗП відділу маркетингу [69:75]';
  const m = await payDay(70500, [zpRow('13.10.2026#h1', 40500, 'Марія Квітна', SALES, { zp: false }), zpRow('13.10.2026#h2', 30000, 'Іван Бурий', MKT, { zp: false })]);
  assert.match(m.block(m.pay()), /є погодження/);
  for (const n of ['ВЗ', 'ПДФО', 'ЄСВ']) {
    assert.equal(m.block(m.tax(n)), '', n);
    assert.equal(m.art(m.tax(n)), '', n);
    assert.ok(m.tax(n).rule.reasons.some(t => /у погодженнях цієї ЗП статті різні: «[^»]*ЗП відділу продажів» \(1\), «[^»]*ЗП відділу маркетингу» \(1\)/.test(t)), n);
  }
});

test('податки із ЗП: на пакет немає погоджень — переказ ЗП і його податки одна група: стаття, вибрана для ЗП, ставиться податкам; про відомість сказано', async () => {
  const d = await payDay(70500, []);
  assert.equal(d.block(d.pay()), '');
  assert.ok(d.pay().rule.reasons.some(t => t.includes('погоджень на цю суму немає — схоже, ЗП з відомості бухгалтерії')), d.pay().rule.reasons.join('; '));
  assert.ok(plain(d.r.txt).includes('погоджень на цю суму немає — схоже, ЗП з відомості бухгалтерії'), 'те саме — у «Зіставленні ШІ»');
  // до виправлення: податки одразу мали «Розробку» (50/37) з історії, а ЗП у їхню групу не входила
  for (const n of ['ВЗ', 'ПДФО', 'ЄСВ']) assert.equal(d.art(d.tax(n)), '', n);
  assert.deepEqual(d.tax('ВЗ').taxPeers.map(p => p.taxName).sort(), ['ЄСВ', 'ЗП', 'ПДФО']);
  Object.assign(d.r.S.rp.get(d.pay().key), { art: '55/47', ta: true });
  await d.r.$('from').onchange();
  await new Promise(res => setTimeout(res, 30));
  for (const n of ['ВЗ', 'ПДФО', 'ЄСВ']) assert.deepEqual([d.art(d.tax(n)), d.r.S.rp.get(d.tax(n).key).sib], ['55/47', true], n);
  // навпаки — ні: стаття, вибрана для податку, на сам переказ ЗП не переходить (зарплатну статтю ЗП вибирає лише людина)
  const e = await payDay(70500, []);
  Object.assign(e.r.S.rp.get(e.tax('ВЗ').key), { art: '69/75', ta: true });
  await e.r.$('from').onchange();
  await new Promise(res => setTimeout(res, 30));
  assert.deepEqual([e.art(e.tax('ПДФО')), e.art(e.tax('ЄСВ')), e.art(e.pay())], ['69/75', '69/75', '']);
});

test('«Зіставлення ШІ»: «% менеджера», оплачений через зарплатний проєкт, входить у пакет ЗП сумою на руки; податки пакета — 2 рядки реєстру', async () => {
  const SALES = 'ЗП відділу продажів [55:47]';
  // «Сума» рядка «% менеджера» в реєстрі — лише податки (4 444,44), на руки — textAmount (40 000,00)
  const pct = { key: '13.10.2026#h2', acc: 1, date: '2026-10-13', amount: 4444.44, textAmount: 40000, recipient: 'Іваненко', content: '% менеджера Іваненко за період з 28.09-11.10', id: 0, action: 'так', status: '', zp: true, share: true, category: SALES };
  const d = await payDay(100000, [zpRow('13.10.2026#h1', 60000, 'Марія Квітна', SALES), zpTax('13.10.2026#h1', 60000, SALES), pct]);
  const T = d.r.S.lastMt;
  // до виправлення: «% менеджера» у набір не йшло — пакет 100 000,00 лишався «набору погоджень на цю суму немає»
  assert.deepEqual(T.res.rows.map(m => [m.bank.amount, m.how, m.ap.map(a => [a.key, a.amount, !!a.pct])]), [[100000, 'пакет', [['13.10.2026#h1', 60000, false], ['13.10.2026#h2', 40000, true]]]]);
  assert.deepEqual(T.res.amb, []);
  assert.match(d.block(d.pay()), /є погодження «Марія Квітна» 60 000,00, «Іваненко» 40 000,00/);
  assert.match(d.block(d.tax('ПДФО')), /вносяться по людях у «Погодженні»: 2 рядки на 11 111,11 \(банк ВЗ \+ ПДФО — 11 111,12\)/);
  assert.ok(plain(d.r.txt).includes('% з балансу'), 'у «Зіставленні ШІ» рядок позначено');
});
test('огляд 16.11.2026: підписка — лише гривневий рахунок і не повернення; податки сусіднього дня, коли банк сам платив податки, не блокують', async () => {
  const eur = [{ id: 5, name: 'ФОП Хоменко Всеволод Приват євро 1234', currency_id: 3, balance: 0, deleted_at: null }];
  const mk = (ccy, list) => bankJson([{ acc: 'UA000000000000000000000001234', ccy, name: 'ФОП Хоменко Всеволод Сергійович', client: 'ФОП Хоменко', opening: 0, closing: list.reduce((s, x) => s + (x.TRANTYPE === 'C' ? 1 : -1) * Number(x.SUM), 0), transactions: list }]);
  const P = 'За послуги з використання програмного продукту Сервіс';
  const a = await run({ accounts: eur, records: [], banks: [mk('EUR', [tx('04.10.2026', 449, P, 'UA_G', 'Горобченко Оксана Романівна')])] });
  assert.ok(a.S.lastRecs.every(p => !p.sub), 'валютний рахунок — не тариф');
  const uah = [{ ...eur[0], name: 'ФОП Хоменко Всеволод Приват 1234', currency_id: 1 }];
  const b = await run({ accounts: uah, records: [], banks: [mk('UAH', [tx('04.10.2026', 449, 'Повернення помилково сплачених коштів за програмний продукт', 'UA_G', 'Горобченко Оксана Романівна')])] });
  assert.ok(b.S.lastRecs.every(p => !p.sub), 'повернення — не підписка');
  // 12.10 банк платив свої податки (у CRM по людях — частково), 13.10 — податки іншої ЗП: записи 12.10 не блокують платежі 13.10
  const acc = [{ ...TOV[0], balance: 0 }];
  const T = (d, s, p) => tx(d, -s, p, 'UA_TAX', 'ГОЛОВНЕ УДКСУ У М.КИЄВІ');
  const bank = bankJson([{ acc: 'UA000000000000000000000008112', ccy: 'UAH', name: 'ТОВ СЕРВІС МАРКЕТ', client: 'ТОВ Маркет', opening: 100000, closing: 100000 - 10000 - 7833.34 + 4321,
    transactions: [T('12.10.2026', 5000, 'Сплата військового збору за вересень 2026'), T('12.10.2026', 5000, 'Сплата ПДФО за вересень 2026'),
      T('13.10.2026', 3916.67, 'Сплата військового збору за жовтень 2026'), T('13.10.2026', 3916.67, 'Сплата ПДФО за жовтень 2026')] }]);
  const c = await run({ accounts: acc, records: [rec(41, '2026-10-12', [[1, 2, 4321]], 'Податки 10 % з 43 210,00 (на руки 38 889,00) — Іваненко Петро: зарплата')], banks: [bank] });
  const d13 = c.S.lastRecs.filter(p => p.date === '2026-10-13');
  assert.equal(d13.length, 2);
  for (const p of d13) assert.ok(!/поруч/.test(p.block || ''), p.block);
});