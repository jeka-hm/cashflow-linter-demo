// Чернетки кешфлоу CRM (core/drafts.js): дата форми → час UTC, чернетка → запис, фільтри списку, вплив на залишок,
// обгортки запитів для панелі (make) і для закладки реєстру погоджень (registry). Усе на підставних запитах — без мережі.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../core/drafts.js');
const M = require('../core/crm-model.js');
const R = require('../core/recon.js');

// чернетка у вигляді справжньої CRM (перевірено 14.11.2026): поля форми — рядками
const EXP = { operation: '2', amount: '1500.50', date: '14-11-2026 23:30', period: '01-11-2026', comment: 'Оренда офісу', location_id: '1', project_id: '12', currency_id: '1',
  invoice_id: '33', pnl_category_id: '5', pnl_operation_id: '41', show_response_in_currency: '0' };
const INC = { ...EXP, operation: '1', amount: '1.00', date: '10-11-2026 09:05', comment: 'Оплата від клієнта', invoice_id: '98', pnl_category_id: '2', pnl_operation_id: '7' };
const TRF = { operation: '3', amount: '20000.00', date: '12-11-2026 14:00', period: '01-11-2026', comment: 'Переказ між своїми', location_id: '1', project_id: '12', currency_id: '1', invoice_from: '33', invoice_to: '68' };
const dr = (id, data, o) => ({ id, status: 'draft', user_id: 7, created_at: '2026-11-14T10:00:00.000000Z', updated_at: '2026-11-14T10:00:01.000000Z', data, files: [], ...o });
// так панель дістає ID створеного запису з відповіді POST (ui/bank-panel.js, idOf)
const idOf = res => { const t = res.json && res.json.data !== undefined ? res.json.data : res.json; return t && typeof t === 'object' ? (Number.isInteger(t.transaction_id) ? t.transaction_id : Array.isArray(t.payments) && Number.isInteger(t.id) ? t.id : null) : null; };
const err = (status, message) => Object.assign(new Error(message || 'HTTP ' + status), { status });
const page = (data, cur, last, total) => ({ current_page: cur, data, last_page: last, per_page: 100, total });

// ---------- kyivIso ----------
test('kyivIso: зимовий час (UTC+2) і літній (UTC+3); без часу — 12:00 за Києвом', () => {
  assert.equal(D.kyivIso('14-11-2026 23:30'), '2026-11-14T21:30:00.000Z');
  assert.equal(D.kyivIso('15-07-2026 23:30'), '2026-07-15T20:30:00.000Z');
  assert.equal(D.kyivIso('15-01-2026 00:10'), '2026-01-14T22:10:00.000Z', 'після півночі за Києвом — ще попередня доба UTC');
  assert.equal(D.kyivIso('01-11-2026'), '2026-11-01T10:00:00.000Z', 'період 01-ММ-РРРР — полудень за Києвом');
  assert.equal(D.kyivIso('01-07-2026'), '2026-07-01T09:00:00.000Z');
  assert.equal(D.kyivIso('05-11-2026 9:05'), '2026-11-05T07:05:00.000Z', 'година однією цифрою');
  assert.equal(D.kyivIso('14.11.2026 08:00'), '2026-11-14T06:00:00.000Z', 'крапки замість дефісів');
  assert.equal(D.kyivIso('2026-11-14 08:00'), '2026-11-14T06:00:00.000Z', 'РРРР-ММ-ДД теж читається');
  assert.equal(D.kyivIso('2026-07-14'), '2026-07-14T09:00:00.000Z');
});

test('kyivIso: не дата — null', () => {
  for (const bad of ['', null, undefined, 'абракадабра', '14-11', '2026', 'сьогодні 12:00', {}, [], 0, NaN]) assert.equal(D.kyivIso(bad), null, `«${String(bad)}»`);
});

test('kyivIso: неможлива дата (31 лютого, 13-й місяць, 25:70) — null, а не сусідній день', () => {
  for (const bad of ['31-02-2026 10:00', '45-13-2026', '14-11-2026 25:70', '00-00-2026']) assert.equal(D.kyivIso(bad), null, bad);
});

test('kyivIso: переведення годинника — навесні години 03:30 немає, восени вона двічі; день лишається той самий', () => {
  for (const s of ['29-03-2026 03:30', '25-10-2026 03:30', '29-03-2026 02:59', '25-10-2026 04:00', '29-03-2026', '25-10-2026']) {
    const iso = D.kyivIso(s);
    assert.ok(iso && !isNaN(new Date(iso)), s);
    assert.equal(M.kyivDate(iso), `2026-${s.slice(3, 5)}-${s.slice(0, 2)}`, s);
  }
  assert.equal(D.kyivIso('25-10-2026 02:30'), '2026-10-24T23:30:00.000Z', 'до переведення — ще літній час');
  assert.equal(D.kyivIso('25-10-2026 04:30'), '2026-10-25T02:30:00.000Z', 'після — зимовий');
});

test('kyivIso → день і час, які бачить звірка: crm-model kyivDate і recon time — на кожну годину доби, взимку і влітку', () => {
  for (const dmy of ['14-11-2026', '31-12-2026', '01-01-2026', '15-07-2026', '30-06-2026', '28-02-2026']) {
    for (let h = 0; h < 24; h++) {
      const hm = `${String(h).padStart(2, '0')}:30`, iso = D.kyivIso(`${dmy} ${hm}`), day = `${dmy.slice(6)}-${dmy.slice(3, 5)}-${dmy.slice(0, 2)}`;
      assert.equal(M.kyivDate(iso), day, `${dmy} ${hm}`);
      const it = R.cashflowByAccount([D.toRecord(dr(1, { ...EXP, date: `${dmy} ${hm}` }))]).get(33)[0];
      assert.deepEqual([it.date, it.time], [day, hm], `${dmy} ${hm}`);
    }
  }
});

// ---------- toRecord ----------
test('toRecord: витрата — запис у вигляді GET invoice-payment, числа замість рядків, позначка draft', () => {
  assert.deepEqual(D.toRecord(dr(27231, EXP)), {
    id: 27231, draft: true, user_id: 7, location_id: 1, project_id: 12, task_payment_id: null, comment: 'Оренда офісу',
    date: '2026-11-14T21:30:00.000Z', period: '2026-11-01T10:00:00.000Z', created_at: '2026-11-14T10:00:00.000000Z', updated_at: '2026-11-14T10:00:01.000000Z',
    deleted_at: null, is_manual: true, is_edited: false,
    payments: [{ id: null, transaction_id: 27231, invoice_id: 33, operation: 2, amount: 1500.5, deleted_at: null, pnl_category_id: 5, pnl_operation_id: 41 }],
    marketer_balance_history: null,
  });
});

test('toRecord: дохід «1.00» — один платіж операції 1 на суму 1', () => {
  const r = D.toRecord(dr(27232, INC));
  assert.deepEqual(r.payments, [{ id: null, transaction_id: 27232, invoice_id: 98, operation: 1, amount: 1, deleted_at: null, pnl_category_id: 2, pnl_operation_id: 7 }]);
  assert.deepEqual([r.date, r.comment, r.draft], ['2026-11-10T07:05:00.000Z', 'Оплата від клієнта', true]);
});

test('toRecord: переказ — два платежі: 4 з рахунку і 3 на рахунок, без статті', () => {
  const r = D.toRecord(dr(27240, TRF));
  assert.deepEqual(r.payments, [
    { id: null, transaction_id: 27240, invoice_id: 33, operation: 4, amount: 20000, deleted_at: null },
    { id: null, transaction_id: 27240, invoice_id: 68, operation: 3, amount: 20000, deleted_at: null }]);
  assert.equal(r.date, '2026-11-12T12:00:00.000Z');
});

test('toRecord: маркетолог — як у записі кешфлоу (marketer_balance_history.marketer_balance.user_id)', () => {
  assert.deepEqual(D.toRecord(dr(1, { ...EXP, marketer_id: '415' })).marketer_balance_history, { marketer_balance: { user_id: 415 } });
  for (const v of ['', null, undefined, '0']) assert.equal(D.toRecord(dr(1, { ...EXP, marketer_id: v })).marketer_balance_history, null, `marketer_id «${v}»`);
});

test('toRecord: недозаповнена чернетка — запис без платежів (у звірку не потрапляє), нічого не падає', () => {
  const none = (data, why) => assert.deepEqual(D.toRecord(dr(5, data)).payments, [], why);
  none({ ...EXP, invoice_id: '' }, 'без рахунку');
  none({ ...EXP, invoice_id: undefined }, 'рахунку немає зовсім');
  none({ ...EXP, amount: '' }, 'без суми');
  none({ ...EXP, amount: '0' }, 'сума 0');
  none({ ...EXP, amount: '-5' }, 'від\'ємна сума');
  none({ ...EXP, amount: 'сто' }, 'сума не число');
  none({ ...EXP, operation: '' }, 'без типу операції');
  none({ ...TRF, invoice_to: '' }, 'переказ без рахунку «куди»');
  none({ ...TRF, invoice_from: '' }, 'переказ без рахунку «звідки»');
  none({ ...EXP, operation: '3' }, 'операція 3 з одним invoice_id — не переказ');
  none({ ...EXP, operation: '5' }, 'обмін валют панель не розбирає');
  none({}, 'порожні дані');
  const r = D.toRecord(dr(5, { comment: null }));
  assert.deepEqual([r.id, r.draft, r.comment, r.date, r.period, r.location_id, r.project_id], [5, true, '', null, null, null, null]);
  assert.equal(R.cashflowByAccount([r]).size, 0);
});

test('toRecord: data масивом [] (вигляд «before» в історії CRM), null чи без data — не падає', () => {
  for (const data of [[], null, undefined, 'рядок', 0]) {
    const r = D.toRecord(dr(9, data));
    assert.deepEqual([r.id, r.draft, r.payments, r.date, r.comment], [9, true, [], null, ''], JSON.stringify(data));
  }
  const bare = D.toRecord({ id: 10 });
  assert.deepEqual([bare.id, bare.user_id, bare.created_at, bare.updated_at, bare.payments], [10, null, null, null, []]);
});

test('toRecord: запис проходить перевірку ID панелі (idOf) навіть без платежів', () => {
  assert.equal(idOf({ json: { data: D.toRecord(dr(27231, EXP)) } }), 27231);
  assert.equal(idOf({ json: { data: D.toRecord(dr(27233, {})) } }), 27233);
});

// ---------- рух рахунку у звірці ----------
test('recon cashflowByAccount: рух із чернетки має draft: true, зі справжнього запису — ні', () => {
  const live = { id: 27230, user_id: 7, project_id: 12, comment: 'Справжній', date: '2026-11-14T08:00:00.000000Z', period: '2026-10-31T22:00:00.000000Z', deleted_at: null, task_payment_id: null,
    payments: [{ id: 900, transaction_id: 27230, invoice_id: 33, operation: 2, amount: 300, deleted_at: null, pnl_category_id: 5, pnl_operation_id: 41 }], marketer_balance_history: null };
  const m = R.cashflowByAccount([live, D.toRecord(dr(27231, { ...EXP, marketer_id: '415' })), D.toRecord(dr(27232, INC)), D.toRecord(dr(27240, TRF))]);
  const of = (acc, id) => m.get(acc).find(x => x.id === id);
  assert.equal('draft' in of(33, 27230), false, 'у справжнього запису позначки немає зовсім');
  assert.deepEqual(of(33, 27231), { id: 27231, date: '2026-11-14', per: '2026-11', time: '23:30', amount: -1500.5, op: 'витрата', comment: 'Оренда офісу', lead: false,
    opc: 2, peer: null, proj: 12, art: '5/41', mk: 415, acc: 33, draft: true });
  assert.deepEqual([of(98, 27232).amount, of(98, 27232).op, of(98, 27232).draft, of(98, 27232).time], [1, 'дохід', true, '09:05']);
  // переказ: обидві сторони — рух із чернетки, кожна знає рахунок другої сторони
  assert.deepEqual([of(33, 27240).amount, of(33, 27240).peer, of(33, 27240).art, of(33, 27240).draft], [-20000, 68, null, true]);
  assert.deepEqual([of(68, 27240).amount, of(68, 27240).peer, of(68, 27240).draft], [20000, 33, true]);
  assert.deepEqual([...m.keys()].sort((a, b) => a - b), [33, 68, 98]);
  // те саме для одного рахунку
  assert.deepEqual(R.cashflowItems([live, D.toRecord(dr(27231, EXP))], 33).map(x => [x.id, !!x.draft]), [[27230, false], [27231, true]]);
});

// ---------- matches ----------
test('matches: межі дат — дні за Києвом, запис о 23:30 належить своєму дню, о 00:30 — наступному', () => {
  const late = D.toRecord(dr(1, EXP)); // 14.11 23:30 за Києвом = 21:30 UTC
  const early = D.toRecord(dr(2, { ...EXP, date: '15-11-2026 00:30' })); // 14.11 22:30 UTC
  const q = (from, to) => `invoice-payment?date_from=${from}&date_to=${to}`;
  assert.equal(D.matches(late, q('14-11-2026', '14-11-2026')), true);
  assert.equal(D.matches(late, q('11-11-2026', '17-11-2026')), true);
  assert.equal(D.matches(late, q('15-11-2026', '17-11-2026')), false);
  assert.equal(D.matches(late, q('01-11-2026', '13-11-2026')), false);
  assert.equal(D.matches(early, q('15-11-2026', '15-11-2026')), true);
  assert.equal(D.matches(early, q('14-11-2026', '14-11-2026')), false, 'за UTC це ще 14-те, за Києвом — уже 15-те');
  assert.equal(D.matches(late, 'invoice-payment?date_from=14-11-2026'), true, 'лише «з»');
  assert.equal(D.matches(late, 'invoice-payment?date_to=13-11-2026'), false, 'лише «до»');
  // межа місяців і років
  const ny = D.toRecord(dr(3, { ...EXP, date: '31-12-2026 23:59' }));
  assert.equal(D.matches(ny, q('01-12-2026', '31-12-2026')), true);
  assert.equal(D.matches(ny, q('01-01-2027', '31-01-2027')), false);
  // чернетка без дати під фільтр дат не підходить, без фільтра — підходить
  const nodate = D.toRecord(dr(4, { ...EXP, date: '' }));
  assert.equal(D.matches(nodate, q('01-01-2015', '31-12-2030')), false);
  assert.equal(D.matches(nodate, 'invoice-payment?per_page=100'), true);
});

test('matches: сума — з допуском пів копійки; «1500.5» у запиті = «1500.50» у чернетці', () => {
  const r = D.toRecord(dr(1, EXP));
  const q = (lo, hi) => `invoice-payment?amount_from=${lo}&amount_to=${hi}`;
  assert.equal(D.matches(r, q(1500.5, 1500.5)), true);
  assert.equal(D.matches(r, q('1500.50', '1500.50')), true);
  assert.equal(D.matches(r, q(1500.51, 1500.51)), false);
  assert.equal(D.matches(r, q(1500.49, 1500.49)), false);
  assert.equal(D.matches(r, q(1000, 2000)), true);
  assert.equal(D.matches(r, q(1500.51, 2000)), false);
  assert.equal(D.matches(r, 'invoice-payment?amount_from=1500'), true, 'лише «від»');
  assert.equal(D.matches(r, 'invoice-payment?amount_to=1500'), false, 'лише «до»');
  // суми з «хвостом» дробу: 0.1 + 0.2
  assert.equal(D.matches(D.toRecord(dr(2, { ...EXP, amount: '0.30' })), q(0.1 + 0.2, 0.1 + 0.2)), true);
  // чернетка без платежів під фільтр суми не підходить
  assert.equal(D.matches(D.toRecord(dr(3, { ...EXP, amount: '' })), q(0, 1e9)), false);
  // видалений платіж не рахується
  const del = D.toRecord(dr(4, EXP));
  del.payments[0].deleted_at = '2026-11-14T10:00:00Z';
  assert.equal(D.matches(del, q(1500.5, 1500.5)), false);
});

test('matches: invoice_ids[] — один чи кілька рахунків; переказ підходить за будь-якою зі сторін', () => {
  const e = D.toRecord(dr(1, EXP)), t = D.toRecord(dr(2, TRF));
  assert.equal(D.matches(e, 'invoice-payment?invoice_ids[]=33'), true);
  assert.equal(D.matches(e, 'invoice-payment?invoice_ids[]=98'), false);
  assert.equal(D.matches(e, 'invoice-payment?invoice_ids[]=98&invoice_ids[]=33&invoice_ids[]=1'), true);
  assert.equal(D.matches(e, 'invoice-payment?invoice_ids[]=98&invoice_ids[]=1'), false);
  assert.equal(D.matches(e, 'invoice-payment?invoice_ids%5B%5D=33'), true, 'закодовані дужки');
  assert.equal(D.matches(e, 'invoice-payment?invoice_ids%5B%5D=98'), false);
  assert.equal(D.matches(e, 'invoice-payment?invoice_ids[]=3'), false, '3 — не 33');
  assert.equal(D.matches(t, 'invoice-payment?invoice_ids[]=33'), true);
  assert.equal(D.matches(t, 'invoice-payment?invoice_ids[]=68'), true);
  assert.equal(D.matches(t, 'invoice-payment?invoice_ids[]=98'), false);
  assert.equal(D.matches(D.toRecord(dr(3, {})), 'invoice-payment?invoice_ids[]=33'), false, 'без платежів — не підходить');
});

test('matches: без фільтрів підходить усе; запит можна дати рядком (з адресою чи без) або URLSearchParams', () => {
  const e = D.toRecord(dr(1, EXP)), empty = D.toRecord(dr(2, {}));
  for (const q of ['', 'invoice-payment', 'invoice-payment?per_page=100&page=1', '/api/invoice-payment?per_page=100', new URLSearchParams(), new URLSearchParams('page=1')]) {
    assert.equal(D.matches(e, q), true);
    assert.equal(D.matches(empty, q), true);
  }
  assert.equal(D.matches(e, 'date_from=14-11-2026&date_to=14-11-2026&invoice_ids[]=33'), true, 'рядок без «?»');
  assert.equal(D.matches(e, new URLSearchParams('date_from=15-11-2026')), false);
  // усі фільтри разом — так запит будує панель («Внести в CRM», пошук дублів)
  const nearQ = (acc, amount) => `invoice-payment?date_from=11-11-2026&date_to=17-11-2026&amount_from=${amount}&amount_to=${amount}&invoice_ids[]=${acc}&per_page=100`;
  assert.equal(D.matches(e, nearQ(33, 1500.5)), true);
  assert.equal(D.matches(e, nearQ(98, 1500.5)), false, 'інший рахунок');
  assert.equal(D.matches(e, nearQ(33, 1500)), false, 'інша сума');
});

// ---------- balanceEffect ----------
test('balanceEffect: дохід +, витрата −, переказ − з рахунку і + на рахунок; суми округлено до копійок', () => {
  const recs = [dr(1, EXP), dr(2, INC), dr(3, TRF), dr(4, { ...EXP, amount: '0.10' }), dr(5, { ...EXP, amount: '0.20' }), dr(6, {}), dr(7, { ...INC, invoice_id: '33', amount: '100' })].map(D.toRecord);
  const m = D.balanceEffect(recs);
  assert.ok(m instanceof Map);
  assert.deepEqual([...m.entries()].sort((a, b) => a[0] - b[0]), [[33, -21400.8], [68, 20000], [98, 1]]);
  assert.equal(D.balanceEffect([]).size, 0);
  assert.equal(D.balanceEffect(null).size, 0);
  assert.equal(D.balanceEffect(undefined).size, 0);
  assert.equal(D.balanceEffect([{ id: 1 }]).size, 0, 'запис без payments');
});

test('balanceEffect: видалені платежі й невідомі операції не рахуються; рахунок рядком = рахунок числом', () => {
  const m = D.balanceEffect([{ payments: [
    { invoice_id: '33', operation: 1, amount: '10.10', deleted_at: null }, { invoice_id: 33, operation: 2, amount: 0.1, deleted_at: null },
    { invoice_id: 33, operation: 1, amount: 999, deleted_at: '2026-11-14' }, { invoice_id: 33, operation: 9, amount: 999, deleted_at: null }] }]);
  assert.deepEqual([...m.entries()], [[33, 10]]);
});

// ---------- make: обгортка для панелі ----------
function fakeApi(o) {
  const calls = [];
  return { calls,
    get: async path => { calls.push(['GET', path]); return o.get(path); },
    post: async (path, body) => { calls.push(['POST', path, body]); return o.post(path, body); } };
}
const pageNo = path => Number(new URLSearchParams(path.split('?')[1] || '').get('page') || 1);

test('make.on: за перемикачем; без опцій — вимкнено; make сам запитів не робить', () => {
  const api = fakeApi({});
  let on = false;
  const DR = D.make(api, { on: () => on });
  assert.equal(DR.on(), false);
  on = true;
  assert.equal(DR.on(), true);
  assert.equal(D.make(api).on(), false);
  assert.equal(D.make(api, {}).on(), false);
  assert.deepEqual(api.calls, []);
});

test('make.list: усі сторінки по 100 (per_page > 100 CRM не приймає), записи з draft: true', async () => {
  const all = Array.from({ length: 230 }, (_, i) => dr(27300 + i, { ...EXP, amount: String(i + 1) }));
  const api = fakeApi({ get: path => { const p = pageNo(path); return page(all.slice((p - 1) * 100, p * 100), p, 3, 230); } });
  const recs = await D.make(api, { on: () => true }).list();
  assert.deepEqual(api.calls, [1, 2, 3].map(p => ['GET', `invoice-payment-drafts?page=${p}&per_page=100`]));
  assert.equal(recs.length, 230);
  assert.deepEqual([recs[0].id, recs[229].id, recs[229].payments[0].amount], [27300, 27529, 230]);
  assert.ok(recs.every(r => r.draft === true && Array.isArray(r.payments)));
});

test('make.list: одна сторінка, порожній список, відповідь масивом — по одному запиту; чернетка, що «переїхала» між сторінками, — один раз', async () => {
  const one = fakeApi({ get: () => page([dr(1, EXP)], 1, 1, 1) });
  assert.deepEqual((await D.make(one).list()).map(r => r.id), [1]);
  assert.equal(one.calls.length, 1);
  const empty = fakeApi({ get: () => page([], 1, 1, 0) });
  assert.deepEqual(await D.make(empty).list(), []);
  assert.equal(empty.calls.length, 1);
  const arr = fakeApi({ get: () => [dr(1, EXP), dr(2, INC)] });
  assert.deepEqual((await D.make(arr).list()).map(r => r.id), [1, 2]);
  assert.equal(arr.calls.length, 1);
  const nul = fakeApi({ get: () => null });
  assert.deepEqual(await D.make(nul).list(), []);
  assert.equal(nul.calls.length, 1);
  // поки читались сторінки, хтось створив чернетку — остання з першої сторінки повторилась на другій
  const moved = fakeApi({ get: path => (pageNo(path) === 1 ? page([dr(3, EXP), dr(2, INC)], 1, 2, 3) : page([dr(2, INC), dr(1, TRF)], 2, 2, 3)) });
  assert.deepEqual((await D.make(moved).list()).map(r => r.id), [3, 2, 1]);
});

test('make.list: помилка запиту не ковтається', async () => {
  const api = fakeApi({ get: () => { throw err(500); } });
  await assert.rejects(D.make(api).list(), e => e.status === 500);
});

test('make.post: успіх — POST на invoice-payment-drafts із тим самим тілом; json.data — запис, ID якого бере панель', async () => {
  const body = { form: true };
  const api = fakeApi({ post: () => ({ status: 201, ok: true, json: { ...dr(27231, EXP), history: [{ before: [], after: EXP }] }, text: '…' }) });
  const res = await D.make(api, { on: () => true }).post(body);
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0].slice(0, 2), ['POST', 'invoice-payment-drafts']);
  assert.equal(api.calls[0][2], body, 'тіло передано як є');
  assert.deepEqual([res.status, res.ok, res.text], [201, true, '…'], 'решта відповіді — без змін');
  assert.equal(idOf(res), 27231);
  assert.deepEqual([res.json.data.draft, res.json.data.payments[0].invoice_id, res.json.data.payments[0].amount, res.json.data.date], [true, 33, 1500.5, '2026-11-14T21:30:00.000Z']);
});

test('make.post: чернетка, загорнута в {data: …}, теж читається; відповідь без ID — ID немає (панель шукатиме запис сама)', async () => {
  const wrapped = fakeApi({ post: () => ({ status: 201, json: { data: dr(27232, INC) } }) });
  const r1 = await D.make(wrapped).post({});
  assert.equal(idOf(r1), 27232);
  assert.equal(r1.json.data.payments[0].operation, 1);
  for (const json of [null, undefined, '', {}, { message: 'ok' }]) {
    const api = fakeApi({ post: () => ({ status: 200, json }) });
    assert.equal(idOf(await D.make(api).post({})), null, JSON.stringify(json));
  }
});

test('make.post: відмова CRM (422, 403, 500) чи відповідь без статусу — повертається той самий об\'єкт, без змін', async () => {
  for (const res of [{ status: 422, json: { message: 'The amount field is required.', errors: { amount: ['…'] } } }, { status: 403, json: { message: 'Forbidden' } },
    { status: 500, json: null, text: '<html>' }, { status: 0, json: null }, { status: 302, json: null }]) {
    const api = fakeApi({ post: () => res });
    const got = await D.make(api).post({});
    assert.equal(got, res, 'статус ' + res.status);
    assert.deepEqual(got, JSON.parse(JSON.stringify(res)));
  }
  assert.equal(await D.make(fakeApi({ post: () => null })).post({}), null);
  await assert.rejects(D.make(fakeApi({ post: () => { throw new Error('мережа'); } })).post({}), /мережа/);
});

test('make.get(id): GET invoice-payment-drafts/{id} → запис; 404 — помилка проходить далі', async () => {
  const api = fakeApi({ get: path => { if (path === 'invoice-payment-drafts/27231') return { ...dr(27231, EXP), history: [] }; throw err(404, 'Запис не знайдено'); } });
  const DR = D.make(api);
  const rec = await DR.get(27231);
  assert.deepEqual(api.calls, [['GET', 'invoice-payment-drafts/27231']]);
  assert.deepEqual([rec.id, rec.draft, rec.payments.length, rec.payments[0].invoice_id, M.kyivDate(rec.date), rec.comment], [27231, true, 1, 33, '2026-11-14', 'Оренда офісу']);
  await assert.rejects(DR.get(5), e => e.status === 404);
  // загорнута відповідь {data: чернетка}
  const w = fakeApi({ get: () => ({ data: dr(27240, TRF) }) });
  assert.deepEqual((await D.make(w).get(27240)).payments.map(p => [p.invoice_id, p.operation]), [[33, 4], [68, 3]]);
});

test('make.near: запит, як його будує панель, — лише чернетки того рахунку, суми й днів; сам список CRM не фільтрує', async () => {
  const all = [dr(1, EXP), // підходить: рахунок 33, 1500.50, 14.11
    dr(2, { ...EXP, invoice_id: '98' }), // інший рахунок
    dr(3, { ...EXP, amount: '1500.00' }), // інша сума
    dr(4, { ...EXP, date: '18-11-2026 00:10' }), // на день пізніше за межу
    dr(5, { ...EXP, date: '17-11-2026 23:50' }), // останній день межі
    dr(6, { ...TRF, amount: '1500.50', date: '11-11-2026 00:05' }), // переказ з 33 — перший день межі
    dr(7, { ...EXP, invoice_id: '' }), // недозаповнена
    dr(8, [])];
  const api = fakeApi({ get: path => { const p = pageNo(path); return page(all.slice((p - 1) * 4, p * 4), p, 2, all.length); } });
  const DR = D.make(api, { on: () => true });
  const amount = Number('1500.50'), acc = 33;
  const nearQ = `invoice-payment?date_from=11-11-2026&date_to=17-11-2026&amount_from=${amount}&amount_to=${amount}&invoice_ids[]=${acc}&per_page=100`;
  assert.deepEqual((await DR.near(nearQ)).map(r => r.id), [1, 5, 6]);
  assert.ok(api.calls.every(c => c[0] === 'GET' && /^invoice-payment-drafts\?page=\d+&per_page=100$/.test(c[1])), 'до invoice-payment near не ходить, фільтри в CRM не шле');
  assert.equal(api.calls.length, 2);
  assert.deepEqual(await DR.near(nearQ.replace('invoice_ids[]=33', 'invoice_ids[]=1')), []);
  assert.equal((await DR.near('invoice-payment?per_page=100')).length, 8, 'без фільтрів — усі');
});

// ---------- registry: обгортка для закладки реєстру погоджень ----------
/* Підставна S(метод, адреса, тіло): live — записи кешфлоу, drafts — чернетки; shape: 'object' (Laravel) чи 'array'. */
function fakeS(o) {
  const st = { live: o.live || [], drafts: o.drafts || [], calls: [], nextId: o.nextId || 27231, perPage: o.perPage || 100 };
  const S = async (method, url, body) => {
    st.calls.push([method, url, body]);
    const path = String(url).split('?')[0], q = new URLSearchParams(String(url).split('?')[1] || '');
    if (o.fail && o.fail(method, path)) throw o.fail(method, path);
    if (method === 'GET' && path === '/api/invoice-payment-drafts') {
      const p = Number(q.get('page') || 1), per = Number(q.get('per_page') || 15);
      if (per > 100) throw err(422, 'per_page');
      const n = Math.min(per, st.perPage);
      return page(st.drafts.slice((p - 1) * n, p * n), p, Math.max(1, Math.ceil(st.drafts.length / n)), st.drafts.length);
    }
    if (method === 'POST' && path === '/api/invoice-payment-drafts') { const d = dr(st.nextId++, body && body.fields ? body.fields : EXP, { history: [] }); st.drafts.push(d); return d; }
    let m = /^\/api\/invoice-payment-drafts\/(\d+)$/.exec(path);
    if (method === 'GET' && m) { const d = st.drafts.find(x => x.id === Number(m[1])); if (!d) throw err(404, 'Чернетку не знайдено'); return d; }
    if (method === 'GET' && path === '/api/invoice-payment') return o.shape === 'array' ? st.live.slice() : page(st.live.slice(), Number(q.get('page') || 1), o.lastPage || 1, st.live.length);
    m = /^\/api\/invoice-payment\/(\d+)$/.exec(path);
    if (method === 'GET' && m) { const r = st.live.find(x => x.id === Number(m[1])); if (!r) throw err(404, 'Запис не знайдено'); return { data: r }; }
    return { ok: true, echo: [method, url] };
  };
  return { S, st, drafts: () => st.calls.filter(c => c[1].startsWith('/api/invoice-payment-drafts')) };
}
const LIVE = { id: 27230, comment: 'Справжній', date: '2026-11-14T08:00:00.000000Z', period: '2026-10-31T22:00:00.000000Z', deleted_at: null,
  payments: [{ id: 900, transaction_id: 27230, invoice_id: 33, operation: 2, amount: 1500.5, deleted_at: null }] };

test('registry: POST /api/invoice-payment → POST чернетки з тим самим тілом; відповідь {data: запис}; у кешфлоу нічого не пишеться', async () => {
  const f = fakeS({}), call = D.registry(f.S), body = { fields: INC };
  const res = await call('POST', '/api/invoice-payment', body);
  assert.deepEqual(f.st.calls.map(c => c.slice(0, 2)), [['POST', '/api/invoice-payment-drafts']]);
  assert.equal(f.st.calls[0][2], body);
  assert.deepEqual(Object.keys(res), ['data']);
  assert.deepEqual([res.data.id, res.data.draft, res.data.payments[0].invoice_id, res.data.payments[0].operation, res.data.payments[0].amount], [27231, true, 98, 1, 1]);
  assert.equal(idOf({ json: res }), 27231);
  // адреса з параметрами — теж створення запису
  await call('POST', '/api/invoice-payment?x=1', body);
  assert.deepEqual(f.st.calls[1].slice(0, 2), ['POST', '/api/invoice-payment-drafts']);
});

test('registry: POST — відмова CRM проходить помилкою далі; загорнута відповідь {data: чернетка} теж читається', async () => {
  const bad = D.registry(async () => { throw err(422, 'The amount field is required.'); });
  await assert.rejects(bad('POST', '/api/invoice-payment', {}), e => e.status === 422 && /amount/.test(e.message));
  const wrapped = D.registry(async () => ({ data: dr(27250, EXP) }));
  assert.deepEqual([(await wrapped('POST', '/api/invoice-payment', {})).data.id, (await wrapped('POST', '/api/invoice-payment', {})).data.draft], [27250, true]);
  const odd = D.registry(async () => ({ message: 'ok' }));
  assert.deepEqual(await odd('POST', '/api/invoice-payment', {}), { data: { message: 'ok' } }, 'без ID — відповідь як є, у data');
});

test('registry: GET списку, перша сторінка — до записів додаються лише чернетки, що підходять під фільтри; вигляд відповіді (об\'єкт із data) зберігається', async () => {
  const f = fakeS({ live: [LIVE], drafts: [dr(27231, EXP), dr(27232, INC), dr(27233, { ...EXP, date: '01-10-2026 10:00' }), dr(27234, {})] }), call = D.registry(f.S);
  const url = '/api/invoice-payment?date_from=11-11-2026&date_to=17-11-2026&amount_from=1500.5&amount_to=1500.5&invoice_ids[]=33&per_page=100';
  const j = await call('GET', url);
  assert.equal(f.st.calls[0][1], url, 'запит до кешфлоу — без змін');
  assert.deepEqual(j.data.map(r => [r.id, !!r.draft]), [[27230, false], [27231, true]]);
  assert.deepEqual([j.current_page, j.last_page, j.total, j.per_page], [1, 1, 1, 100], 'решта полів сторінки — як у CRM');
  assert.equal(j.data[0], LIVE, 'справжні записи — ті самі об\'єкти');
  // page=1 явно — теж перша сторінка
  assert.deepEqual((await call('GET', url + '&page=1')).data.map(r => r.id), [27230, 27231]);
  // без фільтрів — усі чернетки
  assert.deepEqual((await call('GET', '/api/invoice-payment')).data.map(r => r.id), [27230, 27231, 27232, 27233, 27234]);
});

test('registry: GET списку — відповідь масивом лишається масивом; чернеток під фільтр немає — відповідь CRM та сама', async () => {
  const f = fakeS({ live: [LIVE], drafts: [dr(27231, EXP)], shape: 'array' }), call = D.registry(f.S);
  const j = await call('GET', '/api/invoice-payment?invoice_ids[]=33');
  assert.ok(Array.isArray(j));
  assert.deepEqual(j.map(r => [r.id, !!r.draft]), [[27230, false], [27231, true]]);
  const none = await call('GET', '/api/invoice-payment?invoice_ids[]=98');
  assert.deepEqual(none, [LIVE]);
  // об'єкт: коли додати нічого — повертається саме відповідь CRM
  const raw = page([LIVE], 1, 1, 1), g = D.registry(async (m, url) => (url.startsWith('/api/invoice-payment-drafts') ? page([dr(1, EXP)], 1, 1, 1) : raw));
  assert.equal(await g('GET', '/api/invoice-payment?invoice_ids[]=98'), raw);
  // чернеток немає зовсім
  const e = fakeS({ live: [LIVE] });
  assert.deepEqual((await D.registry(e.S)('GET', '/api/invoice-payment')).data, [LIVE]);
});

test('registry: GET списку, сторінки 2+ — без чернеток і без запиту до них (щоб чернетка не з\'явилась двічі)', async () => {
  const f = fakeS({ live: [LIVE], drafts: [dr(27231, EXP)], lastPage: 3 }), call = D.registry(f.S);
  for (const p of [2, 3]) {
    const j = await call('GET', `/api/invoice-payment?invoice_ids[]=33&per_page=100&page=${p}`);
    assert.deepEqual(j.data.map(r => r.id), [27230], 'сторінка ' + p);
  }
  assert.equal(f.drafts().length, 0);
  assert.deepEqual((await call('GET', '/api/invoice-payment?invoice_ids[]=33&per_page=100&page=1')).data.map(r => r.id), [27230, 27231]);
});

test('registry: чернеток багато — читаються всі сторінки по 100', async () => {
  const drafts = Array.from({ length: 205 }, (_, i) => dr(28000 + i, EXP));
  const f = fakeS({ drafts }), call = D.registry(f.S);
  assert.equal((await call('GET', '/api/invoice-payment?invoice_ids[]=33')).data.length, 205);
  assert.deepEqual(f.drafts().map(c => c[1]), [1, 2, 3].map(p => `/api/invoice-payment-drafts?page=${p}&per_page=100`));
});

test('registry: список чернеток пам\'ятається 4 секунди; створену чернетку видно одразу без нового читання списку', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-14T10:00:00Z') });
  const f = fakeS({ live: [LIVE], drafts: [dr(27231, EXP)], nextId: 27232 }), call = D.registry(f.S);
  const url = '/api/invoice-payment?invoice_ids[]=33';
  await call('GET', url);
  await call('GET', url);
  t.mock.timers.tick(3900);
  await call('GET', url);
  assert.equal(f.drafts().length, 1, 'три списки поспіль — чернетки прочитано раз');
  t.mock.timers.tick(200);
  await call('GET', url);
  assert.equal(f.drafts().length, 2, 'минуло понад 4 с — прочитано заново');
  // створення: нова чернетка дописується в запам'ятаний список — пакет із багатьох рядків не перечитує всі чернетки щоразу
  const made = await call('POST', '/api/invoice-payment', { fields: { ...EXP, comment: 'Нова' } });
  assert.equal(made.data.id, 27232);
  const j = await call('GET', url);
  assert.deepEqual(j.data.map(r => r.id), [27230, 27231, 27232]);
  assert.deepEqual(f.drafts().map(c => c[0]), ['GET', 'GET', 'POST']);
  // POST, який CRM відхилив, теж скидає кеш (що саме сталось на сервері — невідомо)
  const g = fakeS({ drafts: [dr(1, EXP)], fail: (m, p) => (m === 'POST' && p === '/api/invoice-payment-drafts' ? err(500) : null) }), c2 = D.registry(g.S);
  await c2('GET', url);
  await assert.rejects(c2('POST', '/api/invoice-payment', {}), e => e.status === 500);
  await c2('GET', url);
  assert.equal(g.drafts().filter(c => c[0] === 'GET').length, 2);
});

test('registry: у кожної закладки свій кеш — два виклики registry(S) один одному не заважають', async () => {
  const a = fakeS({ drafts: [dr(1, EXP)] }), b = fakeS({ drafts: [dr(2, INC)] });
  const ca = D.registry(a.S), cb = D.registry(b.S);
  assert.deepEqual((await ca('GET', '/api/invoice-payment')).data.map(r => r.id), [1]);
  assert.deepEqual((await cb('GET', '/api/invoice-payment')).data.map(r => r.id), [2]);
});

test('registry: GET за ID — справжній запис як є (чернетки не чіпаються); 404 — чернетка записом', async () => {
  const f = fakeS({ live: [LIVE], drafts: [dr(27231, EXP)] }), call = D.registry(f.S);
  assert.deepEqual(await call('GET', '/api/invoice-payment/27230'), { data: LIVE });
  assert.equal(f.drafts().length, 0);
  const rec = await call('GET', '/api/invoice-payment/27231');
  assert.deepEqual(f.st.calls.slice(1).map(c => c.slice(0, 2)), [['GET', '/api/invoice-payment/27231'], ['GET', '/api/invoice-payment-drafts/27231']]);
  assert.deepEqual([rec.id, rec.draft, rec.payments[0].invoice_id, rec.payments[0].amount, M.kyivDate(rec.date)], [27231, true, 33, 1500.5, '2026-11-14']);
  // адреса з параметрами
  assert.equal((await call('GET', '/api/invoice-payment/27231?with=history')).id, 27231);
  // немає ні запису, ні чернетки — помилка 404
  await assert.rejects(call('GET', '/api/invoice-payment/5'), e => e.status === 404);
});

test('registry: GET за ID — інші помилки (500, 403, мережа) проходять далі, до чернеток запиту немає', async () => {
  for (const e0 of [err(500), err(403, 'Forbidden'), err(401), new Error('Failed to fetch'), err(undefined)]) {
    const f = fakeS({ drafts: [dr(27231, EXP)], fail: (m, p) => (p === '/api/invoice-payment/27231' ? e0 : null) });
    await assert.rejects(D.registry(f.S)('GET', '/api/invoice-payment/27231'), e => e === e0);
    assert.equal(f.drafts().length, 0, String(e0.status));
  }
});

test('registry: помилка списку кешфлоу проходить далі; до чернеток запиту немає', async () => {
  const f = fakeS({ drafts: [dr(1, EXP)], fail: (m, p) => (m === 'GET' && p === '/api/invoice-payment' ? err(500) : null) });
  await assert.rejects(D.registry(f.S)('GET', '/api/invoice-payment?invoice_ids[]=33'), e => e.status === 500);
  assert.equal(f.drafts().length, 0);
});

test('registry: решта запитів — без змін (та сама адреса, метод, тіло, та сама відповідь)', async () => {
  const f = fakeS({ drafts: [dr(27231, EXP)] }), call = D.registry(f.S), body = { a: 1 };
  const other = [['GET', '/api/invoices?per_page=100'], ['GET', '/api/pnl-categories'], ['PUT', '/api/invoice-payment/27230', body], ['DELETE', '/api/invoice-payment/27230'],
    ['POST', '/api/invoice-payment/27230', body], ['GET', '/api/invoice-payment/27230/history'], ['GET', '/api/invoice-payment/export?date_from=01-11-2026'],
    ['POST', '/api/invoice-payment/exchange', body], ['GET', '/api/invoice-payment-drafts?page=1&per_page=100'], ['DELETE', '/api/invoice-payment-drafts/27231'],
    ['POST', '/api/invoice-payment-drafts/27231/convert'], ['GET', '/api/invoice-payments'], ['GET', '/api/task-payment?page=1']];
  for (const [m, url, b] of other) {
    const n = f.st.calls.length, res = await call(m, url, b);
    assert.equal(f.st.calls.length, n + 1, `${m} ${url}: один запит`);
    assert.deepEqual(f.st.calls[n], [m, url, b], `${m} ${url}`);
    if (!url.startsWith('/api/invoice-payment-drafts')) assert.deepEqual(res, { ok: true, echo: [m, url] });
  }
  assert.equal(f.st.calls.filter(c => c[0] === 'POST' && c[1] === '/api/invoice-payment-drafts').length, 0, 'жодної чернетки не створено');
});

test('PATH — адреса чернеток CRM', () => {
  assert.equal(D.PATH, 'invoice-payment-drafts');
});

test('registry: одночасні запити (перевірка рядків іде по 4) читають список чернеток один раз', async () => {
  const f = fakeS({ live: [LIVE], drafts: [dr(27231, EXP)] }), call = D.registry(f.S);
  await Promise.all([1, 2, 3, 4].map(() => call('GET', '/api/invoice-payment?invoice_ids[]=33')));
  assert.equal(f.drafts().length, 1);
});

test('registry: PUT запису, який насправді чернетка, не відправляється — зрозуміла відмова, а не 404 від кешфлоу', async () => {
  const f = fakeS({ live: [LIVE], drafts: [dr(27231, EXP)] }), call = D.registry(f.S);
  await call('GET', '/api/invoice-payment?invoice_ids[]=33'); // реєстр побачив чернетку у списку
  const before = f.st.calls.length;
  await assert.rejects(call('PUT', '/api/invoice-payment/27231', {}), e => e.status === 409 && /чернетка CRM/.test(e.message));
  assert.equal(f.st.calls.length, before, 'до CRM запит не дійшов');
});

test('список: у чернетки лише статус draft — проведена чи відхилена (якщо CRM лишить її у списку) не рахується; запис з тим самим ID не дублюється', async () => {
  const api = { get: async () => page([dr(1, EXP), dr(2, INC, { status: 'converted' }), dr(3, TRF, { status: 'rejected' })], 1, 1, 3) };
  assert.deepEqual((await D.make(api, { on: () => true }).list()).map(r => r.id), [1]);
  const f = fakeS({ live: [{ ...LIVE, id: 27231 }], drafts: [dr(27231, EXP)] }), call = D.registry(f.S);
  assert.deepEqual((await call('GET', '/api/invoice-payment?invoice_ids[]=33')).data.map(r => r.id), [27231]);
  assert.equal(D.toRecord(null), null);
});