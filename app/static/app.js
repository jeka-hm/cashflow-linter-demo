/* Помічник кешфлоу — інтерфейс. Сервер: app/helper.py (127.0.0.1). */
(() => {
  'use strict';
  const H = window.HELPER;
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = x => (x === null || x === undefined || Number.isNaN(x)) ? 'не знаю' : Number(x).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const kyivToday = () => CFModel.kyivNow().slice(0, 10);
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const iso2dash = s => s.split('-').reverse().join('-');
  $('#ver').textContent = 'v' + H.version;

  // ---------- зв'язок із сервером ----------
  async function hx(method, path, body, headers) {
    const r = await fetch(path, { method, headers: { 'X-Helper-Key': H.key, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text: json ? '' : text.slice(0, 500), retryAfter: Number(r.headers.get('Retry-After')) || 0 };
  }
  async function hj(method, path, body) {
    const r = await hx(method, path, body);
    if (r.status < 200 || r.status >= 300) throw new Error((r.json && r.json.error) || `HTTP ${r.status}`);
    return r.json;
  }
  // CRM — через проксі сервера (токен лише на сервері)
  // зміни (PUT) сервер пропускає лише з позначкою режиму редагування — її ставимо, тільки коли він увімкнений у панелі
  const crmRaw = (method, path, body) => hx(method, '/api/crm/' + path, body, method === 'PUT' && PANEL && PANEL.editing ? { 'X-Helper-Edit': '1' } : null);
  const api = CFLinter.makeApi(crmRaw, { minInterval: 0 }); // паузу ≥300 мс між запитами до CRM тримає сервер Помічника
  const toB64 = data => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const storage = {
    async saveFile(name, mime, data) {
      const j = await hj('POST', '/api/files/save', { name, base64: toB64(data) });
      toast(`Збережено: ${j.kind}/${j.name}`);
      return j;
    },
    pickFile(accept) {
      return new Promise(res => {
        const i = document.createElement('input');
        i.type = 'file'; i.accept = accept;
        i.onchange = async () => { const f = i.files[0]; res(f ? { name: f.name, text: await f.text() } : null); };
        i.click();
      });
    },
  };
  function toast(t) {
    const d = document.createElement('div');
    d.textContent = t;
    d.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#111;color:#fff;padding:8px 14px;border-radius:8px;z-index:99999;max-width:520px';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 4500);
  }

  // ---------- стан ----------
  let STATUS = null, RULES = null, LIVE = null;
  async function refreshStatus() {
    try {
      STATUS = await hj('GET', '/api/status');
      const c = $('#conn');
      c.className = 'conn' + (STATUS.crm.connected ? ' ok' : '');
      c.textContent = STATUS.crm.connected ? `CRM: ${STATUS.crm.user || 'підключено'}` : 'CRM не підключено — див. Налаштування';
    } catch (e) { $('#conn').textContent = 'сервер Помічника не відповідає'; }
  }
  async function liveRef() {
    if (LIVE) return LIVE;
    const list = j => Array.isArray(j) ? j : (j && j.data) || [];
    const accounts = list(await api.get('invoice?get_all=1'));
    const currencies = list(await api.get('currency'));
    LIVE = { accounts, ccyById: Object.fromEntries(currencies.map(c => [c.id, c.code])) };
    return LIVE;
  }

  // ---------- вкладки ----------
  const inited = {};
  function show(tab) {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach(s => s.classList.toggle('on', s.id === 'tab-' + tab));
    if (!inited[tab]) { inited[tab] = true; ({ bank: initBank, lint: initLint, rules: initRules, files: initFiles, settings: initSettings })[tab](); }
    else if (tab === 'files') initFiles();
    else if (tab === 'bank') monoNote(); // галочку «валютні рахунки Моно» могли змінити в «Налаштуваннях»
  }
  // що вивантажить Моно — за поточною галочкою в «Налаштуваннях»
  function monoNote() {
    const e = $('#b-monofx');
    if (e) e.textContent = STATUS && STATUS.bank.mono_currency ? 'Валютні рахунки Моно теж вивантажуються (галочка в «Налаштуваннях»).' : 'З Моно — лише гривневі рахунки (валютні — галочкою в «Налаштуваннях»).';
  }
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => show(b.dataset.tab));

  function needCrm(el) {
    if (STATUS && STATUS.crm.connected) return false;
    el.innerHTML = `<div class="warn">Помічник ще не підключено до CRM. Відкрийте вкладку «Налаштування».</div>`;
    return true;
  }

  // ================= ЗВІРКА З БАНКОМ =================
  function initBank() {
    const el = $('#tab-bank');
    // з 1-го числа місяця вчорашнього дня — інакше 1-го числа «з» > «по» (07.11.2026)
    const y = addDays(kyivToday(), -1);
    el.innerHTML = `<h2>Звірка виписок банку з кешфлоу</h2>
<div class="box"><div class="row">Період: з <input type="date" id="b-from" value="${y.slice(0, 8)}01"> по <input type="date" id="b-to" value="${y}">
 <button class="b" id="b-fetch">Отримати виписки з банків (privat_fetch.py)</button><span id="b-jobst" class="muted"></span></div>
 <pre class="log" id="b-log" style="display:none"></pre>
 <div class="muted">Скрипт бере токени з privat_tokens.json у папці <code id="b-dir"></code>. Моно віддає 1 запит на хвилину: кожен наступний рахунок того самого токена й кожні наступні 31 день періоду — ще хвилина. <span id="b-monofx"></span></div></div>
<div class="box"><h4>Файли виписок</h4><div id="b-files" class="muted">завантажую…</div>
 <div class="row"><button class="b primary" id="b-load">Звірити з кешфлоу</button><button class="b" id="b-refresh">Оновити список</button></div></div>
<div id="b-accs"></div><div id="b-out"></div>`;
    $('#b-dir').textContent = STATUS ? STATUS.bank.dir : '';
    monoNote();
    $('#b-refresh').onclick = loadFiles;
    $('#b-fetch').onclick = startFetch;
    $('#b-load').onclick = loadBank;
    loadFiles();
    if (STATUS && !STATUS.bank.script) $('#b-files').insertAdjacentHTML('beforebegin', `<div class="err">Не знайдено privat_fetch.py у папці ${esc(STATUS.bank.dir)} — вкажіть папку в «Налаштуваннях».</div>`);
  }
  async function loadFiles() {
    try {
      const j = await hj('GET', '/api/bank/files');
      const from = $('#b-from').value, to = $('#b-to').value;
      const want = `${iso2dash(from).replace(/-/g, '.')}_${iso2dash(to).replace(/-/g, '.')}`;
      const files = j.files.filter(f => f.all).concat(j.files.filter(f => !f.all));
      if (!files.length) { $('#b-files').innerHTML = 'Файлів виписок немає — натисніть «Отримати виписки з банків».'; return; }
      const pick = (files.find(f => f.all && f.name.includes(want)) || files.find(f => f.all) || files[0]).name;
      $('#b-files').innerHTML = files.slice(0, 40).map(f => `<label style="display:block"><input type="radio" name="bf" value="${esc(f.name)}"${f.name === pick ? ' checked' : ''}> ${esc(f.name)} <span class="muted">(${(f.size / 1024).toFixed(0)} КБ, ${esc(f.mtime.replace('T', ' '))})</span></label>`).join('');
    } catch (e) { $('#b-files').innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
  }
  async function startFetch() {
    const from = $('#b-from').value, to = $('#b-to').value;
    if (!from || !to || from > to) { alert('Перевірте період'); return; }
    // сьогодні можна, як і в панелі та в Помічнику (helper.py) — 07.11.2026
    if (to > kyivToday()) { alert('Дата «по» пізніша за сьогодні'); return; }
    try { await hj('POST', '/api/bank/fetch', { from, to }); } catch (e) { alert(e.message); return; }
    $('#b-fetch').disabled = true;
    $('#b-log').style.display = 'block';
    for (;;) {
      const j = await hj('GET', '/api/bank/job');
      $('#b-log').textContent = j.log.join('\n');
      $('#b-log').scrollTop = 1e9;
      $('#b-jobst').textContent = j.running ? ' вивантажую…' : (j.code === 0 ? ' готово' : ` завершено з кодом ${j.code}`);
      if (!j.running) break;
      await sleep(1500);
    }
    $('#b-fetch').disabled = false;
    await loadFiles();
  }

  let BANK = [];
  async function loadBank() {
    const out = $('#b-out'), accEl = $('#b-accs');
    out.innerHTML = '';
    if (needCrm(accEl)) return;
    const name = (document.querySelector('input[name=bf]:checked') || {}).value;
    if (!name) { alert('Виберіть файл виписки'); return; }
    accEl.innerHTML = '<div class="muted">читаю виписку і рахунки кешфлоу…</div>';
    try {
      const r = await fetch('/api/bank/file?name=' + encodeURIComponent(name), { headers: { 'X-Helper-Key': H.key } });
      if (!r.ok) throw new Error('файл виписки: HTTP ' + r.status);
      const json = await r.json();
      BANK = CFRecon.bankAccounts(json, name);
      const { accounts, ccyById } = await liveRef();
      const map = (STATUS.config && STATUS.config.account_map) || {};
      const liveAcc = accounts.filter(a => !a.deleted_at);
      for (const b of BANK) {
        const m = CFRecon.autoMatch(b, liveAcc, ccyById);
        b.cand = m.cand;
        b.cfId = (b.iban && map[b.iban] && liveAcc.some(a => a.id === map[b.iban])) ? map[b.iban] : m.id;
        b.note = b.iban && map[b.iban] ? 'збережений вибір' : m.id ? 'автоматично' : m.cand.length > 1 ? 'кілька збігів — виберіть' : 'не знайдено — виберіть';
        b.empty = !b.rows.length && !Number(b.opening) && !Number(b.closing);
      }
      // дати з файлу виписки — у HTML лише як рррр-мм-дд (інше в цій сторінці з ключем Помічника не вставляємо)
      const isoOr = (v, d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : esc(d));
      const opts = sel => `<option value="">— не звіряти —</option>` + liveAcc.map(a => `<option value="${a.id}"${a.id === sel ? ' selected' : ''}>${esc(a.name)} (id ${a.id})</option>`).join('');
      accEl.innerHTML = `<div class="box"><h4>Рахунки з виписки (${BANK.length}) → рахунки кешфлоу</h4>
<table class="t"><tr><th></th><th>Банк</th><th>Рахунок</th><th>Валюта</th><th>Клієнт</th><th>Операцій</th><th>Рахунок кешфлоу</th></tr>
${BANK.map((b, i) => `<tr><td><input type="checkbox" data-k="${i}"${b.cfId && !b.empty ? ' checked' : ''}></td><td>${b.bank === 'mono' ? 'Моно' : 'Приват'}</td><td>${esc(b.iban || '')}</td><td>${esc(b.ccy || '')}</td><td>${esc(b.client || b.owner)}</td><td class="n">${b.rows.length}</td>
<td><select class="acc-sel" data-s="${i}">${opts(b.cfId)}</select> <span class="muted">${esc(b.empty && !b.cfId ? 'без руху' : b.note)}</span></td></tr>`).join('')}</table>
<div class="row">Звіряти за період: з <input type="date" id="b-rfrom" value="${isoOr(json.from, $('#b-from').value)}"> по <input type="date" id="b-rto" value="${isoOr(json.to, $('#b-to').value)}">
<button class="b primary" id="b-run">Звірити вибрані</button><button class="b" id="b-xlsx" disabled>Звіт .xlsx</button><span id="b-st" class="muted"></span></div></div>`;
      accEl.querySelectorAll('[data-s]').forEach(s => s.onchange = async () => {
        const b = BANK[+s.dataset.s];
        b.cfId = +s.value || null;
        accEl.querySelector(`[data-k="${s.dataset.s}"]`).checked = !!b.cfId;
        if (b.iban) {
          const m2 = { ...((STATUS.config && STATUS.config.account_map) || {}) };
          if (b.cfId) m2[b.iban] = b.cfId; else delete m2[b.iban];
          await hj('POST', '/api/config', { account_map: m2 });
          STATUS.config.account_map = m2;
        }
      });
      $('#b-run').onclick = runRecon;
      $('#b-xlsx').onclick = exportRecon;
    } catch (e) { accEl.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }

  let REPORT = [];
  async function runRecon() {
    const from = $('#b-rfrom').value, to = $('#b-rto').value, out = $('#b-out');
    if (!from || !to || from > to) { alert('Перевірте період'); return; }
    const todo = BANK.map((b, i) => ({ b, on: $(`#b-accs [data-k="${i}"]`).checked })).filter(x => x.on);
    if (!todo.length) { alert('Не позначено жодного рахунку'); return; }
    $('#b-run').disabled = true; REPORT = [];
    out.innerHTML = `<div class="muted">Період ${from} – ${to}. Кешфлоу лише читається.</div>`;
    const { accounts, ccyById } = await liveRef();
    const cache = new Map();
    try {
      for (const { b } of todo) {
        const acc = accounts.find(a => a.id === b.cfId);
        if (!acc) { out.insertAdjacentHTML('beforeend', `<h3>${esc(b.iban)}</h3><div class="err">не вибрано рахунок кешфлоу</div>`); continue; }
        if (!cache.has(acc.id)) {
          const recs = [];
          for (let p = 1; p <= 400; p++) {
            const j = await api.get(`invoice-payment?date_from=01-01-2015&date_to=${iso2dash(addDays(to, 1))}&per_page=500&page=${p}&invoice_ids[]=${acc.id}`);
            recs.push(...(j.data || []));
            $('#b-st').textContent = ` кешфлоу «${acc.name}»: сторінка ${p}/${j.last_page}`;
            if (!j.last_page || p >= j.last_page) break;
          }
          cache.set(acc.id, CFRecon.cashflowItems(recs, acc.id));
        }
        const R = CFRecon.reconcile(b, cache.get(acc.id), from, to);
        REPORT.push({ R, cfName: acc.name, iban: b.iban, src: b.src, from, to });
        out.insertAdjacentHTML('beforeend', renderAcc(acc, ccyById[acc.currency_id] || '', b, R, from, to));
      }
      const twice = [...new Set(todo.map(x => x.b.cfId).filter((id, i, a) => id && a.indexOf(id) !== i))];
      if (twice.length) out.insertAdjacentHTML('afterbegin', `<div class="warn">Один рахунок кешфлоу зіставлено з кількома рахунками банку: ${twice.map(id => esc((accounts.find(a => a.id === id) || {}).name)).join('; ')}. Звірка по кожному з них неповна.</div>`);
      out.insertAdjacentHTML('afterbegin', renderSummary());
      $('#b-st').textContent = ' готово';
      $('#b-xlsx').disabled = !REPORT.length;
    } catch (e) { out.insertAdjacentHTML('beforeend', `<div class="err">${esc(e.message)}</div>`); }
    finally { $('#b-run').disabled = false; }
  }
  const td = (v, cls) => `<td class="n ${cls || ''}">${fmt(v)}</td>`;
  const dcls = v => (v === null || Math.abs(v) < 0.005) ? 'okc' : 'badc';
  function renderSummary() {
    return `<h3>Підсумок</h3><table class="t"><tr><th>Рахунок кешфлоу</th><th>Вхідний: різниця</th><th>Кредит: різниця</th><th>Дебет: різниця</th><th>Вихідний: різниця</th><th>Банк без кешфлоу</th><th>Кешфлоу без банку</th></tr>` +
      REPORT.map(x => `<tr><td>${esc(x.cfName)}</td>${td(x.R.dOpen, dcls(x.R.dOpen))}${td(x.R.dCred, dcls(x.R.dCred))}${td(x.R.dDeb, dcls(x.R.dDeb))}${td(x.R.dClose, dcls(x.R.dClose))}<td class="n ${x.R.bOnly.length ? 'badc' : 'okc'}">${x.R.bOnly.length}</td><td class="n ${x.R.cOnly.length ? 'badc' : 'okc'}">${x.R.cOnly.length}</td></tr>`).join('') + '</table>';
  }
  function renderAcc(acc, ccyCF, bank, R, from, to) {
    let h = `<h3>${esc(acc.name)} <span class="muted">(id ${acc.id}; кешфлоу ${esc(ccyCF)}; банк ${esc(bank.ccy || 'не знаю')}; ${esc(bank.src)}; ${esc(bank.iban || '')})</span></h3>`;
    if (bank.ccy && ccyCF && bank.ccy !== ccyCF) h += `<div class="warn">Валюта рахунку в кешфлоу (${esc(ccyCF)}) ≠ валюта банку (${esc(bank.ccy)}): суми не порівнювані напряму.</div>`;
    bank.warnings.forEach(w => { h += `<div class="warn">${esc(w)}</div>`; });
    h += `<table class="t"><tr><th>Показник</th><th>Банк</th><th>Кешфлоу</th><th>Різниця (кешфлоу − банк)</th></tr>
<tr><td>Вхідний залишок на ${from}</td>${td(R.bOpen)}${td(R.cOpen)}${td(R.dOpen, dcls(R.dOpen))}</tr>
<tr><td>Надходження (кредит)</td>${td(R.bCred)}${td(R.cCred)}${td(R.dCred, dcls(R.dCred))}</tr>
<tr><td>Списання (дебет)</td>${td(R.bDeb)}${td(R.cDeb)}${td(R.dDeb, dcls(R.dDeb))}</tr>
<tr><td>Вихідний залишок на ${to}</td>${td(R.bClose)}${td(R.cClose)}${td(R.dClose, dcls(R.dClose))}</tr></table>
<div class="muted">Банк: ${esc(R.bOpenNote)}. Кешфлоу: вхідний = сума всіх записів рахунку до ${from}. Операцій: банк ${R.nB}, кешфлоу ${R.nC}, зіставлено ${R.matched.length}.</div>`;
    if (R.fileCheck && dcls(R.fileCheck.diff) !== 'okc') h += `<div class="warn">Контроль джерела: вхідний ${fmt(bank.fileOpening)} + рух ${fmt(R.fileCheck.move)} ≠ вихідний ${fmt(R.fileCheck.fileClosing)} (різниця ${fmt(R.fileCheck.diff)}).</div>`;
    if (bank.fileTo && bank.fileTo < to) h += `<div class="warn">Дані банку лише до ${esc(bank.fileTo)}, а період — до ${to}.</div>`;
    const bd = R.dayRows.filter(d => Math.abs(d.dIn) >= 0.005 || Math.abs(d.dOut) >= 0.005);
    if (bd.length) h += `<details><summary>Дні з розбіжностями: ${bd.length}</summary><table class="t"><tr><th>Дата</th><th>Кредит банк</th><th>Дохід кешфлоу</th><th>Різниця</th><th>Дебет банк</th><th>Витрата кешфлоу</th><th>Різниця</th></tr>` +
      bd.map(d => `<tr><td>${d.date}</td>${td(d.bIn)}${td(d.cIn)}${td(d.dIn, dcls(d.dIn))}${td(d.bOut)}${td(d.cOut)}${td(d.dOut, dcls(d.dOut))}</tr>`).join('') + '</table></details>';
    const sb = CFRecon.r2(R.bOnly.reduce((s, x) => s + x.amount, 0)), sc = CFRecon.r2(R.cOnly.reduce((s, x) => s + x.amount, 0));
    h += `<details${R.bOnly.length ? ' open' : ''}><summary>У банку, немає в кешфлоу: ${R.bOnly.length} (сума ${fmt(sb)})</summary>` + (R.bOnly.length ? `<table class="t"><tr><th>Дата</th><th>Час</th><th>Сума</th><th>Контрагент</th><th>Призначення</th></tr>` +
      R.bOnly.map(x => `<tr><td>${x.date}</td><td>${esc(x.time)}</td>${td(x.amount)}<td>${esc(x.cpty)}</td><td>${esc(x.purpose)}</td></tr>`).join('') + '</table>' : '') + '</details>';
    h += `<details${R.cOnly.length ? ' open' : ''}><summary>У кешфлоу, немає в банку: ${R.cOnly.length} (сума ${fmt(sc)})</summary>` + (R.cOnly.length ? `<table class="t"><tr><th>Дата</th><th>ID</th><th>Тип</th><th>Сума</th><th>Коментар</th></tr>` +
      R.cOnly.map(x => `<tr><td>${x.date}</td><td>${x.id}${x.lead ? ' (лід)' : ''}</td><td>${esc(x.op)}</td>${td(x.amount)}<td>${esc(x.comment)}</td></tr>`).join('') + '</table>' : '') + '</details>';
    if (R.shifted.length) h += `<details><summary>Зіставлено з іншою датою: ${R.shifted.length}</summary><table class="t"><tr><th>Дата банк</th><th>Дата кешфлоу</th><th>Сума</th><th>ID кешфлоу</th><th>Контрагент</th></tr>` +
      R.shifted.map(b => `<tr><td>${b.date}</td><td>${b.m.date}</td>${td(b.amount)}<td>${b.m.id}</td><td>${esc(b.cpty)}</td></tr>`).join('') + '</table></details>';
    return h;
  }
  function exportRecon() {
    if (!REPORT.length) return;
    storage.saveFile(`Звірка_банк_кешфлоу_${REPORT[0].from}_${REPORT[0].to}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', CFXlsx.buildXlsx(CFRecon.reportSheets(REPORT)));
  }

  // ================= ЛІНТЕР =================
  let PANEL = null;
  async function initLint() {
    const el = $('#tab-lint');
    if (needCrm(el)) { inited.lint = false; return; }
    try {
      RULES = RULES || await (await fetch('/rules/rules.json', { cache: 'no-store' })).json();
      // ID користувача CRM Помічник знає з «Підключити Помічник» («користувач 1243») — за ним панель перевіряє права на кешфлоу
      const userId = (String((STATUS && STATUS.crm && STATUS.crm.user) || '').match(/\d+/) || [])[0] || null;
      PANEL = CFPanel.mount(el, { api, rulesDoc: RULES, storage, applyAllowed: true, bankTab: false, apprTab: false, title: 'Лінтер кешфлоу', userId, // звірка з банком — окрема вкладка Помічника; реєстр погоджень працює лише на сторінці CRM
        ai: body => hj('POST', '/api/ai/hints', body) }); // «Підказки ШІ» — той самий сервер Помічника
    } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; inited.lint = false; }
  }
  async function rollbackFile(name) {
    const r = await fetch(`/api/files/get?kind=backups&name=${encodeURIComponent(name)}`, { headers: { 'X-Helper-Key': H.key } });
    if (!r.ok) { alert('Не вдалося прочитати резервну копію'); return; }
    const backup = await r.json();
    show('lint');
    for (let i = 0; i < 50 && !PANEL; i++) await sleep(100);
    if (!PANEL) { alert('Спершу підключіть Помічник до CRM'); return; }
    await PANEL.rollbackFrom(backup, name);
  }

  // ================= ПРАВИЛА =================
  // Редактор rules.json. Зміни — у чернетці DRAFT, її перевіряє той самий рушій, що й лінтер. «Зберегти» — нова версія файлу
  // (попередня — у rules/архів), лінтер перезбирається й підписується, і закладка на сторінці CRM бере нові правила з Помічника.
  // Змінювати можна лише на комп'ютері з ключем підпису збірок (у власника лінтера); колезі — «Опублікувати колезі».
  let DRAFT = null, RMETA = null, EDIT = null, IMPACT = null;
  let AIDR = null, AIST = null, AI_OPEN = false; // чернетка правил від ШІ і стан ШІ (лише на комп'ютері, де можна змінювати правила)
  const RF = { q: '', group: '', off: false };
  const clone = o => JSON.parse(JSON.stringify(o));
  const NL = String.fromCharCode(10);
  // порядок полів правила — як у rules.json, щоб зміни в файлі було видно рядок у рядок
  const RULE_ORDER = ['id', 'group', 'title', 'priority', 'source', 'effective_from', 'effective_to', 'date_field', 'match', 'unless', 'set', 'on_ambiguous', 'mode', 'disabled', 'note'];
  const ordered = r => { const o = {}; for (const k of RULE_ORDER) if (r[k] !== undefined && r[k] !== '' && r[k] !== null) o[k] = r[k]; for (const k of Object.keys(r)) if (!(k in o) && r[k] !== undefined) o[k] = r[k]; return o; };

  async function initRules(force) {
    const el = $('#tab-rules');
    try {
      if (force || !RULES) RULES = await (await fetch('/rules/rules.json', { cache: 'no-store' })).json();
      RMETA = await hj('GET', '/api/rules/meta');
      if (RMETA.canEdit) await loadAiDrafts();
    } catch (e) { el.innerHTML = `<div class="err">rules.json: ${esc(e.message)}</div>`; return; }
    if (force || !DRAFT) { DRAFT = clone(RULES); EDIT = null; IMPACT = null; CEDIT = null; }
    renderRules();
  }
  function rulesDiff() {
    const before = new Map((RULES.rules || []).map(r => [r.id, JSON.stringify(r)]));
    const after = new Map((DRAFT.rules || []).map(r => [r.id, JSON.stringify(r)]));
    const changed = [...after].filter(([id, k]) => before.get(id) !== k).map(([id]) => id);
    const removed = [...before.keys()].filter(id => !after.has(id));
    const cards = JSON.stringify(cardsOf(RULES)) !== JSON.stringify(cardsOf(DRAFT));
    return { changed, removed, cards, n: changed.length + removed.length + (cards ? 1 : 0) };
  }
  // значення статті для rules.json: коротка назва, якщо вона однозначна, інакше «Група / Назва»
  function artValue(ref, a) {
    const art = ref.articles[CFRules.normText(a.name)];
    return art && art.category_id === a.category_id && art.operation_id === a.operation_id ? a.name : `${a.group} / ${a.name}`;
  }
  function artOf(ref, v) { try { return v ? CFRules.resolveArticle(ref, v, '') : null; } catch (e) { return null; } }

  // ---------- корп. картки (rules.json → reference.cards) ----------
  // Форма замість ручного редагування файлу: номер (4 останні цифри), рахунок картки й рахунок, з якого вона списує, — зі списку
  // рахунків CRM; хто тримає картку з якої дати (маркетолог її покупок). Зміни — у чернетці, як і правила: «Зберегти зміни».
  let CEDIT = null, CARDS_OPEN = false;
  const cardsOf = doc => (doc && doc.reference && doc.reference.cards) || [];
  const dmy = s => String(s || '').split('-').reverse().join('.');
  const CARD_ORDER = ['last4', 'account_id', 'account', 'debit_account_id', 'debit_account', 'holders', 'note'];
  async function loadCardRefs() {
    try { await liveRef(); } catch (e) { toast('Рахунки з CRM не завантажено: ' + e.message); }
  }
  /* Перевірка картки з форми і той самий вигляд, що в rules.json (порядок полів; назви рахунків — з CRM, якщо список завантажено).
     c — {last4, account_id, debit_account_id, holders: [{from, name}], note}; i — індекс картки, яку змінюють (−1 — нова). → {card} | {error} */
  function checkCard(c, cards, i) {
    const accs = (LIVE && LIVE.accounts) || [], nameOf = id => (accs.find(a => Number(a.id) === id) || {}).name;
    const last4 = String(c.last4 || '').trim(), old = i >= 0 ? cards[i] || {} : {};
    if (!/^\d{4}$/.test(last4)) return { error: 'Номер — рівно 4 останні цифри картки (повний номер не потрібен і не зберігається).' };
    if (cards.some((x, j) => j !== i && String(x.last4) === last4)) return { error: `Картка …${last4} уже є в довіднику.` };
    if (!(c.account_id > 0)) return { error: 'Виберіть рахунок картки в CRM.' };
    if (accs.length && !nameOf(c.account_id)) return { error: `У CRM немає рахунку з ID ${c.account_id}.` };
    if (c.debit_account_id && c.debit_account_id === c.account_id) return { error: 'Рахунок картки й рахунок, з якого вона списує, мають бути різні.' };
    if (c.debit_account_id && accs.length && !nameOf(c.debit_account_id)) return { error: `У CRM немає рахунку з ID ${c.debit_account_id}.` };
    const hs = (c.holders || []).map(h => ({ from: h.from || '', name: String(h.name || '').trim() })).filter(h => h.name || h.from);
    if (hs.some(h => !h.name)) return { error: 'У кожного, хто тримає картку, має бути ім\'я (або приберіть рядок).' };
    if (hs.some(h => h.from && !/^\d{4}-\d{2}-\d{2}$/.test(h.from))) return { error: 'Дата «з» — у форматі дати.' };
    if (hs.filter(h => !h.from).length > 1) return { error: 'Без дати може бути лише перший; для наступних вкажіть, з якого дня картка в них.' };
    const sorted = hs.slice().sort((a, b) => a.from.localeCompare(b.from));
    if (sorted.some((h, k) => k && h.from === sorted[k - 1].from)) return { error: 'Двоє з тієї самої дати — залиште одного.' };
    const card = {
      last4, account_id: c.account_id,
      // підпис рахунку — як був, якщо рахунок той самий (там бувають уточнення, напр. кінець IBAN); новий — назва з CRM
      account: (Number(old.account_id) === c.account_id && old.account) || nameOf(c.account_id),
      debit_account_id: c.debit_account_id || undefined,
      debit_account: c.debit_account_id ? (Number(old.debit_account_id) === c.debit_account_id && old.debit_account) || nameOf(c.debit_account_id) : undefined,
      holders: sorted.length ? sorted.map(h => (h.from ? { from: h.from, name: h.name } : { name: h.name })) : undefined,
      note: String(c.note || '').trim() || undefined,
    };
    const out = {};
    for (const k of CARD_ORDER) if (card[k] !== undefined) out[k] = card[k];
    for (const k of Object.keys(old)) if (!CARD_ORDER.includes(k) && k !== 'local' && old[k] !== undefined) out[k] = old[k]; // інші поля картки — як були
    return { card: out };
  }
  function cardsHtml(can) {
    const cards = cardsOf(DRAFT), accs = (LIVE && LIVE.accounts) || [];
    const acc = (id, fb) => (id ? `${esc((accs.find(a => Number(a.id) === Number(id)) || {}).name || fb || 'рахунок ' + id)} <span class="muted">ID ${esc(id)}</span>` : '<span class="muted">—</span>');
    const hold = c => (c.holders || []).map(x => `${esc(x.name)}${x.from ? ` <span class="muted">з ${esc(dmy(x.from))}</span>` : ''}`).join('<br>') || '<span class="muted">—</span>';
    let h = `<details class="box" id="r-cards"${CARDS_OPEN || CEDIT ? ' open' : ''}><summary><b>Корп. картки: ${cards.length}</b> <span class="muted">— рахунок картки, з якого рахунку вона списує і хто її тримає</span></summary>
<div class="muted" style="margin:6px 0">За номером картки «Звірка з банком» і «Погодження» зводять її покупки з рахунком картки в CRM, навіть якщо номера немає в назві рахунку. Хто тримає картку на дату покупки — той маркетолог її покупок. Зміни потрапляють у чернетку; у файл — кнопкою «Зберегти зміни» вгорі. Картки, запам'ятані «Звіркою з банком» лише в браузері, сюди не потрапляють — додайте їх тут, щоб знали всі.</div>
<table class="t"><tr><th>Картка</th><th>Рахунок картки в CRM</th><th>Списує з рахунку</th><th>Хто тримає</th><th>Примітка</th><th></th></tr>`;
    cards.forEach((c, i) => {
      h += `<tr${CEDIT && CEDIT.i === i ? ' class="chg"' : ''}><td><b>…${esc(c.last4)}</b></td><td>${acc(c.account_id, c.account)}</td><td>${acc(c.debit_account_id, c.debit_account)}</td><td>${hold(c)}</td>
<td class="muted" style="max-width:380px">${esc(c.note || '')}</td><td>${can ? `<button class="b" data-c-ed="${i}" title="Змінити картку">✎</button>` : ''}</td></tr>`;
      if (CEDIT && CEDIT.i === i) h += `<tr class="edrow"><td colspan="6">${cardEditHtml()}</td></tr>`;
    });
    if (!cards.length) h += '<tr><td colspan="6" class="muted">Карток у довіднику ще немає.</td></tr>';
    if (CEDIT && CEDIT.i < 0) h += `<tr class="edrow"><td colspan="6">${cardEditHtml()}</td></tr>`;
    h += '</table>';
    if (can) h += `<div class="row"><button class="b" id="c-new"${CEDIT ? ' disabled' : ''}>Додати картку</button>${accs.length ? '' : '<button class="b" id="c-accs" title="Назви рахунків — з CRM (потрібне підключення)">Завантажити рахунки з CRM</button> <span class="muted">без списку ID рахунку вписується числом</span>'}</div>`;
    return h + '</details>';
  }
  function cardEditHtml() {
    const c = CEDIT.card, accs = ((LIVE && LIVE.accounts) || []).filter(a => !a.deleted_at);
    const sel = (f, v, empty) => (accs.length
      ? `<select data-cf="${f}" style="max-width:440px"><option value="">${empty}</option>${accs.map(a => `<option value="${a.id}"${Number(v) === Number(a.id) ? ' selected' : ''}>${esc(a.name)} · ID ${esc(a.id)}</option>`).join('')}</select>`
      : `<input type="number" data-cf="${f}" min="1" value="${esc(v || '')}" placeholder="ID рахунку" style="width:130px">`);
    const hs = c.holders && c.holders.length ? c.holders : [{ name: '' }];
    return `<div class="ed" data-card-ed>
<div class="grid">
 <label>4 останні цифри <input type="text" data-cf="last4" value="${esc(c.last4 || '')}" maxlength="4" inputmode="numeric" autocomplete="off" placeholder="0000" style="width:90px"></label>
 <label>Рахунок картки в CRM ${sel('account_id', c.account_id, '— виберіть —')}</label>
 <label>Списує з рахунку ${sel('debit_account_id', c.debit_account_id, '— не вказано —')}</label>
</div>
<div class="muted" style="font-size:12px;margin-top:8px">Хто тримає картку: з якого дня (у першого дату можна не вказувати — з самого початку). Ім'я — як у CRM: за ним лінтер знаходить маркетолога покупок.</div>
${hs.map((x, k) => `<div class="row" data-holder="${k}" style="margin:4px 0"><input type="date" data-hf="from" value="${esc(x.from || '')}"><input type="text" data-hf="name" list="c-mks" value="${esc(x.name || '')}" placeholder="Прізвище Ім'я" style="min-width:260px"><button class="b" data-h-del="${k}" title="Прибрати рядок" style="margin:0">✕</button></div>`).join('')}
<datalist id="c-mks">${[...new Set(cardsOf(DRAFT).flatMap(x => (x.holders || []).map(h => h.name)).filter(Boolean))].map(n => `<option value="${esc(n)}">`).join('')}</datalist>
<div class="row"><button class="b" data-a="h-add">+ ще один власник</button></div>
<div class="grid"><label>Примітка <input type="text" data-cf="note" value="${esc(c.note || '')}" style="min-width:560px"></label></div>
<div class="err" data-cf-err hidden></div>
<div class="row"><button class="b primary" data-a="c-ok">Готово</button><button class="b" data-a="c-cancel">Скасувати</button>${CEDIT.i >= 0 ? '<button class="b" data-a="c-del">Видалити картку</button>' : ''}</div></div>`;
  }
  function readCard(box) {
    const v = f => box.querySelector(`[data-cf="${f}"]`).value.trim();
    const holders = [...box.querySelectorAll('[data-holder]')].map(r => ({ from: r.querySelector('[data-hf="from"]').value, name: r.querySelector('[data-hf="name"]').value }));
    return { last4: v('last4'), account_id: Number(v('account_id')) || null, debit_account_id: Number(v('debit_account_id')) || null, holders, note: v('note') };
  }
  function bindCards() {
    const el = $('#tab-rules'), det = $('#r-cards');
    if (!det) return;
    det.ontoggle = () => { CARDS_OPEN = det.open; };
    const edit = async (i, card) => {
      if (STATUS && STATUS.crm && STATUS.crm.connected && !LIVE) await loadCardRefs();
      CEDIT = { i, card }; CARDS_OPEN = true;
      renderRules();
      const f = el.querySelector('[data-card-ed] [data-cf="last4"]'); if (f) f.focus();
    };
    el.querySelectorAll('[data-c-ed]').forEach(b => { b.onclick = () => { const i = Number(b.dataset.cEd); if (CEDIT && CEDIT.i === i) { CEDIT = null; renderRules(); } else edit(i, clone(cardsOf(DRAFT)[i])); }; });
    const nw = $('#c-new'); if (nw) nw.onclick = () => edit(-1, { holders: [{ name: '' }] });
    const la = $('#c-accs'); if (la) la.onclick = async () => { la.disabled = true; await loadCardRefs(); renderRules(); };
    const box = el.querySelector('[data-card-ed]');
    if (!box) return;
    // вписане у форму — одразу в CEDIT: таблицю правил перемальовують і інші дії («Додати в чернетку», галочки правил), і форма
    // малюється знову з CEDIT — вписане, але ще не «Готово», не губиться
    const sync = () => { if (CEDIT) CEDIT.card = { ...CEDIT.card, ...readCard(box) }; };
    box.addEventListener('input', sync);
    box.addEventListener('change', sync);
    const err = box.querySelector('[data-cf-err]'), fail = t => { err.hidden = false; err.textContent = t; };
    // додати чи прибрати рядок власника: спершу прочитати форму, щоб не загубити вписане
    box.querySelector('[data-a="h-add"]').onclick = () => { CEDIT.card = { ...CEDIT.card, ...readCard(box) }; CEDIT.card.holders.push({ name: '' }); renderRules(); };
    box.querySelectorAll('[data-h-del]').forEach(b => { b.onclick = () => { CEDIT.card = { ...CEDIT.card, ...readCard(box) }; CEDIT.card.holders.splice(Number(b.dataset.hDel), 1); renderRules(); }; });
    box.querySelector('[data-a="c-cancel"]').onclick = () => { CEDIT = null; renderRules(); };
    box.addEventListener('keydown', e => { if (e.key === 'Escape') { CEDIT = null; renderRules(); } });
    const del = box.querySelector('[data-a="c-del"]');
    if (del) del.onclick = () => {
      const c = cardsOf(DRAFT)[CEDIT.i];
      if (!confirm(`Видалити картку …${c.last4} з чернетки? (У файлі — лише після «Зберегти зміни».)`)) return;
      DRAFT.reference.cards = cardsOf(DRAFT).filter((x, j) => j !== CEDIT.i);
      CEDIT = null; renderRules();
    };
    box.querySelector('[data-a="c-ok"]').onclick = () => {
      const r = checkCard({ ...CEDIT.card, ...readCard(box) }, cardsOf(DRAFT), CEDIT.i);
      if (r.error) return fail(r.error);
      const cards = cardsOf(DRAFT).slice();
      if (CEDIT.i >= 0) cards[CEDIT.i] = r.card; else cards.push(r.card);
      DRAFT.reference = { ...(DRAFT.reference || {}), cards };
      CEDIT = null; renderRules();
    };
  }

  function renderRules() {
    const el = $('#tab-rules'), can = !!(RMETA && RMETA.canEdit);
    const c = CFRules.compileRules(DRAFT), d = rulesDiff();
    const byId = new Map(c.rules.map(r => [r.id, r]));
    const errsOf = id => c.errors.filter(e => e.startsWith(`правило ${id}:`));
    const groups = [...new Set(DRAFT.rules.map(r => r.group).filter(Boolean))];
    const code = m => { const t = JSON.stringify(m || {}); return `<span title="${esc(t)}">${esc(t.length > 220 ? t.slice(0, 220) + '…' : t)}</span>`; };
    const q = RF.q.trim().toLowerCase();
    const list = DRAFT.rules.filter(r => (!RF.group || r.group === RF.group) && (!RF.off || r.disabled) && (!q || JSON.stringify(r).toLowerCase().includes(q)));
    const arts = (DRAFT.reference && DRAFT.reference.articles) || [];
    let h = `<h2>Правила (rules.json ${esc(RULES.version)})</h2>
<div class="${can ? 'muted' : 'warn'}">${can
      ? 'Зміни спершу потрапляють у чернетку. «Зберегти» записує нову версію rules.json (попередня лишається в архіві нижче) і перезбирає лінтер — закладка на сторінці CRM одразу візьме нові правила з Помічника. Колезі — «Опублікувати колезі».'
      : "Правила змінює власник лінтера: на цьому комп'ютері немає ключа підпису збірок. Тут — перегляд і перевірка; нові правила приходять оновленням («Оновити лінтер кешфлоу»)."}</div>
${c.errors.length ? `<div class="err">${esc(c.errors.join(NL))}</div>` : ''}
<div class="row" style="margin:10px 0">
${can ? `<button class="b" id="r-new">Нове правило</button>
<input type="text" id="r-note" placeholder="Що змінено — піде в номер версії" style="min-width:300px">
<button class="b primary" id="r-save"${d.n && !c.errors.length ? '' : ' disabled'}>Зберегти зміни (${d.n})</button>
<button class="b" id="r-undo"${d.n ? '' : ' disabled'}>Скасувати зміни</button>` : ''}
<button class="b" id="r-imp-open">Перевірити на записах…</button>
${can && RMETA.publish ? '<button class="b" id="r-pub" title="Відкриє вікно «Опублікувати оновлення»: збірка, підпис і відправка у ваш репозиторій GitHub">Опублікувати колезі</button>' : ''}
<span class="muted">${c.rules.length} правил${d.n ? ` · у чернетці змінено: ${d.n}${d.cards ? ' (з них — корп. картки)' : ''}` : ''}</span></div>
<div class="box"><h4>Перевірити коментар (на чернетці правил)</h4><div class="row"><input type="text" id="sb-text" placeholder="Текст коментаря, напр. «Банківська комісія за жовтень»">
<select id="sb-type"><option value="expense">витрата</option><option value="income">дохід</option><option value="transfer">переказ</option></select>
<input type="date" id="sb-date" value="${kyivToday()}"><select id="sb-art"><option value="">поточна стаття: —</option>${arts.map(a => `<option value="${a.category_id}/${a.operation_id}">${esc(a.group + ' / ' + a.name)}</option>`).join('')}</select>
<button class="b primary" id="sb-go">Перевірити</button></div><div id="sb-out"></div></div>
<div id="r-imp">${IMPACT ? impactHtml() : ''}</div>
${aiDraftHtml(can)}
${cardsHtml(can)}
<div class="row"><input type="text" id="r-q" placeholder="Пошук: назва, слово з умови, id…" value="${esc(RF.q)}">
<select id="r-grp"><option value="">усі групи</option>${groups.map(g => `<option${g === RF.group ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select>
<label><input type="checkbox" id="r-off"${RF.off ? ' checked' : ''}> лише вимкнені</label></div>
<table class="t rules"><tr><th title="Вимкнене правило лінтер не застосовує">Увімк.</th><th>ID</th><th>Назва</th><th>Режим</th><th>Пріор.</th><th>Діє</th><th>Умова</th><th>Крім</th><th>Встановлює</th><th></th></tr>`;
    for (const r of list) {
      const cr = byId.get(r.id), err = errsOf(r.id), chg = d.changed.includes(r.id);
      h += `<tr class="${r.disabled ? 'off' : ''}${chg ? ' chg' : ''}"><td><input type="checkbox" data-r-on="${esc(r.id)}"${r.disabled ? '' : ' checked'}${can ? '' : ' disabled'}></td>
<td>${esc(r.id)}</td><td>${esc(r.title)}${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}${err.length ? `<div class="bad">${esc(err.join('; '))}</div>` : ''}</td>
<td>${can ? `<select data-r-mode="${esc(r.id)}"><option value="fix">fix</option><option value="review"${r.mode === 'review' ? ' selected' : ''}>review</option></select>` : esc(r.mode || 'fix')}</td>
<td class="n">${esc(r.priority)}</td><td>${esc(r.effective_from || '…')} — ${esc(r.effective_to || '…')}</td>
<td class="code">${code(r.match)}</td><td class="code">${(r.unless || []).map(code).join('<hr>')}</td>
<td>${esc(cr ? Object.values(cr.setLabel).join('; ') : JSON.stringify(r.set || {}))}</td><td>${can ? `<button class="b" data-r-ed="${esc(r.id)}" title="Змінити правило">✎</button>` : ''}</td></tr>`;
      if (EDIT && !EDIT.isNew && EDIT.id === r.id) h += `<tr class="edrow"><td colspan="10">${editHtml(EDIT.rule, c.ref, groups)}</td></tr>`;
    }
    if (EDIT && EDIT.isNew) h += `<tr class="edrow"><td colspan="10">${editHtml(EDIT.rule, c.ref, groups)}</td></tr>`;
    h += '</table>';
    if (d.removed.length) h += `<div class="warn">У чернетці видалено правила: ${esc(d.removed.join(', '))}</div>`;
    if (RMETA.versions.length) h += `<details style="margin-top:14px"><summary>Попередні версії rules.json: ${RMETA.versions.length}</summary><table class="t">${RMETA.versions.map(v => `<tr><td>${esc(v.mtime.replace('T', ' '))}</td><td>${esc(v.version)}</td><td>${can ? `<button class="b" data-r-restore="${esc(v.name)}">Відновити</button>` : ''}</td></tr>`).join('')}</table></details>`;
    el.innerHTML = h;
    bindRules(c);
    if (window.CFCombo) CFCombo.enhance(el, { variant: 'b' }); // довгі списки (статті, рахунки карток) — з пошуком
  }

  function editHtml(r, ref, groups) {
    const set = r.set || {}, cur = artOf(ref, set.category);
    const arts = (DRAFT.reference && DRAFT.reference.articles) || [], projects = Object.keys((DRAFT.reference && DRAFT.reference.projects) || {});
    const other = Object.fromEntries(Object.entries(set).filter(([k]) => !['category', 'project', 'type', 'exclude_from_pnl', 'review'].includes(k)));
    const keepCat = set.category && typeof set.category !== 'string'; // стаття об'єктом {category_id, operation_id} — лишається як є
    return `<div class="ed">
<div class="grid">
 <label>ID <input type="text" data-f="id" value="${esc(r.id)}"${EDIT.isNew ? '' : ' disabled'} style="min-width:150px"></label>
 <label>Назва <input type="text" data-f="title" value="${esc(r.title || '')}" style="min-width:420px"></label>
 <label>Група <input type="text" data-f="group" list="r-groups" value="${esc(r.group || '')}" style="min-width:120px"></label>
 <label>Пріоритет <input type="number" data-f="priority" value="${esc(r.priority)}" style="width:80px"></label>
 <label>Режим <select data-f="mode"><option value="fix">fix — застосовувати</option><option value="review"${r.mode === 'review' ? ' selected' : ''}>review — лише з підтвердженням рядка</option></select></label>
 <label>Діє з <input type="date" data-f="effective_from" value="${esc(r.effective_from || '')}"></label>
 <label>по <input type="date" data-f="effective_to" value="${esc(r.effective_to || '')}"></label>
 <label>Дата для «діє» <select data-f="date_field">${[['date', 'дата запису'], ['period', 'період'], ['created', 'коли внесено']].map(([v, t]) => `<option value="${v}"${(r.date_field || 'date') === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
</div><datalist id="r-groups">${groups.map(g => `<option value="${esc(g)}">`).join('')}</datalist>
<div class="grid2">
 <label>Умова (match), JSON<textarea data-f="match" rows="6">${esc(JSON.stringify(r.match || {}, null, 1))}</textarea></label>
 <label>Крім (unless) — список умов, JSON<textarea data-f="unless" rows="6">${esc(JSON.stringify(r.unless || [], null, 1))}</textarea></label>
</div>
<div class="muted">Приклади: <code>{"type": "expense", "comment_regex": "(?i)hetzner|сервер"}</code> · імена — <code>"names": ["Сливк*"]</code> · усі умови разом — <code>"all": [{…}, {…}]</code>, будь-яка — <code>"any": [...]</code>. Повний формат — rules/ФОРМАТ_ПРАВИЛ.md.</div>
<div class="row">Швидко скласти умову: слова в коментарі <input type="text" data-f="words" placeholder="через кому: hetzner, сервер" style="min-width:240px">
 тип <select data-f="wtype"><option value="expense">витрата</option><option value="income">дохід</option><option value="">будь-який</option></select> <button class="b" data-a="words">→ в умову</button></div>
<div class="grid">
 <label>Стаття ${keepCat ? '<span class="muted">(задано номером — змінюється в «Інше в set»)</span>' : `<select data-f="category"><option value="">— не змінювати —</option>${arts.map(a => `<option value="${esc(artValue(ref, a))}"${cur && cur.category_id === a.category_id && cur.operation_id === a.operation_id ? ' selected' : ''}>${esc(a.group + ' / ' + a.name)}</option>`).join('')}</select>`}</label>
 <label>Проєкт <select data-f="project"><option value="">— не змінювати —</option>${projects.map(n => `<option${set.project === n ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
 <label><input type="checkbox" data-f="type"${set.type === 'transfer' ? ' checked' : ''}> має бути переказ між рахунками</label>
 <label><input type="checkbox" data-f="exclude_from_pnl"${set.exclude_from_pnl ? ' checked' : ''}> не P&amp;L</label>
 <label>Перевірити вручну, причина <input type="text" data-f="review" value="${esc(set.review || '')}" style="min-width:260px"></label>
</div>
${Object.keys(other).length || keepCat ? `<label>Інше в «set», JSON<textarea data-f="setother" rows="2">${esc(JSON.stringify(keepCat ? { ...other, category: set.category } : other))}</textarea></label>` : ''}
<div class="grid"><label>Примітка <input type="text" data-f="note" value="${esc(r.note || '')}" style="min-width:420px"></label><label>Джерело <input type="text" data-f="source" value="${esc(r.source || '')}" style="min-width:320px"></label></div>
<div class="err" data-f-err hidden></div>
<div class="row"><button class="b primary" data-a="ok">Готово</button><button class="b" data-a="cancel">Скасувати</button>${EDIT.isNew ? '' : '<button class="b" data-a="dup">Дублювати</button><button class="b" data-a="del">Видалити правило</button>'}</div></div>`;
  }

  function readForm(box, base) {
    const v = f => box.querySelector(`[data-f="${f}"]`);
    const json = (f, def) => { const t = v(f) ? v(f).value.trim() : ''; if (!t) return def; try { return JSON.parse(t); } catch (e) { throw new Error(`«${f}»: це не JSON (${e.message})`); } };
    const set = json('setother', {});
    if (v('category') && v('category').value) set.category = v('category').value;
    if (v('project').value) set.project = v('project').value;
    if (v('type').checked) set.type = 'transfer';
    if (v('exclude_from_pnl').checked) set.exclude_from_pnl = true;
    if (v('review').value.trim()) set.review = v('review').value.trim();
    const unless = json('unless', []);
    if (!Array.isArray(unless)) throw new Error('«Крім» має бути списком умов: [ {…}, {…} ]');
    return ordered({ ...base, id: v('id').value.trim(), group: v('group').value.trim() || undefined, title: v('title').value.trim(), priority: Number(v('priority').value),
      effective_from: v('effective_from').value || undefined, effective_to: v('effective_to').value || undefined, date_field: v('date_field').value === 'date' ? undefined : v('date_field').value,
      match: json('match', {}), unless: unless.length ? unless : undefined, set, mode: v('mode').value === 'review' ? 'review' : undefined,
      note: v('note').value.trim() || undefined, source: v('source').value.trim() || undefined });
  }

  function nextRuleId() {
    const n = Math.max(0, ...DRAFT.rules.map(r => (/^R-USER-(\d+)$/.exec(r.id) || [])[1]).filter(Boolean).map(Number));
    return `R-USER-${String(n + 1).padStart(2, '0')}`;
  }

  function bindRules(c) {
    const el = $('#tab-rules'), on = (sel, ev, fn) => el.querySelectorAll(sel).forEach(e => { e[ev] = () => fn(e); });
    const ruleById = id => DRAFT.rules.find(r => r.id === id);
    on('[data-r-on]', 'onchange', e => { const r = ruleById(e.dataset.rOn); if (e.checked) delete r.disabled; else r.disabled = true; Object.assign(r, ordered(r)); renderRules(); });
    on('[data-r-mode]', 'onchange', e => { const r = ruleById(e.dataset.rMode); if (e.value === 'review') r.mode = 'review'; else delete r.mode; DRAFT.rules[DRAFT.rules.indexOf(r)] = ordered(r); renderRules(); });
    on('[data-r-ed]', 'onclick', e => { EDIT = EDIT && EDIT.id === e.dataset.rEd ? null : { id: e.dataset.rEd, rule: clone(ruleById(e.dataset.rEd)) }; renderRules(); });
    on('[data-r-restore]', 'onclick', async e => {
      if (!confirm(`Відновити цю версію rules.json? Поточна піде в архів, лінтер буде перезібрано.`)) return;
      try { const j = await hj('POST', '/api/rules/restore', { name: e.dataset.rRestore }); toast(`Відновлено: rules.json ${j.version}`); await afterSave(); } catch (err) { alert(err.message); }
    });
    const q = $('#r-q'); if (q) q.onchange = () => { RF.q = q.value; renderRules(); };
    const g = $('#r-grp'); if (g) g.onchange = () => { RF.group = g.value; renderRules(); };
    const off = $('#r-off'); if (off) off.onchange = () => { RF.off = off.checked; renderRules(); };
    const nw = $('#r-new'); if (nw) nw.onclick = () => {
      EDIT = { isNew: true, rule: ordered({ id: nextRuleId(), group: 'Статті', title: '', priority: 100, source: `Помічник, ${kyivToday().split('-').reverse().join('.')}`, effective_from: kyivToday(), match: { type: 'expense', comment_regex: '(?i)' }, set: {} }) };
      renderRules();
      const f = el.querySelector('.edrow [data-f="title"]'); if (f) f.focus();
    };
    const sv = $('#r-save'); if (sv) sv.onclick = async () => {
      sv.disabled = true;
      try {
        const d = rulesDiff(), only = d.cards && !d.changed.length && !d.removed.length;
        const j = await hj('POST', '/api/rules/save', { doc: DRAFT, note: $('#r-note').value.trim() || (only ? 'корп. картки' : '') });
        toast(`Збережено: rules.json ${j.version}. Лінтер перезібрано — закладка візьме нові правила з Помічника.`);
        await afterSave();
      } catch (err) { alert('Не збережено: ' + err.message); sv.disabled = false; }
    };
    const un = $('#r-undo'); if (un) un.onclick = () => { if (confirm('Скасувати всі зміни в чернетці?')) { DRAFT = clone(RULES); EDIT = null; CEDIT = null; renderRules(); } };
    const pb = $('#r-pub'); if (pb) pb.onclick = async () => {
      if (rulesDiff().n && !confirm('У чернетці є незбережені зміни — вони не потраплять у публікацію. Продовжити?')) return;
      try { await hj('POST', '/api/rules/publish'); toast('Відкрито вікно «Опублікувати оновлення» — дочекайтеся «Опубліковано».'); } catch (err) { alert(err.message); }
    };
    const io = $('#r-imp-open'); if (io) io.onclick = () => { IMPACT = IMPACT || { from: DRAFT.fix_from || kyivToday().slice(0, 8) + '01', to: kyivToday() }; renderImpact(); };
    bindImpact();
    bindCards();
    bindAiDrafts();
    // форма правила (не форма картки — у неї свій bindCards)
    const box = el.querySelector('.edrow .ed:not([data-card-ed])');
    if (box) {
      const err = box.querySelector('[data-f-err]'), fail = t => { err.hidden = false; err.textContent = t; };
      box.querySelector('[data-a="words"]').onclick = () => {
        const words = box.querySelector('[data-f="words"]').value.split(',').map(s => s.trim()).filter(Boolean);
        if (!words.length) return fail('Впишіть слова через кому.');
        const esc2 = s => s.replace(/[.*+?^${}()|[\]\\]/g, ch => String.fromCharCode(92) + ch);
        const m = { comment_regex: '(?i)' + words.map(esc2).join('|') }, t = box.querySelector('[data-f="wtype"]').value;
        if (t) m.type = t;
        box.querySelector('[data-f="match"]').value = JSON.stringify(m, null, 1);
      };
      box.querySelector('[data-a="cancel"]').onclick = () => { EDIT = null; renderRules(); };
      box.querySelector('[data-a="ok"]').onclick = () => {
        let r;
        try { r = readForm(box, EDIT.isNew ? {} : EDIT.rule); } catch (e) { return fail(e.message); }
        if (!r.title) return fail('Вкажіть назву правила.');
        const next = clone(DRAFT);
        const i = EDIT.isNew ? -1 : next.rules.findIndex(x => x.id === EDIT.id);
        if (EDIT.isNew && next.rules.some(x => x.id === r.id)) return fail(`Правило ${r.id} уже є — змініть ID.`);
        if (i >= 0) next.rules[i] = r; else next.rules.push(r);
        const errs = CFRules.compileRules(next).errors.filter(e => e.startsWith(`правило ${r.id}:`));
        if (errs.length) return fail(errs.join(NL));
        DRAFT = next; EDIT = null; renderRules();
      };
      const dup = box.querySelector('[data-a="dup"]');
      if (dup) dup.onclick = () => { const r = clone(ruleById(EDIT.id)); EDIT = { isNew: true, rule: ordered({ ...r, id: nextRuleId(), title: r.title + ' (копія)' }) }; renderRules(); };
      const del = box.querySelector('[data-a="del"]');
      if (del) del.onclick = () => { if (!confirm(`Видалити правило ${EDIT.id} з чернетки? (Збережеться лише після «Зберегти зміни».)`)) return; DRAFT.rules = DRAFT.rules.filter(x => x.id !== EDIT.id); EDIT = null; renderRules(); };
    }
    // перевірка коментаря — на чернетці
    $('#sb-go').onclick = () => {
      const art = $('#sb-art').value.split('/').map(Number);
      const rec = { id: 0, date: $('#sb-date').value, period: $('#sb-date').value.slice(0, 8) + '01', text: $('#sb-text').value, type: $('#sb-type').value,
        category_id: art[0] || null, operation_id: art[1] || null, project_id: null, account_ids: [], account_names: [], amount: 0, currency: 'UAH', is_lead: false, is_auto: false, is_salary: false };
      const res = CFRules.evaluate(rec, c);
      const ua = s => CFLinter.STATUS_UA[s] || s; // статуси словами, як у панелі (07.11.2026)
      $('#sb-out').innerHTML = !res ? '<div class="muted">Жодне правило не спрацювало.</div>' :
        `<div>Статус: <b>${esc(ua(res.status))}</b>${res.reasons.length ? ' — ' + esc(res.reasons.join('; ')) : ''}</div><ul>${res.applicable.map(r => `<li>${esc(r.id)} — ${esc(r.title)} → ${esc(Object.values(r.setLabel).join('; '))} <span class="muted">(${esc(ua(res.perRule[r.id]))})</span></li>`).join('')}</ul>`;
    };
  }

  async function afterSave() {
    // лінтер у Помічнику — заново з новими правилами (закладка на сторінці CRM візьме їх сама)
    inited.lint = false; PANEL = null; $('#tab-lint').innerHTML = '';
    await initRules(true);
  }

  // ---------- чернетка правил від ШІ (раз на тиждень, з 05.11.2026 — Claude Opus 5.5; app/helper_ai.py) ----------
  // Правило ШІ потрапляє в чернетку лише кнопкою «Додати в чернетку» (зміна чинного — «Замінити в чернетці»), у файл — лише «Зберегти
  // зміни»; перед тим — «Перевірити на записах…».
  const sameRule = (a, b) => JSON.stringify(ordered(clone(a))) === JSON.stringify(ordered(clone(b)));
  const aiInDraft = r => !!(r.rule && (r.replaces ? DRAFT.rules.some(x => x.id === r.rule.id && sameRule(x, r.rule)) : DRAFT.rules.some(x => x.id === r.rule.id)));
  const dt = s => String(s || '').replace('T', ' ').slice(0, 16).replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3.$2.$1');
  const money = x => '$' + Number(x || 0).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  async function loadAiDrafts() {
    try { [AIST, AIDR] = await Promise.all([hj('GET', '/api/ai/status'), hj('GET', '/api/ai/drafts')]); } catch (e) { AIST = AIDR = null; }
  }
  function aiDraftHtml(can) {
    if (!can || !AIST) return '';
    const d = AIDR || {}, rules = d.rules || [], job = d.job || {}, dr = AIST.drafts || {}, ready = AIST.state === 'ready';
    // нові — і «додані», яких у чернетці вже немає (скасували зміни, перезавантажили сторінку): у файлі їх ще немає
    const fresh = rules.filter(r => r.status !== 'rejected' && r.rule && !aiInDraft(r)).length;
    const code = m => { const t = JSON.stringify(m || {}); return `<span title="${esc(t)}">${esc(t.length > 220 ? t.slice(0, 220) + '…' : t)}</span>`; };
    let h = `<details class="box" id="r-ai"${AI_OPEN || fresh || job.running ? ' open' : ''}><summary><b>Чернетка правил від ШІ${fresh ? `: нових ${fresh}` : ''}</b> <span class="muted">— ${esc((AIST.roles || {}).weekly || 'Claude')} раз на тиждень переглядає, де лінтер і щоденний ШІ не впоралися, і пропонує нові правила чи зміни чинних</span></summary>`;
    if (!ready) h += `<div class="warn">ШІ: ${esc(AIST.state_ua)}.${AIST.state === 'nokey' ? ' Ключ Claude API вставляється у вкладці «Налаштування».' : ''}</div>`;
    if (job.running) h += '<div class="info">Claude складає чернетку — до кількох хвилин…</div>';
    if (job.error) h += `<div class="err">Чернетку не складено: ${esc(job.error)}</div>`;
    if (d.at) h += `<div class="muted" style="margin:6px 0">Чернетка від ${esc(dt(d.at))}${d.model ? ` (${esc(d.model)})` : ''}${d.auto ? ', щотижнева' : ''}: розглянуто записів без правил і операцій банку без статті — ${esc(d.n_obs)}${d.usd ? `, ≈ ${money(d.usd)}` : ''}. ${esc(d.summary || '')}</div>`;
    if (rules.length) {
      h += '<table class="t"><tr><th>Правило</th><th>Умова</th><th>Встановлює</th><th>Чому</th><th></th></tr>';
      rules.forEach((r, i) => {
        const inDraft = aiInDraft(r);
        let errs = r.error ? [r.error] : [], cr = null;
        if (r.rule) {
          const c = CFRules.compileRules({ ...DRAFT, rules: DRAFT.rules.filter(x => x.id !== r.rule.id).concat([r.rule]) });
          errs = c.errors.filter(e => e.startsWith(`правило ${r.rule.id}:`));
          cr = c.rules.find(x => x.id === r.rule.id);
        }
        const st = inDraft ? '<span class="good">у чернетці</span>' : r.status === 'rejected' ? '<span class="muted">відхилено</span>' : '';
        const acts = st || `${r.rule && !errs.length ? (r.replaces ? `<button class="b primary" data-ai-add="${i}" title="Замінити чинне правило ${esc(r.replaces)} цією зміною в чернетці правил (у файл — лише «Зберегти зміни»)">Замінити в чернетці</button>` : `<button class="b primary" data-ai-add="${i}" title="Додати правило в чернетку правил (у файл — лише «Зберегти зміни»)">Додати в чернетку</button>`) : ''}<button class="b" data-ai-rej="${i}">Відхилити</button>`;
        h += `<tr${inDraft ? ' class="chg"' : r.status === 'rejected' ? ' class="off"' : ''}><td><b>${esc((r.rule && r.rule.title) || r.title)}</b><div class="muted">${esc(r.rule ? `${r.rule.id} · ${r.rule.mode || 'fix'}${r.rule.effective_from ? ' · з ' + r.rule.effective_from : ''}` : '')}</div>${r.replaces ? '<div class="warn" style="margin:4px 0 0;padding:2px 6px">зміна чинного правила</div>' : ''}${errs.length ? `<div class="bad">${esc(errs.join('; '))}</div>` : ''}</td>
<td class="code">${r.rule ? code(r.rule.match) + ((r.rule.unless || []).length ? '<hr>крім: ' + r.rule.unless.map(code).join('<hr>') : '') : `<span class="muted">${esc(r.raw || '')}</span>`}${r.old ? `<hr><span class="muted">було: </span>${code(r.old.match)}` : ''}</td>
<td>${esc(cr ? Object.values(cr.setLabel).join('; ') : r.rule ? JSON.stringify(r.rule.set || {}) : '')}</td>
<td style="max-width:420px">${esc(r.why)}${r.covers ? `<div class="muted">записів: ${esc(r.covers)}${r.examples.length ? ` · напр. ID ${esc(r.examples.slice(0, 5).join(', '))}` : ''}</div>` : ''}</td><td>${acts}</td></tr>`;
      });
      h += '</table><div class="muted" style="margin:6px 0">Перш ніж зберегти, натисніть «Перевірити на записах…» угорі: там видно, що правило змінить у записах CRM. Змінити умову чи режим — ✎ у таблиці правил нижче.</div>';
    } else if (d.at) h += '<div class="muted">Нових правил ШІ не запропонував.</div>';
    h += `<div class="row"><button class="b" id="r-ai-run"${ready && !job.running ? '' : ' disabled'}>Скласти чернетку зараз</button><span class="muted">Сама — раз на тиждень, коли назбирається щонайменше ${esc(dr.min_new)} нових записів без правил (зараз ${esc(dr.new_obs)})${dr.next ? `, не раніше ${esc(dt(dr.next))}` : ''}. Записи без правил ШІ бачить, коли «Статті й проєкти» перевіряють їх з увімкненими ШІ-підказками.</span></div>`;
    return h + '</details>';
  }
  function bindAiDrafts() {
    const det = $('#r-ai');
    if (!det) return;
    det.ontoggle = () => { AI_OPEN = det.open; };
    /* позначка — для тієї самої чернетки й того самого правила: поки сторінка відкрита, тижнева чернетка могла скластися заново
       (тоді Помічник відповідає 409, а сторінка перечитує чернетку — нічого не позначено й не додано). → чи можна продовжувати */
    const mark = async (i, status) => {
      const r = AIDR.rules[i];
      const res = await hx('POST', '/api/ai/drafts/mark', { i, status, at: AIDR.at, id: (r && r.rule && r.rule.id) || '' }).catch(e => ({ status: 0, json: { error: e.message } }));
      if (res.status === 409) { toast((res.json && res.json.error) || 'Чернетка ШІ оновилася'); AI_OPEN = true; await loadAiDrafts(); renderAiDrafts(); return false; }
      if (res.status < 200 || res.status >= 300) toast((res.json && res.json.error) || `HTTP ${res.status}`);
      return true;
    };
    det.querySelectorAll('[data-ai-add]').forEach(b => { b.onclick = async () => {
      const i = Number(b.dataset.aiAdd), r = AIDR.rules[i];
      if (!r || !r.rule || aiInDraft(r)) return;
      if (!r.replaces && DRAFT.rules.some(x => x.id === r.rule.id)) return;
      if (!(await mark(i, 'added'))) return;
      const at = DRAFT.rules.findIndex(x => x.id === r.rule.id);
      if (r.replaces && at >= 0) DRAFT.rules[at] = ordered(clone(r.rule)); // зміна чинного правила — на його місці
      else if (at >= 0) return;
      else DRAFT.rules.push(ordered(clone(r.rule)));
      // відкритий ✎ того самого правила — уже на новому правилі: інакше «Готово» записало б назад старе
      if (EDIT && !EDIT.isNew && EDIT.id === r.rule.id) EDIT = { id: r.rule.id, rule: clone(DRAFT.rules.find(x => x.id === r.rule.id)) };
      r.status = 'added'; AI_OPEN = true;
      toast(r.replaces ? `Правило ${r.rule.id} змінено в чернетці. Перевірте його на записах і збережіть.` : `Правило ${r.rule.id} — у чернетці. Перевірте його на записах і збережіть.`);
      renderRules();
    }; });
    det.querySelectorAll('[data-ai-rej]').forEach(b => { b.onclick = async () => {
      const i = Number(b.dataset.aiRej);
      if (!(await mark(i, 'rejected'))) return;
      AIDR.rules[i].status = 'rejected'; AI_OPEN = true;
      renderAiDrafts();
    }; });
    const run = $('#r-ai-run');
    if (run) run.onclick = async () => {
      run.disabled = true;
      try { await hj('POST', '/api/ai/draft'); } catch (e) { alert(e.message); run.disabled = false; return; }
      AI_OPEN = true;
      for (;;) {
        await loadAiDrafts();
        renderAiDrafts();
        if (!AIDR || !AIDR.job || !AIDR.job.running) break;
        await sleep(2000);
      }
    };
  }
  // лише блок ШІ: відкрита форма правила (вписане, але ще не «Готово») не перемальовується
  function renderAiDrafts() {
    const det = $('#r-ai');
    if (!det) return;
    det.outerHTML = aiDraftHtml(!!(RMETA && RMETA.canEdit));
    bindAiDrafts();
  }

  // ---------- вплив змін: ті самі записи CRM — за правилами з файлу і за чернеткою ----------
  function impactHtml() {
    const I = IMPACT, rows = I.rows || [];
    let h = `<div class="box"><h4>Що зміниться в записах CRM, якщо зберегти чернетку</h4><div class="row">з <input type="date" id="ri-from" value="${esc(I.from)}"> по <input type="date" id="ri-to" value="${esc(I.to)}">
<button class="b primary" id="ri-go"${I.busy ? ' disabled' : ''}>${I.busy ? 'Перевіряю…' : 'Перевірити'}</button> <span class="muted">Лише читання: записи CRM за період оцінюються двічі — за поточними правилами й за чернеткою.</span></div>`;
    if (I.error) h += `<div class="err">${esc(I.error)}</div>`;
    if (I.rows) {
      h += `<div>Перевірено записів: ${I.n}. ${rows.length ? `Зміниться результат у ${rows.length}:` : 'Чернетка нічого не змінює в цих записах.'}</div>`;
      if (rows.length) h += `<table class="t"><tr><th>ID · дата</th><th>Рахунок</th><th class="n">Сума</th><th>Коментар</th><th>Зараз</th><th>З чернеткою</th></tr>${rows.slice(0, 300).map(x => `<tr><td>${esc(x.rec.id)}<div class="muted">${esc(x.rec.date)}</div></td><td>${esc((x.rec.account_names || []).join(', '))}</td><td class="n">${esc(fmt(x.rec.amount))}</td><td>${esc(String(x.rec.text || '').slice(0, 160))}</td><td>${esc(x.before)}<div class="muted">${esc(x.rb)}</div></td><td>${esc(x.after)}<div class="muted">${esc(x.ra)}</div></td></tr>`).join('')}</table>${rows.length > 300 ? `<div class="muted">Показано 300 з ${rows.length}.</div>` : ''}`;
    }
    return h + '</div>';
  }
  function renderImpact() { const b = $('#r-imp'); if (b) { b.innerHTML = impactHtml(); bindImpact(); } }
  function bindImpact() {
    const go = $('#ri-go');
    if (!go) return;
    go.onclick = async () => {
      IMPACT = { from: $('#ri-from').value, to: $('#ri-to').value, busy: true };
      renderImpact();
      try {
        if (!IMPACT.from || !IMPACT.to || IMPACT.from > IMPACT.to) throw new Error('Перевірте період.');
        const cur = CFLinter.createLinter({ api, rulesDoc: RULES }), drf = CFLinter.createLinter({ api, rulesDoc: DRAFT });
        if (drf.compiled.errors.length) throw new Error('У чернетці є помилки — спершу виправте їх.');
        const { problems } = await cur.loadReference();
        if (problems.length) throw new Error('Довідник статей у CRM не збігається з rules.json:' + NL + problems.join(NL));
        drf.live = cur.live;
        const raws = await cur.fetchRecords(IMPACT.from, IMPACT.to);
        // статуси словами, як у панелі лінтера (07.11.2026)
        const sum = x => (x ? `${CFLinter.STATUS_UA[x.status] || x.status}${x.changes.length ? ' → ' + x.changes.map(ch => ch.toLabel).join('; ') : ''}` : 'жодне правило');
        const ids = x => (x ? x.applicable.map(r => r.id).join(', ') : '');
        const A = new Map(cur.evaluateAll(raws).results.map(x => [x.raw.id, x])), B = new Map(drf.evaluateAll(raws).results.map(x => [x.raw.id, x]));
        const rows = [];
        for (const id of new Set([...A.keys(), ...B.keys()])) {
          const a = A.get(id), b = B.get(id);
          if (sum(a) !== sum(b) || ids(a) !== ids(b)) rows.push({ rec: (b || a).record, before: sum(a), after: sum(b), rb: ids(a), ra: ids(b) });
        }
        rows.sort((x, y) => (x.rec.date < y.rec.date ? 1 : -1));
        IMPACT = { from: IMPACT.from, to: IMPACT.to, n: raws.filter(r => !r.deleted_at).length, rows };
      } catch (e) { IMPACT = { from: IMPACT.from, to: IMPACT.to, error: e.message.includes('HTTP 401') || e.message.includes('HTTP 403') ? 'Підключіть Помічник до CRM (вкладка «Налаштування»).' : e.message }; }
      renderImpact();
    };
  }

  // ================= ФАЙЛИ =================
  async function initFiles() {
    const el = $('#tab-files');
    try {
      const j = await hj('GET', '/api/files/list');
      const kinds = { backups: 'Резервні копії (для відкату)', journals: 'Журнали змін', reports: 'Звіти', bank: 'Виписки' };
      el.innerHTML = `<h2>Файли Помічника</h2><div class="muted">Папка: <code>${esc(j.dir)}</code></div>` + Object.entries(kinds).map(([k, title]) => {
        const fs = j.files.filter(f => f.kind === k);
        return `<h3>${title} <button class="b" data-open="${k}">Відкрити папку</button></h3>` + (fs.length ? `<table class="t"><tr><th>Файл</th><th>Розмір</th><th>Змінено</th>${k === 'backups' ? '<th></th>' : ''}</tr>${fs.map(f => `<tr><td>${esc(f.name)}</td><td class="n">${(f.size / 1024).toFixed(1)} КБ</td><td>${esc(f.mtime.replace('T', ' '))}</td>${k === 'backups' ? `<td>${f.name.includes('_тип_') ? '<span class="muted">повертають вручну в CRM</span>' : `<button class="b" data-rb="${esc(f.name)}">Відкат…</button>`}</td>` : ''}</tr>`).join('')}</table>` : '<div class="muted">порожньо</div>');
      }).join('') + `<p class="muted">«Відкат…» повертає статтю й проєкт записів із резервної копії (з окремим підтвердженням; записи, які після лінтера змінювали вручну, буде пропущено).</p>`
        // копії «Звірки з банком» (тип, рахунок «куди») — інший формат, відкат лінтера їх не читає (07.11.2026)
        + (j.files.some(f => f.kind === 'backups' && f.name.includes('_тип_')) ? `<p class="muted">Копії <code>кешфлоу_резервна_копія_тип_….json</code> — зі «Звірки з банком» (зміна типу на «Переказ між рахунками» чи рахунку «куди»). Повернути їх можна посиланням «Повернути як було» одразу після зміни; пізніше — вручну в CRM за цим файлом.</p>` : '');
      el.querySelectorAll('[data-open]').forEach(b => b.onclick = () => hj('POST', '/api/files/open', { kind: b.dataset.open }).catch(e => alert(e.message)));
      el.querySelectorAll('[data-rb]').forEach(b => b.onclick = () => rollbackFile(b.dataset.rb).catch(e => alert(e.message)));
    } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }

  // ================= НАЛАШТУВАННЯ =================
  function initSettings() {
    const el = $('#tab-settings');
    const s = STATUS || { crm: {}, bank: {}, config: {} };
    el.innerHTML = `<h2>Налаштування</h2>
<div class="box"><h4>Вхід у CRM</h4>
<div>Стан: ${s.crm.connected ? `<span class="good">підключено${s.crm.user && s.crm.user !== 'підключено' ? ` (${esc(s.crm.user)})` : ''}</span>` : '<span class="bad">не підключено</span>'}</div>
<ol><li>Один раз додайте закладки: відкрийте <a href="/dist/встановлення.html" target="_blank">сторінку закладок</a> і перетягніть «Підключити Помічник» на панель закладок.</li>
<li>Відкрийте crm.example.com під своїм логіном і натисніть цю закладку. Якщо браузер спитає дозвіл на доступ до програм на цьому пристрої — дозвольте.</li>
<li>Якщо закладка скаже «токен скопійовано» — вставте його сюди:</li></ol>
<div class="row"><input type="text" id="st-token" placeholder="токен (Ctrl+V)" autocomplete="off"><button class="b primary" id="st-save">Підключити</button><button class="b" id="st-out">Від'єднати</button></div>
<div class="muted">Токен зберігається зашифрованим (Windows DPAPI) у папці app\\data і потрібен лише для запитів до CRM. Права — як у вашого користувача CRM.</div></div>
<div class="box" id="st-ai"><h4>ШІ-підказки (Claude API)</h4><div class="muted">завантажую…</div></div>
<div class="box"><h4>Виписки банку</h4><div class="row">Папка зі скриптом privat_fetch.py: <input type="text" id="st-dir" value="${esc(s.bank.dir || '')}"><button class="b" id="st-dirsave">Зберегти</button><button class="b" id="st-diropen">Відкрити</button></div>
<div>privat_fetch.py: ${s.bank.script ? '<span class="good">знайдено</span>' : '<span class="bad">не знайдено</span>'}; privat_tokens.json: ${s.bank.tokens ? '<span class="good">знайдено</span>' : '<span class="bad">не знайдено</span>'}${s.bank.clients && s.bank.clients.length ? ` (клієнти: ${esc(s.bank.clients.join(', '))})` : ''}</div>
<div class="row" style="margin-top:8px"><label><input type="checkbox" id="st-monofx"${s.bank.mono_currency ? ' checked' : ''}> валютні рахунки Моно (долар, євро…) — теж вивантажувати</label></div>
<div class="muted">Без галочки з Моно беруться лише гривневі рахунки ФОП: на валютних руху зазвичай немає, а кожен із них — ще хвилина (банк дозволяє 1 запит на 60 с). Їхній поточний залишок усе одно видно в журналі вивантаження. Приват вивантажує всі рахунки, як і раніше. Галочка діє, коли виписки вивантажує Помічник; окремий запуск privat_fetch.py (запустити.bat) — завжди лише гривневі.${s.bank.script && !s.bank.mono_flag ? ' <span class="bad">Ваш privat_fetch.py ще старий — він вивантажує всі валюти; оновіть його («Оновити.bat»).</span>' : ''}</div></div>
<div class="box"><h4>Зіставлення рахунків банку з кешфлоу</h4>${Object.keys((s.config && s.config.account_map) || {}).length ? `<table class="t"><tr><th>IBAN</th><th>Рахунок кешфлоу (id)</th></tr>${Object.entries(s.config.account_map).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table><button class="b" id="st-mapclear">Скинути всі вибори</button>` : '<div class="muted">Зіставлення запам\'ятовується, коли вибираєте рахунок у вкладці «Звірка з банком».</div>'}</div>`;
    $('#st-save').onclick = async () => {
      try { const j = await hj('POST', '/api/token', { token: $('#st-token').value }); $('#st-token').value = ''; toast('Підключено: ' + (j.user || '')); await refreshStatus(); initSettings(); }
      catch (e) { alert(e.message); }
    };
    $('#st-out').onclick = async () => { if (!confirm('Від\'єднати Помічник від CRM і стерти збережений токен?')) return; await hj('POST', '/api/logout', {}); await refreshStatus(); initSettings(); };
    $('#st-dirsave').onclick = async () => { await hj('POST', '/api/config', { bank_dir: $('#st-dir').value.trim() }); await refreshStatus(); initSettings(); toast('Збережено'); };
    $('#st-diropen').onclick = () => hj('POST', '/api/files/open', { kind: 'bankdir' }).catch(e => alert(e.message));
    $('#st-monofx').onchange = async e => {
      const on = e.target.checked;
      try { await hj('POST', '/api/config', { mono_currency: on }); toast(on ? 'Моно: вивантажуватимуться й валютні рахунки' : 'Моно: лише гривневі рахунки'); }
      catch (err) { alert(err.message); }
      await refreshStatus(); initSettings();
    };
    const mc = $('#st-mapclear');
    if (mc) mc.onclick = async () => { if (!confirm('Скинути всі збережені зіставлення рахунків?')) return; await hj('POST', '/api/config', { account_map: {} }); await refreshStatus(); initSettings(); };
    loadAiBox();
  }

  // ---------- ШІ-підказки: ключ Claude API, увімкнення, ліміт, витрати (app/helper_ai.py) ----------
  let AI_T = null;
  async function loadAiBox() {
    clearTimeout(AI_T);
    const box = $('#st-ai');
    if (!box) return;
    let s;
    try { s = await hj('GET', '/api/ai/status'); } catch (e) { box.innerHTML = `<h4>ШІ-підказки (Claude API)</h4><div class="err">${esc(e.message)}</div>`; return; }
    const u = s.usage || {};
    const cls ={ ready: 'good', limit: 'bad', badkey: 'bad', nosdk: 'bad' }[s.state] || '';
    const job = s.sdk_job || { log: [] }, chk = s.check || {}, sh = s.shared || { others: [], name: 'Кешфлоу ШІ', set: '' };
    const n = v => `${v.n} ${v.n % 10 === 1 && v.n % 100 !== 11 ? 'запит' : [2, 3, 4].includes(v.n % 10) && ![12, 13, 14].includes(v.n % 100) ? 'запити' : 'запитів'}`;
    box.innerHTML = `<h4>ШІ-підказки (Claude API)</h4>
<div>Стан: <b class="${cls}">${esc(s.state_ua)}</b>${chk.at ? ` <span class="muted">· ключ перевірено ${esc(dt(chk.at))}${chk.ok ? '' : ': ' + esc(chk.error)}</span>` : ''}</div>
<ul class="muted" style="margin:6px 0 10px;padding-left:18px">
<li><b>Щодня — ${esc((s.roles || {}).daily || '')}</b>: стаття й проєкт для записів без правил («Статті й проєкти», картка «Підказки ШІ») і для операцій банку без статті («Звірка з банком» → «Внести в CRM»); «Зіставлення ШІ» на кнопку. Змінює запис людина кнопкою, як зараз.</li>
<li><b>Раз на тиждень — ${esc((s.roles || {}).weekly || '')}</b>: переглядає, де лінтер і щоденний ШІ не впоралися, і складає чернетку нових правил чи змін чинних — у вкладці «Правила». У файл правило потрапляє лише після «Зберегти зміни».</li>
<li>ШІ нічого не змінює в CRM. У Claude ідуть дата, сума, рахунок, коментар, стаття й проєкт записів без правил (і контрагент з призначенням операцій банку) — без IBAN, номерів карток, ІПН, телефонів і e-mail.</li></ul>
<div class="row"><input type="password" id="ai-key" placeholder="${s.key ? 'ключ збережено — щоб замінити, вставте новий' : 'ключ Claude API: sk-ant-…'}" autocomplete="off" style="min-width:380px">
<button class="b primary" id="ai-save">${s.key ? 'Замінити й перевірити' : 'Зберегти й перевірити'}</button>${s.key ? '<button class="b" id="ai-forget">Забути ключ</button>' : ''}</div>
<div class="row"><label><input type="checkbox" id="ai-on"${s.on ? ' checked' : ''}> підказки увімкнено</label>
<span>Ліміт на місяць, $ <input type="number" id="ai-limit" min="0" max="1000" step="1" value="${esc(s.limit)}" style="width:90px"></span><button class="b" id="ai-cfg">Зберегти</button></div>
<div class="muted">Ліміт витрачається рівномірно, щоб його вистачило на весь місяць: на сьогодні — до ${money(s.pace)} (частка за дні, що минули, і 10 % запасу). ${sh.path ? 'Зі спільною папкою витрати всіх Помічників рахуються разом — ліміт один на всіх.' : 'Без спільної папки кожен Помічник рахує лише свої витрати: ліміти на кількох комп\'ютерах разом не мають перевищувати кредит.'}</div>
<div class="row" style="margin-top:8px">Спільна папка ШІ: ${sh.path ? `<b>${esc(sh.path)}</b> <span class="muted">· ${sh.others.length ? `ще пишуть: ${sh.others.map(o => `${esc(o.who)} (${esc(dt(o.at))})`).join(', ')}` : 'інших комп\'ютерів поки немає'}</span>` : sh.off ? '<span class="muted">вимкнено</span>' : sh.missing ? `<span class="bad">папки «${esc(sh.set)}» немає</span>` : `<span class="muted">не знайдено: на Google Диску немає папки «${esc(sh.name)}» (як налаштувати — в інструкції, «ШІ-підказки»)</span>`}</div>
<div class="row"><input id="ai-shared" placeholder="порожньо — шукати «${esc(sh.name)}» на Google Диску самому; off — вимкнути" value="${esc(sh.set)}" style="min-width:380px"><button class="b" id="ai-shared-save">Зберегти папку</button></div>
<div>Цього місяця: <b>${money(u.usd + (s.others_usd || 0))}</b>${s.others_usd ? ` <span class="muted">(з них інші комп'ютери — ${money(s.others_usd)})</span>` : ''} з ${money(s.limit)}${Object.entries(u.models || {}).map(([k, v]) => ` · ${esc(s.models[k] || k)}: ${n(v)}, ${money(v.usd)}`).join('')} <span class="muted">(оцінка за цінами Claude API; точна сума — у Claude Console, плитка «Spend this month»)</span></div>
<div>Пакет anthropic: ${job.running ? '<b>встановлюється…</b>' : s.sdk ? `<span class="good">встановлено (${esc(s.sdk)})</span>` : '<span class="bad">не встановлено</span> — Помічник поставить його сам, щойно ви збережете ключ. <button class="b" id="ai-sdk">Встановити зараз</button>'}</div>
${job.log && job.log.length && (job.running || job.code) ? `<pre class="log">${esc(job.log.join(NL))}</pre>` : ''}
<details style="margin-top:8px"><summary>Як отримати ключ (один раз)</summary><ol>
<li>На claude.ai: «Налаштування» → «Billing» — підключіть щомісячний API-кредит підписки до організації в Claude Console (створіть її, наприклад «Кешфлоу»).</li>
<li>У <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">Claude Console → API keys</a> натисніть «Create key». За бажання — окремий робочий простір «Лінтер» з лімітом витрат.</li>
<li>Скопіюйте ключ (починається з sk-ant-), вставте сюди й натисніть «Зберегти й перевірити». Ключ зберігається зашифрованим (Windows DPAPI) у app\\data і нікуди більше не потрапляє.</li></ol></details>`;
    $('#ai-save').onclick = async () => {
      const k = $('#ai-key').value.trim();
      if (!k) return toast('Вставте ключ у поле');
      $('#ai-save').disabled = true;
      try {
        const j = await hj('POST', '/api/ai/key', { key: k });
        $('#ai-key').value = '';
        toast(j.installing ? 'Ключ збережено. Помічник встановлює пакет anthropic — потім сам перевірить ключ.' : j.ok ? 'Ключ збережено й перевірено — ШІ-підказки працюють.' : 'Ключ збережено, але перевірка не вдалася: ' + j.error);
      } catch (e) { alert(e.message); }
      loadAiBox();
    };
    const fg = $('#ai-forget');
    if (fg) fg.onclick = async () => { if (!confirm('Забути ключ Claude API? ШІ-підказки зупиняться; отримані підказки лишаться.')) return; await hj('POST', '/api/ai/forget', {}); loadAiBox(); };
    $('#ai-shared-save').onclick = async () => {
      try { await hj('POST', '/api/ai/config', { shared: $('#ai-shared').value.trim() }); toast('Збережено'); } catch (e) { alert(e.message); }
      loadAiBox();
    };
    $('#ai-cfg').onclick = async () => {
      // порожнє поле (чи «50,5», якого поле-число не розуміє) — не $0: інакше ШІ мовчки зупинявся б до кінця місяця
      const raw = $('#ai-limit').value.trim();
      if (raw === '' || !Number.isFinite(Number(raw))) { toast('Вкажіть ліміт числом, у доларах (наприклад 100)'); $('#ai-limit').focus(); return; }
      if (Number(raw) === 0 && !confirm('Ліміт $0 зупинить ШІ-підказки до кінця місяця. Зберегти?')) return;
      try { await hj('POST', '/api/ai/config', { on: $('#ai-on').checked, limit: Number(raw) }); toast('Збережено'); } catch (e) { alert(e.message); }
      loadAiBox();
    };
    const sd = $('#ai-sdk');
    if (sd) sd.onclick = async () => { try { await hj('POST', '/api/ai/sdk', {}); } catch (e) { alert(e.message); } loadAiBox(); };
    if (job.running) AI_T = setTimeout(loadAiBox, 2000); // хід встановлення пакета — наживо
  }

  // ---------- старт ----------
  (async () => {
    await refreshStatus();
    setInterval(refreshStatus, 15000);
    show(STATUS && STATUS.crm.connected ? 'bank' : 'settings');
  })();
})();
