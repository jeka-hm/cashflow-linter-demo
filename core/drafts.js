/* =====================================================================
   Чернетки кешфлоу CRM (14.11.2026). У CRM з'явились чернетки записів: /api/invoice-payment-drafts — той самий набір полів, що й
   у звичайного запису (POST /api/invoice-payment), але запис не потрапляє в кешфлоу й не змінює залишок рахунку, доки головний
   бухгалтер не «проведе» чернетку (POST …/{id}/convert). Перевірено на справжній CRM 14.11.2026:
     • GET  invoice-payment-drafts?page=&per_page= (≤ 100) → {data: [{id, status: 'draft', user_id, created_at, data: {поля форми
       рядками}, files}], last_page, total}; фільтрів за датою, сумою чи рахунком немає — список віддається весь;
     • POST invoice-payment-drafts (FormData, ті самі поля) → 201 і сама чернетка; GET …/{id}; DELETE …/{id} → 204;
     • ID чернетки — з того самого ряду номерів, що й ID записів (після запису 27230 чернетка отримала 27231): збігів ID немає;
     • у GET invoice-payment (список і за ID) чернетки немає (за ID — 404).
   Перемикач «нові записи — у чернетки» (ui/linter-panel.js): коли він увімкнений, лінтер створює чернетки, а під час звірки й пошуку
   дублів бере й чернетки — у вигляді звичайного запису (toRecord, позначка draft: true), щоб нічого не внести вдруге. Коли вимкнений —
   жодного запиту до чернеток немає, усе працює як раніше.
   Чисті функції + дві обгортки запитів: make (для opts.api панелі) і registryCall (для функції запитів закладки реєстру).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CFDrafts = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PATH = 'invoice-payment-drafts';
  const SIGN = { 1: 1, 2: -1, 3: 1, 4: -1 };
  const r2 = n => Math.round(n * 100) / 100;
  const num = v => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? null : Number(v));

  let fmt = null;
  function kyivParts(ms) {
    fmt = fmt || new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const p = {};
    for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }
  /* «ДД-ММ-РРРР[ ГГ:ХХ]» за Києвом (так дату надсилає форма) → ISO-час UTC; без часу — 12:00. Не дата — null. */
  function kyivIso(s) {
    const m = /^\s*(\d{2})[-.](\d{2})[-.](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(s || '')) || (() => {
      const x = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(s || ''));
      return x ? [x[0], x[3], x[2], x[1], x[4], x[5]] : null;
    })();
    if (!m) return null;
    const H = m[4] === undefined ? 12 : Number(m[4]), Mi = m[5] === undefined ? 0 : Number(m[5]);
    // неможлива дата (31-02, місяць 13, 25:70) — не дата: інакше вона «перекотилась» би на сусідній день
    const chk = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    if (H > 23 || Mi > 59 || chk.getUTCMonth() !== Number(m[2]) - 1 || chk.getUTCDate() !== Number(m[1]) || Number(m[1]) < 1) return null;
    const want = `${m[3]}-${m[2]}-${m[1]}T${String(H).padStart(2, '0')}:${String(Mi).padStart(2, '0')}`;
    for (const off of [2, 3]) { // Київ: UTC+2 взимку, UTC+3 влітку
      const ms = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), H - off, Mi);
      if (kyivParts(ms) === want) return new Date(ms).toISOString();
    }
    return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), H - 2, Mi)).toISOString(); // година переведення годинника
  }
  const kyivDay = iso => { const d = new Date(iso); return isNaN(d) ? null : kyivParts(d.getTime()).slice(0, 10); };

  /* Чернетка CRM → запис у вигляді GET invoice-payment (id, date, period, comment, payments[…]) з позначкою draft: true.
     Переказ (operation 3 + invoice_from / invoice_to) — два платежі: 4 з рахунку і 3 на рахунок, як у звичайного переказу.
     Чернетка без рахунку чи суми (недозаповнена людиною, обмін валют) — запис без платежів: у звірку не потрапляє. */
  function toRecord(d) {
    if (!d || typeof d !== 'object') return null;
    const f = (d && d.data && !Array.isArray(d.data) ? d.data : null) || {};
    const op = Number(f.operation), amount = num(f.amount);
    const pay = (acc, operation, extra) => Object.assign({ id: null, transaction_id: d.id, invoice_id: Number(acc), operation, amount, deleted_at: null }, extra || {});
    let payments = [];
    if (amount !== null && amount > 0) {
      if (op === 3 && num(f.invoice_from) && num(f.invoice_to)) payments = [pay(f.invoice_from, 4), pay(f.invoice_to, 3)];
      else if ((op === 1 || op === 2) && num(f.invoice_id)) payments = [pay(f.invoice_id, op, { pnl_category_id: num(f.pnl_category_id), pnl_operation_id: num(f.pnl_operation_id) })];
    }
    const mk = num(f.marketer_id);
    return { id: d.id, draft: true, user_id: d.user_id === undefined ? null : d.user_id, location_id: num(f.location_id), project_id: num(f.project_id), task_payment_id: null,
      comment: f.comment === undefined || f.comment === null ? '' : String(f.comment), date: kyivIso(f.date), period: kyivIso(f.period), created_at: d.created_at || null,
      updated_at: d.updated_at || null, deleted_at: null, is_manual: true, is_edited: false, payments,
      marketer_balance_history: mk ? { marketer_balance: { user_id: mk } } : null };
  }

  /* Чи підходить запис під фільтри списку invoice-payment: date_from / date_to (ДД-ММ-РРРР, день за Києвом), amount_from / amount_to
     (сума будь-якого платежу), invoice_ids[] (рахунок будь-якого платежу). Список чернеток CRM сам не фільтрує. */
  function matches(rec, query) {
    const q = typeof query === 'string' ? new URLSearchParams(query.replace(/^[^?]*\?/, '')) : query;
    const day = s => { const m = /^(\d{2})-(\d{2})-(\d{4})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
    const d = rec.date ? kyivDay(rec.date) : null, from = day(q.get('date_from')), to = day(q.get('date_to'));
    if ((from || to) && (!d || (from && d < from) || (to && d > to))) return false;
    const pays = (rec.payments || []).filter(p => !p.deleted_at);
    const lo = num(q.get('amount_from')), hi = num(q.get('amount_to'));
    if ((lo !== null || hi !== null) && !pays.some(p => (lo === null || Number(p.amount) >= lo - 0.005) && (hi === null || Number(p.amount) <= hi + 0.005))) return false;
    const ids = q.getAll('invoice_ids[]').concat(q.getAll('invoice_ids%5B%5D')).map(Number).filter(Boolean);
    if (ids.length && !pays.some(p => ids.includes(Number(p.invoice_id)))) return false;
    return true;
  }
  /* Скільки чернетки додають до залишку рахунку CRM, коли їх проведуть: Map(id рахунку → сума зі знаком). */
  function balanceEffect(records) {
    const m = new Map();
    for (const r of records || []) for (const p of r.payments || []) {
      if (p.deleted_at || !SIGN[p.operation]) continue;
      m.set(Number(p.invoice_id), r2((m.get(Number(p.invoice_id)) || 0) + SIGN[p.operation] * Number(p.amount)));
    }
    return m;
  }
  const listOf = j => (Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []));
  // у списку — лише справжні чернетки: проведена чи відхилена (якщо CRM лишає її в списку з іншим статусом) — уже не чернетка
  const isDraft = d => !!d && typeof d === 'object' && d.id !== undefined && (d.status === undefined || d.status === null || d.status === 'draft');
  const one = j => (j && j.data && !Array.isArray(j.data) && j.data.id !== undefined && j.status === undefined ? j.data : j);

  /* Тіло нової чернетки — як його зберігає сам CRM: JSON з числами (16.11.2026). Форма (FormData) дає лише рядки, CRM зберігає їх
     як є, а вікно чернетки шукає рахунок, статтю, проєкт і маркетолога суворим порівнянням (id === значення): з рядком «68» списки
     лишались порожніми — «у чернетках не вистачає даних». → об'єкт або null (не форма чи у формі файл — тоді надсилається як є). */
  const NUM_KEYS = new Set(['operation', 'amount', 'invoice_id', 'invoice_from', 'invoice_to', 'location_id', 'project_id', 'marketer_id',
    'pnl_category_id', 'pnl_operation_id', 'currency_id', 'rate', 'commission', 'show_response_in_currency']);
  function plain(form) {
    if (!form || typeof form.entries !== 'function') return null;
    const o = {};
    for (const [k, v] of form.entries()) {
      if (typeof v !== 'string') return null;
      o[k] = NUM_KEYS.has(k) && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
    }
    return o;
  }

  /* Для панелі: api — {get(path) → json (кидає помилку не на 200), post(path, body) → {status, json, …}}; on() — чи увімкнено.
     → {on, list() — усі чернетки записами, near(query) — ті, що підходять під фільтри списку, post(form) — створити чернетку
        (відповідь — як у api.post, але json = {data: запис}), get(id) — чернетка записом}. */
  function make(api, o) {
    const on = () => !!(o && o.on && o.on());
    async function list() {
      const out = new Map();
      for (let p = 1; p <= 200; p++) {
        const j = await api.get(`${PATH}?page=${p}&per_page=100`);
        for (const d of listOf(j)) if (isDraft(d)) out.set(d.id, toRecord(d));
        if (Array.isArray(j) || !j || !j.last_page || p >= j.last_page) break;
      }
      return [...out.values()];
    }
    return {
      on, list,
      near: async query => (await list()).filter(r => matches(r, query)),
      post: async form => {
        const res = await api.post(PATH, plain(form) || form); // об'єкт api надсилає як JSON
        if (!res || res.status < 200 || res.status >= 300) return res;
        const d = one(res.json);
        return Object.assign({}, res, { json: { data: d && d.id !== undefined ? toRecord(d) : d } });
      },
      get: async id => toRecord(one(await api.get(`${PATH}/${id}`))),
    };
  }

  /* Для закладки реєстру погоджень: S(метод, адреса, тіло) → json (кидає Error зі .status). У режимі чернеток:
     POST /api/invoice-payment → чернетка (відповідь — {data: запис}); GET списку — ще й чернетки, що підходять під його фільтри
     (на першій сторінці); GET за ID, якого в кешфлоу немає (404), — чернетка. Решта запитів — без змін. */
  function registry(S) {
    // список чернеток — один запит на всіх, хто питає одночасно (перевірка рядків іде по 4), і на 4 секунди; створена чернетка
    // дописується в нього, а не скидає його (інакше кожен рядок пакета перечитував би весь список)
    let cache = null;
    const ids = new Set(); // ID чернеток, які бачив реєстр: змінювати їх запитом до кешфлоу не можна
    const load = async () => {
      const out = [];
      for (let p = 1; p <= 200; p++) {
        const j = await S('GET', `/api/${PATH}?page=${p}&per_page=100`);
        for (const d of listOf(j)) if (isDraft(d)) out.push(toRecord(d));
        if (Array.isArray(j) || !j || !j.last_page || p >= j.last_page) break;
      }
      out.forEach(r => ids.add(Number(r.id)));
      return out;
    };
    const all = () => {
      if (cache && Date.now() - cache.at < 4000) return cache.promise;
      const mine = { at: Date.now(), promise: null };
      mine.promise = load().catch(e => { if (cache === mine) cache = null; throw e; });
      cache = mine;
      return mine.promise;
    };
    call.isDraft = id => ids.has(Number(id)); // чи це ID чернетки, яку бачив реєстр (для примітки в «Реєстрі»)
    return call;
    async function call(method, url, body) {
      const path = String(url).split('?')[0];
      if (method === 'POST' && path === '/api/invoice-payment') {
        let d;
        // запит реєстру заголовка Content-Type не ставить — його дає сам Blob
        const o = plain(body), json = o && typeof Blob !== 'undefined' ? new Blob([JSON.stringify(o)], { type: 'application/json' }) : body;
        try { d = one(await S('POST', `/api/${PATH}`, json)); } catch (e) { cache = null; throw e; } // чи створилась чернетка — невідомо
        const rec = d && d.id !== undefined ? toRecord(d) : null;
        if (rec) {
          ids.add(Number(rec.id));
          if (cache) { const c = cache; c.promise = c.promise.then(l => l.concat([rec])); }
        } else cache = null;
        return { data: rec || d };
      }
      if (method === 'GET' && path === '/api/invoice-payment') {
        const j = await S(method, url, body), q = new URLSearchParams(String(url).replace(/^[^?]*\?/, ''));
        if (Number(q.get('page') || 1) > 1) return j;
        const have = new Set(listOf(j).map(r => r.id)); // чернетку щойно провели — вона вже серед записів
        const extra = (await all()).filter(r => !have.has(r.id) && matches(r, q));
        if (!extra.length) return j;
        return Array.isArray(j) ? j.concat(extra) : Object.assign({}, j, { data: listOf(j).concat(extra) });
      }
      const m = /^\/api\/invoice-payment\/(\d+)$/.exec(path);
      if (m && method === 'GET') {
        try { return await S(method, url, body); } catch (e) {
          if (!e || e.status !== 404) throw e;
          const rec = toRecord(one(await S('GET', `/api/${PATH}/${m[1]}`)));
          if (rec) ids.add(Number(rec.id));
          return rec;
        }
      }
      if (m && ids.has(Number(m[1]))) { // PUT / DELETE запису, який насправді чернетка: у кешфлоу його немає (CRM відповів би 404)
        const e = new Error(`запис ${m[1]} — чернетка CRM: змініть її в CRM («CashFlow» → «Чернетки»)`);
        e.status = 409;
        throw e;
      }
      return S(method, url, body);
    }
  }
  return { PATH, toRecord, matches, balanceEffect, kyivIso, make, registry, plain };
}));
