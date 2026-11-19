// Тести кожного правила з rules.json на випадках з test/rule-cases.json (ТЗ 8.1)
// і перевірка покриття: у кожного правила ≥1 позитивний і ≥1 негативний випадок, у правил з датами — межі.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../core/rules-engine.js');
const M = require('../core/crm-model.js');

const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules', 'rules.json'), 'utf8'));
const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, 'rule-cases.json'), 'utf8'));
const compiled = R.compileRules(doc);
const live = M.buildLiveRef({ cats: doc.reference.articles.map(a => ({ id: a.category_id, name: a.category })), ops: doc.reference.articles.map(a => ({ id: a.operation_id, name: a.name })), config: { salary: { category_id: 21 } } });
const ctx = { salaryOps: live.salaryOps, marketerArts: live.marketerArts };
const OP = { expense: 2, income: 1, transfer: 4 };

function rawRecord(text, o) {
  const d = o.date || '2026-09-15';
  const iso = new Date(d + 'T12:00:00+03:00').toISOString().replace('.000Z', '.000000Z');
  const created = o.created ? new Date(o.created + 'T10:00:00+03:00').toISOString() : iso;
  const [cat, op] = (o.art || '59/55').split('/').map(Number);
  return {
    id: 1, comment: text, date: iso, period: iso, created_at: created, deleted_at: null, project_id: o.prj === undefined ? 1 : o.prj,
    task_payment_id: null, is_manual: true,
    payments: [{ invoice_id: 33, operation: OP[o.type || 'expense'], pnl_category_id: cat, pnl_operation_id: op, amount: 1000, deleted_at: null,
      invoice: { name: o.acc || '1 UAH ПРИКЛАД Приват ТОВ', currency_id: 1 } }],
  };
}

test('rules.json компілюється без помилок', () => {
  assert.deepEqual(compiled.errors, []);
  assert.ok(compiled.rules.length >= 40);
});

test('покриття: у кожного правила є позитивний і негативний тест, у правил з датами — межі', () => {
  const by = {};
  for (const [id, kind, , o, exp] of cases) {
    const b = by[id] || (by[id] = { pos: 0, neg: 0, date: 0, dates: new Set() });
    if (kind === 'pos') b.pos++;
    else if (kind === 'neg') b.neg++;
    else { b.date++; b.dates.add(o.date); }
    if (kind === 'neg') assert.equal(exp, null, `${id}: негативний тест має очікувати null`);
  }
  const missing = [];
  for (const r of compiled.rules) {
    const b = by[r.id];
    if (!b || !b.pos || !b.neg) missing.push(`${r.id}: pos ${b ? b.pos : 0}, neg ${b ? b.neg : 0}`);
    if ((r.from || r.to) && (!b || !b.date)) missing.push(`${r.id}: немає тесту меж дат`);
    if (r.from === '2026-10-20' && b && !(b.dates.has('2026-10-19') && b.dates.has('2026-10-20'))) missing.push(`${r.id}: потрібні межі 19.10.2026 / 20.10.2026`);
  }
  assert.deepEqual(missing, []);
});

for (const [id, kind, text, o, expected] of cases) {
  test(`${id} [${kind}] ${text.slice(0, 60)}`, () => {
    const rec = M.normalizeRecord(rawRecord(text, o), live);
    const res = R.evaluate(rec, compiled, ctx);
    const st = res && res.applicable.some(r => r.id === id) ? res.perRule[id] : null;
    assert.equal(st, expected, `правило ${id}: очікувалось ${expected}, отримано ${st}${res ? ' (спрацювали: ' + res.applicable.map(r => r.id + ':' + res.perRule[r.id]).join(', ') + ')' : ''}`);
  });
}
