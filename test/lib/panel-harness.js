// «Звірка з банком» (ui/bank-panel.js) на імітованій сторінці: без мережі й без CRM — записи CRM і виписки передає тест.
// Звірка йде тим самим шляхом, що в браузері: «Додати файл .json» → «Звірити»; HTML розділів — у el.querySelector('[data-b="out"]').
// Використання: const r = await run({accounts, records, banks}); r.S — стан панелі (lastAll, lastRecs, lastMt…), r.txt — текст.
// Режим чернеток CRM (core/drafts.js) і створення записів кнопками панелі — параметри drafts, draftMode, create (див. run).
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

globalThis.fetch = () => Promise.reject(new Error('тест без мережі'));
const store = new Map();
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const BP = require(path.join(ROOT, 'ui', 'bank-panel.js'));
const CFD = require(path.join(ROOT, 'core', 'drafts.js'));
const RULES = JSON.parse(require('fs').readFileSync(path.join(ROOT, 'rules', 'rules.json'), 'utf8'));

class El {
  constructor(sel) {
    this.sel = sel; this._html = ''; this.kids = new Map(); this.dataset = {}; this.style = {}; this.value = ''; this.hidden = false; this.disabled = false; this.textContent = '';
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } }; this.offsetParent = null;
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.kids = new Map(); }
  insertAdjacentHTML(pos, h) { this._html += h; }
  querySelector(s) { if (!this.kids.has(s)) this.kids.set(s, new El(s)); return this.kids.get(s); }
  querySelectorAll() { return []; }
  closest() { return null; }
  contains() { return false; }
  addEventListener() {}
  click() {}
  focus() {}
}
const textOf = h => String(h).replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/[  ]/g, ' ').replace(/\s+/g, ' ');

// запис CRM: rec(id, 'РРРР-ММ-ДД', [[рахунок, операція (1 дохід, 2 витрата, 3/4 переказ), сума]], коментар)
const rec = (id, kyiv, pays, comment) => ({ id, date: `${kyiv}T12:00:00+03:00`, period: `${kyiv.slice(0, 8)}01T00:00:00+03:00`, comment: comment || `запис ${id}`, task_payment_id: null, deleted_at: null,
  payments: pays.map(([invoice_id, operation, amount], i) => ({ id: id * 10 + i, invoice_id, operation, amount, deleted_at: null })) });
// рядок виписки Привату: tx('ДД.ММ.РРРР', сума зі знаком, призначення, рахунок контрагента, назва контрагента, час)
let seq = 0;
const tx = (d, s, p, cp, cpn, t) => {
  const n = ++seq;
  return { ID: `T${n}`, DAT_OD: d, TIM_P: t || '10:00', SUM: String(Math.abs(s)), TRANTYPE: s < 0 ? 'D' : 'C', PR_PR: 'r', OSND: p, AUT_CNTR_ACC: cp || '', AUT_CNTR_NAM: cpn || '', REF: `R${n}` };
};
const bankJson = (accs, from, to) => ({ source: 'bank_api', client: 'ТОВ ПРИКЛАД', from: from || '2026-10-01', to: to || '2026-10-31', fetched_at: '01.11.2026 09:00', accounts: accs });
const tick = () => new Promise(r => setTimeout(r, 30));

/* Імітація чернеток CRM (перевірено на справжній CRM 14.11.2026): список — сторінками Laravel, без фільтрів, per_page > 100 → 422;
   за ID — чернетка або 404; POST — 201 і сама чернетка (поля — рядками, як надіслано), ID — з того самого ряду, що й ID записів. */
const draft = (id, data) => ({ id, status: 'draft', user_id: 7, created_at: '2026-11-14T08:00:00.000000Z', updated_at: '2026-11-14T08:00:00.000000Z', data, files: [] });
const httpErr = (status, message) => Object.assign(new Error(message), { status });

/* run({accounts, records, banks, from, to, open, drafts, draftMode, create}):
   draftMode не задано — як раніше: opts.drafts панелі не передається, будь-який запит до чернеток — помилка «тест не чекав запиту»;
   draftMode: false — перемикач є, але вимкнений (так панель живе у лінтері): запит до чернеток — так само помилка;
   draftMode: true — чернетки (drafts — сирі об'єкти CRM) віддає імітація; r.setDrafts(on) — перемкнути, як у шапці панелі;
   create: true — закладка APPLY: вікно підтвердження відповідає «так», api.post записує запити (r.posts), журнал — r.files. */
/* keepStore: true — localStorage лишається від попереднього run (панель «відкрили знову»); keepPeriod: true — дати не ставляться:
   звіряється період, який панель сама поставила при відкритті; hist — записи CRM, які віддаються на запит історії рахунку (invoice_ids). */
async function run({ accounts, records, banks, from, to, open, drafts, draftMode, create, keepStore, keepPeriod, hist, ls, onPost }) {
  if (!keepStore) store.clear();
  for (const [k, v] of Object.entries(ls || {})) store.set(k, JSON.stringify(v)); // ls — що вже запам'ятано в браузері; onPost(шлях, поля) — під час POST
  const el = new El('root');
  const D = (drafts || []).slice(), calls = [], posts = [], files = [], dialogs = [], subs = [];
  let dOn = !!draftMode;
  const draftGet = p => {
    const one = /^invoice-payment-drafts\/(\d+)$/.exec(p);
    if (one) { const d = D.find(x => x.id === Number(one[1])); if (!d) throw httpErr(404, 'Запис не знайдено'); return JSON.parse(JSON.stringify(d)); }
    const q = new URLSearchParams(p.replace(/^[^?]*\?/, '')), per = Number(q.get('per_page') || 15), page = Number(q.get('page') || 1);
    if (per > 100) throw httpErr(422, 'The per page field must not be greater than 100.');
    return { current_page: page, data: JSON.parse(JSON.stringify(D.slice((page - 1) * per, page * per))), last_page: Math.max(1, Math.ceil(D.length / per)), total: D.length };
  };
  const api = { get: async p => {
    calls.push('GET ' + p);
    if (/^invoice\?page=/.test(p)) return { data: accounts, last_page: 1 };
    if (p === 'currency') return [{ id: 1, code: 'UAH' }];
    if (p === 'pnl/operation-config') return null;
    if (/^user\//.test(p)) return [];
    // пошук дублів перед створенням (amount_from … invoice_ids[]) — лише з create; чернеток у списку записів CRM немає
    if (create && /^invoice-payment\?/.test(p) && /amount_from=/.test(p)) return records.filter(r => CFD.matches(r, p));
    if (/^invoice-payment\?/.test(p)) return /invoice_ids/.test(p) ? hist || [] : records;
    if (dOn && /^invoice-payment-drafts(\?|\/\d+$)/.test(p)) return draftGet(p);
    throw new Error('тест не чекав запиту GET ' + p);
  } };
  if (create) api.post = async (p, form) => {
    const data = typeof form.entries === 'function' ? Object.fromEntries(form.entries()) : form; // чернетка — об'єктом (JSON з числами)
    posts.push({ path: p, data });
    calls.push('POST ' + p);
    if (onPost) onPost(p, data);
    if (p !== 'invoice-payment-drafts') throw new Error('тест не чекав запиту POST ' + p);
    const id = Math.max(27230, ...records.map(r => r.id), ...D.map(d => d.id)) + 1, d = draft(id, data);
    D.push(d);
    return { status: 201, json: Object.assign({ history: [] }, JSON.parse(JSON.stringify(d))) };
  };
  const storage = create ? { saveFile: async (name, mime, data) => { files.push({ name, data }); }, keepFile: async (name, mime, data, kind) => { files.push({ name, data, kind }); return { where: 'helper', path: 'journals/' + name }; } }
    : { saveFile: () => {} };
  const opts = { api, storage, applyAllowed: !!create, dialog: async (html, yes) => { dialogs.push({ html, yes }); return !!create; }, projects: arguments[0].projects || { 'Україна': 1 }, rulesDoc: JSON.parse(JSON.stringify(RULES)) };
  // як у ui/linter-panel.js: DRF = CFDrafts.make(api, {on}) + subscribe
  if (draftMode !== undefined) opts.drafts = Object.assign(CFD.make(api, { on: () => dOn }), { subscribe: fn => { subs.push(fn); } });
  const P = BP.mount(el, opts);
  const $ = k => el.querySelector(`[data-b="${k}"]`);
  if (!keepPeriod) {
    $('from').value = from || '2026-10-01';
    $('to').value = to || '2026-10-31';
  }
  $('file').files = banks.map((j, i) => ({ name: `b${i}.json`, text: async () => JSON.stringify(j) }));
  await $('file').onchange();
  await $('calc').onclick();
  await tick();
  if (open) { for (const id of open) P.state.open.add(id); await $('calc').onclick(); await tick(); }
  const notesNow = () => textOf($('notes').innerHTML);
  const notes = notesNow();
  // кнопка всередині намальованих розділів (обробник ставить bindXfer / bindRecs після кожного render): 'xcreate', 'rcreate'
  const click = async k => { const b = $('out').querySelector(`[data-b="${k}"]`); if (typeof b.onclick !== 'function') throw new Error(`кнопки «${k}» немає`); await b.onclick(); await tick(); };
  return { S: P.state, P, el, $, notes, errors: /class="err/.test($('notes').innerHTML) ? [notes] : [], get out() { return $('out').innerHTML; }, get txt() { return textOf($('out').innerHTML); },
    calls, posts, files, dialogs, drafts: D, click, get notesNow() { return notesNow(); }, get errorsNow() { return /class="err/.test($('notes').innerHTML) ? [notesNow()] : []; },
    draftCalls: () => calls.filter(c => /invoice-payment-drafts/.test(c)),
    setDrafts: async on => { dOn = !!on; for (const fn of subs) await fn(dOn); await tick(); } };
}
/** Погодження реєстру для «Зіставлення ШІ» (як з дії bank) і перерахунок: рядки — {key, acc, date, amount, recipient, content, id, action, status}. */
async function withApprovals(r, rows) {
  localStorage.setItem('pogodzh_cfg_v1', JSON.stringify({ url: 'https://example.invalid/exec', key: 'k' }));
  Object.assign(r.S.wd, { rows, from: '2026-09-01', to: '2026-11-30', error: '', busy: false });
  r.S.mt = null;
  await r.$('from').onchange();
  await tick();
  return r;
}
module.exports = { run, withApprovals, rec, tx, bankJson, textOf, draft, RULES, El, tick };
