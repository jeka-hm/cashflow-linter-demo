/* Мок внутрішнього API crm.example.com для тестів лінтера (як mock_gas.js у реєстрі).
   Відтворює: пагінацію invoice-payment (per_page/page/last_page/total), фільтр дат (за Києвом),
   invoice_ids[], GET запису за id (без обгортки data, як справжній сайт), PUT з частковими полями,
   HTTP 422 для зарплатних операцій, HTTP 429 кожен N-й запит, довідники pnl/*;
   з оновлення CRM 29.10.2026 — профіль user/{id} з правами, 403 без «Повного редагування» (noFullEdit), закриті місяці (closedMonths). */
'use strict';
const M = require('../core/crm-model.js');

const CATS = [
  { id: 76, name: 'Комісії платіжних систем' }, { id: 57, name: 'Офіс' }, { id: 59, name: 'Інші витрати' }, { id: 48, name: 'Інші витрати' },
  { id: 55, name: 'ЗП відділу продажів' }, { id: 69, name: 'ЗП відділу маркетингу' }, { id: 53, name: 'Дослідження' }, { id: 71, name: 'Інфраструктура' },
  { id: 21, name: 'Platform participant`s comissions' }, { id: 47, name: 'Комісії відділу продажів' }, { id: 45, name: 'Маркетплейс' },
];
const OPS = [
  { id: 82, name: 'Комісії платіжних систем', operation: 2 }, { id: 52, name: 'Офіс', operation: 2 }, { id: 55, name: 'Інші витрати', operation: 2 },
  { id: 32, name: 'Інші витрати', operation: 2 }, { id: 47, name: 'ЗП відділу продажів', operation: 2 }, { id: 75, name: 'ЗП відділу маркетингу', operation: 2 },
  { id: 45, name: 'Дослідження', operation: 2 }, { id: 77, name: 'Інфраструктура', operation: 2 }, { id: 31, name: 'Комісії відділу продажів', operation: 2 },
  { id: 21, name: 'Послуги клієнтам (B2C)', operation: 1 },
];
const ACCOUNTS = [{ id: 33, name: '1 UAH ПРИКЛАД Приват ТОВ', currency_id: 1 }, { id: 84, name: 'corpCard UAH Маркет ТОВ', currency_id: 1 }, { id: 16, name: '1 USD USA LLC', currency_id: 2 }];
const CURRENCIES = [{ id: 1, code: 'UAH' }, { id: 2, code: 'USD' }];

let nextPayId = 1000;
/* Запис у форматі сайту. date — 'РРРР-ММ-ДД' за Києвом (зберігається як UTC, мінус 3 год). */
function makeRecord(o) {
  const d = o.date || '2026-09-10';
  const utc = new Date(d + 'T12:00:00+03:00').toISOString().replace('.000Z', '.000000Z');
  const op = o.operation || 2;
  const pays = o.payments || [{ invoice_id: o.invoice_id || 33, operation: op, pnl_category_id: o.cat === undefined ? 59 : o.cat, pnl_operation_id: o.op === undefined ? 55 : o.op, amount: o.amount || 100, comment: null }];
  return {
    id: o.id, user_id: 1, location_id: null, project_id: o.project_id === undefined ? 1 : o.project_id, task_payment_id: o.lead ? 777 : null,
    comment: o.comment || '', date: utc, period: utc, created_at: utc, updated_at: utc, deleted_at: o.deleted ? utc : null,
    is_manual: o.is_manual === undefined ? true : o.is_manual, is_edited: false,
    payments: pays.map(p => ({ id: nextPayId++, transaction_id: o.id, deleted_at: null, tax: null, invoice: undefined, ...p })),
  };
}

function createMock(opts) {
  opts = opts || {};
  const db = new Map((opts.records || []).map(r => [r.id, JSON.parse(JSON.stringify(r))]));
  const calls = [];
  let n = 0;
  const live = M.buildLiveRef({ cats: CATS, ops: OPS, accounts: ACCOUNTS, currencies: CURRENCIES, config: { salary: { category_id: 21 } } });
  const res = (status, json) => ({ status, json, text: json ? JSON.stringify(json) : '' });

  async function rawFetch(method, path, body) {
    n++;
    calls.push({ method, path, body });
    if (opts.every429 && n % opts.every429 === 0) return { status: 429, json: { message: 'Too Many Attempts.' }, text: 'Too Many Attempts.', retryAfter: 0 };
    if (opts.failPut && method === 'PUT' && opts.failPut(path, body)) return res(500, { message: 'Server Error' });
    if (opts.failGet && method === 'GET' && opts.failGet(path)) return res(500, { message: 'Server Error' });
    const [p, q] = path.split('?');
    const qs = new URLSearchParams(q || '');
    if (method === 'GET' && p === 'pnl/category') return res(200, CATS);
    if (method === 'GET' && p === 'pnl/operation/') return res(200, OPS);
    if (method === 'GET' && p === 'invoice') return res(200, ACCOUNTS);
    if (method === 'GET' && p === 'currency') return res(200, CURRENCIES);
    if (method === 'GET' && p === 'pnl/operation-config') return res(200, { salary: { category_id: 21 } });
    if (method === 'GET' && /^user\/\d+$/.test(p)) return res(200, { id: Number(p.slice(5)), role: { name: 'бухгалтер' },
      permissions: { invoice: { read: 1, operation_read: 1, operation_edit: 1, ...(opts.noFullEdit ? {} : { operation_full_edit: 1 }) } } });
    if (method === 'GET' && p === 'invoice-payment') {
      const toIso = s => s.split('-').reverse().join('-');
      const from = toIso(qs.get('date_from')), to = toIso(qs.get('date_to'));
      const inv = qs.getAll('invoice_ids[]').map(Number);
      const per = Number(qs.get('per_page') || 15), page = Number(qs.get('page') || 1);
      const all = [...db.values()].filter(r => !r.deleted_at).filter(r => { const d = M.kyivDate(r.date); return d >= from && d <= to; })
        .filter(r => !inv.length || r.payments.some(x => inv.includes(x.invoice_id))).sort((a, b) => b.id - a.id);
      const last = Math.max(1, Math.ceil(all.length / per));
      return res(200, { current_page: page, data: all.slice((page - 1) * per, page * per).map(withNested), last_page: last, per_page: per, total: all.length });
    }
    const m = /^invoice-payment\/(\d+)$/.exec(p);
    if (m) {
      const r = db.get(Number(m[1]));
      if (!r) return res(404, { message: 'Not found' });
      if (method === 'GET') return res(200, JSON.parse(JSON.stringify(r)));
      if (method === 'PUT') {
        // оновлення CRM 29.10.2026: без «Повного редагування операцій Cash Flow» — 403; закритий місяць (за періодом запису) — 422 з errors.period
        if (opts.noFullEdit) return res(403, { message: 'Недостатньо прав для виконання цієї дії' });
        if (opts.closedMonths && opts.closedMonths.has(M.kyivDate(r.period).slice(0, 7))) return res(422, { message: M.CLOSED_PERIOD_MESSAGE, errors: { period: [M.CLOSED_PERIOD_MESSAGE] } });
        if (r.payments.some(x => x.pnl_category_id === 21) || (opts.put422 && opts.put422.has(r.id))) return res(422, { message: 'Зарплатну операцію змінити не можна' });
        for (const k of Object.keys(body)) if (!['pnl_category_id', 'pnl_operation_id', 'project_id'].includes(k)) return res(422, { message: 'unexpected field ' + k });
        if (opts.ignorePut) return res(200, r);  // «тиха» відмова — перевірка має це спіймати
        if (body.pnl_category_id != null) r.payments[0].pnl_category_id = Number(body.pnl_category_id);
        if (body.pnl_operation_id != null) r.payments[0].pnl_operation_id = Number(body.pnl_operation_id);
        if (body.project_id != null) r.project_id = Number(body.project_id);
        r.is_edited = true;
        return res(200, r);
      }
    }
    return res(404, { message: `route ${method} ${p} not found` });
  }
  function withNested(r) {
    const c = JSON.parse(JSON.stringify(r));
    c.payments.forEach(x => { x.invoice = ACCOUNTS.find(a => a.id === x.invoice_id) || null; });
    return c;
  }
  // зовнішня зміна запису (імітація користувача між звітом і застосуванням)
  function touch(id, f) { f(db.get(id)); }
  return { rawFetch, calls, db, live, touch, count: () => n };
}

module.exports = { createMock, makeRecord, CATS, OPS, ACCOUNTS, CURRENCIES };
