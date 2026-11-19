// Огляд 16.11.2026 — зручність «Звірки з банком» і «Статей і проєктів»: вікно підтвердження створення, підсумок біля кнопки,
// фільтр статусів і спільний період пам'ятаються, «І для ще N таких самих», проєкт з історії рахунку, журнал до відповіді CRM,
// тип статті в «Підказках ШІ». Кожен сценарій падав на коді до виправлення.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, rec, tx, bankJson } = require('./lib/panel-harness.js');
const LP = require('../ui/linter-panel.js');
const M = require('../core/crm-model.js');
const plain = s => String(s).replace(/[  ]/g, ' ');
const tick = () => new Promise(r => setTimeout(r, 30));
const today = () => M.kyivNow().slice(0, 10);

const ACC = [{ id: 5, name: 'ФОП Хоменко Всеволод Приват 1234', currency_id: 1, balance: 100000, deleted_at: null }];
// три оплати одному контрагенту (правил і історії для них немає) і одна — іншому
const PAYS = [[-1000, 'ФОП Іваненко Петро'], [-2000, 'ФОП Іваненко Петро'], [-3000.5, 'ФОП Іваненко Петро'], [-700, 'ТОВ Інша Фірма']];
const bank = (list = PAYS) => bankJson([{ acc: 'UA000000000000000000000001234', ccy: 'UAH', name: 'ФОП Хоменко Всеволод Сергійович', client: 'ФОП Хоменко', opening: 100000,
  closing: 100000 + list.reduce((s, x) => s + x[0], 0), transactions: list.map(([s, who], i) => tx(`1${i}.10.2026`, s, 'Оплата послуг за жовтень', 'UA_I' + who.length, who)) }]);
const keysOf = (r, who) => r.S.lastRecs.filter(p => p.row.cpty === who).map(p => p.key);

test('«Внести в CRM»: стаття, вибрана в рядку, пропонується таким самим операціям — кнопкою, без галочок і не мовчки', async () => {
  const r = await run({ accounts: ACC, records: [], banks: [bank()], create: true });
  assert.deepEqual(r.errors, []);
  const same = keysOf(r, 'ФОП Іваненко Петро'), other = keysOf(r, 'ТОВ Інша Фірма');
  assert.equal(same.length, 3);
  assert.ok(!r.out.includes('data-rsame'), 'до вибору статті кнопки немає');
  r.P.act.recPickArt(same[0], '62/66'); // те саме, що робить список статей у рядку
  assert.ok(r.out.includes('І для ще 2 таких самих'), 'кнопка в рядку, де вибрали статтю');
  assert.deepEqual(same.map(k => r.S.rp.get(k).art), ['62/66', '', ''], 'сама по собі стаття нікуди не розноситься');
  r.P.act.recSpreadArt(same[0]);
  assert.deepEqual(same.map(k => r.S.rp.get(k).art), ['62/66', '62/66', '62/66']);
  assert.deepEqual(same.concat(other).map(k => r.S.rp.get(k).on), [false, false, false, false], 'галочок кнопка не ставить');
  assert.equal(r.S.rp.get(other[0]).art, '', 'інший контрагент — без статті');
  assert.ok(!r.out.includes('data-rsame') && r.txt.includes('та сама стаття, що ви вибрали для такої самої операції'));
});

test('«Створити позначені»: у вікні спершу підсумок і весь перелік словами, поля запиту — згорнуто; підсумок зробленого — над списком, хід — на кнопці', async () => {
  const seen = [];
  const r = await run({ accounts: ACC, records: [], banks: [bank()], drafts: [], draftMode: true, create: true,
    onPost: () => seen.push(JSON.parse(localStorage.getItem('cfl_rec_journal') || '[]').map(e => [e.amount, e.result])) });
  const keys = keysOf(r, 'ФОП Іваненко Петро');
  keys.forEach(k => Object.assign(r.S.rp.get(k), { art: '62/66', ta: true, on: true }));
  const btn = r.$('out').querySelector('[data-b="rcreate"]');
  await r.click('rcreate');
  const d = r.dialogs[0].html, head = plain(d.split('<details')[0]);
  assert.match(head, /Разом:<\/b> витрати — 3 на 6 000,50 грн/);
  for (const s of ['1 000,00', '2 000,00', '3 000,50']) assert.ok(head.includes(`витрата ${s}`), `рядок ${s} — у відкритому переліку`);
  assert.ok(!head.includes('pnl_category_id') && /<details><summary>Технічно: запит до CRM<\/summary>/.test(d), 'поля запиту — під «Технічно»');
  assert.ok(d.includes('3 запити (по одному на запис)') && d.includes('POST /api/invoice-payment-drafts'));
  assert.equal(r.posts.length, 3);
  // журнал у браузері — ще до відповіді CRM: під час кожного POST його запис уже там
  assert.deepEqual(seen.map(j => j[j.length - 1]), [[1000, 'перевірте'], [2000, 'перевірте'], [3000.5, 'перевірте']]);
  assert.equal(btn.textContent, 'Створюю 3 з 3…');
  // підсумок — у розділі «Внести в CRM», а не лише в повідомленнях угорі вкладки
  assert.ok(/data-b="done"/.test(r.out) && r.txt.includes('Щойно: Записи з виписки: зроблено й перевірено — 3.'), r.txt.slice(0, 400));
  assert.deepEqual(r.errorsNow, []);
});

test('«Рахунки»: фільтр статусів пам\'ятається; розбіжність на початку завжди видно й стоїть у групі першою', async () => {
  const acc = [{ id: 5, name: 'Приват ФОП Антонов Іван 1234', currency_id: 1, balance: 100000, deleted_at: null },
    { id: 6, name: 'Приват ФОП Ярошенко Емілія 5678', currency_id: 1, balance: 50000, deleted_at: null },
    { id: 7, name: 'Приват ФОП Без Виписки 9999', currency_id: 1, balance: 0, deleted_at: null }];
  const mk = (iban, name, open, list) => ({ acc: iban, ccy: 'UAH', name, client: name, opening: open, closing: open + list.reduce((s, x) => s + x, 0),
    transactions: list.map(s => tx('10.10.2026', s, 'Оплата послуг за жовтень', 'UA_I', 'ФОП Іваненко Петро')) });
  const banks = () => [bankJson([mk('UA000000000000000000000001234', 'ФОП Антонов Іван Іванович', 100000, []), mk('UA000000000000000000000005678', 'ФОП Ярошенко Емілія Юріївна', 50500, [-500])])];
  const a = await run({ accounts: acc, records: [], banks: banks() });
  assert.deepEqual(a.errors, []);
  const st = id => a.S.lastAll.find(x => x.a.id === id).status;
  assert.deepEqual([st(5), st(6), st(7)], ['ok', 'bad', 'none']);
  const order = h => [...h.matchAll(/<tr data-acc="(\d+)"/g)].map(m => +m[1]);
  assert.deepEqual(order(a.out).slice(0, 2), [6, 5], 'розбіжність — перед «сходиться», хоч за назвою вона друга');
  a.P.act.stToggle('none'); // те саме, що натиснути статус «немає даних банку»
  assert.deepEqual(order(a.out), [6, 5]);
  assert.ok(a.txt.includes('Показано 2 з 3 — вибір пам\'ятається.') && /data-b="stall"/.test(a.out));
  // панель відкрили знову
  const b = await run({ accounts: acc, records: [], banks: banks(), keepStore: true });
  assert.ok(!b.S.filter.has('none'), 'сховане «немає даних банку» лишається схованим');
  assert.deepEqual(order(b.out), [6, 5]);
  b.P.act.stToggle(null); // «Показати всі»
  assert.equal(order(b.out).length, 3);
  // запам'ятаний фільтр без «розбіжності» нову розбіжність не сховає
  const c = await run({ accounts: acc, records: [], banks: banks(), ls: { cfl_bank_filter: ['ok'] } });
  assert.ok(c.S.filter.has('bad') && c.S.filter.has('part') && !c.S.filter.has('none'));
});

test('спільний період: звірений сьогодні період панель ставить сама при наступному відкритті; іншого дня — сьогодні', async () => {
  const a = await run({ accounts: ACC, records: [], banks: [bank()], from: '2026-10-05', to: '2026-10-20' });
  const saved = JSON.parse(localStorage.getItem('cfl_period'));
  assert.deepEqual([saved.from, saved.to, saved.day, saved.by], ['2026-10-05', '2026-10-20', today(), 'bank']);
  assert.deepEqual([LP.sharedPeriod().from, LP.sharedPeriod().to], ['2026-10-05', '2026-10-20'], '«Статті й проєкти» бачать той самий період');
  const b = await run({ accounts: ACC, records: [], banks: [bank()], keepStore: true, keepPeriod: true });
  assert.deepEqual([b.S.from, b.S.to], ['2026-10-05', '2026-10-20']); // до виправлення — сьогодні
  // період, перевірений тим часом у «Статтях і проєктах», — у поля дат, коли вкладку показано знову; сама звірка не перезапускається
  const n = b.calls.length;
  LP.savePeriod('2026-10-07', '2026-10-09', 'cat');
  b.P.syncPeriod();
  assert.deepEqual([b.$('from').value, b.$('to').value, b.S.from, b.calls.length], ['2026-10-07', '2026-10-09', '2026-10-05', n]);
  assert.match(b.$('st').textContent, /як у «Статтях і проєктах»/);
  // учорашній запам'ятаний період не відновлюється
  const c = await run({ accounts: ACC, records: [], banks: [bank()], keepPeriod: true, ls: { cfl_period: { from: '2026-10-05', to: '2026-10-20', day: '2026-01-01', by: 'bank', n: 1 } } });
  assert.equal(c.S.from === '2026-10-05', false);
  assert.equal(LP.sharedPeriod().day, today());
});

test('«Внести в CRM»: проєкт нового запису — з історії рахунку, коли її прочитано після першого показу, а не «останній вибраний»', async () => {
  const hist = [1, 2, 3].map(i => ({ ...rec(900 + i, '2026-09-1' + i, [[5, 2, 100 * i]], 'ФОП Іваненко: послуги'), project_id: 4 }));
  const r = await run({ accounts: ACC, records: [], banks: [bank(PAYS.slice(0, 1))], hist, ls: { cfl_rec_proj: 3 } });
  await tick(); await tick();
  assert.deepEqual(r.errorsNow, []);
  assert.ok(r.S.hist.has(5) && r.S.hist.get(5).length === 3, 'історію рахунку прочитано');
  assert.equal(r.S.rp.get(r.S.lastRecs[0].key).proj, 4); // до виправлення — 3 (проєкт, вибраний колись в іншому рядку)
});

test('«Статті й проєкти»: тип статті з підказки ШІ; позначені зміни й «Закриття місяця»', () => {
  const income = { category_id: 45, operation_id: 21, type: 1 }, expense = { category_id: 57, operation_id: 52, type: 2 };
  assert.equal(LP.artTypeOk(income, 'expense'), false, 'дохідну статтю витраті не пропонуємо');
  assert.equal(LP.artTypeOk(expense, 'income'), false);
  assert.ok(LP.artTypeOk(expense, 'expense') && LP.artTypeOk(income, 'income'));
  assert.ok(LP.artTypeOk({ category_id: 1, operation_id: 2 }, 'expense') && LP.artTypeOk(expense, 'transfer'), 'тип невідомий — не перевіряється');
  assert.equal(LP.artTypeOk(undefined, 'expense'), false);
  // є позначені, але не застосовані зміни — перевірка місяця їх не стирає (рахується окремо)
  assert.equal(LP.hasPendingWork({ editMode: true, applyDone: false, selected: 2, manual: 0 }), true);
  assert.equal(LP.hasPendingWork({ editMode: true, applyDone: false, selected: 0, manual: 1 }), true);
  assert.equal(LP.hasPendingWork({ editMode: true, applyDone: true, selected: 2, manual: 1 }), false);
  assert.equal(LP.hasPendingWork({ editMode: false, applyDone: false, selected: 0, manual: 0 }), false);
});
