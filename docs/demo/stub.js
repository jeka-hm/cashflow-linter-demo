/* Демо без сервера: підміна fetch, яка імітує API CRM (рахунки, записи кешфлоу, чернетки, POST / PUT / DELETE)
   і локальну програму «Помічник кешфлоу» (виписки банків). Усе живе в пам'яті сторінки: оновили сторінку — дані як спочатку.
   Логіка — та сама, що в тестовому сервері test/mock_crm_server.py, лише мовою браузера.
   install(win, data, {helper, log}) → {state, fetch}: win.fetch замінюється; запити не до CRM і не до Помічника йдуть як були. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CFDemoStub = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SIGN = { 1: 1, 2: -1, 3: 1, 4: -1, 5: 1, 6: -1 };
  const SALARY_OPS = new Set([31, 32, 33, 34, 35, 36, 37, 38, 39, 61, 62]);
  const TOKEN = 'demo-token';
  const NOT_FOUND = { message: 'Запис не знайдено' };
  const AI_OFF = { ok: true, state: 'nokey', state_ua: 'у демо ШІ вимкнено (немає ключа Claude API)', results: {}, pending: 0, failed: 0, running: false, error: '', model: '—', usage: { usd: 0, limit: 0 } };
  const clone = o => JSON.parse(JSON.stringify(o));
  const round2 = n => Math.round(n * 100) / 100;
  const pad = n => String(n).padStart(2, '0');

  function makeState(data) {
    const DB = new Map(data.records.map(r => [r.id, clone(r)])), DRAFTS = new Map();
    let last = Math.max(0, ...DB.keys());
    const nextId = () => { last = Math.max(last, ...DB.keys(), ...DRAFTS.keys()) + 1; return last; };
    return { DB, DRAFTS, nextId, accounts: clone(data.accounts), bank: data.bank, files: new Map(), job: { running: false, log: [], code: null, file: null, started: null, args: null }, saved: [], calls: [] };
  }

  function install(win, data, opts) {
    const o = opts || {}, S = makeState(data), log = o.log || (() => {});
    const origin = (win.location && win.location.origin) || 'http://demo.invalid';
    const helper = String(o.helper || origin + '/demo-helper').replace(/\/+$/, '');
    const real = win.fetch ? win.fetch.bind(win) : null;
    const R = win.Response || Response;
    const json = (status, obj) => new R(status === 204 ? null : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

    const account = a => ({ ...a, balance: round2([...S.DB.values()].filter(r => !r.deleted_at).reduce((s, r) => s + r.payments.filter(p => p.invoice_id === a.id && !p.deleted_at)
      .reduce((q, p) => q + (SIGN[p.operation] || 0) * p.amount, 0), 0)) });
    const withInvoice = r => { const c = clone(r); delete c.kyiv; for (const p of c.payments) p.invoice = S.accounts.find(a => a.id === p.invoice_id) || null; return c; };
    const isoOf = d => `${d}T10:00:00.000000Z`;
    const mkRec = (id, d, acc, op, cat, opid, amount, comment, prj, mk) => ({ id, user_id: 5, location_id: null, project_id: prj || 1, task_payment_id: null, comment, date: isoOf(d), period: isoOf(d.slice(0, 8) + '01'),
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null, is_manual: true, is_edited: false, kyiv: d,
      marketer_balance_history: mk ? { marketer_balance: { user_id: mk } } : null,
      payments: [{ id: id * 10, transaction_id: id, invoice_id: acc, operation: op, pnl_category_id: cat, pnl_operation_id: opid, amount: round2(Math.abs(amount)), deleted_at: null, comment: null, tax: null }] });

    /** Новий запис з полів форми (POST invoice-payment і «провести» чернетку). */
    function create(f, rid) {
      const m = /^(\d\d)-(\d\d)-(\d{4})/.exec(String(f.date || ''));
      if (!m) return [422, { message: 'демо: очікується дата ДД-ММ-РРРР' }];
      const d = `${m[3]}-${m[2]}-${m[1]}`, s = k => (f[k] == null ? '' : String(f[k]));
      let make;
      if (s('operation') === '3' && s('invoice_from') && s('invoice_to')) {
        make = id => { const r = mkRec(id, d, Number(f.invoice_from), 4, null, null, Number(f.amount), s('comment'), Number(f.project_id) || 1);
          r.payments.push({ ...r.payments[0], id: id * 10 + 1, invoice_id: Number(f.invoice_to), operation: 3 }); return r; };
      } else if (['1', '2'].includes(s('operation')) && s('invoice_id') && s('pnl_category_id') && s('pnl_operation_id') && s('currency_id')) {
        const art = `${Number(f.pnl_category_id)}/${Number(f.pnl_operation_id)}`;
        if (['20/30', '20/40', '20/41', '23/42'].includes(art) && !s('marketer_id')) return [422, { message: 'marketer_id обов’язковий (демо)' }];
        make = id => mkRec(id, d, Number(f.invoice_id), Number(f.operation), Number(f.pnl_category_id), Number(f.pnl_operation_id), Number(f.amount), s('comment'), Number(f.project_id) || 1, s('marketer_id') ? Number(f.marketer_id) : null);
      } else return [422, { message: 'демо: очікується переказ (operation=3, invoice_from, invoice_to) або запис (operation 1/2, invoice_id, стаття, currency_id)', got: f }];
      const id = rid || S.nextId();
      S.DB.set(id, make(id));
      return [200, { data: withInvoice(S.DB.get(id)) }];
    }
    const draftOut = (d, full) => { const c = clone(d); if (!full) delete c.history; return c; };

    async function body(init) {
      const b = init && init.body;
      if (!b) return {};
      if (typeof b === 'string') { try { const j = JSON.parse(b); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } }
      if (typeof b.entries === 'function') return Object.fromEntries([...b.entries()].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
      return {};
    }

    async function crm(method, p, q, init) {
      const auth = new (win.Headers || Headers)((init && init.headers) || {}).get('Authorization') || '';
      if (auth !== 'Bearer ' + TOKEN) return json(401, { message: 'Unauthenticated.' });
      let m;
      if (method === 'GET') {
        if (p === 'currency') return json(200, data.currencies);
        if ((m = /^user\/(\d+)$/.exec(p))) return json(200, { id: Number(m[1]), name: 'Демо Бухгалтерка', role: { id: 2, name: 'бухгалтер' },
          permissions: { invoice: { read: 1, edit: 1, operation_read: 1, operation_edit: 1, operation_full_edit: 1 } } });
        if (p === 'user' || p === 'user/') return json(200, data.users);
        if (p === 'invoice') {
          if (!q.has('page')) return json(200, S.accounts.map(a => ({ id: a.id, name: a.name, currency_id: a.currency_id })));
          const per = Number(q.get('per_page') || 20), page = Number(q.get('page')), all = S.accounts.map(account);
          return json(200, { current_page: page, data: all.slice((page - 1) * per, page * per), last_page: Math.max(1, Math.ceil(all.length / per)), per_page: per, total: all.length });
        }
        if ((m = /^invoice\/(\d+)$/.exec(p))) { const a = S.accounts.find(x => x.id === Number(m[1])); return a ? json(200, account(a)) : json(404, { message: 'not found' }); }
        if (p === 'pnl/category') return json(200, data.cats);
        if (p === 'pnl/operation/' || p === 'pnl/operation') return json(200, data.ops);
        if (p === 'pnl/operation-config') return json(200, { salary: { category_id: 21 }, marketer_add_balance: [{ category_id: 20, operations: [40, 41, 30] }, { category_id: 23, operations: [42] }] });
        if (p === 'pnl/category/21') return json(200, { id: 21, operations: [...SALARY_OPS].sort((a, b) => a - b).map(id => ({ id })) });
        if (p === 'invoice-payment') {
          const iso = s => String(s || '').split('-').reverse().join('-');
          const d1 = iso(q.get('date_from')) || '0000', d2 = iso(q.get('date_to')) || '9999', inv = new Set(q.getAll('invoice_ids[]').map(Number));
          const a1 = q.has('amount_from') ? Number(q.get('amount_from')) : -1e18, a2 = q.has('amount_to') ? Number(q.get('amount_to')) : 1e18;
          const per = Number(q.get('per_page') || 15), page = Number(q.get('page') || 1);
          const rows = [...S.DB.values()].sort((a, b) => b.id - a.id).filter(r => d1 <= r.kyiv && r.kyiv <= d2 && (!inv.size || r.payments.some(x => inv.has(x.invoice_id)))
            && r.payments.some(x => a1 - 0.005 <= x.amount && x.amount <= a2 + 0.005));
          // як у CRM: у списку маркетолога запису немає — лише в GET invoice-payment/ID
          const out = rows.slice((page - 1) * per, page * per).map(r => { const c = withInvoice(r); delete c.marketer_balance_history; return c; });
          return json(200, { current_page: page, data: out, last_page: Math.max(1, Math.ceil(rows.length / per)), per_page: per, total: rows.length });
        }
        if ((m = /^invoice-payment\/(\d+)$/.exec(p))) {
          const r = S.DB.get(Number(m[1]));
          if (!r) return json(404, NOT_FOUND);
          const c = withInvoice(r); c.payments.forEach(x => delete x.invoice);
          return json(200, c);
        }
        if (p === 'invoice-payment-drafts') {
          const num = (k, d) => (/^\d+$/.test(q.get(k) || '') ? Number(q.get(k)) : d), per = num('per_page', 15), page = Math.max(1, num('page', 1));
          if (per < 1 || per > 100) return json(422, { message: 'Validation error', errors: { per_page: [per > 100 ? 'The per page field must not be greater than 100.' : 'The per page field must be at least 1.'] } });
          const rows = [...S.DRAFTS.values()].sort((a, b) => b.id - a.id).map(d => draftOut(d));
          return json(200, { current_page: page, data: rows.slice((page - 1) * per, page * per), last_page: Math.max(1, Math.ceil(rows.length / per)), per_page: per, total: rows.length });
        }
        if ((m = /^invoice-payment-drafts\/(\d+)$/.exec(p))) { const d = S.DRAFTS.get(Number(m[1])); return d ? json(200, draftOut(d, true)) : json(404, NOT_FOUND); }
        return json(404, { message: 'not found' });
      }
      if (method === 'POST') {
        if (p === 'invoice-payment') { const [st, out] = create(await body(init)); if (st === 200) log(`POST invoice-payment → запис ${out.data.id}`); return json(st, out); }
        if (p === 'invoice-payment-drafts') {
          const f = await body(init), id = S.nextId(), now = new Date().toISOString();
          S.DRAFTS.set(id, { id, status: 'draft', user_id: 5, created_at: now, updated_at: now, data: f, files: [], history: [{ id: id * 10, draft_id: id, user_id: 5, action: 'created', created_at: now }] });
          log(`POST invoice-payment-drafts → чернетка ${id}`);
          return json(201, draftOut(S.DRAFTS.get(id), true));
        }
        if ((m = /^invoice-payment-drafts\/(\d+)\/convert$/.exec(p))) {
          const id = Number(m[1]), d = S.DRAFTS.get(id);
          if (!d) return json(404, NOT_FOUND);
          const [st, out] = create(Object.fromEntries(Object.entries(d.data).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])), id);
          if (st === 200) { S.DRAFTS.delete(id); log(`чернетку ${id} проведено`); }
          return json(st, out);
        }
        return json(404, { message: 'not found' });
      }
      if (method === 'DELETE') {
        if (!(m = /^invoice-payment-drafts\/(\d+)$/.exec(p))) return json(404, { message: 'not found' });
        if (!S.DRAFTS.delete(Number(m[1]))) return json(404, NOT_FOUND);
        log(`DELETE invoice-payment-drafts/${m[1]}`);
        return json(204, null);
      }
      if (method === 'PUT') {
        m = /^invoice-payment\/(\d+)$/.exec(p);
        const r = m && S.DB.get(Number(m[1])), b = await body(init);
        if (!r) return json(404, { message: 'not found' });
        const sal = x => x != null && x !== '' && SALARY_OPS.has(Number(x));
        if (r.payments.some(x => sal(x.pnl_operation_id)) || sal(b.pnl_operation_id)) return json(422, { message: 'Операції по зарплаті не доступні для редагування' });
        const op = String(b.operation || ''), p0 = r.payments[0];
        if (op === '3' && b.invoice_from && b.invoice_to) { // зміна типу на переказ, як у формі редагування CRM
          r.payments = [{ ...p0, id: r.id * 10, invoice_id: Number(b.invoice_from), operation: 4, pnl_category_id: null, pnl_operation_id: null },
            { ...p0, id: r.id * 10 + 1, invoice_id: Number(b.invoice_to), operation: 3, pnl_category_id: null, pnl_operation_id: null }];
          r.marketer_balance_history = null;
        } else if ((op === '1' || op === '2') && b.invoice_id) {
          r.payments = [{ ...p0, id: r.id * 10, invoice_id: Number(b.invoice_id), operation: Number(op), pnl_category_id: b.pnl_category_id ? Number(b.pnl_category_id) : null, pnl_operation_id: b.pnl_operation_id ? Number(b.pnl_operation_id) : null }];
        } else for (const k of ['pnl_category_id', 'pnl_operation_id']) if (b[k] != null && b[k] !== '') r.payments[0][k] = Number(b[k]);
        if (b.project_id != null && b.project_id !== '') r.project_id = Number(b.project_id);
        r.is_edited = true;
        log(`PUT invoice-payment/${r.id}`);
        return json(200, withInvoice(r));
      }
      return json(405, { message: 'method not allowed' });
    }

    /** Виписка за період з повної: операції в межах дат, залишки перераховано (як bank_for_period у тестовому сервері). */
    function bankFor(from, to) {
      const accs = S.bank.accounts.map(a => {
        const rows = a.transactions.map(t => {
          if (a.bank === 'mono') { const k = new Date((t.time + 3 * 3600) * 1000).toISOString().slice(0, 10); return [k, t.amount / 100, t]; }
          const [dd, mm, yy] = t.DAT_OD.split('.');
          return [`${yy}-${mm}-${dd}`, Number(String(t.SUM).replace(',', '.')) * (t.TRANTYPE === 'D' ? -1 : 1), t];
        });
        const before = rows.filter(x => x[0] < from).reduce((s, x) => s + x[1], 0), inside = rows.filter(x => from <= x[0] && x[0] <= to);
        const opening = round2(a.opening + before);
        return { ...a, opening, closing: round2(opening + inside.reduce((s, x) => s + x[1], 0)), transactions: inside.map(x => x[2]) };
      });
      const n = new Date();
      return { ...S.bank, client: 'ВСІ', from, to, fetched_at: `${pad(n.getDate())}.${pad(n.getMonth() + 1)}.${n.getFullYear()} ${pad(n.getHours())}:${pad(n.getMinutes())}`, accounts: accs };
    }
    const localMinute = () => { const n = new Date(); return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}`; };

    async function help(method, p, q, init) {
      if (p === '/api/panel/bank/status') return json(200, { ok: true, app: 'cashflow-helper', demo: true, bank: { dir: '(демо)', script: true, tokens: true, clients: ['ПРИКЛАД', 'ФОП Хоменко'] }, job: S.job });
      if (p === '/api/panel/bank/job') return json(200, S.job);
      if (p === '/api/panel/bank/files') return json(200, { files: [...S.files.values()].map(f => ({ name: f.name, size: 1, mtime: f.mtime, all: true })) });
      if (p === '/api/panel/bank/file') { const f = S.files.get(q.get('name') || ''); return f ? json(200, f.json) : json(404, { error: 'файл не знайдено' }); }
      if (method === 'POST' && p === '/api/panel/bank/fetch') {
        const b = await body(init);
        if (!b.from || !b.to || b.from > b.to) return json(400, { error: 'перевірте період' });
        const dmy = s => s.split('-').reverse().join('.'), name = `виписка_ВСІ_${dmy(b.from)}_${dmy(b.to)}.json`;
        S.files.set(name, { name, mtime: localMinute(), json: bankFor(b.from, b.to) });
        S.job = { running: false, code: 0, file: name, started: localMinute() + ':00', args: [b.from, b.to], log: [`Період ${dmy(b.from)} – ${dmy(b.to)} (демо: виписки вигадані)`, '== ПРИКЛАД', '  Приват: 3 рахунки', '== ФОП Хоменко', '  Приват: 1 рахунок', '  Моно: 1 рахунок', 'Готово: ' + name] };
        log(`Помічник (демо): виписки за ${dmy(b.from)}–${dmy(b.to)}`);
        return json(200, { ok: true });
      }
      if (method === 'POST' && p === '/api/panel/files/save') {
        const b = await body(init), kind = b.kind || 'journals';
        S.saved.push({ name: b.name, kind, size: String(b.base64 || '').length });
        log(`Помічник (демо): збережено ${b.name}`);
        return json(200, { ok: true, path: `(демо)\\${kind}\\${b.name}`, dir: `(демо)\\${kind}`, name: b.name, kind });
      }
      if (method === 'POST' && p === '/api/panel/ai/hints') return json(200, AI_OFF);
      if (method === 'POST' && p === '/api/panel/ai/match') return json(200, { ...AI_OFF, matches: [] });
      return json(404, { error: 'невідомий запит' });
    }

    async function fetchStub(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input), method = String((init && init.method) || 'GET').toUpperCase();
      const isCrm = url.startsWith(origin + '/api/'), isHelper = url.startsWith(helper + '/');
      if (!isCrm && !isHelper) { if (real) return real(input, init); throw new TypeError('демо: мережі немає'); }
      const rest = url.slice((isCrm ? origin + '/api/' : helper).length), i = rest.indexOf('?');
      const path = decodeURIComponent(i < 0 ? rest : rest.slice(0, i)), q = new URLSearchParams(i < 0 ? '' : rest.slice(i + 1));
      S.calls.push(`${method} ${isCrm ? 'crm' : 'helper'}:${path}`);
      await new Promise(r => setTimeout(r, 15)); // запити не миттєві — як у житті
      return isCrm ? crm(method, path, q, init) : help(method, path, q, init);
    }
    win.fetch = fetchStub;
    return { state: S, fetch: fetchStub, helper, token: TOKEN, bankFor };
  }

  return { install, TOKEN };
});
