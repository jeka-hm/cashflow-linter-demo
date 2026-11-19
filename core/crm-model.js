/* =====================================================================
   Модель даних кешфлоу crm.example.com (внутрішній API сайту).
   Визначено читанням (GET) реальних записів і коду фронтенду сайту 24.10.2026:
   - запис кешфлоу = GET /api/invoice-payment (пагінація per_page/page/last_page);
     у записі payments[]: invoice_id (рахунок), operation (1 дохід, 2 витрата,
     3/4 переказ, 5/6 обмін), pnl_category_id + pnl_operation_id (стаття), amount;
     project_id — проєкт (країна) на рівні запису;
   - зміна = PUT /api/invoice-payment/{id} з JSON лише зі зміненими полями
     (так само робить форма редагування на сторінці CashFlow).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules-engine.js'));
  else root.CFModel = factory(root.CFRules);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (R) {
  'use strict';

  // Лінтер змінює ЛИШЕ ці поля (ТЗ, розділ 6: не сума, не дата, не рахунок, не валюта)
  const PUT_FIELDS = ['pnl_category_id', 'pnl_operation_id', 'project_id'];
  const OP_TYPE = { 1: 'income', 2: 'expense', 3: 'transfer', 4: 'transfer', 5: 'exchange', 6: 'exchange' };
  const TYPE_UA = { income: 'дохід', expense: 'витрата', transfer: 'переказ', exchange: 'обмін', unknown: '?' };
  const SALARY_CATEGORY_DEFAULT = 21; // pnl/operation-config → salary.category_id

  let kyivFmt = null;
  function kyivParts(d) {
    try {
      kyivFmt = kyivFmt || new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      const p = {};
      for (const x of kyivFmt.formatToParts(d)) p[x.type] = x.value;
      return { y: p.year, m: p.month, d: p.day, H: p.hour, M: p.minute };
    } catch (e) { // без ICU: Київ = UTC+2 взимку, UTC+3 влітку (остання неділя березня/жовтня)
      const y = d.getUTCFullYear();
      const lastSun = m => { const x = new Date(Date.UTC(y, m + 1, 0)); x.setUTCDate(x.getUTCDate() - x.getUTCDay()); return x; };
      const s = lastSun(2), w = lastSun(9);
      const summer = d >= new Date(s.getTime() + 3600e3) && d < new Date(w.getTime() + 3600e3);
      const t = new Date(d.getTime() + (summer ? 3 : 2) * 3600e3).toISOString();
      return { y: t.slice(0, 4), m: t.slice(5, 7), d: t.slice(8, 10), H: t.slice(11, 13), M: t.slice(14, 16) };
    }
  }
  function kyivDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    const p = kyivParts(d);
    return `${p.y}-${p.m}-${p.d}`;
  }
  // поточний київський час 'YYYY-MM-DDTHH:MM' — для дат за замовчуванням і назв файлів
  function kyivNow() { const p = kyivParts(new Date()); return `${p.y}-${p.m}-${p.d}T${p.H}:${p.M}`; }

  /* Довідник із живого CRM (для показу назв і перевірки rules.json):
     cats — GET pnl/category, ops — GET pnl/operation/, accounts — GET invoice?get_all=1,
     currencies — GET currency, config — GET pnl/operation-config. */
  /* salaryOps — операції зарплатної категорії (GET pnl/category/{salary.category_id} → operations[].id):
     записи з такими статтями API не змінює (HTTP 422 «Операції по зарплаті не доступні…»). */
  const SALARY_OPS_DEFAULT = [31, 32, 33, 34, 35, 36, 37, 38, 39, 61, 62]; // знімок 24.10.2026 (як fallback у cashflow_import.js)
  // статті, для яких CRM вимагає маркетолога: operation-config → marketer_add_balance [{category_id, operations}]
  const MARKETER_ARTS_DEFAULT = ['20/30', '20/40', '20/41', '23/42'];
  function marketerArtsOf(config) {
    const list = config && Array.isArray(config.marketer_add_balance) ? config.marketer_add_balance : null;
    if (!list) return new Set(MARKETER_ARTS_DEFAULT);
    return new Set(list.flatMap(x => (x.operations || []).map(op => `${x.category_id}/${op}`)));
  }
  function buildLiveRef({ cats, ops, accounts, currencies, config, projects, salaryOps }) {
    const catName = {}, opName = {}, accName = {}, accCcy = {}, ccy = {};
    for (const c of cats || []) catName[c.id] = c.name;
    for (const o of ops || []) opName[o.id] = o.name;
    for (const a of accounts || []) { accName[a.id] = a.name; accCcy[a.id] = a.currency_id; }
    for (const c of currencies || []) ccy[c.id] = c.code;
    return {
      catName, opName, accName, accCcy, ccy,
      projects: projects || { 1: 'Україна', 2: 'Польща', 3: 'Велика Британія', 4: 'США', 5: 'ОАЕ' },
      salaryCategoryId: (config && config.salary && config.salary.category_id) || SALARY_CATEGORY_DEFAULT,
      salaryOps: new Set((salaryOps && salaryOps.length ? salaryOps : SALARY_OPS_DEFAULT).map(Number)),
      marketerArts: marketerArtsOf(config),
    };
  }

  /* Перевірка, що статті з rules.json (reference.articles) існують у CRM з тими самими назвами. */
  function checkArticles(doc, live) {
    const problems = [];
    for (const a of (doc.reference && doc.reference.articles) || []) {
      const c = live.catName[a.category_id], o = live.opName[a.operation_id];
      if (c === undefined) problems.push(`категорії id ${a.category_id} («${a.category}») немає в CRM`);
      else if (R.normText(c) !== R.normText(a.category)) problems.push(`категорія id ${a.category_id}: у CRM «${c}», у rules.json «${a.category}»`);
      if (o === undefined) problems.push(`статті id ${a.operation_id} («${a.name}») немає в CRM`);
      else if (R.normText(o) !== R.normText(a.name)) problems.push(`стаття id ${a.operation_id}: у CRM «${o}», у rules.json «${a.name}»`);
    }
    return problems;
  }

  function articleLabel(live, catId, opId) {
    if (catId == null && opId == null) return '';
    const c = live && live.catName[catId], o = live && live.opName[opId];
    if (c && o) return R.normText(c) === R.normText(o) ? c : `${c} / ${o}`;
    return `${c || 'кат. ' + catId} / ${o || 'ст. ' + opId}`;
  }

  /* invoice-payment → нормалізований запис для рушія правил. */
  function normalizeRecord(raw, live) {
    const pays = (raw.payments || []).filter(p => !p.deleted_at);
    const ops = pays.map(p => Number(p.operation));
    let type = 'unknown';
    if (ops.some(o => o === 3 || o === 4)) type = 'transfer';
    else if (ops.some(o => o === 5 || o === 6)) type = 'exchange';
    else if (ops.includes(1)) type = 'income';
    else if (ops.includes(2)) type = 'expense';
    // головний платіж: для переказу/обміну — списання (4/6), інакше перший
    const main = pays.find(p => [4, 6].includes(Number(p.operation))) || pays[0] || {};
    const text = [raw.comment, ...pays.map(p => p.comment)].filter(Boolean).join(' | ');
    const accIds = pays.map(p => p.invoice_id);
    const accNames = pays.map(p => (p.invoice && p.invoice.name) || (live && live.accName[p.invoice_id]) || ('рахунок ' + p.invoice_id));
    const ccyId = (main.invoice && main.invoice.currency_id) || (live && live.accCcy[main.invoice_id]);
    const catId = main.pnl_category_id == null ? null : Number(main.pnl_category_id);
    const opId = main.pnl_operation_id == null ? null : Number(main.pnl_operation_id);
    const salaryCat = (live && live.salaryCategoryId) || SALARY_CATEGORY_DEFAULT;
    const salaryOps = (live && live.salaryOps) || new Set(SALARY_OPS_DEFAULT);
    // автоматичний запис (модуль ЗП, підтвердження виведення з балансу): is_manual=false або
    // дата = час створення до секунди і секунди ≠ 00 (так розпізнає cashflow_import.js → autoReason)
    const autoByTime = !!(raw.date && raw.created_at && raw.date === raw.created_at && !/:00(\.0+)?Z$/.test(raw.date));
    const rec = {
      id: raw.id,
      date: kyivDate(raw.date),
      period: raw.period ? kyivDate(raw.period).slice(0, 7) + '-01' : null,
      created: kyivDate(raw.created_at),
      text,
      textApos: R.normApos(text), textNorm: R.normText(text), textFold: R.fold(text), textCyr: R.toCyr(text),
      comment: raw.comment || '',
      type, n_payments: pays.length,
      category_id: type === 'income' || type === 'expense' ? catId : null,
      operation_id: type === 'income' || type === 'expense' ? opId : null,
      project_id: raw.project_id == null ? null : Number(raw.project_id),
      account_ids: accIds, account_names: accNames,
      amount: Number(main.amount) || 0,
      currency: (live && live.ccy[ccyId]) || (ccyId ? 'валюта ' + ccyId : ''),
      is_lead: raw.task_payment_id != null,
      // ручним вважається лише запис з явним is_manual = true; будь-що інше (false, null, немає поля) — автоматичний, не чіпаємо
      is_auto: !(raw.is_manual === true || raw.is_manual === 1 || raw.is_manual === '1') || autoByTime,
      is_edited: !!raw.is_edited,
      is_salary: pays.some(p => salaryOps.has(Number(p.pnl_operation_id)) || Number(p.pnl_category_id) === salaryCat),
      deleted: !!raw.deleted_at,
    };
    rec.category_label = articleLabel(live, rec.category_id, rec.operation_id);
    rec.project_label = rec.project_id == null ? '' : ((live && live.projects[rec.project_id]) || 'проєкт ' + rec.project_id);
    return rec;
  }

  /* Зміни від рушія правил → тіло PUT (рядкові значення, як надсилає форма сайту). */
  function buildUpdate(changes) {
    const body = {};
    for (const ch of changes) {
      if (ch.field === 'category') {
        if (!ch.to || ch.to.category_id == null || ch.to.operation_id == null) throw new Error('стаття без id');
        body.pnl_category_id = String(ch.to.category_id);
        body.pnl_operation_id = String(ch.to.operation_id);
      } else if (ch.field === 'project') {
        if (ch.to == null) throw new Error('порожній проєкт не встановлюється');
        body.project_id = String(ch.to);
      } else throw new Error(`поле «${ch.field}» лінтер не змінює`);
    }
    for (const k of Object.keys(body)) if (!PUT_FIELDS.includes(k)) throw new Error(`заборонене поле ${k}`);
    if (!Object.keys(body).length) throw new Error('немає змін');
    return body;
  }

  /* Відмова CRM на зміну чи створення запису (оновлення сайту 29.10.2026, як у його notifyFinancialError):
     закритий місяць — HTTP 422 з errors.period, бракує прав — HTTP 403. r — {status, json, text}.
     → {kind: 'closed' | 'rights' | 'invalid' (інший 422) | 'error', message} */
  const CLOSED_PERIOD_MESSAGE = 'Місяць закрито. Внесіть операцію в новий відкритий період';
  const NO_RIGHTS_MESSAGE = 'Недостатньо прав для виконання цієї дії';
  const FULL_EDIT = '«Повне редагування операцій Cash Flow»';
  function crmFailure(r) {
    const j = (r && r.json) || null, errs = j && j.errors && typeof j.errors === 'object' ? j.errors : null;
    const strs = v => [v].flat().filter(x => typeof x === 'string' && x.trim());
    if (r.status === 422 && errs && Object.prototype.hasOwnProperty.call(errs, 'period')) return { kind: 'closed', message: strs(errs.period).join(' ') || CLOSED_PERIOD_MESSAGE };
    if (r.status === 403) return { kind: 'rights', message: (j && j.message) || NO_RIGHTS_MESSAGE };
    const msg = errs ? Object.values(errs).flatMap(strs).join('; ') : '';
    return { kind: r.status === 422 ? 'invalid' : 'error', message: msg || (j && (j.message || j.error)) || (r.text ? String(r.text).slice(0, 200) : '') };
  }
  /* Те саме як помилка з текстом для журналу: put — зміна запису, post — нова операція. err.kind — як у crmFailure. */
  function crmError(r, action) {
    const f = crmFailure(r);
    const text = f.kind === 'closed' ? `місяць закрито в CRM («${f.message}»): ${action === 'post' ? 'внесіть операцію з періодом відкритого місяця' : 'змінити запис закритого місяця може лише Адмін'}`
      : f.kind === 'rights' ? `CRM: «${f.message}» — ${action === 'post' ? 'у вашої ролі немає права вносити операції' : `потрібне право ${FULL_EDIT}`}`
        : `CRM відповів HTTP ${r.status}${f.message ? ': ' + f.message : ''}`;
    return Object.assign(new Error(text), { kind: f.kind, status: r.status });
  }
  /* Права на кешфлоу з GET user/{id} → permissions.invoice. З 29.10.2026 статтю, проєкт, тип, суму змінює лише
     роль з operation_full_edit; з самим operation_edit CRM дає змінити тільки коментар. null — прав не видно. */
  function cashflowRights(user) {
    const u = user && user.data && user.data.permissions ? user.data : user;
    const p = u && u.permissions && u.permissions.invoice;
    if (!p || typeof p !== 'object') return null;
    const on = v => v === true || v === 1 || v === '1';
    return { full: on(p.operation_full_edit), edit: on(p.operation_full_edit) || on(p.operation_edit), role: (u.role && u.role.name) || '' };
  }
  const noFullText = r => `У вашої ролі${r && r.role ? ` «${r.role}»` : ''} немає права ${FULL_EDIT}: з 29.10.2026 без нього CRM дає змінити в записі лише коментар. Попросіть адміністратора CRM додати це право.`;

  /* Закриті місяці (P&L → «Закриття періоду»): CRM перевіряє період запису, лінтер пам'ятає «закрито по РРРР-ММ» включно.
     monthOf — місяць «РРРР-ММ» з 'РРРР-ММ-ДД' (period після normalizeRecord), 'ДД-ММ-РРРР' (форма CRM, реєстр) чи 'РРРР-ММ';
     сирі UTC-дати API спершу через kyivDate. openFrom — перший відкритий день після закритих: 'РРРР-ММ-01'. */
  function monthOf(s) {
    const t = String(s || '').trim();
    let m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(t);
    if (m) return `${m[1]}-${m[2]}`;
    m = /^\d{2}[-.](\d{2})[-.](\d{4})(?:\s.*)?$/.exec(t);
    return m ? `${m[2]}-${m[1]}` : null;
  }
  function openFrom(through) {
    const m = monthOf(through);
    if (!m) return null;
    let [y, mo] = m.split('-').map(Number);
    if (++mo > 12) { mo = 1; y++; }
    return `${y}-${String(mo).padStart(2, '0')}-01`;
  }
  const isClosedMonth = (period, through) => { const a = monthOf(period), b = monthOf(through); return !!(a && b && a <= b); };
  const monthUa = s => { const m = monthOf(s); return m ? `${m.slice(5)}.${m.slice(0, 4)}` : ''; };

  /* Тіло PUT для відкату: повернути значення з резервної копії.
     Порожнє значення (запис був без проєкту / без статті) API лінтер не відправляє — це поле
     потрапляє в manual («повернути вручну»), щоб не надсилати неперевірений запит. */
  function buildRestore(rawBefore, fields) {
    const rec = normalizeRecord(rawBefore, null);
    const body = {}, manual = [];
    if (fields.includes('category')) {
      if (rec.category_id == null) manual.push('стаття: у резервній копії порожня — поверніть вручну');
      else { body.pnl_category_id = String(rec.category_id); body.pnl_operation_id = String(rec.operation_id); }
    }
    if (fields.includes('project')) {
      if (rec.project_id == null) manual.push('проєкт: до лінтера був порожній — поверніть «без проєкту» вручну');
      else body.project_id = String(rec.project_id);
    }
    return { body, manual };
  }

  /* Після PUT: цільові поля мають нові значення, захищені — без змін. */
  function verifyUpdate(beforeRaw, afterRaw, body) {
    const b = normalizeRecord(beforeRaw, null), a = normalizeRecord(afterRaw, null), problems = [];
    if (body.pnl_category_id != null && String(a.category_id) !== String(body.pnl_category_id)) problems.push(`стаття: очікувалась категорія ${body.pnl_category_id}, у записі ${a.category_id}`);
    if (body.pnl_operation_id != null && String(a.operation_id) !== String(body.pnl_operation_id)) problems.push(`стаття: очікувалась ${body.pnl_operation_id}, у записі ${a.operation_id}`);
    if (body.project_id != null && String(a.project_id) !== String(body.project_id)) problems.push(`проєкт: очікувався ${body.project_id}, у записі ${a.project_id}`);
    // поля, яких немає в запиті, не мали змінитись
    if (body.pnl_operation_id == null && (a.category_id !== b.category_id || a.operation_id !== b.operation_id)) problems.push(`змінилась стаття: ${b.category_id}/${b.operation_id} → ${a.category_id}/${a.operation_id}`);
    if (body.project_id == null && a.project_id !== b.project_id) problems.push(`змінився проєкт: ${b.project_id} → ${a.project_id}`);
    if (a.period !== b.period) problems.push(`змінився період: ${b.period} → ${a.period}`);
    if (a.amount !== b.amount) problems.push(`змінилась сума: ${b.amount} → ${a.amount}`);
    if (a.date !== b.date) problems.push(`змінилась дата: ${b.date} → ${a.date}`);
    if (a.account_ids.join(',') !== b.account_ids.join(',')) problems.push(`змінився рахунок: ${b.account_ids} → ${a.account_ids}`);
    if (a.type !== b.type) problems.push(`змінився тип: ${b.type} → ${a.type}`);
    if ((afterRaw.comment || '') !== (beforeRaw.comment || '')) problems.push('змінився коментар');
    return { ok: !problems.length, problems };
  }

  return { PUT_FIELDS, OP_TYPE, TYPE_UA, SALARY_OPS_DEFAULT, SALARY_CATEGORY_DEFAULT, CLOSED_PERIOD_MESSAGE, marketerArtsOf, kyivDate, kyivNow, buildLiveRef, checkArticles, articleLabel, normalizeRecord, buildUpdate, buildRestore, verifyUpdate,
    crmFailure, crmError, cashflowRights, noFullText, monthOf, openFrom, isClosedMonth, monthUa };
}));
