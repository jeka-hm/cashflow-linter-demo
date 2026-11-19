// Наскрізні тести лінтера на моку API: читання з пагінацією, 429, статуси, застосування, 422, перевірка, відкат.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../core/linter.js');
const { createMock, makeRecord } = require('./mock-api.js');

const RULES = {
  version: 'test-1',
  reference: {
    articles: [
      { group: 'Адміністративні витрати', category: 'Комісії платіжних систем', category_id: 76, name: 'Комісії платіжних систем', operation_id: 82 },
      { group: 'Адміністративні витрати', category: 'Офіс', category_id: 57, name: 'Офіс', operation_id: 52 },
      { group: 'Адміністративні витрати', category: 'Інші витрати', category_id: 59, name: 'Інші витрати', operation_id: 55 },
      { group: 'Продажі та маркетинг', category: 'Комісії відділу продажів', category_id: 47, name: 'Комісії відділу продажів', operation_id: 31 },
    ],
    projects: { 'Україна': 1, 'США': 4 },
  },
  rules: [
    { id: 'R-COMM-01', title: 'Банківська комісія', priority: 100, match: { comment_regex: '(?i)банківськ\\w* коміс', type: 'expense' }, unless: [{ comment_regex: '(?i)\\bзп\\b' }], set: { category: 'Комісії платіжних систем' } },
    { id: 'R-OFF-01', title: 'Прибирання → Офіс', priority: 100, match: { text_any: ['прибирання'] }, set: { category: 'Офіс' } },
    { id: 'R-USA-01', title: 'США паспорт → США', priority: 100, match: { text_any: ['сша паспорт'] }, set: { project: 'США' }, mode: 'review' },
  ],
};

function setup(records, mockOpts, linterOpts) {
  const mock = createMock({ records, ...mockOpts });
  const api = L.makeApi(mock.rawFetch, { minInterval: 0, sleep: async () => {} });
  const progress = [];
  const linter = L.createLinter({ api, rulesDoc: RULES, perPage: 2, onProgress: p => progress.push(p), ...linterOpts });
  return { mock, api, linter, progress };
}
const RECS = () => [
  makeRecord({ id: 1, comment: 'Банківська комісія за обслуговування рахунку', date: '2026-09-01' }),
  makeRecord({ id: 2, comment: 'Банківська комісія', cat: 76, op: 82, date: '2026-09-05' }),            // уже правильно
  makeRecord({ id: 3, comment: 'Прибирання офісу', date: '2026-09-30' }),
  makeRecord({ id: 4, comment: 'Банківська комісія', lead: true, is_manual: false, date: '2026-09-10' }), // з ліда
  makeRecord({ id: 5, comment: 'Банківська комісія', cat: 21, op: 31, date: '2026-09-11' }),            // зарплатна
  makeRecord({ id: 6, comment: 'Оплата США паспорт', date: '2026-09-12' }),                              // review
  makeRecord({ id: 7, comment: 'Банківська комісія за ЗП відділу', date: '2026-09-13' }),               // unless
  makeRecord({ id: 8, comment: 'Банківська комісія', date: '2026-10-01' }),                             // поза періодом
  makeRecord({ id: 9, comment: 'Прибирання', date: '2026-08-31' }),                                     // поза періодом
];

test('dry-run: пагінація, лічильник «отримано N із M», статуси', async () => {
  const { linter, progress, mock } = setup(RECS());
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(run.fetched, 7);
  const reads = progress.filter(p => p.stage === 'read');
  assert.equal(reads.at(-1).got, 7);
  assert.equal(reads.at(-1).total, 7);
  assert.equal(reads.length, 4); // 7 записів по 2 на сторінку
  const st = Object.fromEntries(run.results.map(r => [r.record.id, r.status]));
  assert.deepEqual(st, { 1: 'fix', 2: 'ok', 3: 'fix', 4: 'locked-auto', 5: 'manual-422', 6: 'review' });
  assert.ok(!mock.calls.some(c => c.method !== 'GET'), 'dry-run не змінює нічого');
});

test('підказки з історії: записи без правил, стаття інша, ніж зазвичай у того самого отримувача', async () => {
  const office = { cat: 57, op: 52 }, other = { cat: 59, op: 55 };
  const recs = [
    ...[1, 2, 3, 4].map(i => makeRecord({ id: 100 + i, comment: `ТОВ «Ромашка»: картриджі ${i}`, ...office, date: `2026-07-0${i}` })),
    makeRecord({ id: 105, comment: 'ТОВ Ромашка: папір', ...other, date: '2026-07-10' }),
    makeRecord({ id: 201, comment: 'ТОВ Ромашка: тонер', ...other, date: '2026-09-15' }),        // інша, ніж зазвичай → підказка
    makeRecord({ id: 202, comment: 'ТОВ Ромашка: фарба', ...office, date: '2026-09-16' }),       // уже звична — без підказки
    makeRecord({ id: 203, comment: 'ФОП Петренко: послуги', ...other, date: '2026-09-17' }),     // мало історії — без підказки
    makeRecord({ id: 204, comment: 'ФОП Петренко: послуги', ...office, date: '2026-08-17' }),
    makeRecord({ id: 205, comment: 'ТОВ Ромашка: тонер', ...office, date: '2026-09-18', lead: true, is_manual: false }), // лід: не підказується, але це історія
    makeRecord({ id: 206, comment: 'Прибирання офісу', ...other, date: '2026-09-19' }),          // спрацювало правило — не в rest
  ];
  const { linter } = setup(recs);
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(run.rest.map(r => r.id).sort(), [201, 202, 203]);
  assert.deepEqual(run.results.map(r => r.record.id), [206]);
  const M = require('../core/crm-model.js');
  const past = (await linter.fetchRecords('2026-05-04', '2026-09-30')).map(x => M.normalizeRecord(x, linter.live));
  const hints = L.historyHints(run.rest, past);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].rec.id, 201);
  assert.equal(hints[0].art, '57:52');
  assert.equal(hints[0].label, 'Офіс');
  assert.equal(hints[0].key, 'тов ромашка');
  assert.deepEqual([hints[0].k, hints[0].n], [6, 7]); // 101–104, 202, 205 з 7 інших
  // поріг частки: 4 з 6 (67 %) — без підказки
  assert.equal(L.historyHints(run.rest, past.filter(x => ![103, 104].includes(x.id)).concat(past.filter(x => x.id === 105).map(x => ({ ...x, id: 106 })))).length, 0);
});

test('підказки ШІ: що з записів без правил піде в Помічник — стаття, проєкт і статті схожих записів періоду', async () => {
  const office = { cat: 57, op: 52 }, other = { cat: 59, op: 55 };
  const recs = [
    makeRecord({ id: 301, comment: 'ТОВ Ромашка: тонер', ...other, date: '2026-09-15' }),
    makeRecord({ id: 302, comment: 'ТОВ Ромашка: фарба', ...office, date: '2026-09-16' }),
    makeRecord({ id: 303, comment: 'ТОВ Ромашка: папір', ...office, date: '2026-09-17' }),
    makeRecord({ id: 304, comment: 'Невідомий платіж', ...other, date: '2026-09-18' }),
    makeRecord({ id: 206, comment: 'Прибирання офісу', ...other, date: '2026-09-19' }), // спрацювало правило — не в rest
  ];
  const { linter } = setup(recs);
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const out = L.aiRecords(run.rest, run.results.map(r => r.record)), by = Object.fromEntries(out.map(x => [x.k, x]));
  const label = id => run.rest.find(r => r.id === id).category_label;
  assert.deepEqual(out.map(x => x.k).sort(), [301, 302, 303, 304]);
  assert.deepEqual([by[301].type, by[301].date, by[301].art, by[301].art_label, by[301].cmt], ['expense', '2026-09-15', '59:55', label(301), 'ТОВ Ромашка: тонер']);
  assert.equal(by[301].ccy, 'UAH');
  assert.ok(by[301].acc.length > 0);
  assert.deepEqual(by[301].same, [['Офіс', 2]]);            // інші записи «ТОВ Ромашка» — з «Офісом»
  assert.deepEqual(by[302].same, [[label(301), 1], ['Офіс', 1]]);
  assert.deepEqual(by[304].same, []);
  assert.ok(!('id' in by[301]) && !('raw' in by[301]));     // лише потрібні поля
});

test('HTTP 429: пауза й повтор, дані повні', async () => {
  const { linter, api } = setup(RECS(), { every429: 3 });
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(run.fetched, 7);
  assert.ok(api.stats().retries429 >= 2);
});

test('не частіше одного запиту на 300 мс', async () => {
  const mock = createMock({ records: RECS() });
  let t = 0;
  const waits = [];
  const api = L.makeApi(mock.rawFetch, { sleep: async ms => { waits.push(ms); t += ms; }, now: () => t });
  await api.get('currency'); await api.get('currency'); await api.get('currency');
  assert.deepEqual(waits, [300, 300]);
});

test('застосування: резервна копія → підтвердження → PUT → перечитування → журнал', async () => {
  const { linter, mock } = setup(RECS());
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const sel = new Set(run.results.filter(r => r.status === 'fix').map(r => r.record.id));
  const plan = linter.planChanges(run.results, sel);
  assert.deepEqual(plan.map(p => p.id).sort(), [1, 3]);
  let backup = null, info = null, journal = null;
  const out = await linter.apply(plan, { saveBackup: b => { backup = b; }, confirm: i => { info = i; return true; }, saveJournal: j => { journal = j; } });
  assert.equal(backup.records.length, 2);
  assert.equal(backup.records[0].comment.length > 0, true);              // повний вміст
  assert.equal(info.count, 2);
  assert.equal(info.sample.method, 'PUT');
  assert.equal(info.sample.url, `/api/invoice-payment/${plan[0].id}`);
  assert.deepEqual(info.sample.body, plan[0].body);
  assert.deepEqual(plan.find(p => p.id === 1).body, { pnl_category_id: '76', pnl_operation_id: '82' });
  assert.deepEqual(journal.map(e => e.result), ['ok', 'ok']);
  assert.equal(mock.db.get(1).payments[0].pnl_operation_id, 82);
  assert.equal(mock.db.get(3).payments[0].pnl_operation_id, 52);
  // лише дозволені поля, ніяких POST/DELETE
  for (const c of mock.calls.filter(c => c.method === 'PUT')) assert.deepEqual(Object.keys(c.body).sort().filter(k => !['pnl_category_id', 'pnl_operation_id', 'project_id'].includes(k)), []);
  assert.ok(!mock.calls.some(c => c.method === 'POST' || c.method === 'DELETE'));
  assert.equal(out.cancelled, false);
});

test('відмова в підтвердженні → жодного PUT', async () => {
  const { linter, mock } = setup(RECS());
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const plan = linter.planChanges(run.results, new Set([1, 3]));
  const out = await linter.apply(plan, { confirm: () => false });
  assert.equal(out.cancelled, true);
  assert.ok(!mock.calls.some(c => c.method === 'PUT'));
});

test('review застосовується лише при окремому виборі рядка; locked/422 — ніколи', async () => {
  const { linter } = setup(RECS());
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(linter.planChanges(run.results, new Set([1, 3])).map(p => p.id).sort(), [1, 3]);
  const withReview = linter.planChanges(run.results, new Set([1, 3, 6, 4, 5]));
  assert.deepEqual(withReview.map(p => p.id).sort(), [1, 3, 6]);
  assert.deepEqual(withReview.find(p => p.id === 6).body, { project_id: '4' });
});

test('ручна правка рядка (режим редагування)', async () => {
  const { linter, mock } = setup(RECS());
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const plan = linter.planChanges(run.results, new Set(), { 6: [{ field: 'category', to: { category_id: 57, operation_id: 52 } }], 4: [{ field: 'project', to: 4 }] });
  assert.deepEqual(plan.map(p => p.id), [6]); // запис з ліда не правиться навіть вручну
  assert.deepEqual(plan[0].ruleIds, ['РУЧНА ПРАВКА']);
  // узята «Підказка ШІ» — так і в плані й журналі
  assert.deepEqual(linter.planChanges(run.results, new Set(), { 6: [{ field: 'category', to: { category_id: 57, operation_id: 52 }, via: 'ai' }] })[0].ruleIds, ['ПІДКАЗКА ШІ']);
  const out = await linter.apply(plan, { confirm: () => true });
  assert.equal(out.journal[0].result, 'ok');
  assert.equal(mock.db.get(6).payments[0].pnl_category_id, 57);
});

test('вибір окремих змін запису: лише проєкт або лише стаття (fieldsById)', async () => {
  const both = { ...RULES, rules: [...RULES.rules, { id: 'R-USA-02', title: 'Офіс США → США', priority: 100, match: { text_any: ['офіс сша'] }, set: { project: 'США' } }] };
  const recs = [makeRecord({ id: 30, comment: 'Прибирання, офіс США', date: '2026-09-15' })];
  const { linter, mock } = setup(recs, {}, { rulesDoc: both });
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(run.results[0].changes.length, 2);
  const onlyPrj = linter.planChanges(run.results, new Set([30]), null, new Map([[30, new Set(['project'])]]));
  assert.deepEqual(onlyPrj.map(p => p.body), [{ project_id: '4' }]);
  assert.deepEqual(onlyPrj[0].ruleIds, ['R-USA-02']);
  const all = linter.planChanges(run.results, new Set([30]));
  assert.deepEqual(all[0].body, { pnl_category_id: '57', pnl_operation_id: '52', project_id: '4' });
  const out = await linter.apply(onlyPrj, { confirm: () => true });
  assert.equal(out.journal[0].result, 'ok');
  assert.equal(mock.db.get(30).project_id, 4);
  assert.equal(mock.db.get(30).payments[0].pnl_operation_id, 55); // стаття не змінилась
});

const RULES_FLOOR = { ...RULES, fix_from: '2026-09-05' };

test('межа fix_from: записи до неї — locked-date, без змін; навіть вибір і ручна правка їх не беруть', async () => {
  const { linter, mock } = setup(RECS(), {}, { rulesDoc: RULES_FLOOR });
  assert.equal(linter.fixFrom, '2026-09-05');
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const st = Object.fromEntries(run.results.map(r => [r.record.id, r.status]));
  assert.deepEqual(st, { 1: 'locked-date', 2: 'ok', 3: 'fix', 4: 'locked-auto', 5: 'manual-422', 6: 'review' });
  const r1 = run.results.find(r => r.record.id === 1);
  assert.deepEqual(r1.changes, []);
  assert.equal(r1.perRule['R-COMM-01'], 'locked-date');
  assert.match(r1.reasons[0], /до 05\.09\.2026/);
  assert.ok(L.summaryRows(run, linter.compiled).some(r => r[0] === 'R-COMM-01' && r[2] === 'locked-date'));
  const plan = linter.planChanges(run.results, new Set([1, 3]), { 1: [{ field: 'category', to: { category_id: 57, operation_id: 52 } }] });
  assert.deepEqual(plan.map(p => p.id), [3]);
  await linter.apply(plan, { confirm: () => true });
  assert.equal(mock.db.get(1).payments[0].pnl_operation_id, 55); // запис до межі не змінено
});

test('межа fix_from: якщо після звіту дату запису перенесли до межі — apply пропускає без запиту', async () => {
  const { linter, mock } = setup(RECS(), {}, { rulesDoc: RULES_FLOOR });
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const plan = linter.planChanges(run.results, new Set([3]));
  mock.touch(3, r => { r.date = new Date('2026-09-02T12:00:00+03:00').toISOString(); });
  const out = await linter.apply(plan, { confirm: () => true });
  assert.equal(out.journal[0].result, 'skipped-locked');
  assert.ok(!mock.calls.some(c => c.method === 'PUT'));
});

test('ignoreFixFrom (лише для аналізу): звіт без межі, але planChanges межу тримає', async () => {
  const { linter } = setup(RECS(), {}, { rulesDoc: RULES_FLOOR, ignoreFixFrom: true });
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(run.results.find(r => r.record.id === 1).status, 'fix');
  assert.deepEqual(linter.planChanges(run.results, new Set([1, 3])).map(p => p.id), [3]);
});

test('запис змінився після звіту → пропуск; 422 → manual-422; тиха відмова → verify-failed', async () => {
  const { linter, mock } = setup(RECS(), { put422: new Set([3]) });
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  mock.touch(1, r => { r.payments[0].pnl_category_id = 57; r.payments[0].pnl_operation_id = 52; });
  const out = await linter.apply(linter.planChanges(run.results, new Set([1, 3])), { confirm: () => true });
  const res = Object.fromEntries(out.journal.map(e => [e.id, e.result]));
  assert.deepEqual(res, { 1: 'skipped-changed', 3: 'manual-422' });

  const s2 = setup(RECS(), { ignorePut: true });
  const run2 = await s2.linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const out2 = await s2.linter.apply(s2.linter.planChanges(run2.results, new Set([1])), { confirm: () => true });
  assert.equal(out2.journal[0].result, 'verify-failed');
});

test('оновлення CRM 29.10.2026: закритий місяць (422 errors.period) → closed-period з текстом CRM, решта змінюється', async () => {
  const { linter, mock } = setup(RECS(), { closedMonths: new Set(['2026-09']) });
  const run = await linter.run({ from: '2026-09-01', to: '2026-10-31' });
  const out = await linter.apply(linter.planChanges(run.results, new Set([1, 3, 8])), { confirm: () => true });
  assert.deepEqual(Object.fromEntries(out.journal.map(e => [e.id, e.result])), { 1: 'closed-period', 3: 'closed-period', 8: 'ok' });
  assert.match(out.journal.find(e => e.id === 1).problems.join(), /«Місяць закрито\. Внесіть операцію в новий відкритий період»\): змінити запис закритого місяця може лише Адмін/);
  assert.equal(out.journal.find(e => e.id === 1).http, 422);
  assert.equal(mock.db.get(8).payments[0].pnl_operation_id, 82);
  assert.equal(mock.db.get(1).payments[0].pnl_operation_id, 55);
  assert.deepEqual(out.backup.applied, [8]);
});

test('оновлення CRM 29.10.2026: без «Повного редагування» (403) → no-rights, решту запитів не надіслано', async () => {
  const { linter, mock } = setup(RECS(), { noFullEdit: true });
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const out = await linter.apply(linter.planChanges(run.results, new Set([1, 3])), { confirm: () => true });
  assert.deepEqual(out.journal.map(e => e.result), ['no-rights', 'skipped-rights']);
  assert.match(out.journal[0].problems.join(), /«Недостатньо прав для виконання цієї дії» — потрібне право «Повне редагування операцій Cash Flow»/);
  assert.equal(mock.calls.filter(c => c.method === 'PUT').length, 1);
  assert.deepEqual(out.backup.applied, []);
  // відкат так само: перша відмова в правах — решта не надсилається
  const backup = { kind: 'cashflow-linter-backup', created_at: new Date().toISOString(), records: [mock.db.get(1), mock.db.get(3)].map(r => JSON.parse(JSON.stringify(r))),
    changes: { 1: { fields: ['category'], body: { pnl_category_id: '59', pnl_operation_id: '55' } }, 3: { fields: ['category'], body: { pnl_category_id: '59', pnl_operation_id: '55' } } } };
  backup.records.forEach(r => { r.payments[0].pnl_category_id = 57; r.payments[0].pnl_operation_id = 52; });
  const rb = await linter.rollback(backup, { confirm: () => true });
  assert.deepEqual(rb.journal.map(e => e.result), ['no-rights', 'skipped-rights']);
});

test('відкат запису, місяць якого вже закрили → closed-period, запис не змінено', async () => {
  const closedMonths = new Set();
  const { linter, mock } = setup(RECS(), { closedMonths });
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  let backup;
  await linter.apply(linter.planChanges(run.results, new Set([1])), { saveBackup: b => { backup = JSON.parse(JSON.stringify(b)); }, confirm: () => true });
  closedMonths.add('2026-09');
  const rb = await linter.rollback(backup, { confirm: () => true });
  assert.deepEqual(rb.journal.map(e => e.result), ['closed-period']);
  assert.equal(mock.db.get(1).payments[0].pnl_operation_id, 82);
});

test('закриті місяці: перша відмова CRM запам’ятовує межу, решта місяця не надсилається; далі ці записи — лише довідка', async () => {
  let closed = null;
  const learned = [];
  const { linter, mock } = setup(RECS(), { closedMonths: new Set(['2026-09']) }, { closedThrough: () => closed, onClosed: m => { learned.push(m); closed = m; } });
  const run = await linter.run({ from: '2026-09-01', to: '2026-10-31' });
  assert.equal(run.results.find(r => r.record.id === 1).status, 'fix'); // поки межі не знаємо — вересень перевіряється
  const out = await linter.apply(linter.planChanges(run.results, new Set([1, 3, 8])), { confirm: () => true });
  assert.deepEqual(learned, ['2026-09']);
  assert.deepEqual(Object.fromEntries(out.journal.map(e => [e.id, e.result])), { 8: 'ok', 3: 'closed-period', 1: 'skipped-closed' });
  assert.match(out.journal.find(e => e.id === 1).problems.join(), /місяць 09\.2026 закрито в CRM — запит не надсилався/);
  assert.equal(mock.calls.filter(c => c.method === 'PUT').length, 2); // жовтень і одна відмова, без зайвих запитів
  const run2 = await linter.run({ from: '2026-09-01', to: '2026-10-31' });
  const st = Object.fromEntries(run2.results.map(r => [r.record.id, r.status]));
  assert.deepEqual([st[1], st[3], st[6]], ['locked-date', 'locked-date', 'locked-date']);
  assert.equal(st[8], 'ok');
  assert.match(run2.results.find(r => r.record.id === 1).reasons[0], /^місяць 09\.2026 закрито в CRM — лише довідка/);
  assert.deepEqual(linter.planChanges(run2.results, new Set([1, 3, 6]), { 6: [{ field: 'project', to: 4 }] }), []); // навіть ручна правка
});

test('модель: закриті місяці — місяць з періоду, перший відкритий день', () => {
  const M = require('../core/crm-model.js');
  assert.equal(M.monthOf('2026-10-01'), '2026-10');
  assert.equal(M.monthOf('01-10-2026'), '2026-10');
  assert.equal(M.monthOf('01.10.2026'), '2026-10');
  assert.equal(M.monthOf('27-10-2026 00:00'), '2026-10');
  assert.equal(M.monthOf('2026-10'), '2026-10');
  assert.equal(M.monthOf('2026-09-30T21:00:00.000000Z'), null); // сира дата API — спершу kyivDate (це вже 01.10 за Києвом)
  assert.equal(M.monthOf(null), null);
  assert.equal(M.openFrom('2026-10'), '2026-11-01');
  assert.equal(M.openFrom('2026-12-01'), '2027-01-01');
  assert.equal(M.openFrom(null), null);
  assert.ok(M.isClosedMonth('2026-09-01', '2026-10') && M.isClosedMonth('01-10-2026', '2026-10'));
  assert.ok(!M.isClosedMonth('2026-11-01', '2026-10') && !M.isClosedMonth('2026-09-01', null) && !M.isClosedMonth(null, '2026-10'));
  assert.equal(M.monthUa('01-10-2026'), '10.2026');
});

test('модель: відмови CRM з оновлення 29.10.2026 і права з профілю користувача', () => {
  const M = require('../core/crm-model.js');
  const CL = 'Місяць закрито. Внесіть операцію в новий відкритий період';
  const closed = { status: 422, json: { message: CL, errors: { period: [CL] } } };
  assert.deepEqual(M.crmFailure(closed), { kind: 'closed', message: CL });
  assert.deepEqual(M.crmFailure({ status: 422, json: { errors: { period: [] } } }), { kind: 'closed', message: M.CLOSED_PERIOD_MESSAGE });
  assert.deepEqual(M.crmFailure({ status: 403, json: null, text: '' }), { kind: 'rights', message: 'Недостатньо прав для виконання цієї дії' });
  assert.deepEqual(M.crmFailure({ status: 422, json: { message: 'The amount field is required.', errors: { amount: ['The amount field is required.'], date: ['bad date'] } } }),
    { kind: 'invalid', message: 'The amount field is required.; bad date' });
  assert.deepEqual(M.crmFailure({ status: 422, json: { message: 'Операції по зарплаті не доступні' } }), { kind: 'invalid', message: 'Операції по зарплаті не доступні' });
  assert.deepEqual(M.crmFailure({ status: 500, json: null, text: '<html>oops</html>' }), { kind: 'error', message: '<html>oops</html>' });
  const post = M.crmError(closed, 'post'), put = M.crmError(closed, 'put'), rights = M.crmError({ status: 403, json: { message: 'Forbidden' } }, 'put');
  assert.equal(post.kind, 'closed');
  assert.match(post.message, /^місяць закрито в CRM \(«Місяць закрито\.[^»]+»\): внесіть операцію з періодом відкритого місяця$/);
  assert.match(put.message, /може лише Адмін$/);
  assert.equal(rights.kind, 'rights');
  assert.equal(rights.message, 'CRM: «Forbidden» — потрібне право «Повне редагування операцій Cash Flow»');
  assert.equal(M.crmError({ status: 500, json: { message: 'Server Error' } }, 'post').message, 'CRM відповів HTTP 500: Server Error');
  assert.deepEqual(M.cashflowRights({ role: { name: 'бухгалтер' }, permissions: { invoice: { operation_edit: 1, operation_full_edit: 1 } } }), { full: true, edit: true, role: 'бухгалтер' });
  assert.deepEqual(M.cashflowRights({ data: { permissions: { invoice: { operation_edit: '1' } } } }), { full: false, edit: true, role: '' });
  assert.deepEqual(M.cashflowRights({ permissions: { invoice: {} } }), { full: false, edit: false, role: '' });
  assert.equal(M.cashflowRights({ id: 5 }), null);
  assert.equal(M.cashflowRights(null), null);
  assert.match(M.noFullText({ role: 'менеджер' }), /^У вашої ролі «менеджер» немає права «Повне редагування операцій Cash Flow»/);
  assert.match(M.noFullText(null), /^У вашої ролі немає права/);
});

test('відкат з резервної копії', async () => {
  const { linter, mock } = setup(RECS());
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  let backup;
  await linter.apply(linter.planChanges(run.results, new Set([1, 3])), { saveBackup: b => { backup = JSON.parse(JSON.stringify(b)); }, confirm: () => true });
  assert.equal(mock.db.get(1).payments[0].pnl_operation_id, 82);
  const rb = await linter.rollback(backup, { confirm: () => true });
  assert.deepEqual(rb.journal.map(e => e.result), ['ok', 'ok']);
  assert.equal(mock.db.get(1).payments[0].pnl_operation_id, 55);
  assert.equal(mock.db.get(3).payments[0].pnl_category_id, 59);
  // повторний відкат: запис уже не в стані «після лінтера» → пропуск
  const rb2 = await linter.rollback(backup, { confirm: () => true });
  assert.deepEqual(rb2.journal.map(e => e.result), ['skipped-changed', 'skipped-changed']);
});

test('відкат запису, що до лінтера був без проєкту: «повернути вручну», решта відкочується', async () => {
  const recs = [...RECS(), makeRecord({ id: 20, comment: 'Оплата США паспорт', project_id: null, date: '2026-09-20' })];
  const { linter, mock } = setup(recs);
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  let backup;
  await linter.apply(linter.planChanges(run.results, new Set([1, 20])), { saveBackup: b => { backup = JSON.parse(JSON.stringify(b)); }, confirm: () => true });
  assert.equal(mock.db.get(20).project_id, 4);
  const rb = await linter.rollback(backup, { confirm: () => true });
  const res = Object.fromEntries(rb.journal.map(e => [e.id, e.result]));
  assert.deepEqual(res, { 1: 'ok', 20: 'manual' });
  assert.match(rb.journal.find(e => e.id === 20).problems.join(), /вручну/);
  assert.equal(mock.db.get(1).payments[0].pnl_operation_id, 55);
});

test('довідник CRM не збігається з rules.json → зупинка до читання записів', async () => {
  const bad = JSON.parse(JSON.stringify(RULES));
  bad.reference.articles[1].category = 'Офіс і господарство'; // правила компілюються, але в CRM інша назва
  const { mock } = setup(RECS());
  const api = L.makeApi(mock.rawFetch, { minInterval: 0, sleep: async () => {} });
  const linter = L.createLinter({ api, rulesDoc: bad });
  await assert.rejects(linter.run({ from: '2026-09-01', to: '2026-09-30' }), /не збігається/);
  assert.ok(!mock.calls.some(c => c.path.startsWith('invoice-payment')));
});

test('звіт: колонки ТЗ і підсумок по правилах', async () => {
  const { linter } = setup(RECS());
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const rows = L.reportRows(run, linter.live);
  assert.deepEqual(rows[0].slice(0, 5), ['ID запису', 'Дата', 'Рахунок', 'Сума', 'Валюта']);
  assert.ok(rows[0].includes('Очікувана стаття') && rows[0].includes('Очікуваний проєкт') && rows[0].includes('Статус'));
  const r1 = rows.find(r => r[0] === 1);
  assert.equal(r1[1], '2026-09-01');
  assert.equal(r1[7], 'Інші витрати');
  assert.equal(r1[10], 'Адміністративні витрати / Комісії платіжних систем');
  const sum = L.summaryRows(run, linter.compiled);
  const comm = sum.filter(r => r[0] === 'R-COMM-01');
  assert.deepEqual(comm.map(r => [r[2], r[3]]), [['fix', 1], ['manual-422', 1], ['locked-auto', 1], ['ok', 1]]);
});

test('київська дата на межі переходу на зимовий час (25.10.2026)', () => {
  const M = require('../core/crm-model.js');
  assert.equal(M.kyivDate('2026-10-24T20:59:00Z'), '2026-10-24'); // 23:59 літнього часу
  assert.equal(M.kyivDate('2026-10-24T21:30:00Z'), '2026-10-25'); // 00:30 (UTC+3)
  assert.equal(M.kyivDate('2026-10-25T21:30:00Z'), '2026-10-25'); // 23:30 зимового часу (UTC+2)
  assert.equal(M.kyivDate('2026-10-25T22:30:00Z'), '2026-10-26');
  assert.equal(M.kyivDate('2026-03-28T22:30:00Z'), '2026-03-29'); // 00:30 (UTC+2, до переходу)
  assert.match(M.kyivNow(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

// ---------- за незалежним рев'ю ----------
const setCat = (cat, op) => r => { r.payments[0].pnl_category_id = cat; r.payments[0].pnl_operation_id = op; };

test('скасування в підтвердженні: резервна копія не зберігається', async () => {
  const { linter, mock } = setup(RECS());
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  let saved = 0;
  const out = await linter.apply(linter.planChanges(run.results, new Set([1, 3])), { saveBackup: () => { saved++; }, confirm: () => false });
  assert.equal(out.cancelled, true);
  assert.equal(saved, 0);
  assert.ok(!mock.calls.some(c => c.method === 'PUT'));
});

test('запис змінили, поки було відкрите вікно підтвердження → пропуск без PUT, зміну колеги збережено', async () => {
  const { linter, mock } = setup(RECS());
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const out = await linter.apply(linter.planChanges(run.results, new Set([1, 3])), { confirm: () => { mock.touch(1, setCat(57, 52)); return true; } });
  assert.deepEqual(Object.fromEntries(out.journal.map(e => [e.id, e.result])), { 1: 'skipped-changed', 3: 'ok' });
  assert.ok(!mock.calls.some(c => c.method === 'PUT' && c.path === 'invoice-payment/1'));
  assert.equal(mock.db.get(1).payments[0].pnl_operation_id, 52);
  assert.deepEqual(out.backup.applied, [3]);
});

test('повторне застосування застарілого плану нічого не змінює, а відкат з такої копії нічого не «повертає»', async () => {
  const { linter, mock } = setup(RECS());
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const plan = linter.planChanges(run.results, new Set([1, 3]));
  await linter.apply(plan, { confirm: () => true });
  const puts = mock.calls.filter(c => c.method === 'PUT').length;
  const out2 = await linter.apply(plan, { confirm: () => true });
  assert.deepEqual(out2.journal.map(e => e.result), ['skipped-changed', 'skipped-changed']);
  assert.equal(mock.calls.filter(c => c.method === 'PUT').length, puts);
  assert.deepEqual(out2.backup.applied, []);
  const fileStyle = JSON.parse(JSON.stringify(out2.backup));
  delete fileStyle.applied; // у файлі копії списку змінених немає
  const rb = await linter.rollback(fileStyle, { confirm: () => true });
  assert.deepEqual(rb.journal.map(e => e.result), ['skipped-nochange', 'skipped-nochange']);
  assert.equal(mock.db.get(1).payments[0].pnl_operation_id, 82); // зміну лінтера не «відкочено» на саму себе
});

test('відкат за списком «applied»: лише записи, які лінтер справді змінив', async () => {
  const { linter, mock } = setup(RECS(), { put422: new Set([3]) });
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const out = await linter.apply(linter.planChanges(run.results, new Set([1, 3])), { confirm: () => true });
  assert.deepEqual(out.backup.applied, [1]);
  mock.touch(3, setCat(57, 52)); // людина сама поставила «Офіс»
  const rb = await linter.rollback(JSON.parse(JSON.stringify(out.backup)), { confirm: () => true });
  assert.deepEqual(rb.journal.map(e => [e.id, e.result]), [[1, 'ok']]);
  assert.equal(mock.db.get(3).payments[0].pnl_operation_id, 52);
  assert.equal(mock.db.get(1).payments[0].pnl_operation_id, 55);
});

test('відкат помічає зміну категорії при тому самому id статті', async () => {
  const { linter, mock } = setup(RECS());
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const out = await linter.apply(linter.planChanges(run.results, new Set(), { 3: [{ field: 'category', to: { category_id: 47, operation_id: 31 } }] }), { confirm: () => true });
  assert.equal(out.journal[0].result, 'ok');
  mock.touch(3, setCat(59, 31)); // інша категорія, той самий id статті
  const rb = await linter.rollback(JSON.parse(JSON.stringify(out.backup)), { confirm: () => true });
  assert.equal(rb.journal[0].result, 'skipped-changed');
});

test('не вдалося прочитати запис для резервної копії → він не змінюється, решта — так', async () => {
  const { linter, mock } = setup(RECS(), { failGet: p => p === 'invoice-payment/1' });
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  let unread = null;
  const out = await linter.apply(linter.planChanges(run.results, new Set([1, 3])), { confirm: i => { unread = i.unread; return true; } });
  assert.equal(unread, 1);
  assert.deepEqual(Object.fromEntries(out.journal.map(e => [e.id, e.result])), { 1: 'error', 3: 'ok' });
  assert.ok(!mock.calls.some(c => c.method === 'PUT' && c.path === 'invoice-payment/1'));
});

test('перед PUT — нова перевірка: став зарплатним → manual-422 без запиту; правило вже не діє → пропуск', async () => {
  const { linter, mock } = setup(RECS());
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const out = await linter.apply(linter.planChanges(run.results, new Set([1, 6])), { confirm: () => {
    mock.touch(6, setCat(21, 31));                       // зміна лише проєкту, але запис став зарплатним
    mock.touch(1, r => { r.comment = 'Оплата хостингу'; }); // правило про комісію вже не спрацьовує
    return true;
  } });
  assert.deepEqual(Object.fromEntries(out.journal.map(e => [e.id, e.result])), { 1: 'skipped-changed', 6: 'manual-422' });
  assert.ok(!mock.calls.some(c => c.method === 'PUT'));
});

test('модель: «ручний» лише з явним is_manual = true; перевірка після PUT ловить зміну полів поза запитом', () => {
  const M = require('../core/crm-model.js');
  for (const v of [false, null, 0, '0']) assert.equal(M.normalizeRecord(makeRecord({ id: 1, is_manual: v }), null).is_auto, true, String(v));
  const noField = makeRecord({ id: 1 });
  delete noField.is_manual;
  assert.equal(M.normalizeRecord(noField, null).is_auto, true);
  assert.equal(M.normalizeRecord(makeRecord({ id: 1, is_manual: true }), null).is_auto, false);
  const before = makeRecord({ id: 2 }), after = JSON.parse(JSON.stringify(before));
  after.payments[0].pnl_category_id = 76; after.payments[0].pnl_operation_id = 82; after.project_id = 3;
  const v = M.verifyUpdate(before, after, { pnl_category_id: '76', pnl_operation_id: '82' });
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /змінився проєкт/);
});

test('експорт: CSV не виконує формули, у xlsx немає недопустимих символів', () => {
  const X = require('../core/xlsx.js');
  const csv = X.toCsv([['-30+65=95', '=SUM(A1)', -30.5, 'текст']]);
  assert.ok(csv.includes("'-30+65=95") && csv.includes("'=SUM(A1)") && csv.includes(';-30,5;'));
  const z = Buffer.from(X.buildXlsx([{ name: 'a', rows: [['h'], ['x￾y￿']] }]));
  assert.ok(!z.includes(Buffer.from('￾')) && !z.includes(Buffer.from('￿')));
});

test('makeApi: читання повторюється після збою мережі й 502 (1, 3, 8 с), запис — ні; одночасні виклики не стартують разом', async () => {
  let t = 0, n = 0;
  const waits = [], starts = [];
  const sleep = async ms => { waits.push(ms); t += ms; };
  const flaky = async (method) => { n++; if (n === 1) throw new TypeError('Failed to fetch'); if (n === 2) return { status: 502 }; return { status: 200, json: { ok: method } }; };
  const api = L.makeApi(flaky, { minInterval: 0, sleep, now: () => t });
  assert.deepEqual(await api.get('x'), { ok: 'GET' });
  assert.deepEqual(waits, [1000, 3000]);
  n = 0;
  await assert.rejects(api.post('x', {}), /Failed to fetch/);
  // черга: три одночасні виклики — кожен у своєму місці черги (щонайменше k × minInterval від першого; таймер може спізнитись,
  // тож між сусідніми буває й менше — під навантаженням тест через це інколи падав)
  const api2 = L.makeApi(async () => { starts.push(Date.now()); return { status: 200, json: {} }; }, { minInterval: 30 }); // справжній час
  await Promise.all([api2.get('a'), api2.get('b'), api2.get('c')]);
  assert.ok(starts[1] - starts[0] >= 25 && starts[2] - starts[0] >= 55, starts.map(s => s - starts[0]).join(','));
});
// огляд 16.11.2026: межа fix_from — і за періодом запису (01–05.09.2026 з періодом 08.2026 — старе правило «з 1 по 5 число — попередній місяць»)
test('межа fix_from: запис з датою в межах роботи, але з періодом старого місяця — locked-date, без змін і без PUT', async () => {
  const FLOOR = { ...RULES, fix_from: '2026-09-01' };
  const aug = r => { r.period = new Date('2026-08-01T00:00:00+03:00').toISOString(); return r; };
  const recs = [aug(makeRecord({ id: 1, comment: 'Банківська комісія за обслуговування рахунку', date: '2026-09-03' })), makeRecord({ id: 3, comment: 'Прибирання офісу', date: '2026-09-04' })];
  const { linter, mock } = setup(recs, {}, { rulesDoc: FLOOR });
  const run = await linter.run({ from: '2026-09-01', to: '2026-09-30' });
  const r1 = run.results.find(r => r.record.id === 1);
  assert.equal(r1.status, 'locked-date'); // до виправлення — 'fix': зміна статті рухала P&L серпня
  assert.match(r1.reasons[0], /^період 08\.2026 — до 01\.09\.2026 — межа роботи лінтера/);
  assert.equal(run.results.find(r => r.record.id === 3).status, 'fix'); // період вересня — як раніше
  const plan = linter.planChanges(run.results, new Set([1, 3]), { 1: [{ field: 'category', to: { category_id: 57, operation_id: 52 } }] });
  assert.deepEqual(plan.map(p => p.id), [3]);
  // період перенесли в старий місяць уже після звіту — apply пропускає без запиту
  mock.touch(3, r => aug(r));
  const out = await linter.apply(plan, { confirm: () => true });
  assert.equal(out.journal[0].result, 'skipped-locked');
  assert.match(out.journal[0].problems.join(), /період 08\.2026/);
  assert.ok(!mock.calls.some(c => c.method === 'PUT'));
});
