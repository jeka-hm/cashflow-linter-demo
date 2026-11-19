// Тести рушія правил (без CRM): регулярні вирази, імена, дати, конфлікти, статуси.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../core/rules-engine.js');

const REF = {
  version: 't',
  reference: {
    articles: [
      { group: 'Адміністративні витрати', category: 'Комісії платіжних систем', category_id: 76, name: 'Комісії платіжних систем', operation_id: 82 },
      { group: 'Адміністративні витрати', category: 'Офіс', category_id: 57, name: 'Офіс', operation_id: 52 },
      { group: 'Адміністративні витрати', category: 'Інші витрати', category_id: 59, name: 'Інші витрати', operation_id: 55 },
      { group: 'Продажі та маркетинг', category: 'Інші витрати', category_id: 48, name: 'Інші витрати', operation_id: 32 },
      { group: 'Продажі та маркетинг', category: 'ЗП відділу продажів', category_id: 55, name: 'ЗП відділу продажів', operation_id: 47 },
    ],
    projects: { 'Україна': 1, 'Польща': 2, 'США': 4 },
  },
};
const doc = rules => ({ ...REF, rules });
const rec = o => {
  const text = o.text || '';
  return { id: 1, date: '2026-10-20', period: '2026-10-01', text, type: 'expense', category_id: 59, operation_id: 55, project_id: 1,
    account_ids: [33], account_names: ['1 UAH ПРИКЛАД Приват ТОВ'], amount: 100, currency: 'UAH', is_lead: false, is_auto: false, is_salary: false, ...o };
};
const pick = a => ({ category_id: a.category_id, operation_id: a.operation_id });
const base = { id: 'R-T-01', title: 't', priority: 100, match: { comment_regex: '(?i)банківськ\\w* коміс' }, set: { category: 'Комісії платіжних систем' } };

test('regex: \\w і \\b працюють з кирилицею, (?i) — прапор', () => {
  const re = R.translateRegex('(?i)банківськ\\w* коміс');
  assert.ok(re.test('Банківська комісія за обслуговування'));
  assert.ok(re.test('БАНКІВСЬКІ КОМІСІЇ'));
  const zp = R.translateRegex('(?i)\\bзп\\b|зарплат');
  assert.ok(zp.test('Комісія за ЗП відділу'));
  assert.ok(!zp.test('Комісія ЗПТ'));       // «зп» лише окремим словом
  assert.ok(zp.test('Зарплата'));
  assert.ok(!R.translateRegex('\\bін\\b').test('Інтернет'));
});

test('regex: зайві екранування Python не ламають JS (режим u)', () => {
  assert.ok(R.translateRegex('ЄСВ\\-ВВ').test('ЄСВ-ВВ'));
  assert.ok(R.translateRegex("Хостинг Україна\\'").test("Хостинг Україна'"));
  assert.ok(R.translateRegex('[\\w\\-]+').test('Хост-Україна'));
  assert.throws(() => R.translateRegex('(?x)a'), /не підтримується/);
  assert.throws(() => R.translateRegex('a(?i)b'), /лише на початку/);
});

test('імена: регістр, апостроф ʼ = \', межі слова, префікс *', () => {
  assert.ok(R.nameRegex("Мар'яна").test(R.fold('оплата МАРʼЯНА')));
  assert.ok(R.nameRegex('Шелег*').test(R.fold('ЗП Шелеги')));
  assert.ok(!R.nameRegex('Ігор').test(R.fold('Ігорович')));      // ціле слово
  assert.ok(R.nameRegex('Логвиненко Віктор').test(R.fold('зп логвиненко   віктор')));
  assert.ok(R.nameRegex('Ігор').test(R.fold('IГОР')));            // латинська I замість І
});

test('компіляція: помилки з назвою правила, без часткового застосування', () => {
  const c = R.compileRules(doc([{ ...base, id: 'R-T-01' }, { ...base, id: 'R-T-01' }, { ...base, id: 'R-T-02', set: { category: 'Інші витрати' } },
    { ...base, id: 'R-T-03', set: { category: 'Немає такої' } }, { ...base, id: 'R-T-04', effective_from: '20.10.2026' }]));
  assert.equal(c.rules.length, 1);
  assert.equal(c.errors.length, 4);
  assert.match(c.errors.join('\n'), /R-T-01: id повторюється/);
  assert.match(c.errors.join('\n'), /неоднозначна/);
  assert.match(c.errors.join('\n'), /відсутня в довіднику/);
  assert.match(c.errors.join('\n'), /РРРР-ММ-ДД/);
});

test('пріоритет: правило, що хоче те саме, що й переможець, не «перекрите»; інше значення — перекрите', () => {
  const same = { ...base, id: 'R-T-11', priority: 90 };                                          // та сама стаття, нижчий пріоритет
  const other = { ...base, id: 'R-T-12', priority: 90, set: { category: 'Офіс' } };               // інша стаття, нижчий пріоритет
  const notKps = { ...base, id: 'R-T-13', priority: 40, set: { category_not: 'Адміністративні витрати / Інші витрати' } }; // обмеження, не конкретна стаття
  const res = R.evaluate(rec({ text: 'банківська комісія' }), R.compileRules(doc([base, same, other, notKps])));
  assert.equal(res.status, 'fix');
  assert.deepEqual(res.perRule, { 'R-T-01': 'fix', 'R-T-11': 'fix', 'R-T-12': 'overridden', 'R-T-13': 'overridden' });
});

test('fix_from (межа роботи): перевіряється формат, повертається в compiled.fixFrom', () => {
  assert.equal(R.compileRules(doc([base])).fixFrom, null);
  assert.equal(R.compileRules({ ...doc([base]), fix_from: '2026-09-01' }).fixFrom, '2026-09-01');
  const bad = R.compileRules({ ...doc([base]), fix_from: '01.09.2026' });
  assert.equal(bad.fixFrom, null);
  assert.match(bad.errors.join('\n'), /fix_from: очікується дата РРРР-ММ-ДД/);
});

test('статуси: ok / fix / locked-auto / manual-422', () => {
  const c = R.compileRules(doc([base]));
  assert.equal(R.evaluate(rec({ text: 'Інше' }), c), null);
  assert.equal(R.evaluate(rec({ text: 'банківська комісія', category_id: 76, operation_id: 82 }), c).status, 'ok');
  const fx = R.evaluate(rec({ text: 'банківська комісія' }), c);
  assert.equal(fx.status, 'fix');
  assert.deepEqual(pick(fx.changes[0].to), { category_id: 76, operation_id: 82 });
  assert.equal(R.evaluate(rec({ text: 'банківська комісія', is_lead: true }), c).status, 'locked-auto');
  assert.equal(R.evaluate(rec({ text: 'банківська комісія', is_auto: true }), c).status, 'locked-auto');
  assert.equal(R.evaluate(rec({ text: 'банківська комісія', is_salary: true }), c).status, 'manual-422');
});

test('unless виключає запис', () => {
  const c = R.compileRules(doc([{ ...base, unless: [{ comment_regex: '(?i)\\bзп\\b|зарплат' }] }]));
  assert.equal(R.evaluate(rec({ text: 'банківська комісія за ЗП відділу продажів' }), c), null);
});

test('дати дії: межі 19.10.2026 / 20.10.2026 включно', () => {
  const c = R.compileRules(doc([{ ...base, effective_from: '2026-10-20' }, { ...base, id: 'R-T-02', effective_to: '2026-10-19', set: { category: 'Офіс' } }]));
  assert.deepEqual(R.evaluate(rec({ text: 'банківська комісія', date: '2026-10-20' }), c).applicable.map(r => r.id), ['R-T-01']);
  assert.deepEqual(R.evaluate(rec({ text: 'банківська комісія', date: '2026-10-19' }), c).applicable.map(r => r.id), ['R-T-02']);
});

test('конфлікт: вищий пріоритет перемагає, рівний — review', () => {
  const hi = { ...base, id: 'R-T-02', priority: 200, set: { category: 'Офіс' } };
  const c1 = R.compileRules(doc([base, hi]));
  const r1 = R.evaluate(rec({ text: 'банківська комісія' }), c1);
  assert.equal(r1.status, 'fix');
  assert.deepEqual(pick(r1.changes[0].to), { category_id: 57, operation_id: 52 });
  assert.equal(r1.perRule['R-T-01'], 'overridden');
  const c2 = R.compileRules(doc([base, { ...hi, priority: 100 }]));
  const r2 = R.evaluate(rec({ text: 'банківська комісія' }), c2);
  assert.equal(r2.status, 'review');
  assert.match(r2.reasons[0], /конфлікт/);
  assert.equal(r2.changes.length, 0); // конфліктне поле не змінюється навіть після підтвердження
  // однакове значення при рівному пріоритеті — не конфлікт
  const c3 = R.compileRules(doc([base, { ...base, id: 'R-T-03' }]));
  assert.equal(R.evaluate(rec({ text: 'банківська комісія' }), c3).status, 'fix');
});

test('тип «переказ» і виключення з P&L — лише review', () => {
  const c = R.compileRules(doc([{ id: 'R-T-05', title: 't', priority: 100, match: { text_any: ['поповнення корпоративної картки'] }, set: { type: 'transfer' } }]));
  const r = R.evaluate(rec({ text: 'Поповнення корпоративної картки 1665' }), c);
  assert.equal(r.status, 'review');
  assert.equal(r.changes.length, 0);
  assert.equal(R.evaluate(rec({ text: 'Поповнення корпоративної картки', type: 'transfer', category_id: null, operation_id: null }), c).status, 'ok');
});

test('mode: review — зміна лише після окремого підтвердження', () => {
  const c = R.compileRules(doc([{ ...base, mode: 'review' }]));
  const r = R.evaluate(rec({ text: 'банківська комісія' }), c);
  assert.equal(r.status, 'review');
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].auto, false);
});

test('проєкт: правило за іменами, список імен з people', () => {
  const d = doc([{ id: 'R-P-01', title: 'США', priority: 100, match: { names: '@usa' }, set: { project: 'США' } }]);
  d.people = { usa: { names: ['Віденець', 'Татоян*'] } };
  const c = R.compileRules(d);
  assert.equal(c.errors.length, 0, c.errors.join());
  assert.equal(R.evaluate(rec({ text: 'ЗП Татояну Артему' }), c).status, 'fix');
  assert.equal(R.evaluate(rec({ text: 'ЗП Віденець', project_id: 4 }), c).status, 'ok');
  assert.equal(R.evaluate(rec({ text: 'ЗП Іванов' }), c), null);
});

test('умови: тип, рахунок, сума, all/any/not', () => {
  const c = R.compileRules(doc([{ id: 'R-T-09', title: 't', priority: 1, set: { category: 'Офіс' },
    match: { type: 'expense', account_regex: '(?i)приват', amount_min: 50, any: [{ text_any: ['прибирання'] }, { text_any: ['клінінг'] }], not: { text_any: ['повернення'] } } }]));
  assert.equal(R.evaluate(rec({ text: 'Прибирання офісу' }), c).status, 'fix');
  assert.equal(R.evaluate(rec({ text: 'Прибирання офісу', amount: 10 }), c), null);
  assert.equal(R.evaluate(rec({ text: 'Прибирання офісу', type: 'income' }), c), null);
  assert.equal(R.evaluate(rec({ text: 'Прибирання, повернення' }), c), null);
  assert.equal(R.evaluate(rec({ text: 'Клінінг', account_names: ['Моно'] }), c), null);
});

test('стаття-група і «не ця стаття»: лише перевірка, без автозміни; точна стаття перемагає вимогу', () => {
  const d = doc([
    { id: 'R-G-01', title: 'група', priority: 100, match: { text_any: ['ноутбук'] }, set: { category_group: 'Продажі та маркетинг' } },
    { id: 'R-N-01', title: 'не КПС', priority: 40, match: { category_in: ['Комісії платіжних систем'], text_any: ['податки'] }, set: { category_not: 'Комісії платіжних систем' } },
    { id: 'R-N-02', title: 'податки ФОП', priority: 100, match: { text_any: ['податки фоп'] }, set: { category: 'ЗП відділу продажів' } },
  ]);
  const c = R.compileRules(d);
  assert.deepEqual(c.errors, []);
  const g = R.evaluate(rec({ text: 'ноутбук' }), c);
  assert.equal(g.status, 'review');
  assert.equal(g.changes.length, 0);
  assert.equal(R.evaluate(rec({ text: 'ноутбук', category_id: 48, operation_id: 32 }), c).status, 'ok');
  const n = R.evaluate(rec({ text: 'податки з ЗП', category_id: 76, operation_id: 82 }), c);
  assert.equal(n.status, 'review');
  const f = R.evaluate(rec({ text: 'податки фоп за 09', category_id: 76, operation_id: 82 }), c);
  assert.equal(f.status, 'fix');
  assert.equal(f.perRule['R-N-01'], 'overridden');
  assert.deepEqual(pick(f.changes[0].to), { category_id: 55, operation_id: 47 });
});

test('правило лише на перевірку (set.review) і межа за датою створення', () => {
  const c = R.compileRules(doc([
    { id: 'R-RV-01', title: 'перевірити', priority: 100, match: { text_any: ['жарков'] }, set: { review: 'країна невідома' } },
    { id: 'R-CR-01', title: 'з дати створення', priority: 100, date_field: 'created', effective_from: '2026-10-20', match: { text_any: ['прибирання'] }, set: { category: 'Офіс' } },
  ]));
  const r = R.evaluate(rec({ text: 'ЗП Жарков' }), c);
  assert.equal(r.status, 'review');
  assert.match(r.reasons.join(), /країна невідома/);
  assert.equal(R.evaluate(rec({ text: 'прибирання', date: '2026-09-30', created: '2026-10-19' }), c), null);
  assert.equal(R.evaluate(rec({ text: 'прибирання', date: '2026-09-30', created: '2026-10-20' }), c).status, 'fix');
});

test('латинська «i» всередині кириличних слів не заважає регуляркам', () => {
  const c = R.compileRules(doc([{ ...base, match: { comment_regex: String.raw`(?i)коміс\w*\s+за\s+обслуговуван` } }]));
  assert.equal(R.evaluate(rec({ text: 'Комiсiя за обслуговування рахунку' }), c).status, 'fix'); // i — латиниця
  assert.equal(R.toCyr('НIКІТЧЕНКО Hetzner'), 'НІКІТЧЕНКО Hetzner'); // латинські слова не чіпаємо
});

test('ціль — зарплатна стаття або стаття з маркетологом: лише review', () => {
  const d = doc([{ id: 'R-S-01', title: 't', priority: 1, match: { text_any: ['x'] }, set: { category: 'ЗП відділу продажів' } }]);
  const c = R.compileRules(d);
  assert.equal(R.evaluate(rec({ text: 'x' }), c, { salaryOps: new Set([47]) }).status, 'review');
  const m = R.evaluate(rec({ text: 'x' }), c, { marketerArts: new Set(['55/47']) });
  assert.equal(m.status, 'review');
  assert.equal(m.changes.length, 0);
});

test('запис зараз у статті з маркетологом: зміна статті лише вручну (review), проєкт — можна', () => {
  const d = doc([{ id: 'R-M-01', title: 't', priority: 1, match: { text_any: ['x'] }, set: { category: 'Офіс', project: 'США' } }]);
  const c = R.compileRules(d);
  const r = R.evaluate(rec({ text: 'x', category_id: 59, operation_id: 55 }), c, { marketerArts: new Set(['59/55']) });
  assert.equal(r.status, 'review');
  assert.deepEqual(r.changes.map(x => x.field), ['project']);
  assert.match(r.reasons.join(), /маркетолог/);
});

test('вибір частини правил не обходить пріоритет невибраного правила', () => {
  const d = doc([
    { id: 'R-HI-01', title: 'hi', priority: 110, match: { text_any: ['завод'] }, set: { category: 'Офіс' } },
    { id: 'R-LO-01', title: 'lo', priority: 100, match: { text_any: ['зп'] }, set: { category: 'ЗП відділу продажів' } },
  ]);
  const c = R.compileRules(d);
  const both = R.evaluate(rec({ text: 'зп контент завод' }), c);
  assert.equal(both.status, 'fix');
  assert.deepEqual(pick(both.changes[0].to), { category_id: 57, operation_id: 52 });
  const onlyLow = R.evaluate(rec({ text: 'зп контент завод' }), c, { ruleIds: new Set(['R-LO-01']) });
  assert.equal(onlyLow.status, 'review');          // не «fix» на 55/47 в обхід правила з пріоритетом 110
  assert.equal(onlyLow.changes.length, 0);
  assert.deepEqual(onlyLow.applicable.map(r => r.id), ['R-LO-01']);
  assert.match(onlyLow.reasons.join(), /R-HI-01/);
  // запис уже відповідає правилу з вищим пріоритетом → ok, вибране правило «перекрите»
  const ok = R.evaluate(rec({ text: 'зп контент завод', category_id: 57, operation_id: 52 }), c, { ruleIds: new Set(['R-LO-01']) });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.perRule['R-LO-01'], 'overridden');
});

test('лід / автоматичний запис у зарплатній статті — locked-auto, а не «змінити вручну»', () => {
  const c = R.compileRules(doc([base]));
  assert.equal(R.evaluate(rec({ text: 'Банківська комісія', is_auto: true, is_salary: true }), c).status, 'locked-auto');
  assert.equal(R.evaluate(rec({ text: 'Банківська комісія', is_lead: true, is_salary: true }), c).status, 'locked-auto');
  assert.equal(R.evaluate(rec({ text: 'Банківська комісія', is_salary: true }), c).status, 'manual-422');
});

test('запис доходу / витрати з кількома платежами не змінюється (review)', () => {
  const c = R.compileRules(doc([base]));
  const r = R.evaluate(rec({ text: 'Банківська комісія', n_payments: 2 }), c);
  assert.equal(r.status, 'review');
  assert.equal(r.changes.length, 0);
  assert.equal(R.evaluate(rec({ text: 'Банківська комісія', n_payments: 1 }), c).status, 'fix');
});

test('запис без кешів тексту (рядки «Звірки з банком», погодження): ті самі результати, у result.record — сам запис', () => {
  // справжні правила й випадки rules.test.js: з кешами normalizeRecord і без них (кеші evaluate додає сам, 07.11.2026)
  const fs = require('fs'), path = require('path'), M = require('../core/crm-model.js');
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules', 'rules.json'), 'utf8'));
  const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, 'rule-cases.json'), 'utf8'));
  const c = R.compileRules(d);
  const live = M.buildLiveRef({ cats: d.reference.articles.map(a => ({ id: a.category_id, name: a.category })), ops: d.reference.articles.map(a => ({ id: a.operation_id, name: a.name })), config: { salary: { category_id: 21 } } });
  const ctx = { salaryOps: live.salaryOps, marketerArts: live.marketerArts };
  const OP = { expense: 2, income: 1, transfer: 4 };
  const sum = x => x && { status: x.status, perRule: x.perRule, reasons: x.reasons, ids: x.applicable.map(r => r.id), changes: x.changes.map(ch => [ch.field, JSON.stringify(ch.to)]) };
  let hit = 0;
  for (const [, , text, o] of cases) {
    const dt = o.date || '2026-09-15', iso = new Date(dt + 'T12:00:00+03:00').toISOString().replace('.000Z', '.000000Z');
    const [cat, op] = (o.art || '59/55').split('/').map(Number);
    const full = M.normalizeRecord({ id: 1, comment: text, date: iso, period: iso, created_at: o.created ? new Date(o.created + 'T10:00:00+03:00').toISOString() : iso, deleted_at: null,
      project_id: o.prj === undefined ? 1 : o.prj, task_payment_id: null, is_manual: true,
      payments: [{ invoice_id: 33, operation: OP[o.type || 'expense'], pnl_category_id: cat, pnl_operation_id: op, amount: 1000, deleted_at: null, invoice: { name: o.acc || '1 UAH ПРИКЛАД Приват ТОВ', currency_id: 1 } }] }, live);
    const bare = { ...full };
    delete bare.textApos; delete bare.textNorm; delete bare.textFold; delete bare.textCyr;
    const a = R.evaluate(full, c, ctx), b = R.evaluate(bare, c, ctx);
    assert.deepEqual(sum(b), sum(a), text);
    if (b) { hit++; assert.equal(b.record, bare); assert.equal(Object.prototype.hasOwnProperty.call(bare, 'textCyr'), false); }
  }
  assert.ok(hit > 50);
});