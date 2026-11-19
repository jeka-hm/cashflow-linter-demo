// Демо-сторінка docs/index.html без браузера: ті самі docs/demo/data.js і docs/demo/stub.js, що їх вантажить сторінка,
// + «Звірка з банком» (ui/bank-panel.js) на імітованій сторінці (test/lib/panel-harness.js).
// Запити панелі йдуть тим самим шляхом, що в браузері: fetch → підміна (stub) → вигаданий CRM і вигаданий «Помічник».
// Чого тут немає: справжнього браузера (верстка, кліки мишею, повна панель з трьома вкладками) — це перевіряється очима.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const H = require('./lib/panel-harness.js'); // ставить globalThis.localStorage і «мережі немає»
const D = require('../docs/demo/data.js');
const Stub = require('../docs/demo/stub.js');
const BP = require('../ui/bank-panel.js');
const L = require('../core/linter.js');
const CFD = require('../core/drafts.js');
const { demoBundle, DEMO_CHECK, HOST_CHECK } = require('../build/build-demo.js');

const ARTICLES = H.RULES.reference.articles;
const plain = s => String(s).replace(/[  ]/g, ' ');

/** Панель «Звірка з банком» на підміні fetch — як її запускає bookmarklet/main.js на демо-сторінці. */
async function openDemo(year, month) {
  const data = D.make({ year, month, articles: ARTICLES });
  const win = { location: { origin: 'https://demo.test' } }, log = [];
  const stub = Stub.install(win, data, { log: t => log.push(t) });
  globalThis.fetch = win.fetch; // панель питає «Помічник» через fetch
  localStorage.setItem('cfl_helper_url', JSON.stringify(stub.helper));
  const rawFetch = async (method, p, body) => { // те саме, що rawFetch у bookmarklet/main.js
    const headers = { Authorization: 'Bearer ' + stub.token, Accept: 'application/json' };
    const form = typeof FormData !== 'undefined' && body instanceof FormData;
    if (body && !form) headers['Content-Type'] = 'application/json';
    const r = await win.fetch(win.location.origin + '/api/' + p, { method, headers, body: body ? (form ? body : JSON.stringify(body)) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text: json ? '' : text.slice(0, 500), retryAfter: 0 };
  };
  const api = L.makeApi(rawFetch, { minInterval: 0 });
  const el = new H.El('root'), files = [];
  const storage = { saveFile: async name => { files.push(name); }, keepFile: async name => { files.push(name); return { where: 'helper', path: name }; } };
  const P = BP.mount(el, { api, storage, applyAllowed: true, dialog: async () => true, projects: H.RULES.reference.projects, rulesDoc: JSON.parse(JSON.stringify(H.RULES)),
    drafts: Object.assign(CFD.make(api, { on: () => true }), { subscribe() {} }) });
  const $ = k => el.querySelector(`[data-b="${k}"]`);
  $('from').value = data.from;
  $('to').value = data.to;
  await $('fetch').onclick(); // «Отримати виписки й звірити»
  await H.tick();
  const click = async k => { const b = $('out').querySelector(`[data-b="${k}"]`); assert.equal(typeof b.onclick, 'function', `кнопки «${k}» немає`); await b.onclick(); await H.tick(); };
  return { data, stub, api, P, S: P.state, $, click, log, files, rawFetch, get txt() { return plain(H.textOf($('out').innerHTML)); }, get notes() { return H.textOf($('notes').innerHTML); } };
}

test('демо: дані вигадані й самоузгоджені — виписки сходяться самі з собою, записи CRM мають відомі статті й рахунки', () => {
  for (const [y, m] of [[2026, 10], [2027, 2], [2028, 2], [2027, 1]]) { // звичайний місяць, лютий, високосний лютий, січень (попередній місяць — у минулому році)
    const d = D.make({ year: y, month: m, articles: ARTICLES });
    assert.match(d.from, /^\d{4}-\d\d-01$/);
    for (const a of d.bank.accounts) {
      const sum = a.transactions.reduce((s, t) => s + (a.bank === 'mono' ? t.amount / 100 : Number(t.SUM) * (t.TRANTYPE === 'D' ? -1 : 1)), 0);
      assert.equal(Math.round((a.opening + sum) * 100), Math.round(a.closing * 100), `${a.name}: вхідний + рух = вихідний`);
      assert.match(a.acc, /^UA0{15,}\d+$/, 'IBAN — з нулів (вигаданий)');
    }
    const cats = new Set(d.cats.map(c => c.id)), ops = new Set(d.ops.map(o => o.id)), accs = new Set(d.accounts.map(a => a.id));
    for (const r of d.records) for (const p of r.payments) {
      assert.ok(accs.has(p.invoice_id));
      if (p.pnl_category_id != null) assert.ok(cats.has(p.pnl_category_id) && ops.has(p.pnl_operation_id), `стаття запису ${r.id} є в довіднику`);
    }
  }
  assert.deepEqual(D.previousMonth(new Date('2027-01-15T12:00:00Z')), { year: 2026, month: 12 });
  assert.deepEqual(D.previousMonth(new Date('2026-12-01T00:30:00+02:00')), { year: 2026, month: 11 });
});

test('демо: «Звірка з банком» через підміну fetch показує всі закладені розбіжності', async () => {
  const r = await openDemo(2026, 10);
  assert.ok(!/class="err/.test(r.$('notes').innerHTML), r.notes);
  const t = r.txt;
  // рахунки: Моно сходиться, решта — з поясненнями
  assert.match(t, /ФОП Хоменко Всеволод Сергійович Моно id 69 · UAH сходиться/);
  // (3) LiqPay: оплата + комісія = зарахування
  assert.match(t, /LiqPay: оплата ліда \+ запис «Комісія LiqPay» = зарахування в банку: 12\.10\.2026 зараховано 838,95 = ID \d+ \(850,00\) − комісія ID \d+ \(11,05\) — сходиться/);
  // (5) податки із ЗП по людях і ЗП через транзитний рахунок
  assert.match(t, /Податки із ЗП за день — у CRM по людях: 15\.10\.2026 ВЗ \+ ПДФО на 3 000,00 = 3 записи .* — сходиться/);
  assert.match(t, /банк 15\.10\.2026 27 000,00 = записи CRM .*\(12 600,00\) \+ .*\(9 000,00\) \+ .*\(5 400,00\) — сходиться/);
  // (6) платіж і його повернення
  assert.match(t, /Платіж і його повернення \(разом 0\): 20\.10\.2026 640,00 ФОП Постачальник Демо — повернено 20\.10\.2026 — у CRM не вносяться/);
  // (4) покупка карткою 13.10, яку банк провів 16.10, — не розбіжність: бракує лише покупки 18.10
  assert.match(t, /покупки карткою, яких немає в CRM: 18\.10\.2026 777,77/);
  assert.ok(!/1 234,56[^.]{0,60}немає в CRM/.test(t), 'покупка з пізнішою датою банку знайдена в CRM');
  // (1) перекази між своїми: один є, одного бракує; (2) продаж валюти — переказ з валютного рахунку, не дохід
  assert.deepEqual(r.S.lastProps.map(p => [p.date, p.amount, p.from, p.to]), [['2026-10-07', 5600, 68, 33], ['2026-10-08', 41250, 36, 33], [r.S.lastProps[2].date, 745.82, 68, 89]]);
  assert.match(t, /Продаж 1000\.00 USD з «Приват долар ТОВ ПРИКЛАД СЕРВІС 0036» за курсом банку 41\.25/);
  assert.ok(!r.S.lastRecs.some(p => p.amount === 41250), 'гривня від продажу валюти не пропонується доходом');
  assert.ok(!r.S.lastRecs.some(p => p.amount === 2000), 'переказ Приват → Моно є в CRM — не пропонується');
  // (7) підписка за тарифом, (8) комісії банку за правилом R-COMM-01, покупка карткою без запису
  const recs = r.S.lastRecs.map(p => [p.amount, p.acc, (p.rule && p.rule.art && p.rule.art.art) || '', (p.sub && p.sub.plan) || '']).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(recs, [[45, 33, '76/82', ''], [123.75, 33, '76/82', ''], [777.77, 89, '', ''], [1000, 36, '', ''], [1699, 68, '44/20', 'PRO']]);
  assert.match(t, /Підписка PRO 1 міс\. — Мельничук Злата Петрівна/);
  // (9) поповнення картки, записане витратою
  assert.deepEqual(r.S.lastTypes.map(p => [p.date, p.amount, p.why]), [['2026-10-14', 1600, 'поповнення корп. картки записано витратою']]);
  // виписки прийшли від «Помічника», записи — від «CRM»
  for (const c of ['GET helper:/api/panel/bank/status', 'POST helper:/api/panel/bank/fetch', 'GET helper:/api/panel/bank/file', 'GET crm:invoice', 'GET crm:invoice-payment', 'GET crm:invoice-payment-drafts']) {
    assert.ok(r.stub.state.calls.includes(c), `панель мала надіслати ${c}`);
  }
});

test('демо: «Створити позначені» створює чернетки у вигаданому CRM; після нової звірки чернетки враховано', async () => {
  const r = await openDemo(2026, 10);
  // переказ між своїми, якого бракує
  const own = r.S.lastProps.find(p => p.amount === 5600);
  r.S.xp.get(own.key).on = true;
  await r.click('xcreate');
  // комісія банку — стаття вже є за правилом; покупка карткою — статтю й маркетолога вибирає людина
  const fee = r.S.lastRecs.find(p => p.amount === 45);
  Object.assign(r.S.rp.get(fee.key), { on: true });
  await r.click('rcreate');
  const drafts = [...r.stub.state.DRAFTS.values()].map(d => d.data);
  assert.equal(drafts.length, 2, r.notes);
  const x = drafts.find(d => String(d.operation) === '3'), f = drafts.find(d => String(d.operation) === '2');
  assert.deepEqual([Number(x.invoice_from), Number(x.invoice_to), Number(x.amount)], [68, 33, 5600]);
  assert.deepEqual([Number(f.invoice_id), Number(f.pnl_category_id), Number(f.pnl_operation_id), Number(f.amount)], [33, 76, 82, 45]);
  assert.equal(r.stub.state.DB.size, r.data.records.length, 'у кешфлоу нічого не записано — лише чернетки');
  assert.ok(r.files.some(n => /журнал/.test(n)), 'журнал створення збережено');
  // ще раз «Звірити»: створені чернетки звіряються як записи — ці дві операції більше не пропонуються
  await r.$('calc').onclick();
  await H.tick();
  assert.ok(!r.S.lastProps.some(p => p.amount === 5600), 'переказ уже є (чернеткою)');
  assert.ok(!r.S.lastRecs.some(p => p.amount === 45), 'комісія вже є (чернеткою)');
  assert.match(r.notes, /враховано чернеток CRM — 2/);
});

test('демо: вигаданий CRM відповідає як справжній — вхід, сторінки, PUT, чернетка → запис, видалення чернетки', async () => {
  const data = D.make({ year: 2026, month: 10, articles: ARTICLES });
  const win = { location: { origin: 'https://demo.test' } };
  const stub = Stub.install(win, data, {});
  const call = async (method, p, body, token) => {
    const r = await win.fetch('https://demo.test/api/' + p, { method, headers: { Authorization: 'Bearer ' + (token || stub.token), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [r.status, r.status === 204 ? null : await r.json()];
  };
  assert.equal((await call('GET', 'currency', null, 'wrong-token'))[0], 401);
  const [, page] = await call('GET', 'invoice?page=1&per_page=100');
  assert.deepEqual(page.data.map(a => a.id), [33, 36, 68, 69, 89]);
  assert.equal(page.data.find(a => a.id === 69).balance, 46730, 'залишок рахунку = сума записів');
  const [, list] = await call('GET', 'invoice-payment?date_from=01-10-2026&date_to=31-10-2026&per_page=10&page=1');
  assert.equal(list.last_page, Math.ceil(list.total / 10));
  assert.ok(list.data.every(x => x.payments[0].invoice && !('marketer_balance_history' in x) && !('kyiv' in x)));
  assert.equal((await call('GET', 'invoice-payment-drafts?per_page=500'))[0], 422, 'як у CRM: не більше 100 на сторінку');
  // «Виправити»: витрата → переказ на рахунок картки
  const wrong = data.records.find(x => /Поповнення корп каркти/.test(x.comment));
  const [st, put] = await call('PUT', 'invoice-payment/' + wrong.id, { operation: 3, invoice_from: 68, invoice_to: 89 });
  assert.equal(st, 200);
  assert.deepEqual(put.payments.map(p => [p.invoice_id, p.operation, p.pnl_category_id]), [[68, 4, null], [89, 3, null]]);
  // зарплатну статтю CRM змінити не дає
  const sal = data.records.find(x => x.payments[0].pnl_operation_id === 47);
  assert.equal((await call('PUT', 'invoice-payment/' + sal.id, { pnl_category_id: 47, pnl_operation_id: 31 }))[0], 422);
  // чернетка → запис з тим самим ID; видалена чернетка зникає
  const form = { date: '21-10-2026 12:00', period: '01-10-2026', operation: 2, invoice_id: 33, amount: 45, currency_id: 1, pnl_category_id: 76, pnl_operation_id: 82, project_id: 1, comment: 'Комісія банку' };
  const [c1, d1] = await call('POST', 'invoice-payment-drafts', form);
  assert.deepEqual([c1, d1.status], [201, 'draft']);
  assert.equal((await call('GET', 'invoice-payment/' + d1.id))[0], 404, 'чернетки серед записів немає');
  const [c2, made] = await call('POST', `invoice-payment-drafts/${d1.id}/convert`);
  assert.deepEqual([c2, made.data.id, made.data.payments[0].amount], [200, d1.id, 45]);
  const [, d2] = await call('POST', 'invoice-payment-drafts', form);
  assert.equal((await call('DELETE', 'invoice-payment-drafts/' + d2.id))[0], 204);
  assert.equal((await call('GET', 'invoice-payment-drafts/' + d2.id))[0], 404);
  // реклама без маркетолога — відмова, як у CRM
  assert.equal((await call('POST', 'invoice-payment', { ...form, pnl_category_id: 20, pnl_operation_id: 30 }))[0], 422);
  // виписка за частину місяця: залишки перераховано
  const part = stub.bankFor('2026-10-10', '2026-10-20');
  for (const a of part.accounts) {
    const sum = a.transactions.reduce((s, t) => s + (a.bank === 'mono' ? t.amount / 100 : Number(t.SUM) * (t.TRANTYPE === 'D' ? -1 : 1)), 0);
    assert.equal(Math.round((a.opening + sum) * 100), Math.round(a.closing * 100));
  }
});

test('демо-збірка: та сама панель, перевірка домену замінена на «демо-сторінка», коду реєстру погоджень немає; сторінка вантажить лише свої файли', () => {
  const code = demoBundle();
  assert.ok(code.includes(DEMO_CHECK) && !code.includes(HOST_CHECK));
  assert.ok(!code.includes('CF_REGISTRY_RUN = function'));
  assert.doesNotThrow(() => new Function(code));
  const html = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
  assert.match(html, /Демо на вигаданих даних/);
  const srcs = [...new Set([...html.matchAll(/(?:src|href)\s*=\s*["']([^"'?]+)/g)].map(m => m[1]))];
  assert.deepEqual(srcs.sort(), ['demo/cashflow_linter.demo.js', 'demo/data.js', 'demo/reference.js', 'demo/stub.js'], 'лише відносні шляхи до файлів демо — без сторонніх серверів');
  for (const s of ['demo/data.js', 'demo/stub.js']) assert.ok(fs.existsSync(path.join(ROOT, 'docs', s)));
  // скрипт сторінки — синтаксично правильний
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(inline.length, 1);
  assert.doesNotThrow(() => new Function(inline[0]));
});

test('демо-збірка виконується на імітованій сторінці: проходить перевірку «демо», монтує панель, питає «CRM» про права й «Помічник» про стан', async () => {
  const vm = require('vm');
  const data = D.make({ year: 2026, month: 10, articles: ARTICLES }), added = [], alerts = [];
  const mk = sel => { const e = new H.El(sel); Object.assign(e, { appendChild: c => { added.push(c); return c; }, remove() {}, setAttribute() {}, getAttribute: () => null, matches: () => false }); return e; };
  const win = { location: { origin: 'https://demo.test', hostname: 'demo.test' }, CF_DEMO: true, CF_LINTER_CONFIG: { APPLY: true },
    document: { getElementById: () => null, createElement: t => mk(t), body: mk('body'), head: mk('head'), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
    localStorage, console, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, FormData, Headers, Response, AbortController, TextEncoder, Intl,
    alert: m => alerts.push(m), confirm: () => true, navigator: { userAgent: 'node' }, MutationObserver: class { observe() {} } };
  win.window = win.globalThis = win.self = win;
  const stub = Stub.install(win, data, {});
  localStorage.setItem('token', JSON.stringify(stub.token));
  localStorage.setItem('user_id', '5');
  localStorage.setItem('cfl_helper_url', JSON.stringify(stub.helper));
  localStorage.setItem('cfl_tab', JSON.stringify('bank'));
  vm.createContext(win);
  vm.runInContext(demoBundle(), win, { filename: 'cashflow_linter.demo.js' });
  await new Promise(r => setTimeout(r, 400));
  assert.deepEqual(alerts, [], 'без «відкрийте сайт CRM» і без «немає токена»');
  assert.ok(added.some(e => e.id === 'cfl-panel'), 'панель додано на сторінку');
  assert.equal(typeof win.CFPanel, 'object');
  assert.equal(typeof win.CF_REGISTRY_RUN, 'undefined', 'реєстру погоджень у публічній збірці немає');
  assert.ok(stub.state.calls.includes('GET crm:user/5') && stub.state.calls.includes('GET helper:/api/panel/bank/status'), stub.state.calls.join(' | '));
  // без позначки «демо» та сама збірка не запускається
  const other = { ...win, CF_DEMO: undefined, alert: m => alerts.push(m) };
  other.window = other.globalThis = other.self = other;
  vm.createContext(other);
  vm.runInContext(demoBundle(), other);
  assert.equal(alerts.length, 1);
});

test('демо: «Статті й проєкти» через підміну fetch — довідники вигаданого CRM збігаються з правилами, перевірка знаходить запис з не тією статтею', async () => {
  const data = D.make({ year: 2026, month: 10, articles: ARTICLES });
  const win = { location: { origin: 'https://demo.test' } };
  const stub = Stub.install(win, data, {});
  const rawFetch = async (method, p, body) => {
    const r = await win.fetch('https://demo.test/api/' + p, { method, headers: { Authorization: 'Bearer ' + stub.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text: json ? '' : text, retryAfter: 0 };
  };
  const linter = L.createLinter({ api: L.makeApi(rawFetch, { minInterval: 0 }), rulesDoc: JSON.parse(JSON.stringify(H.RULES)) });
  const out = await linter.run({ from: data.from, to: data.to }); // назви статей у CRM інші — тут була б помилка «не збігається»
  assert.equal(out.fetched, data.records.filter(r => r.kyiv >= data.from).length);
  const by = st => out.results.filter(r => r.status === st).map(r => r.record.comment);
  assert.deepEqual(by('fix'), ['Hetzner: сервер за місяць'], 'сервер у статті «Офіс» — правило пропонує «Інфраструктура»');
  assert.deepEqual(by('review'), ['Дмитро Миколаївський: Поповнення корп каркти, для реклами ФБ']);
});
