/* =====================================================================
   Звірка рахунків банку з кешфлоу (логіка privat_recon.js без інтерфейсу).
   Банк — json з privat_fetch.py (API Автоклієнта Привату і monobank).
   Порівнює: вхідний залишок, обороти, вихідний залишок, суми по днях,
   поштучно операції (сума до копійки; дата: спершу той самий день, далі ±1…±3).
   Залишки на дату: CRM — поточний balance рахунку мінус рух записами, датованими пізніше
   (саме так CRM і показує залишок); банк — вхідний залишок виписки плюс рух до дати.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./crm-model.js'));
  else root.CFRecon = factory(root.CFModel);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';
  const r2 = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
  const cents = x => Math.round(Number(x) * 100);
  const num = v => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return v;
    const m = String(v).replace(/[\s  ]/g, '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };
  const dmy2iso = s => { const m = String(s || '').match(/(\d{2})\.(\d{2})\.(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  // номер дня запам'ятовується (07.11.2026): multiPairs порівнює кожну пару без 1:1, і розбір дат займав майже весь час звірки
  const DAYN = new Map();
  const dayNo = a => { let v = DAYN.get(a); if (v === undefined) { v = Math.floor(Date.parse(a + 'T12:00:00Z') / 864e5); DAYN.set(a, v); } return v; };
  const dayDiff = (a, b) => dayNo(a) - dayNo(b);
  let tFmt = null;
  const kyivTime = iso => { try { tFmt = tFmt || new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' }); return tFmt.format(new Date(iso)); } catch (e) { return ''; } };

  // ---------- банк: json з privat_fetch.py ----------
  function bankAccounts(json, fileName) {
    const accs = json.accounts || [json];
    return accs.map(a => {
      const bank = a.bank || json.bank || 'privat';
      const src = `${fileName || 'json'} (${bank === 'mono' ? 'API monobank' : 'API Автоклієнта'}, отримано ${json.fetched_at || '?'})`;
      const n = bank === 'mono' ? normMono(a, src, json.from, json.to) : normPrivat(a, src, json.from, json.to);
      return { ...n, bank, iban: a.acc || null, owner: a.name || '', client: a.client || json.client || '', fileName: fileName || '' };
    });
  }
  // monobank: time — Unix-час (с), amount — у копійках/центах (документація monobank)
  function normMono(a, src, from, to) {
    const res = { src, rows: [], opening: a.opening, closing: a.closing, fileFrom: from, fileTo: to, ccy: a.ccy || null, warnings: [...(a.warnings || [])] };
    let holds = 0;
    for (const t of a.transactions || []) {
      const iso = new Date(t.time * 1000).toISOString();
      if (t.hold) holds++;
      res.rows.push({ date: M.kyivDate(iso), time: kyivTime(iso), amount: r2(t.amount / 100), cpty: t.counterName || t.description || '',
        purpose: [t.description, t.comment].filter(Boolean).join(' / '), ref: t.id || '', cpIban: t.counterIban || '', cpCode: t.counterEdrpou || '' });
    }
    if (holds) res.warnings.push(`Операцій зі статусом hold (блокування суми): ${holds} — включені у звірку.`);
    res.fileOpening = res.opening; res.fileClosing = res.closing;
    return res;
  }
  function normPrivat(a, src, from, to) {
    // skipped — не проведені банком (PR_PR ≠ «r»): у звірку не йдуть, але видно в «Операції з виписок поза звіркою»
    const res = { src, rows: [], skipped: [], opening: a.opening, closing: a.closing, fileFrom: from, fileTo: to, ccy: a.ccy || null, warnings: [...(a.warnings || [])] };
    // Приват на межі сторінок віддав ту саму операцію двічі (вересень 2026, …9953): дубль за ID пропускається (07.11.2026).
    // Без ID — за референсом і всіма полями; без референсу не зливаємо: дві однакові комісії в ту саму хвилину — різні операції
    const seen = new Set(), dups = [];
    for (const t of a.transactions || []) {
      const key = t.ID ? `id:${t.ID}` : t.REF ? ['ref', t.REF, t.REFN, t.TRANTYPE, t.SUM, t.DAT_OD, t.TIM_P].join('|') : null;
      if (key && seen.has(key)) { dups.push(t); continue; }
      if (key) seen.add(key);
      const s = num(t.SUM), sign = t.TRANTYPE === 'D' ? -1 : 1;
      const row = { date: dmy2iso(t.DAT_OD), time: t.TIM_P || '', amount: r2(sign * s), cpty: t.AUT_CNTR_NAM || '', purpose: t.OSND || '', ref: (t.REF || '') + (t.REFN ? '/' + t.REFN : ''),
        cpIban: t.AUT_CNTR_ACC || '', cpCode: t.AUT_CNTR_CRF || '' };
      if (t.PR_PR && t.PR_PR !== 'r') { res.skipped.push({ ...row, why: `банк не провів операцію (статус ${t.PR_PR}: не проведена, сторнована чи забракована)` }); continue; }
      res.rows.push(row);
      if (!res.ccy && t.CCY) res.ccy = t.CCY;
    }
    if (res.skipped.length) res.warnings.push(`Пропущено ${res.skipped.length} транзакцій зі статусом PR_PR ≠ «r» (не проведені / сторновані / забраковані).`);
    if (dups.length) res.warnings.push(`Банк віддав операцію двічі — дубль пропущено (${dups.length} шт.: ${dups.slice(0, 3).map(t => `${t.DAT_OD || '?'} ${t.TRANTYPE === 'D' ? '−' : '+'}${num(t.SUM)}`).join(', ')}${dups.length > 3 ? '…' : ''}).`);
    // вхідний + рух ≠ вихідний — банк пропустив чи задвоїв операцію: попередження на будь-який період, не лише на останній день файлу
    const open = num(a.opening), close = num(a.closing);
    if (open !== null && close !== null) {
      const d = r2(open + res.rows.reduce((s, x) => s + x.amount, 0) - close);
      if (Math.abs(d) >= 0.005) res.warnings.push(`Виписка неповна: вхідний + рух ≠ вихідний на ${r2(Math.abs(d))} ${!res.ccy || res.ccy === 'UAH' ? 'грн' : res.ccy} — вивантажте заново.`);
    }
    res.fileOpening = res.opening; res.fileClosing = res.closing;
    return res;
  }

  // ---------- зіставлення рахунку банку з рахунком кешфлоу ----------
  const BANKRE = { privat: /приват|privat/i, mono: /моно|mono|універсал|universal/i };
  const bankOf = a => Object.keys(BANKRE).find(k => BANKRE[k].test(a.name + ' ' + (a.alias_en || '')));
  const Wb = x => new RegExp('(?<!\\p{L})(' + x + ')(?!\\p{L})', 'iu');
  // валюта в назві рахунку CRM: старі назви — кодом («4 USD Маркет…», «ЗЛТ»), нові (з 30.10.2026) — словом («Приват долар ТОВ…», «євро», «злотий»)
  const CCYRE = { UAH: Wb('UAH|ГРН|гривн\\p{L}*'), USD: Wb('USD|долар\\p{L}*|доллар\\p{L}*'), EUR: Wb('EUR|ЄВР|Євр|євро'), PLN: Wb('PLN|ЗЛТ|злот\\p{L}*'), GBP: Wb('GBP|фунт\\p{L}*'), AED: Wb('AED|дирхам\\p{L}*') };
  const INACTIVE = /неактуал|not actual|не актуал/i;
  // останні 4 цифри IBAN у назві рахунку CRM («Приват ТОВ СЕРВІС МАРКЕТ 8112» ↔ UA00…00008112) — найпевніший збіг
  const ibanTail = b => (b && b.iban ? String(b.iban).replace(/\s+/g, '').slice(-4) : null);
  const hasTail = (a, t) => !!t && /^\d{4}$/.test(t) && new RegExp(`(?<!\\d)${t}(?!\\d)`).test(a.name || '');
  const STOP = new Set(['фоп', 'тов', 'пп', 'ат', 'приват', 'privat', 'моно', 'mono', 'монобанк', 'monobank', 'ua', 'uah', 'грн', 'usd', 'eur', 'pln', 'універсал', 'universal']);
  const words = s => String(s || '').toLowerCase().replace(/[«»"'ʼ’`]/g, ' ').split(/[^a-zа-яіїєґ0-9]+/i).filter(w => w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w));
  // відстань редагування ≤ 1 (одна літера вставлена, пропущена чи замінена)
  function near1(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, d = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++d > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return d + (a.length - i) + (b.length - j) <= 1;
  }
  /* accounts — рахунки кешфлоу (GET invoice?get_all=1), ccyById — {1:'UAH',…}. Повертає {id, cand}. */
  function autoMatch(b, accounts, ccyById) {
    const live = accounts.filter(a => !a.deleted_at);
    // корп. картка — не рахунок банку (вона списує з рахунку ФОП / ТОВ), навіть якщо в назві є цифри
    const t = ibanTail(b), byTail = live.filter(a => bankOf(a) === b.bank && !isCorp(a) && hasTail(a, t));
    if (byTail.length) {
      const act = byTail.filter(a => !INACTIVE.test(a.name)), c = act.length ? act : byTail;
      return { id: c.length === 1 ? c[0].id : null, cand: c };
    }
    const kw = [...new Set([...words(b.client), ...words(b.owner)])];
    // слово з виписки є в назві рахунку CRM; для довгих прізвищ — і з різницею в одну літеру («Житинська» / «Житенська»)
    const score = a => { const n = a.name.toLowerCase(), nw = words(a.name); return kw.filter(w => n.includes(w) || (w.length >= 6 && nw.some(x => near1(w, x)))).length; };
    let c = live.filter(a => bankOf(a) === b.bank && !isCorp(a)).map(a => ({ a, s: score(a) })).filter(x => x.s > 0);
    if (!c.length) return { id: null, cand: [] };
    const mx = Math.max(...c.map(x => x.s));
    c = c.filter(x => x.s === mx).map(x => x.a);
    const re = CCYRE[b.ccy];
    if (re) {
      const byCcy = c.filter(a => re.test(a.name));
      if (byCcy.length) c = byCcy;
      else if (b.ccy !== 'UAH') c = [];
      else c = c.filter(a => !Object.entries(CCYRE).some(([k, r]) => k !== 'UAH' && r.test(a.name)));
    } else if (b.ccy && b.ccy !== 'UAH') c = c.filter(a => ccyById && ccyById[a.currency_id] === b.ccy); // інша валюта (CZK…) — лише рахунок CRM у ній
    const act = c.filter(a => !INACTIVE.test(a.name));
    if (act.length) c = act;
    const byCode = c.filter(a => ccyById && ccyById[a.currency_id] === b.ccy);
    if (byCode.length) c = byCode;
    return { id: c.length === 1 ? c[0].id : null, cand: c };
  }

  /* Службові рахунки Привату: масові виплати, РКО, ЗП, цільові зарахування — у CRM їх немає. */
  const SERVICE_ACC = /^\s*(мас\.?\s*вип|рко|ціл[-ь]?[а-яіїєґ]*\.?\s*зарах)/i;
  /* З них транзитні для ЗП (цільові зарахування, масові виплати): гроші там не затримуються — з рахунку йде один переказ на виплату. */
  const PAY_ACC = /^\s*(мас\.?\s*вип|ціл[-ь]?[а-яіїєґ]*\.?\s*зарах)/i;
  /* Технічні рахунки банку за балансовим рахунком в IBAN (назва в них — як у поточного): 2603 — розподільчий валютний
     (надходження з-за кордону одразу переходять на поточний 2600), 3570 — облік комісій банку. У CRM їх немає й не треба. */
  const TECH_BAL = { 2603: 'розподільчий валютний рахунок: надходження з нього одразу йдуть на поточний', 3570: 'технічний рахунок банку для комісій' };
  const balOf = iban => (/^UA\d{8}0*([1-9]\d{3})/.exec(String(iban || '').replace(/\s+/g, '')) || [])[1] || null;
  /* Зіставлення всіх рахунків виписки з рахунками CRM. saved — збережений вибір {IBAN: id рахунку CRM або 0 = «не звіряти»}.
     Службові не зіставляються; якщо кілька рахунків банку автоматично підходять до одного рахунку CRM, лишається один —
     з операціями у виписці, далі з більшим залишком (решта — «не звіряється», людина може вибрати інший).
     Той самий рахунок банку з кількох файлів виписок (той самий IBAN) — один рахунок: зіставляється один раз, а файл під період вибирає звірка.
     Повертає [{cfId, note, fixed, service, second}] у порядку banks; fixed — вибір людини; second — ще один рахунок банку для вже зіставленого. */
  function matchAccounts(banks, accounts, ccyById, saved) {
    saved = saved || {};
    const live = accounts.filter(a => !a.deleted_at), nameOf = id => (live.find(a => a.id === id) || {}).name || id;
    const keyOf = (b, i) => b.iban || `#${i}`, keys = banks.map(keyOf), one = new Map();
    banks.forEach((b, i) => {
      if (one.has(keys[i])) return;
      if (b.iban && Object.prototype.hasOwnProperty.call(saved, b.iban)) {
        const id = Number(saved[b.iban]) || null;
        one.set(keys[i], id && live.some(a => a.id === id) ? { cfId: id, note: 'збережений вибір', fixed: true } : { cfId: null, note: 'не звіряти (ваш вибір)', fixed: true });
      } else if (SERVICE_ACC.test(b.owner || '')) one.set(keys[i], { cfId: null, note: 'службовий рахунок (масові виплати, РКО, ЗП, цільові) — не звіряється', fixed: false, service: true });
      else if (TECH_BAL[balOf(b.iban)]) one.set(keys[i], { cfId: null, note: `${TECH_BAL[balOf(b.iban)]} — у CRM не потрібен, не звіряється`, fixed: false, service: true });
      else {
        const m = autoMatch(b, live, ccyById);
        // порожній рахунок (операцій немає, залишок 0), для якого в CRM рахунку немає (напр., валютні рахунки Моно): звіряти нічого — дія не потрібна
        const empty = banks.filter((x, j) => keys[j] === keys[i]).every(x => !x.rows.length && !(Math.abs(Number(x.closing) || 0) >= 0.005) && !(Math.abs(Number(x.opening) || 0) >= 0.005));
        one.set(keys[i], { cfId: m.id, note: m.id ? 'автоматично' : m.cand.length > 1 ? 'кілька збігів — виберіть' : empty ? 'у CRM такого рахунку немає; операцій і залишку теж немає — звіряти нічого' : 'не знайдено — виберіть', fixed: false, empty: !m.id && empty });
      }
    });
    const groups = new Map();
    for (const [k, r] of one) if (r.cfId && !r.fixed) { if (!groups.has(r.cfId)) groups.set(r.cfId, []); groups.get(r.cfId).push(k); }
    for (const [id, ks] of groups) {
      const taken = [...one.values()].some(r => r.fixed && r.cfId === id);
      if (ks.length < 2 && !taken) continue;
      // з кількох рахунків банку лишається той, де є операції, далі — з більшим залишком (з усіх його файлів)
      const score = k => { const list = banks.filter((b, i) => keys[i] === k); return [list.some(b => b.rows.length) ? 1 : 0, Math.max(...list.map(b => Math.abs(Number(b.closing) || 0)))]; };
      const order = new Map(ks.map((k, i) => [k, i]));
      ks.sort((x, y) => { const a = score(x), c = score(y); return c[0] - a[0] || c[1] - a[1] || order.get(x) - order.get(y); });
      ks.forEach((k, n) => {
        if (taken || n > 0) one.set(k, { cfId: null, note: `ще один рахунок банку для «${nameOf(id)}» — не звіряється (виберіть, якщо потрібен саме він)`, fixed: false, second: true });
        else one.get(k).note = `автоматично, з ${ks.length} рахунків банку — перевірте`;
      });
    }
    return keys.map(k => ({ ...one.get(k) }));
  }

  // ---------- кешфлоу рахунку ----------
  const SIGN = { 1: 1, 2: -1, 3: 1, 4: -1, 5: 1, 6: -1 };
  const OPN = { 1: 'дохід', 2: 'витрата', 3: 'переказ (вхід)', 4: 'переказ (вихід)', 5: 'обмін (вхід)', 6: 'обмін (вихід)' };
  const PAIR = { 3: 4, 4: 3, 5: 6, 6: 5 };
  /* рух рахунку з платежу x запису r; для переказу й обміну peer — рахунок другої сторони; mk — маркетолог (рекламний бюджет), як у реєстрі;
     per — місяць P&L запису «РРРР-ММ» (за ним CRM закриває місяць) */
  const itemOf = (r, x) => {
    const o = Number(x.operation), y = PAIR[o] ? (r.payments || []).find(p => p !== x && !p.deleted_at && Number(p.operation) === PAIR[o]) : null;
    const mb = r.marketer_balance_history && r.marketer_balance_history.marketer_balance;
    return { id: r.id, date: M.kyivDate(r.date), per: r.period ? M.monthOf(M.kyivDate(r.period)) : null, time: kyivTime(r.date), amount: r2(SIGN[x.operation] * Number(x.amount)), op: OPN[x.operation] || x.operation, comment: r.comment || '', lead: !!r.task_payment_id,
      opc: o, peer: y ? y.invoice_id : null, proj: r.project_id || null, art: x.pnl_category_id != null ? `${x.pnl_category_id}/${x.pnl_operation_id}` : null,
      mk: mb && mb.user_id ? Number(mb.user_id) : null, acc: Number(x.invoice_id), ...(r.draft ? { draft: true } : {}), // draft — чернетка CRM (core/drafts.js)
      ...(autoRec(r) ? { auto: true } : {}) };
  };
  /* Автоматичний запис CRM (модуль ЗП, «Підтвердження виведення коштів з балансу»): як у crm-model.normalizeRecord — ручний лише з явним
     is_manual = true, або дата = час створення до секунди. Такий запис лінтер не змінює («Записи з неправильним типом», огляд 16.11.2026). */
  const autoRec = r => !(r.is_manual === true || r.is_manual === 1 || r.is_manual === '1') || !!(r.date && r.created_at && r.date === r.created_at && !/:00(\.0+)?Z$/.test(r.date));
  /* записи invoice-payment → рух рахунку accId (знак за типом операції) */
  function cashflowItems(records, accId) {
    const items = [];
    for (const r of records) {
      if (r.deleted_at) continue;
      for (const x of r.payments || []) {
        if (x.invoice_id !== accId || x.deleted_at || !SIGN[x.operation]) continue;
        items.push(itemOf(r, x));
      }
    }
    return items;
  }
  /* те саме для всіх рахунків одразу: Map(id рахунку → рух) */
  function cashflowByAccount(records) {
    const m = new Map();
    for (const r of records) {
      if (r.deleted_at) continue;
      for (const x of r.payments || []) {
        if (x.deleted_at || !SIGN[x.operation]) continue;
        if (!m.has(x.invoice_id)) m.set(x.invoice_id, []);
        m.get(x.invoice_id).push(itemOf(r, x));
      }
    }
    return m;
  }

  // ---------- залишки на кінець дня (за Києвом) ----------
  /* CRM: balance зараз − рух записами з датою після date. items мають містити ВСІ записи рахунку, датовані після date. */
  function crmBalanceAt(balanceNow, items, date) {
    const after = r2((items || []).filter(x => x.date > date).reduce((s, x) => s + x.amount, 0));
    return { value: r2(Number(balanceNow) - after), after };
  }
  /* Банк (рахунок із bankAccounts): {value, note, warn}; value = null, якщо дата поза випискою або залишків немає. */
  function bankBalanceAt(b, date) {
    if (b.fileFrom && date < b.fileFrom) return { value: null, note: `виписка починається з ${b.fileFrom}` };
    if (b.fileTo && date > b.fileTo) return { value: null, note: `виписка лише до ${b.fileTo}` };
    const move = r2(b.rows.filter(x => x.date <= date && (!b.fileFrom || x.date >= b.fileFrom)).reduce((s, x) => s + x.amount, 0));
    const calc = b.opening == null ? null : r2(b.opening + move);
    if (b.closing != null && date === b.fileTo) {
      const warn = calc !== null && Math.abs(calc - b.closing) >= 0.005 ? `у виписці вхідний ${b.opening} + рух ${move} ≠ вихідний ${b.closing}` : '';
      return { value: r2(b.closing), note: 'вихідний залишок виписки', warn };
    }
    if (calc === null) return { value: null, note: 'у виписці немає вхідного залишку' };
    return { value: calc, note: move ? `вхідний залишок виписки + рух до ${date}` : 'вхідний залишок виписки' };
  }
  /* Банк: залишок на початок дня date (до його операцій); null, якщо виписка цього не дає. */
  function bankOpeningAt(b, date) {
    if (b.opening == null || !b.fileFrom || date < b.fileFrom || (b.fileTo && date > b.fileTo)) return null;
    return r2(b.opening + b.rows.filter(x => x.date < date && x.date >= b.fileFrom).reduce((s, x) => s + x.amount, 0));
  }

  // ---------- звірка за період: залишки, обороти, кількість операцій за кожною сумою ----------
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const sumPos = a => r2(a.filter(x => x.amount > 0).reduce((s, x) => s + x.amount, 0));
  const sumNeg = a => r2(-a.filter(x => x.amount < 0).reduce((s, x) => s + x.amount, 0));
  const dif = (c, b) => (c === null || c === undefined || b === null || b === undefined ? null : r2(c - b));
  /* Суми, кількість операцій з якими в банку і в CRM різна (сума — зі знаком, до копійки).
     near — коли в банку операцій більше: записи CRM з цією сумою за 5 днів до чи після періоду (можлива причина — інша дата). */
  function countByAmount(B, C, cfAll, from, to) {
    const m = new Map();
    const get = c => { if (!m.has(c)) m.set(c, { amount: c / 100, bank: [], crm: [] }); return m.get(c); };
    B.forEach(x => get(cents(x.amount)).bank.push(x));
    C.forEach(x => get(cents(x.amount)).crm.push(x));
    const out = [];
    for (const [c, v] of m) {
      if (v.bank.length === v.crm.length) continue;
      const near = v.bank.length > v.crm.length ? (cfAll || []).filter(x => cents(x.amount) === c && (x.date < from ? dayDiff(from, x.date) : x.date > to ? dayDiff(x.date, to) : 99) <= 5) : [];
      out.push({ ...v, nB: v.bank.length, nC: v.crm.length, d: v.crm.length - v.bank.length, near });
    }
    return { mismatched: out.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)), distinct: m.size };
  }
  // ---------- перекази між своїми рахунками ----------
  const MASK = /(?:^|[^\d])\d{4,6}[\s*xх]*\*{2,}[\s*xх]*(\d{4})(?!\d)/i;
  /* «4246 **** **** 3462 08.10.2026 …» → '3462' */
  const cardTail = s => { const m = MASK.exec(String(s || '')); return m ? m[1] : null; };
  // рахунок корп. картки: старі назви «corpCard …», нові (з 30.10.2026) — «корп. картка 3462 ФОП …», «майбутня корп карта …», «corp card 9450 …»
  const isCorp = a => /corp\s*card|корп\.?\s*карт/i.test((a && a.name) || '');
  /* Власник рахунку з назви CRM: «ФОП Мазовецька Корнелія …», «корп. картка 7365 ФОП Мазовецька …» → «ФОП Мазовецька»;
     «Приват ТОВ ПРИКЛАД СЕРВІС 5608» → «ТОВ ПРИКЛАД СЕРВІС»; «… PRYKLAD MARKET INC. Chase» → «PRYKLAD MARKET INC».
     Не видно з назви (старі назви на кшталт «1 ГРН Польша ФОП») — null. */
  function ownerOf(name) {
    const s = String(name || '').replace(/\s+/g, ' ');
    let m = /(?<!\p{L})ФОП\s+(\p{L}[\p{L}'’ʼ-]*)/iu.exec(s);
    if (m) return `ФОП ${m[1]}`;
    m = /(?<!\p{L})ТОВ\s+([^\d(]*[^\d(\s])/u.exec(s);
    if (m) return `ТОВ ${m[1].trim()}`;
    m = /([A-Z][A-Z .&-]*[A-Z])\.?\s+(INC|LLC|LTD)\b/.exec(s);
    return m ? `${m[1]} ${m[2]}` : null;
  }
  // картки, якої ще немає («майбутня корп карта …»), неактуальної чи «(видалити)» не поповнюють
  const CARD_OFF = /майбутн|неактуал|not actual|\(видалити\)/i;
  /* Корп. картку поповнюють лише з рахунку її власника: з ФОП Хоменко — на картку Хоменка, з ТОВ — на картку цього ТОВ
     (уточнення 30.10.2026; rules.json → reference.card_topup). Діючі корп. картки власника рахунку from серед accounts;
     власник не видно з назви — null (обмеження немає). */
  function ownerCards(from, accounts) {
    const ow = ownerOf(from && from.name);
    if (!ow) return null;
    return (accounts || []).filter(a => a && !a.deleted_at && isCorp(a) && !CARD_OFF.test(a.name || '') && String(ownerOf(a.name)).toLowerCase() === ow.toLowerCase());
  }
  /* Маркетолог за контрагентом (rules.json → reference.counterparty_marketers [{counterparty, marketer_id, marketer}]): назва контрагента
     є в тексті (отримувач, призначення) → {id, name, cpty} або null. «ФОП Власич Оксана Володимирівна …» → Євген Сливко (уточнення 03.11.2026). */
  const lowTxt = s => String(s || '').toLowerCase().replace(/[’ʼ'`]/g, '').replace(/\s+/g, ' ');
  function cptyMarketer(list, text) {
    const t = lowTxt(text);
    const m = (list || []).find(m => m && m.counterparty && Number(m.marketer_id) > 0 && t.includes(lowTxt(m.counterparty)));
    return m ? { id: Number(m.marketer_id), name: String(m.marketer || ''), cpty: String(m.counterparty) } : null;
  }
  /* Хто тримає корп. картку на дату date (рррр-мм-дд): rules.json → reference.cards[].holders [{from?, name}] — останній з from ≤ date
     (без from — з самого початку). → {from?, name} або null. */
  function holderOf(card, date) {
    const hs = ((card && card.holders) || []).filter(h => h && h.name && (!h.from || !date || h.from <= date));
    return hs.sort((a, b) => String(a.from || '').localeCompare(String(b.from || ''))).pop() || null;
  }
  /* Людину name («Сидоричев Андрій») названо в тексті: усі слова імені (щонайменше два) — у будь-якому порядку й відмінку
     («Андрій Сидоричев», «для Андрія Сидоричева»). */
  const personWords = s => String(s || '').toLowerCase().replace(/[’ʼ`']/g, '').split(/[^\p{L}]+/u).filter(w => w.length >= 2);
  function personIn(name, text) {
    const nw = personWords(name), cw = personWords(text);
    if (nw.length < 2 || !cw.length) return false;
    return nw.every(w => cw.some(c => c === w || (w.length >= 4 && c.length <= w.length + 2 && c.startsWith(w.slice(0, -1)))));
  }
  /* Корп. картка за тримачем: у тексті (отримувач і зміст погодження, коментар запису) названо того, хто тримає картку на дату date
     (rules.json → reference.cards[].holders). ok(id рахунку картки) — які картки годяться (того самого власника, діючі).
     → {id, last4, name, from} — якщо така картка одна; {ambig: [last4…]} — якщо кілька; null — нікого не названо. */
  function holderCard(cards, text, date, ok) {
    const hit = new Map();
    for (const c of cards || []) {
      const id = Number(c && c.account_id), h = id > 0 && holderOf(c, date);
      // картку можуть тримати двоє одразу (holders[].also — 2804 з 18.11.2026: Шелега і Ларіоненко): названо будь-кого з них
      const who = h && [h.name].concat(h.also || []).find(n => personIn(n, text));
      if (!h || (ok && !ok(id)) || !who) continue;
      if (!hit.has(id)) hit.set(id, { id, last4: String(c.last4), name: who, from: h.from || null });
    }
    return hit.size === 1 ? [...hit.values()][0] : hit.size ? { ambig: [...hit.values()].map(x => x.last4) } : null;
  }
  /* Номер корп. картки з назви рахунку CRM («corpCard …_UAH_3462», «корп. картка 3462 …» → «3462») або ''. */
  function nameTail(a) {
    if (!a || a.deleted_at || !isCorp(a)) return '';
    const d = String(a.name).match(/(?<!\d)\d{4}(?!\d)/g);
    return d ? d[d.length - 1] : '';
  }
  /* Картка, запам'ятана лише в цьому браузері («Нові корп. картки у виписці» → «Запам'ятати»), застаріла: її номер уже є в назві
     рахунку CRM або рахунок картки отримав у назві інший номер (рахунок перейменували, завели новий) — назва CRM важить більше. */
  function staleLocalCard(c, accounts) {
    const t = String(c && c.last4), id = Number(c && c.account_id);
    return (accounts || []).some(a => { const n = nameTail(a); return !!n && (n === t || (a.id === id && n !== t)); });
  }
  /* Номер корп. картки → рахунок corpCard у CRM: чотири цифри з назви («corpCard …_UAH_3462», «корп. картка 3462 …») і з коментарів поповнень
     («поповнення корп картки 7365 …» — картку могли перевипустити, а назву рахунку не змінити). Номер, що веде до кількох рахунків, не береться,
     хіба що діючий рахунок серед них один (решта — «неактуальн…», «(видалити)», «майбутн…»).
     cards — картки з довідника (rules.json → reference.cards: [{last4, account_id}]): вони сильніші за назви й коментарі; запам'ятані
     лише в браузері (local) — ні, коли назви CRM уже кажуть інше (staleLocalCard). */
  function cardTails(accounts, itemsByAcc, cards) {
    const seen = new Map();
    const add = (t, id) => { if (!seen.has(t)) seen.set(t, new Set()); seen.get(t).add(id); };
    for (const a of accounts) {
      if (a.deleted_at || !isCorp(a)) continue;
      const n = nameTail(a);
      if (n) add(n, a.id);
      for (const x of (itemsByAcc && itemsByAcc.get(a.id)) || []) {
        const m = x.opc === 3 && /карт\p{L}*\s*(?:№\s*)?(\d{4})(?!\d)/iu.exec(x.comment || '');
        if (m) add(m[1], a.id);
      }
    }
    const out = {}, nameOf = id => ((accounts.find(a => a.id === id) || {}).name || '');
    for (const [t, ids] of seen) {
      // той самий номер у кількох рахунках (завели новий рахунок картки, а старий не перейменували): діючий, якщо він один
      const live = ids.size === 1 ? [...ids] : [...ids].filter(id => !CARD_OFF.test(nameOf(id)));
      if (live.length === 1) out[t] = live[0];
    }
    for (const c of cards || []) {
      if (!c || !/^\d{4}$/.test(String(c.last4)) || !(Number(c.account_id) > 0) || (c.local && staleLocalCard(c, accounts))) continue;
      out[String(c.last4)] = Number(c.account_id);
    }
    return out;
  }
  /* Довідник своїх рахунків. byKey: IBAN рахунку з виписок → рахунок CRM (null — наш рахунок, ще не зіставлений з CRM)
     і вибір людини {IBAN контрагента або «контрагент|призначення» → id рахунку CRM; 0 — «не переказ»}; cards — номер картки → corpCard;
     pay — IBAN транзитних рахунків ЗП з виписок (не зіставлені з CRM); cardList — картки з довідника (cardTails). */
  function ownDirectory(banks, accounts, itemsByAcc, ownMap, cardList) {
    const byKey = new Map(), pay = new Set();
    for (const b of banks) {
      if (!b.iban) continue;
      // технічні рахунки банку (2603, 3570) і РКО — не наші рахунки для переказів: платіж на них — комісія чи плата банку, а не
      // «схоже на переказ між своїми» (07.11.2026). Хіба що людина сама зіставила такий рахунок з CRM; транзитні рахунки ЗП лишаються
      if (!b.cfId && (TECH_BAL[balOf(b.iban)] || (SERVICE_ACC.test(b.owner || '') && !PAY_ACC.test(b.owner || '')))) continue;
      byKey.set(b.iban, b.cfId || null);
      if (!b.cfId && PAY_ACC.test(b.owner || '')) pay.add(b.iban);
    }
    for (const [k, v] of Object.entries(ownMap || {})) byKey.set(k, Number(v) || 0);
    /* Свій рахунок без виписки (Універсал ТОВ: API немає): у назві рахунку CRM — останні 4 цифри IBAN («Універсал ТОВ СЕРВІС МАРКЕТ
       МАРКЕТПЛЕЙС 0873»). Платіж від/на нього — переказ між своїми, а не дохід чи витрата (роялті Маркет → ПРИКЛАД, 12.11.2026). */
    const withBank = new Set(banks.map(b => b.cfId).filter(Boolean)), byTail = new Map();
    for (const a of accounts || []) {
      if (a.deleted_at || isCorp(a) || withBank.has(a.id) || CARD_OFF.test(a.name || '')) continue;
      const d = String(a.name || '').match(/(?<!\d)\d{4}(?!\d)/g);
      if (!d) continue;
      const t = d[d.length - 1];
      if (!byTail.has(t)) byTail.set(t, []);
      byTail.get(t).push(a);
    }
    // валютні рахунки з виписок, зіставлені з CRM, — звідки приходить гривня від продажу валюти
    const fx = banks.filter(b => b.cfId && b.ccy && b.ccy !== 'UAH');
    return { byKey, pay, cards: cardTails(accounts, itemsByAcc, cardList), byTail, fx };
  }
  // рахунок CRM без виписки, якому належить IBAN контрагента: ті самі останні 4 цифри й усі слова назви контрагента є в назві рахунку
  function tailPeer(x, dir) {
    const m = /(\d{4})$/.exec(String(x.cpIban || '')), list = m && dir.byTail ? dir.byTail.get(m[1]) : null;
    if (!list) return 0;
    const w = nameWords(x.cpty);
    const hit = w.length ? list.filter(a => { const n = new Set(nameWords(a.name)); return w.every(v => n.has(v)); }) : [];
    return hit.length === 1 ? hit[0].id : 0;
  }
  /* Операція банку — переказ на транзитний рахунок ЗП (або повернення з нього): за IBAN контрагента з виписок чи за його назвою
     («Ціл-ві зарах.…», «Мас.вип.…»), якщо виписки цього рахунку немає. */
  const payRow = (x, dir) => !!((x.cpIban && dir && dir.pay && dir.pay.has(x.cpIban)) || PAY_ACC.test(x.cpty || ''));
  // податки на ЗП: у CRM їх можуть внести одним записом із зарплатною статтею на кілька платежів банку
  const PAY_TAX = /пдфо|військов\p{L}*\s+зб[іо]р|(?<!\p{L})єсв(?!\p{L})|єдин\p{L}*\s+соц/iu;
  /* Рух групи рахунків CRM (рахунок і зведені з ним corpCard) без переказів усередині групи: поповнення корп. картки з рахунку,
     з якого вона й списує, у банку не видно — там лише покупки карткою. */
  function groupItems(itemsByAcc, ids) {
    const g = new Set(ids);
    return ids.flatMap(id => (itemsByAcc.get(id) || []).filter(x => !((x.opc === 3 || x.opc === 4) && g.has(x.peer))));
  }
  const ownKey = x => x.cpIban || `${x.cpty || ''}|${String(x.purpose || '').slice(0, 40)}`;
  const OWN_RE = /переказ\p{L}*\s+власних\s+коштів|між\s+власними\s+рахунками|на\s+корп\p{L}*\.?\s*карт|поповн\p{L}*\s+корп\p{L}*\.?\s*карт/iu;
  const TO_CARD_RE = /^\s*переказ\s+на\s+(свою\s+)?картку/iu;
  // банк пише латинські двійники літер («Гривнi вiд продажу») — «і» й «i» рівноправні
  const FX_SELL = /в[іi]д\s+продажу\s+[\d\s.,]*\d\s*(USD|EUR|GBP|PLN|CZK|CHF)(?![A-Za-z])/iu;
  const NOT_OWN_RE = /^\s*коміс|зп\s*\/\s*карток|для\s+виплат/iu;
  const nameWords = s => (String(s || '').toLowerCase().match(/[a-zа-яіїєґ'’ʼ-]{3,}/giu) || []).filter(w => !STOP.has(w));
  const sameOwner = (a, b) => { const x = new Set(nameWords(a)); return nameWords(b).some(w => x.has(w)); };
  /* Операція банку рахунку, що звіряється з групою рахунків CRM group (рахунок і його corpCard):
     {kind: 'own', peer} — контрагент — наш рахунок peer; {kind: 'maybe', why} — схоже на переказ між своїми, рахунок «куди» невідомий;
     {kind: 'pay'} — переказ на транзитний рахунок ЗП (у CRM ЗП внесено по людях — це не переказ між рахунками CRM); інакше null.
     Покупки корп. карткою (номер у призначенні) — не перекази: вони звіряються з витратами corpCard. */
  function ownKind(x, dir, group, owner) {
    const key = ownKey(x), p = dir.byKey.get(key);
    if (!p && payRow(x, dir)) return { kind: 'pay' }; // хіба що людина сама вибрала для нього рахунок CRM
    if (dir.byKey.has(key)) {
      if (p === 0 || (p && group.has(p))) return null;
      return p ? { kind: 'own', peer: p } : { kind: 'maybe', why: 'контрагент — наш рахунок, ще не зіставлений з CRM' };
    }
    const t = cardTail(x.purpose);
    if (t && dir.cards[t]) return null;
    const s = String(x.purpose || '');
    if (NOT_OWN_RE.test(s)) return null;
    const tp = tailPeer(x, dir);
    if (tp && !group.has(tp)) return { kind: 'own', peer: tp };
    /* Продаж валюти: «Продаж UAH клієнтів: Гривні від продажу 495.00 EUR по курсу 50.57» — гривня з валютного рахунку тієї самої фірми.
       У CRM це переказ між рахунками («Продаж 495.00 EUR з «Приват євро …» за курсом банку … → «Приват ТОВ …»»), а не дохід (12.11.2026).
       Валютний рахунок — єдиний рахунок цієї валюти того самого власника серед виписок, зіставлений з CRM; інакше — «виберіть рахунок». */
    const fx = x.amount > 0 && FX_SELL.exec(s);
    if (fx) {
      const mine = new Set(nameWords(owner)), same = b => { const w = nameWords(b.owner); return w.length === mine.size && w.every(v => mine.has(v)); };
      const from = (dir.fx || []).filter(b => b.ccy === fx[1].toUpperCase() && !group.has(b.cfId) && same(b));
      return from.length === 1 ? { kind: 'own', peer: from[0].cfId } : { kind: 'maybe', why: `продаж валюти (${fx[1].toUpperCase()}) — переказ з валютного рахунку` };
    }
    // переказ самому власникові ФОП на картку (Моно: «Переказ на картку»; Приват: «5363 **** **** 3912 Переказ власних коштів»), отримувач — людина
    // без «ФОП» / «ТОВ» у назві: це особиста картка, рахунку CRM для неї немає — у CRM така операція вноситься витратою (на що пішли гроші)
    const person = !/(?<!\p{L})(фоп|тов)(?!\p{L})/iu.test(x.cpty || '') && sameOwner(x.cpty, owner);
    if (person && (TO_CARD_RE.test(s) || (t && OWN_RE.test(s)))) return { kind: 'card', why: `переказ на особисту картку власника ФОП (${String(x.cpty || '').trim()})` };
    // так само — на особистий поточний рахунок власника (балансовий 2620, без номера картки: Мазовецька «Переказ власних коштів», 07.11.2026)
    if (person && balOf(x.cpIban) === '2620' && OWN_RE.test(s)) return { kind: 'card', why: `переказ на особистий рахунок власника ФОП (${String(x.cpty || '').trim()})` };
    if (OWN_RE.test(s) || (TO_CARD_RE.test(s) && sameOwner(x.cpty, owner))) return { kind: 'maybe', why: 'схоже на переказ між своїми' };
    return null;
  }
  /* Перекази між своїми на рахунку за період: B — операції банку, C — рух CRM групи (внутрішні перекази групи вже прибрано).
     Для операції з відомим рахунком «куди»: у CRM переказ саме між цими рахунками — ok; запис з тією самою сумою, але не переказ — type;
     переказ з/на інший рахунок — peer; нічого — missing (пропозиція створити переказ).
     maybe — схоже на переказ, рахунок «куди» невідомий, і запису з такою сумою в CRM немає.
     cfAll — увесь рух групи: переказ, який у CRM є з датою до ±5 днів поза періодом, — near (не пропонується; підказка «з іншою датою»). */
  function ownTransfers(B, C, dir, group, owner, cfAll, into) {
    const kinds = B.map(x => ownKind(x, dir, group, owner));
    const free = new Set(C);
    const take = pred => { for (const c of free) if (pred(c)) { free.delete(c); return c; } return null; };
    const same = (x, c) => cents(c.amount) === cents(x.amount);
    // into — Map(рахунок corpCard → рахунок, з яким він звіряється): у банку поповнення видно як переказ на рахунок, з якого картка
    // списує, а в CRM (R-NP-CORPCARD-01) — переказ на сам рахунок картки; це той самий рахунок «куди» (07.11.2026)
    const samePeer = (c, p) => c.peer === p || !!(into && c.peer != null && into.get(Number(c.peer)) === p);
    // переказ того самого напрямку; продаж валюти в CRM вносять і «обміном» (операції 5/6: ID 26152, 26153 у жовтні 2026) — це той самий
    // рух між тими самими рахунками, а не «переказ з іншим рахунком» (огляд 16.11.2026)
    const dirOk = (c, x) => (x.amount < 0 ? c.opc === 4 || c.opc === 6 : c.opc === 3 || c.opc === 5);
    const xfers = [], maybe = [], missing = new Set();
    const own = B.map((x, i) => ({ x, k: kinds[i] })).filter(o => o.k && o.k.kind === 'own');
    // 1) переказ між тими самими рахунками в тому самому напрямку
    const left = own.filter(o => {
      const c = take(c => same(o.x, c) && samePeer(c, o.k.peer) && dirOk(c, o.x));
      if (c) xfers.push({ row: o.x, peer: o.k.peer, state: 'ok', item: c });
      return !c;
    });
    // 2) решта операцій банку забирає свої записи (не перекази), щоб випадковий збіг суми не приписати переказу
    const rest = B.filter((x, i) => !(kinds[i] && kinds[i].kind === 'own')).filter(x => !take(c => same(x, c) && !(c.opc >= 3)));
    // 3) переказу немає: запис з тією самою сумою іншого типу, переказ з іншим рахунком — або нічого
    for (const o of left) {
      /* «інший тип» — лише запис поруч за датою (±3 дні, найближчий): сама сума — ще не той самий рух. Автоматичний запис «Підтвердження
         виведення коштів з балансу» 5 000 від 02.10 пропонувався змінити на переказ через переказ 5 000 від 29.10 (огляд 16.11.2026);
         далекий запис лишається собі («немає в банку»), а переказ — «немає в CRM» (пропозиція створити). */
      const typ = [...free].filter(c => same(o.x, c) && !(c.opc >= 3) && Math.abs(dayDiff(c.date, o.x.date)) <= 3)
        .sort((a, b) => Math.abs(dayDiff(a.date, o.x.date)) - Math.abs(dayDiff(b.date, o.x.date)))[0];
      let c = typ ? take(c => c === typ) : null;
      if (c) { xfers.push({ row: o.x, peer: o.k.peer, state: 'type', item: c }); continue; }
      c = take(c => same(o.x, c) && c.opc >= 3);
      if (c) { xfers.push({ row: o.x, peer: o.k.peer, state: 'peer', item: c }); continue; }
      const inP = new Set(C);
      c = (cfAll || []).find(c => !inP.has(c) && same(o.x, c) && samePeer(c, o.k.peer) && dirOk(c, o.x) && Math.abs(dayDiff(c.date, o.x.date)) <= 5);
      if (c) { xfers.push({ row: o.x, peer: o.k.peer, state: 'near', item: c }); continue; }
      xfers.push({ row: o.x, peer: o.k.peer, state: 'missing' });
      missing.add(o.x);
    }
    // 4) «схоже на переказ», для якого в CRM немає запису з такою сумою
    for (const x of rest) {
      const k = kinds[B.indexOf(x)];
      if (k && k.kind === 'maybe' && !take(c => same(x, c))) maybe.push({ row: x, why: k.why, key: ownKey(x) });
    }
    return { xfers, maybe, missing, kinds: new Map(B.map((x, i) => [x, kinds[i]]).filter(p => p[1])) };
  }

  /* Пари «операція банку — запис CRM»: з однаковою сумою, спершу найближчі за датою. Map: операція банку → запис CRM.
     maxDays — лише пари не далі стількох днів (periodRecon спершу бере близькі, далі — групи «суми не 1:1», а вже потім пари
     з іншою датою: інакше запис ліда 30 000 від 22.10 діставався чужій оплаті 30 000 від 14.10, 08.11.2026). */
  function pairRows(B, C, maxDays) {
    const byC = new Map(), lim = maxDays === undefined || maxDays === null ? Infinity : maxDays;
    for (const c of C) { const k = cents(c.amount); if (!byC.has(k)) byC.set(k, []); byC.get(k).push(c); }
    const pairs = [];
    // покупка карткою: у CRM — за датою покупки (з 07.11.2026) або проведення; відстань — до ближчої з них (інакше покупка 10.10, проведена
    // 11.10, забирала запис покупки 12.10 з тією самою сумою, 08.11.2026)
    for (const x of B) {
      const cands = byC.get(cents(x.amount));
      if (!cands) continue;
      const buy = cardDate(x.purpose);
      for (const c of cands) { const d = Math.min(Math.abs(dayDiff(x.date, c.date)), buy ? Math.abs(dayDiff(buy, c.date)) : Infinity); if (d <= lim) pairs.push([d, x, c]); }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const out = new Map(), uC = new Set();
    for (const [, x, c] of pairs) if (!out.has(x) && !uC.has(c)) { out.set(x, c); uC.add(c); }
    return out;
  }
  /* Що лишилось без пари: bank — операції банку, яких немає в CRM; crm — записи CRM, яких немає в банку. */
  function missingRows(B, C) {
    const p = pairRows(B, C), uC = new Set(p.values());
    return { bank: B.filter(x => !p.has(x)), crm: C.filter(c => !uC.has(c)) };
  }
  /* Комбінація від 2 до maxK записів з list (усі того самого знаку, що й target), сума яких до копійки дорівнює target; спершу найкоротша. */
  function subsetSum(target, list, maxK) {
    const c = list.slice(0, 18).map(x => Math.abs(cents(x.amount))), t = Math.abs(target), pick = [];
    const go = (i, sum, k) => {
      if (pick.length === k) return sum === t;
      for (let j = i; j < c.length; j++) {
        if (sum + c[j] > t) continue;
        pick.push(j);
        if (go(j + 1, sum + c[j], k)) return true;
        pick.pop();
      }
      return false;
    };
    for (let k = 2; k <= maxK; k++) if (go(0, 0, k)) return pick.map(j => list[j]);
    return null;
  }
  /* Будь-яка комбінація з list (до max перших елементів; від minK до maxK штук), сума якої до копійки дорівнює |target|.
     Перебір від більших сум з відсіканням (решти не вистачить / уже забагато) і з обмеженням кроків — без зависань на десятках записів. */
  function subsetExact(target, list, o) {
    const n = Math.min(list.length, (o && o.max) || 20), minK = (o && o.minK) || 1, maxK = (o && o.maxK) || n, t = Math.abs(cents(target));
    const it = list.slice(0, n).map(x => ({ x, c: Math.abs(cents(x.amount)) })).sort((a, b) => b.c - a.c);
    const rest = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) rest[i] = rest[i + 1] + it[i].c;
    const pick = [];
    let steps = 0;
    const go = (i, sum) => {
      if (sum === t) return pick.length >= minK;
      if (pick.length >= maxK || ++steps > 200000) return false;
      for (let j = i; j < n; j++) {
        if (sum + rest[j] < t) return false;
        if (sum + it[j].c > t) continue;
        pick.push(j);
        if (go(j + 1, sum + it[j].c)) return true;
        pick.pop();
      }
      return false;
    };
    return t > 0 && go(0, 0) ? pick.map(j => it[j].x) : null;
  }
  const sumC = list => list.reduce((s, x) => s + cents(x.amount), 0);
  const nameWordsOf = s => new Set((String(s || '').toLowerCase().replace(/[’ʼ'`]/g, '').match(/\p{L}{4,}/gu) || []).filter(w => !STOP.has(w)));
  const LEAD_NO = /(?:^|\s)Лід:\s*(\d+)/i;
  /* Суми не 1:1: одна операція банку = кілька записів CRM (наприклад, переказ на картку власника, а з неї — виплати кільком людям)
     або один запис CRM = кілька операцій банку. Того самого знаку, за ±3 дні, разом до копійки. LB, LC — без пар 1:1;
     can(x, c) — чи може операція банку x бути разом із записом c (за замовчуванням — так). → [{bank: [], crm: []}]
     З 08.11.2026 (звірка жовтня): кандидати — спершу найближчі за датою й з тим самим ім'ям платника (раніше бралися перші 18 у порядку
     виписки, і на рахунку з сотнями операцій потрібні часто не потрапляли); покупка корп. карткою — лише з записами рахунку цієї картки,
     а запис картки — лише з її покупками (o.cardOf(x) → id рахунку картки або null, o.cards — рахунки карток групи; раніше покупку
     «складало» з комісією банку в податок); переказ на особисту картку власника (o.kindOf(x) === 'card') — до 10 записів того самого дня
     (виплати менеджерам з картки); кілька замовлень одного ліда за день (у коментарі «Лід: N») — один запис для «кілька операцій банку». */
  function multiPairs(LB, LC, can, o) {
    const out = [], uB = new Set(), uC = new Set(), ok = can || (() => true);
    const cards = (o && o.cards) || null, cardOf = (o && o.cardOf) || (() => null), kindOf = (o && o.kindOf) || (() => null);
    const isBuy = x => !!(cardTail(x.purpose) && cardDate(x.purpose));
    // покупка відомою корп. карткою — з записами її рахунку або основного рахунку (покупки 3462 Хоменко пише й на ФОП), але не з податком;
    // запис рахунку картки — лише з покупками цієї картки
    const compat = (x, c) => {
      if (!cards || !cards.size) return true;
      const k = isBuy(x) ? cardOf(x) : null;
      return k ? c.acc === k || (!cards.has(c.acc) && !TAX_REC.test(c.comment || '')) : !cards.has(c.acc);
    };
    const fits = (a, b) => (a.amount < 0) === (b.amount < 0) && Math.abs(b.amount) < Math.abs(a.amount) && Math.abs(dayDiff(a.date, b.date)) <= 3;
    const big = list => [...list].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    // найближчі за датою, з тим самим ім'ям (платник у банку ↔ клієнт у коментарі) — спершу; далі більші суми
    const rank = (t, list, txt) => {
      const w = nameWordsOf(t.cpty || t.comment || '');
      const sc = y => Math.abs(dayDiff(t.date, y.date)) * 2 - ([...nameWordsOf(txt(y))].some(v => w.has(v)) ? 1 : 0);
      return list.map(y => [sc(y), y]).sort((p, q) => p[0] - q[0] || Math.abs(q[1].amount) - Math.abs(p[1].amount)).map(p => p[1]);
    };
    for (const x of big(LB)) {
      let cand = LC.filter(c => !uC.has(c) && fits(x, c) && ok(x, c) && compat(x, c)), maxK = 5;
      // до 10 записів — лише серед записів того самого дня і лише коли їх небагато: з десятків кандидатів точну суму «складе» випадково
      if (kindOf(x) === 'card') { const day = cand.filter(c => c.date === x.date); if (day.length <= 12) { cand = day; maxK = 10; } }
      const got = subsetSum(cents(x.amount), rank(x, cand, c => c.comment), maxK);
      if (got) { uB.add(x); got.forEach(c => uC.add(c)); out.push({ bank: [x], crm: got }); }
    }
    // кілька замовлень одного ліда за той самий день — разом як один запис
    const units = [], byLead = new Map();
    for (const c of LC) {
      const m = !uC.has(c) && LEAD_NO.exec(c.comment || '');
      if (!m) continue;
      const k = `${m[1]}|${c.date}|${c.amount < 0 ? '-' : '+'}`;
      if (!byLead.has(k)) byLead.set(k, []);
      byLead.get(k).push(c);
    }
    for (const list of byLead.values()) if (list.length > 1) units.push({ amount: r2(list.reduce((s, c) => s + c.amount, 0)), date: list[0].date, comment: list[0].comment, acc: list[0].acc, members: list });
    for (const c of big([...LC, ...units])) {
      const mem = c.members || [c];
      if (mem.some(z => uC.has(z))) continue;
      const cand = LB.filter(x => !uB.has(x) && fits(c, x) && mem.every(z => ok(x, z) && compat(x, z)));
      const one = c.members ? LB.find(x => !uB.has(x) && cents(x.amount) === cents(c.amount) && Math.abs(dayDiff(x.date, c.date)) <= 3 && mem.every(z => ok(x, z) && compat(x, z))) : null;
      // покупки карткою й інші операції банку в одну суму не складаються: спершу ті, на які схожий запис (реклама — покупки), далі інші
      const buys = cand.filter(isBuy), rest = cand.filter(x => !isBuy(x)), adsLike = /facebook|google|\bfb\b|meta|ads|картк/i.test(c.comment || '');
      const pools = (adsLike ? [buys, rest] : [rest, buys]).filter(p => p.length);
      let got = one ? [one] : null;
      for (const p of pools) { if (got) break; got = subsetSum(cents(c.amount), rank(c, p, x => x.cpty), 5); }
      if (got) { mem.forEach(z => uC.add(z)); got.forEach(x => uB.add(x)); out.push({ bank: got, crm: mem }); }
    }
    return out;
  }
  /* ---------- групи за ознаками операцій (звірка жовтня 2026, 08.11.2026) ----------
     Кожна функція — на операціях банку LB і записах CRM LC без пар; → [{bank, crm, why}]. Сума групи до копійки: bank = crm. */
  /* Покупки корп. карткою за день: у CRM часто один запис на всі покупки картки за день («Facebook, 1011.31+514,00+1386.43 = 2 911,74»,
     «тотал. сума по fb за 02.10.2026» — 21 покупка). Запис рахунку картки (витрата) від D ↔ покупки цією карткою з датою покупки D
     (з призначення виписки): усі разом або частина (до 24 покупок). tailsOf(id рахунку) → номери карток рахунку. */
  function cardDays(LB, LC, tailsOf) {
    const out = [], uB = new Set();
    const buys = LB.filter(x => x.amount < 0 && cardTail(x.purpose) && cardDate(x.purpose));
    if (!buys.length) return out;
    for (const c of LC.filter(c => c.opc === 2 && c.amount < 0).sort((a, b) => a.amount - b.amount)) {
      const tails = tailsOf(c.acc);
      if (!tails || !tails.length) continue;
      const cand = buys.filter(x => !uB.has(x) && tails.includes(cardTail(x.purpose)) && cardDate(x.purpose) === c.date);
      if (cand.length < 2) continue;
      // усі покупки дня — скільки б їх не було; частина — лише з ≤ 12 покупок (з більшої кількості точну суму «складе» випадково)
      const got = sumC(cand) === cents(c.amount) ? cand : cand.length <= 12 ? subsetExact(c.amount, cand, { max: 12, minK: 2 }) : null;
      if (got) { got.forEach(x => uB.add(x)); out.push({ bank: got, crm: [c], why: 'card-day' }); }
    }
    return out;
  }
  /* LiqPay: у банку — зараховано (без комісії), у CRM — оплата ліда (брутто) і окремий запис «Комісія LiqPay …» з тим самим LIQPAY ID
     (або «…, зараховано N — LiqPay ДД.ММ.РРРР»). Лід + комісія = зарахування в банку до копійки — це той самий платіж, не два записи
     «немає в банку» і не «немає в CRM». Ліда — за номером «запис N» у коментарі комісії, інакше з тією сумою за ±3 дні. */
  const LIQ_ID = /liqpay\s*id\s*:?\s*(\d{6,})/i;
  const LIQ_FEE = /коміс\p{L}*\s+liqpay/iu;
  const moneyIn = s => { const m = /зараховано\s+(\d[\d\s  ]*(?:[.,]\d{1,2})?)/i.exec(String(s || '')); return m ? cents(Number(m[1].replace(/[\s  ]/g, '').replace(',', '.'))) : null; };
  function liqpayGroups(LB, LC) {
    const out = [], uC = new Set();
    const fees = LC.filter(c => c.amount < 0 && LIQ_FEE.test(c.comment || ''));
    if (!fees.length) return out;
    for (const x of LB.filter(x => x.amount > 0 && /liqpay/i.test(`${x.purpose || ''} ${x.cpty || ''}`))) {
      const id = (LIQ_ID.exec(x.purpose || '') || [])[1];
      let f = id ? fees.find(c => !uC.has(c) && (LIQ_ID.exec(c.comment) || [])[1] === id) : null;
      if (!f) f = fees.find(c => !uC.has(c) && !LIQ_ID.test(c.comment) && moneyIn(c.comment) === cents(x.amount) && (dmy2iso(String(c.comment).replace(/^.*liqpay\s+/i, '')) || c.date) === x.date);
      if (!f) continue;
      const need = cents(x.amount) - cents(f.amount), lead = (/запис\s+(\d+)/i.exec(f.comment) || [])[1];
      const g = LC.filter(c => !uC.has(c) && c !== f && c.amount > 0 && cents(c.amount) === need && Math.abs(dayDiff(c.date, x.date)) <= 3)
        .sort((a, b) => (String(b.id) === lead) - (String(a.id) === lead) || Math.abs(dayDiff(a.date, x.date)) - Math.abs(dayDiff(b.date, x.date)))[0];
      if (!g) continue;
      uC.add(f); uC.add(g);
      out.push({ bank: [x], crm: [g, f], why: 'liqpay' });
    }
    return out;
  }
  /* Податки із ЗП за день: банк платить ВЗ + ПДФО (+ ЄСВ) кількома платежами, у CRM — податки по людях («Податки 10 % з …», «9405,56*2=…»).
     Платежі податків дня D (усі, без ЄСВ або однією хвилиною — один пакет) ↔ записи податків від D: усі разом чи частина (до 18). */
  const TAX_REC = /подат|пдфо|(?<!\p{L})єсв(?!\p{L})|військов\p{L}*\s+зб|\d\s*\*\s*2\s*=/iu;
  const ESV_RE = /(?<!\p{L})єсв(?!\p{L})|єдин\p{L}*\s+соц/iu;
  /* opt.exact — лише весь день до копійки (усі платежі податків дня, з ЄСВ або без, = усі записи податків дня), і лише коли це не пари 1:1:
     так periodRecon бере очевидний день ще до пар за сумою — інакше чужа операція з тією самою сумою (оплата постачальнику 2 000 наступного
     дня) забирала один запис «Податки 10 % з …», день не складався, і податки показувались «немає в CRM» (огляд 16.11.2026). */
  function taxDays(LB, LC, opt) {
    const out = [], uB = new Set(), uC = new Set(), exact = !!(opt && opt.exact);
    const tb = LB.filter(x => x.amount < 0 && PAY_TAX.test(x.purpose || '')), tc = LC.filter(c => c.amount < 0 && c.opc === 2 && TAX_REC.test(c.comment || '') && !LIQ_FEE.test(c.comment || ''));
    if (!tb.length || !tc.length) return out;
    for (const d of [...new Set(tb.map(x => x.date))].sort()) {
      const BD = tb.filter(x => x.date === d);
      if (!tc.some(c => c.date === d)) continue;
      const noEsv = BD.filter(x => !ESV_RE.test(x.purpose || ''));
      const byTime = list => [...new Set(list.map(x => x.time || ''))].map(t => list.filter(x => (x.time || '') === t));
      const variants = exact ? [BD, noEsv] : [BD, noEsv, ...(byTime(BD).length > 1 ? byTime(BD) : []), ...(byTime(noEsv).length > 1 ? byTime(noEsv) : [])];
      for (const V of variants) {
        if (!V.length || V.some(x => uB.has(x))) continue;
        const CD = tc.filter(c => c.date === d && !uC.has(c));
        if (!CD.length) break;
        // податок, внесений цілим платежем (кожен платіж має запис з тією самою сумою), — це пари 1:1, не група (пари потрібні «Внести в CRM»)
        if (exact && V.every(x => CD.some(c => cents(c.amount) === cents(x.amount)))) continue;
        const got = sumC(CD) === sumC(V) ? CD : !exact && CD.length <= 14 ? subsetExact(sumC(V) / 100, CD, { max: 14 }) : null;
        if (got) { V.forEach(x => uB.add(x)); got.forEach(c => uC.add(c)); out.push({ bank: V, crm: got, why: 'tax-day' }); }
      }
      if (exact) continue;
      // податки по людях у CRM рахують «10 % з …» і округлюють кожен окремо: увесь день без ЄСВ — з різницею до 1 коп. на запис (до 5 коп.)
      const CD = tc.filter(c => c.date === d && !uC.has(c)), V = noEsv.filter(x => !uB.has(x));
      const dd = sumC(CD) - sumC(V);
      if (CD.length && V.length && V.length === noEsv.length && dd !== 0 && Math.abs(dd) <= Math.min(5, CD.length)) {
        V.forEach(x => uB.add(x)); CD.forEach(c => uC.add(c));
        out.push({ bank: V, crm: CD, why: 'tax-day', diff: r2(dd / 100) });
      }
    }
    return out;
  }
  /* ЗП через транзитний рахунок за день: перекази на транзит дня D (isPay) ↔ записи ЗП (sal) від D — разом до копійки. */
  function payDays(LB, LC, isPay, sal) {
    const out = [];
    const pb = LB.filter(x => x.amount < 0 && isPay(x)), pc = LC.filter(c => c.amount < 0 && c.opc <= 2 && sal(c));
    for (const d of [...new Set(pb.map(x => x.date))].sort()) {
      const BD = pb.filter(x => x.date === d), CD = pc.filter(c => c.date === d);
      if (CD.length && sumC(BD) === sumC(CD)) out.push({ bank: BD, crm: CD, why: 'pay-day' });
    }
    return out;
  }
  /* Платіж і його повернення (той самий контрагент, та сама сума, повернення — не пізніше 14 днів, у призначенні «поверн…»):
     разом 0, у CRM не вносяться. → [{bank: [платіж, повернення], crm: [], why: 'refund'}] */
  const samePeerB = (a, b) => (a.cpCode && b.cpCode ? a.cpCode === b.cpCode : a.cpIban && b.cpIban ? a.cpIban === b.cpIban : !!a.cpty && lowTxt(a.cpty) === lowTxt(b.cpty));
  function refundPairs(LB, skip) {
    const out = [], used = new Set();
    for (const y of LB.filter(y => y.amount > 0 && /поверн/i.test(y.purpose || ''))) {
      const x = LB.filter(x => !used.has(x) && x.amount < 0 && cents(x.amount) === -cents(y.amount) && x.date <= y.date && dayDiff(y.date, x.date) <= 14 && samePeerB(x, y))
        .sort((a, b) => dayDiff(y.date, a.date) - dayDiff(y.date, b.date))[0];
      if (x) { used.add(x); used.add(y); out.push({ bank: [x, y], crm: [], why: 'refund' }); }
    }
    /* Навпаки: гроші надійшли — і їх повернули платникові (той самий контрагент, та сама сума, не пізніше 3 днів; у списанні «поверн…»
       або те саме призначення слово в слово: 17.09.2026 +60 000 і −60 000 «За послуги адвоката …» на той самий IBAN). Теж разом 0 — не
       надходження й витрата в «Внести в CRM» (огляд 16.11.2026). skip(x) — операції, що мають свій розбір (схоже на переказ між своїми). */
    const txt = s => lowTxt(String(s || '').replace(/\s+/g, ' ').trim());
    for (const y of LB.filter(y => y.amount > 0 && !used.has(y) && !(skip && skip(y)))) {
      const x = LB.filter(x => !used.has(x) && !(skip && skip(x)) && x.amount < 0 && cents(x.amount) === -cents(y.amount) && x.date >= y.date && dayDiff(x.date, y.date) <= 3 && samePeerB(x, y)
        && (/поверн/i.test(x.purpose || '') || (!!txt(y.purpose) && txt(x.purpose) === txt(y.purpose))))
        .sort((a, b) => dayDiff(a.date, y.date) - dayDiff(b.date, y.date))[0];
      if (x) { used.add(x); used.add(y); out.push({ bank: [y, x], crm: [], why: 'refund' }); }
    }
    return out;
  }
  // дата покупки карткою з призначення виписки: «4246 **** **** 7365 24.10.2026 17:03:51 …» → '2026-10-24'
  const CARD_DATE = /\*{2,}[\s*xх]*\d{4}\s+(\d{2})\.(\d{2})\.(\d{4})/i;
  const cardDate = s => { const m = CARD_DATE.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  /* Покупки карткою: банк проводить їх за 1–3 дні, а в CRM вони — за датою покупки. → [{kind, bank, crm}]
     later   — банк провів у періоді покупку, яка в CRM записана раніше (запис з тією самою сумою за дату покупки);
     after   — запис corpCard у періоді, банк провів його вже після періоду (є у виписці);
     pending — запис corpCard, а виписка закінчується раніше, ніж за 3 дні після нього: банк ще не провів.
     LB, LC — без пар; cf — увесь рух групи; cards — id corpCard групи; used — записи CRM, що вже мають пару. */
  function cardTiming(LB, LC, cf, cards, bank, to, used, from) {
    const out = [], taken = new Set(used), takenB = new Set();
    /* Операції банку й записи CRM поза періодом, що мають пару між собою (±3 дні, покупка — за датою покупки), — зайняті: покупки з тією
       самою сумою в сусідні дні — звичайна річ (у жовтні 2026 — 83 з 228). Інакше зайвий запис 31.10 «пояснювався» листопадовою покупкою,
       яка належить запису 01.11, а покупка 01.10 без запису — записом 30.09, що вже має свою операцію 30.09 (огляд 16.11.2026). */
    // пари шукаються разом з кандидатами періоду (найближчий за датою виграє; за рівної відстані — запис чи операція, що стоїть першою)
    const isAfter = c => !taken.has(c) && cards.has(c.acc) && c.opc === 2, postC = new Set(cf.filter(c => c.date > to));
    for (const [y, c] of pairRows(bank.rows.filter(y => y.date > to), [...LC.filter(isAfter), ...postC], 3)) if (postC.has(c)) takenB.add(y);
    if (from) {
      const preB = new Set(bank.rows.filter(y => y.date < from && (!bank.fileFrom || y.date >= bank.fileFrom)));
      for (const [y, c] of pairRows([...preB, ...LB.filter(x => { const d = cardDate(x.purpose); return d && d < x.date; })], cf.filter(c => c.date < from && !taken.has(c)), 3)) if (preB.has(y)) taken.add(c);
    }
    for (const x of LB) {
      const d = cardDate(x.purpose);
      if (!d || d >= x.date) continue;
      const c = cf.filter(c => !taken.has(c) && cents(c.amount) === cents(x.amount) && c.date >= addDays(d, -1) && c.date <= x.date)
        .sort((a, b) => Math.abs(dayDiff(a.date, d)) - Math.abs(dayDiff(b.date, d)))[0];
      if (c) { taken.add(c); out.push({ kind: 'later', bank: x, crm: c, buy: d }); }
    }
    for (const c of LC) {
      if (taken.has(c) || !cards.has(c.acc) || c.opc !== 2) continue;
      const y = bank.rows.find(y => !takenB.has(y) && y.date > to && cents(y.amount) === cents(c.amount) && cardDate(y.purpose) && Math.abs(dayDiff(cardDate(y.purpose), c.date)) <= 1);
      if (y) { takenB.add(y); taken.add(c); out.push({ kind: 'after', bank: y, crm: c }); }
      else if (bank.fileTo && dayDiff(bank.fileTo, c.date) <= 3) { taken.add(c); out.push({ kind: 'pending', bank: null, crm: c }); }
    }
    return out;
  }
  /* Тип для фільтра звірки. У CRM — за операцією: переказ і обмін — «між рахунками». У банку — переказ між своїми, якщо контрагент —
     наш рахунок, або в CRM ця операція записана переказом, або вона схожа на переказ і запису немає; інакше за знаком суми
     (переказ на транзитний рахунок ЗП — списання: у CRM це витрати по людях).
     pairOf(x) — запис CRM у парі з операцією банку (1:1, «кілька записів» чи покупка карткою з іншою датою) або нічого. */
  const crmKind = c => (c.opc >= 3 ? 'own' : c.opc === 1 ? 'credit' : 'debit');
  const KINDS = ['all', 'credit', 'debit', 'own'];
  function bankKinds(B, own, pairOf) {
    const out = new Map();
    for (const x of B) {
      const k = own && own.kinds.get(x), c = pairOf(x);
      out.set(x, (k && k.kind === 'own') || (c ? crmKind(c) === 'own' : !!(k && k.kind === 'maybe')) ? 'own' : x.amount > 0 ? 'credit' : 'debit');
    }
    return out;
  }

  /* Рахунок за період from…to (включно, дати за Києвом).
     bank — рахунок із bankAccounts або null; cf — рух рахунку в CRM щонайменше з (from − 5 днів) до сьогодні;
     balanceNow — поточний balance рахунку в CRM (залишки CRM — так, як їх показує CRM).
     manualClose — залишок банку на кінець періоду, введений вручну (коли виписки немає).
     own — {dir, group, owner, kind, into}: dir — шукати перекази між своїми (ownTransfers; into — Map corpCard → рахунок, з яким він звіряється). Переказ, якого немає в CRM, не потрапляє
     в «суми, що не сходяться»: він — у own.missing; xferOnly — після створення цих переказів рахунок зійдеться.
     kind — що звіряти: 'all', 'credit' (надходження), 'debit' (списання), 'own' (перекази між рахунками); з фільтром обороти,
     кількість і суми — лише цього типу, а залишки на початок і кінець не порівнюються. cards — id corpCard, зведених з рахунком.
     Пояснені різниці не рахуються в «суми, що не сходяться»: multi — одна операція = кілька записів (multiPairs);
     timing — покупки карткою, які банк провів в інший день (cardTiming); adj — різниці без них, timingOk — без них усе сходиться;
     cross — з фільтром типу: у банку переказ між своїми, а в CRM той самий рух записано витратою чи доходом (різниця лишається).
     ЗП через транзитний рахунок поштучно не звіряється: у банку — переказ одним платежем, у CRM — записи по людях зі статтями ЗП
     (own.salary(запис) → true) за днем погодження. Такі операції банку й записи без пари — у pay {bank, crm}: не в «сумах, що не
     сходяться», а їхня різниця — в adj (timingOk). Записи ЗП — лише в такі пари (multi), якщо рахунок платить ЗП через транзитний:
     у періоді є переказ на нього або own.payroll (бачили раніше).
     own.skip(операція банку, вид) → причина — за правилом не вноситься в CRM (кошти броніків): ruled [{row, why}], поза звіркою;
     own.calc(запис CRM) → причина — розрахунковий запис без руху в банку (1.5 % від бронювання): calc [{crm, why}]. Обидва — в adj.
     Групи multi з 08.11.2026 мають why: 'card-day' (покупки картки за день), 'liqpay' (лід + комісія LiqPay = зарахування), 'tax-day'
     (податки із ЗП за день), 'pay-day' (ЗП через транзит за день), 'refund' (платіж і його повернення, crm: []); без why — суми не 1:1.
     missing — решта операцій банку без пари в CRM і записів CRM без пари в банку (для пропозицій); pairs — пари 1:1 (операція → запис). */
  function periodRecon(bank, cf, balanceNow, from, to, manualClose, own) {
    const kind = own && KINDS.includes(own.kind) ? own.kind : 'all';
    const C0 = cf.filter(x => x.date >= from && x.date <= to), C = kind === 'all' ? C0 : C0.filter(c => crmKind(c) === kind);
    const crm = { open: crmBalanceAt(balanceNow, cf, addDays(from, -1)).value, close: crmBalanceAt(balanceNow, cf, to).value, cred: sumPos(C), deb: sumNeg(C), n: C.length };
    const res = { crm, bank: null, diff: null, amounts: [], distinct: 0, covered: false, warnings: [], source: '', kind };
    if (bank) {
      const covered = !!(bank.fileFrom && bank.fileTo && bank.fileFrom <= from && bank.fileTo >= to);
      const B0 = bank.rows.filter(x => x.date >= from && x.date <= to);
      const closeV = bankBalanceAt(bank, to);
      res.bank = { open: bankOpeningAt(bank, from), close: closeV.value, cred: null, deb: null, n: null };
      res.covered = covered;
      // те саме вже каже попередження файлу «Виписка неповна…» (normPrivat) — двічі не показуємо
      if (closeV.warn && !(bank.warnings || []).some(w => /^Виписка неповна/.test(w))) res.warnings.push(closeV.warn);
      if (!covered) res.warnings.push(`виписка за ${bank.fileFrom || '?'}…${bank.fileTo || '?'} не покриває період — обороти й кількість операцій не порівнюються`);
      if (covered) {
        // перекази між своїми розпізнаються на всіх операціях, а фільтр типу — вже після
        if (own && own.dir) res.own = ownTransfers(B0, C0, own.dir, own.group, own.owner, cf, own.into);
        const miss = res.own ? res.own.missing : new Set();
        const kindOf = x => (res.own && res.own.kinds.get(x) ? res.own.kinds.get(x).kind : null);
        const isOwn = x => kindOf(x) === 'own', isPay = x => kindOf(x) === 'pay';
        const sal = (own && own.salary) || (() => false), payAcc = !!(own && own.payroll) || B0.some(isPay);
        /* За правилом компанії в CRM не вносяться (own.skip(x, вид) → причина): кошти броніків, їхня ЗП і податки (rules.json →
           reference.bronik_accounts). Перекази між своїми звіряються як завжди. Такі операції — поза звіркою (ruled), з причиною. */
        res.ruled = [];
        // «схоже на переказ між своїми» (maybe: рахунок «куди» невідомий чи не зіставлений) — теж переказ, звіряється як завжди, не «кошти броніків»
        if (own && own.skip) for (const x of B0) { if (isOwn(x) || kindOf(x) === 'maybe' || miss.has(x)) continue; const why = own.skip(x, kindOf(x)); if (why) res.ruled.push({ row: x, why }); }
        const rB = new Set(res.ruled.map(o => o.row));
        // розрахункові записи CRM, руху яких у банку немає за самим правилом (1.5 % від бронювання): own.calc(запис) → причина
        res.calc = [];
        if (own && own.calc) for (const c of C0) { const why = own.calc(c); if (why) res.calc.push({ crm: c, why }); }
        const rC = new Set(res.calc.map(o => o.crm));
        let Bm = B0.filter(x => !miss.has(x) && !rB.has(x)), Cm = C0.filter(c => !rC.has(c));
        // 0) LiqPay — до пар 1:1: запис комісії прямо називає платіж (LIQPAY ID чи «запис N»), а лід з тією самою сумою інакше могла забрати чужа пара
        const groups = [], gB = new Set(), gC = new Set();
        for (const g of liqpayGroups(Bm, Cm)) { groups.push(g); g.bank.forEach(x => gB.add(x)); g.crm.forEach(c => gC.add(c)); }
        // і податки із ЗП, де день сходиться цілим (ВЗ + ПДФО банку = податки по людях у CRM), — теж до пар (огляд 16.11.2026)
        for (const g of taxDays(Bm.filter(x => !gB.has(x) && !isOwn(x)), Cm.filter(c => !gC.has(c)), { exact: true })) { groups.push(g); g.bank.forEach(x => gB.add(x)); g.crm.forEach(c => gC.add(c)); }
        Bm = Bm.filter(x => !gB.has(x)); Cm = Cm.filter(c => !gC.has(c));
        // 1) пари 1:1 за сумою в межах ±3 днів (08.11.2026: далекі пари — після груп, інакше чужий запис з тією самою сумою «з'їдав» групу)
        const P1 = res.pairs = pairRows(Bm, Cm, 3), p1c = new Set(P1.values());
        let LB = Bm.filter(x => !P1.has(x) && !isOwn(x)), LC = Cm.filter(c => !p1c.has(c));
        // 2) групи за ознаками: покупки картки за день, податки із ЗП і ЗП через транзит за день, платіж і повернення
        const cardSet = new Set((own && own.cards) || []), tails = new Map();
        for (const [t, id] of Object.entries((own && own.dir && own.dir.cards) || {})) if (cardSet.has(Number(id))) tails.set(Number(id), (tails.get(Number(id)) || []).concat(t));
        const keep = list => { for (const g of list) { groups.push(g); g.bank.forEach(x => gB.add(x)); g.crm.forEach(c => gC.add(c)); } LB = LB.filter(x => !gB.has(x)); LC = LC.filter(c => !gC.has(c)); };
        if (tails.size) keep(cardDays(LB, LC, id => tails.get(id)));
        keep(taxDays(LB, LC));
        if (payAcc) keep(payDays(LB, LC, isPay, sal));
        keep(refundPairs(LB, x => !!kindOf(x)));
        // 3) одна операція = кілька записів (і навпаки); записи ЗП складаються лише в перекази на транзитний рахунок і в податки на ЗП —
        // не у випадкову суму іншої операції; покупка корп. карткою — лише з записами рахунку цієї картки
        const cardOf = x => { const t = cardTail(x.purpose), id = t && own && own.dir && own.dir.cards ? Number(own.dir.cards[t]) : 0; return id && cardSet.has(id) ? id : null; };
        res.multi = groups.concat(multiPairs(LB, LC, payAcc ? (x, c) => !sal(c) || isPay(x) || PAY_TAX.test(x.purpose || '') : null, { cards: cardSet, cardOf, kindOf }));
        const mB = new Map(), mC = new Set();
        res.multi.forEach(g => { g.bank.forEach(x => mB.set(x, g.crm[0])); g.crm.forEach(c => mC.add(c)); });
        // 4) пари 1:1 з іншою датою (далі ніж за 3 дні)
        for (const [x, c] of pairRows(Bm.filter(x => !P1.has(x) && !mB.has(x)), Cm.filter(c => !p1c.has(c) && !mC.has(c)))) { P1.set(x, c); p1c.add(c); }
        LB = LB.filter(x => !mB.has(x) && !P1.has(x)); LC = LC.filter(c => !mC.has(c) && !p1c.has(c));
        res.timing = cardTiming(LB, LC, cf, cardSet, bank, to, new Set([...p1c, ...mC]), from);
        const tB = new Map(res.timing.filter(t => t.kind === 'later').map(t => [t.bank, t.crm]));
        const tC = new Set(res.timing.filter(t => t.kind !== 'later').map(t => t.crm));
        if (res.own) res.own.maybe = res.own.maybe.filter(m => !mB.has(m.row)); // «схоже на переказ», а в CRM це кілька записів — не переказ
        res.kinds = bankKinds(B0, res.own, x => P1.get(x) || mB.get(x) || tB.get(x));
        const B = kind === 'all' ? B0 : B0.filter(x => res.kinds.get(x) === kind);
        Object.assign(res.bank, { cred: sumPos(B), deb: sumNeg(B), n: B.length });
        // решта переказів на транзитний рахунок ЗП і записів ЗП без пари поштучно не звіряються — лише підсумок
        res.pay = null;
        if (payAcc) {
          const inB = new Set(B), inC = new Set(C);
          const pB = LB.filter(x => inB.has(x) && !mB.has(x) && !tB.has(x) && isPay(x)), pC = LC.filter(c => inC.has(c) && !mC.has(c) && !tC.has(c) && c.opc <= 2 && sal(c));
          if (pB.length || pC.length) res.pay = { bank: pB, crm: pC };
        }
        const yB = new Set(res.pay ? res.pay.bank : []), yC = new Set(res.pay ? res.pay.crm : []);
        // з фільтром типу: пара, де в банку переказ між своїми, а в CRM — витрата чи дохід, — не «немає в банку / в CRM», а cross (різний тип)
        res.cross = kind === 'all' ? [] : [...P1].filter(([x, c]) => res.kinds.get(x) !== crmKind(c) && (res.kinds.get(x) === kind || crmKind(c) === kind)).map(([x, c]) => ({ bank: x, crm: c }));
        const xB = new Set(res.cross.map(p => p.bank)), xC = new Set(res.cross.map(p => p.crm));
        // кількість за сумами — без відсутніх переказів між своїми (вони — у пропозиціях), без пояснених різниць і ЗП через транзит
        const Bc = B.filter(x => !miss.has(x) && !mB.has(x) && !tB.has(x) && !xB.has(x) && !yB.has(x) && !rB.has(x)), Cc = C.filter(c => !mC.has(c) && !tC.has(c) && !xC.has(c) && !yC.has(c) && !rC.has(c));
        const a = countByAmount(Bc, Cc, kind === 'all' ? cf : cf.filter(c => crmKind(c) === kind), from, to);
        res.amounts = a.mismatched; res.distinct = a.distinct;
        res.missing = missingRows(Bc, Cc);
      }
    } else if (manualClose !== undefined && manualClose !== null) {
      res.bank = { open: null, close: r2(manualClose), cred: null, deb: null, n: null };
      res.source = 'manual';
    }
    if (res.bank) res.diff = { open: dif(crm.open, res.bank.open), close: dif(crm.close, res.bank.close), cred: dif(crm.cred, res.bank.cred), deb: dif(crm.deb, res.bank.deb), n: res.bank.n === null ? null : crm.n - res.bank.n };
    const z = v => v === null || Math.abs(v) < 0.005;
    const keys = kind === 'all' ? ['open', 'close', 'cred', 'deb'] : ['cred', 'deb'];
    res.ok = !!res.bank && (kind === 'all' ? res.diff.close !== null && (res.covered || res.source === 'manual') : res.covered) && keys.every(k => z(res.diff[k])) && !res.amounts.length;
    // різниця лише через дати проведення покупок карткою і ЗП через транзитний рахунок: adj — різниці без них; timingOk — без них усе сходиться
    // групи, що змінюють обороти (не суму): LiqPay — у банку зараховано, у CRM лід і комісія; платіж і повернення — лише в банку
    const turnG = (res.multi || []).filter(g => g.why === 'liqpay' || g.why === 'refund');
    res.adjWhy = [...new Set([res.pay ? 'pay' : '', res.timing && res.timing.length ? 'timing' : '', ...turnG.map(g => g.why),
      res.ruled && res.ruled.length ? 'ruled' : '', res.calc && res.calc.length ? 'calc' : ''].filter(Boolean))];
    if (!res.ok && res.adjWhy.length && !res.amounts.length) {
      const adj = { open: 0, close: 0, cred: 0, deb: 0 };
      const onlyB = x => { if (kind !== 'all' && res.kinds.get(x) !== kind) return; if (x.amount > 0) adj.cred += x.amount; else adj.deb -= x.amount; adj.close -= x.amount; };
      const onlyC = c => { if (kind !== 'all' && crmKind(c) !== kind) return; if (c.amount > 0) adj.cred -= c.amount; else adj.deb += c.amount; adj.close += c.amount; };
      // ЗП (вже лише вибраного типу): у банку переказ є, а в CRM немає (+); у CRM запис є, а в банку немає (−) — як у покупок карткою
      if (res.pay) { res.pay.bank.forEach(onlyB); res.pay.crm.forEach(onlyC); }
      // за правилом не вноситься в CRM (кошти броніків) — лише в банку; розрахунковий запис (1.5 % від бронювання) — лише в CRM
      (res.ruled || []).forEach(o => onlyB(o.row));
      (res.calc || []).forEach(o => onlyC(o.crm));
      turnG.forEach(g => { g.bank.forEach(onlyB); g.crm.forEach(onlyC); });
      for (const t of res.timing || []) {
        const a = t.kind === 'later' ? t.bank.amount : t.crm.amount;
        if (kind !== 'all' && kind !== (a > 0 ? 'credit' : 'debit')) continue;
        const s = t.kind === 'later' ? 1 : -1; // банк провів у періоді те, що в CRM раніше (+), або в CRM у періоді те, що банк провів пізніше (−)
        if (a > 0) adj.cred += s * a; else adj.deb -= s * a;
        if (t.kind !== 'later') adj.close += t.crm.amount;
        else if (t.crm.date < from) adj.open += t.crm.amount;
      }
      const sub = (v, d) => (v === null ? null : r2(v - d));
      res.adj = { open: sub(res.diff.open, adj.open), close: sub(res.diff.close, adj.close), cred: sub(res.diff.cred, -adj.cred), deb: sub(res.diff.deb, -adj.deb) };
      res.timingOk = (kind !== 'all' || res.diff.close !== null) && keys.every(k => z(res.adj[k]));
    }
    if (!res.ok && res.own && res.own.missing.size && !res.own.maybe.length && !res.amounts.length && res.diff.cred !== null && (kind === 'all' || kind === 'own')) {
      const inS = r2([...res.own.missing].filter(x => x.amount > 0).reduce((s, x) => s + x.amount, 0));
      const outS = r2(-[...res.own.missing].filter(x => x.amount < 0).reduce((s, x) => s + x.amount, 0));
      // пояснені різниці (ЗП через транзит, дати проведення, LiqPay, повернення, броніки, 1.5 %) — не розбіжність: якщо без них лишаються
      // лише відсутні перекази, рахунок після їх внесення зійдеться з поясненнями (08.11.2026)
      const D = res.adj || res.diff;
      const left = [D.cred + inS, D.deb + outS].concat(kind === 'all' ? [D.open, D.close === null ? null : D.close + inS - outS] : []);
      res.xferOnly = (kind !== 'all' || res.diff.close !== null) && left.every(v => z(v === null ? null : r2(v)));
    }
    return res;
  }

  // ---------- звірка ----------
  /* opt.cOpen — вхідний залишок CRM на from (якщо не задано — сума всіх записів рахунку до from) */
  function reconcile(bank, cf, from, to, opt) {
    const inP = x => x.date >= from && x.date <= to;
    const B = bank.rows.filter(inP), C = cf.filter(inP);
    let bOpen = null, bOpenNote = '';
    if (bank.opening !== null && bank.opening !== undefined) {
      if (bank.fileFrom && bank.fileFrom > from) bOpenNote = `файл починається з ${bank.fileFrom} — вхідний залишок на ${from} не знаю`;
      else {
        const before = r2(bank.rows.filter(x => x.date < from && (!bank.fileFrom || x.date >= bank.fileFrom)).reduce((s, x) => s + x.amount, 0));
        bOpen = r2(bank.opening + before);
        bOpenNote = before ? `вхідний залишок файлу ${bank.opening} + рух до ${from} ${before}` : 'вхідний залишок виписки';
      }
    } else bOpenNote = 'у джерелі немає вхідного залишку';
    const sumPos = a => r2(a.filter(x => x.amount > 0).reduce((s, x) => s + x.amount, 0));
    const sumNeg = a => r2(-a.filter(x => x.amount < 0).reduce((s, x) => s + x.amount, 0));
    const bCred = sumPos(B), bDeb = sumNeg(B);
    const bClose = bOpen === null ? null : r2(bOpen + bCred - bDeb);
    let fileCheck = null;
    if (bank.fileOpening != null && bank.fileClosing != null) {
      const move = r2(bank.rows.reduce((s, x) => s + x.amount, 0));
      fileCheck = { calc: r2(bank.fileOpening + move), fileClosing: bank.fileClosing, move, diff: r2(bank.fileClosing - bank.fileOpening - move) };
    }
    const cOpen = opt && opt.cOpen != null ? r2(opt.cOpen) : r2(cf.filter(x => x.date < from).reduce((s, x) => s + x.amount, 0));
    const cCred = sumPos(C), cDeb = sumNeg(C), cClose = r2(cOpen + cCred - cDeb);
    // поштучно: сума до копійки; спершу той самий день, потім ±1…±3 дні
    const bL = B.map((x, i) => ({ ...x, k: i, m: null })), cL = C.map((x, i) => ({ ...x, k: i, m: null }));
    for (const tol of [0, 1, 2, 3]) {
      for (const b of bL) {
        if (b.m) continue;
        const c = cL.find(c => !c.m && cents(c.amount) === cents(b.amount) && Math.abs(dayDiff(c.date, b.date)) === tol);
        if (c) { b.m = c; c.m = b; b.tol = tol; }
      }
    }
    const days = {};
    const D = d => days[d] || (days[d] = { bIn: 0, bOut: 0, cIn: 0, cOut: 0 });
    B.forEach(x => { if (x.amount > 0) D(x.date).bIn += x.amount; else D(x.date).bOut -= x.amount; });
    C.forEach(x => { if (x.amount > 0) D(x.date).cIn += x.amount; else D(x.date).cOut -= x.amount; });
    const dayRows = Object.keys(days).sort().map(d => { const v = days[d]; return { date: d, bIn: r2(v.bIn), cIn: r2(v.cIn), dIn: r2(v.cIn - v.bIn), bOut: r2(v.bOut), cOut: r2(v.cOut), dOut: r2(v.cOut - v.bOut) }; });
    return {
      bOpen, bOpenNote, bCred, bDeb, bClose, fileCheck, cOpen, cCred, cDeb, cClose,
      dOpen: bOpen === null ? null : r2(cOpen - bOpen), dCred: r2(cCred - bCred), dDeb: r2(cDeb - bDeb), dClose: bClose === null ? null : r2(cClose - bClose),
      matched: bL.filter(b => b.m), bOnly: bL.filter(b => !b.m), cOnly: cL.filter(c => !c.m), shifted: bL.filter(b => b.m && b.tol > 0),
      dayRows, nB: B.length, nC: C.length,
    };
  }

  /* Аркуші xlsx (як у privat_recon.js): Підсумок, По днях, Банк без кешфлоу, Кешфлоу без банку, Зіставлено */
  function reportSheets(list) {
    const sum = [['Рахунок кешфлоу', 'Рахунок банку', 'Джерело', 'Період з', 'по', 'Вхідний банк', 'Вхідний кешфлоу', 'Різниця', 'Кредит банк', 'Дохід кешфлоу', 'Різниця',
      'Дебет банк', 'Витрата кешфлоу', 'Різниця', 'Вихідний банк', 'Вихідний кешфлоу', 'Різниця', 'Операцій банк', 'Операцій кешфлоу', 'Зіставлено', 'Банк без кешфлоу', 'Кешфлоу без банку']];
    const days = [['Рахунок', 'Дата', 'Кредит банк', 'Дохід кешфлоу', 'Різниця', 'Дебет банк', 'Витрата кешфлоу', 'Різниця']];
    const bo = [['Рахунок', 'Дата', 'Час', 'Сума', 'Контрагент', 'Призначення', 'Референс']];
    const co = [['Рахунок', 'Дата', 'ID запису', 'Лід CRM', 'Тип', 'Сума', 'Коментар']];
    const mt = [['Рахунок', 'Дата банк', 'Дата кешфлоу', 'Сума', 'ID кешфлоу', 'Контрагент', 'Призначення', 'Коментар кешфлоу']];
    for (const x of list) {
      const R = x.R, n = x.cfName;
      sum.push([n, x.iban || '', x.src, x.from, x.to, R.bOpen, R.cOpen, R.dOpen, R.bCred, R.cCred, R.dCred, R.bDeb, R.cDeb, R.dDeb, R.bClose, R.cClose, R.dClose, R.nB, R.nC, R.matched.length, R.bOnly.length, R.cOnly.length]);
      R.dayRows.forEach(d => days.push([n, d.date, d.bIn, d.cIn, d.dIn, d.bOut, d.cOut, d.dOut]));
      R.bOnly.forEach(b => bo.push([n, b.date, b.time, b.amount, b.cpty, b.purpose, b.ref]));
      R.cOnly.forEach(c => co.push([n, c.date, c.id, c.lead ? 'так' : '', c.op, c.amount, c.comment]));
      R.matched.forEach(b => mt.push([n, b.date, b.m.date, b.amount, b.m.id, b.cpty, b.purpose, b.m.comment]));
    }
    return [
      { name: 'Підсумок', rows: sum, widths: [34, 30, 40, 11, 11, 14, 14, 12, 14, 14, 12, 14, 14, 12, 14, 14, 12, 9, 9, 9, 9, 9], money: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] },
      { name: 'По днях', rows: days, widths: [34, 11, 14, 14, 12, 14, 14, 12], money: [2, 3, 4, 5, 6, 7] },
      { name: 'Банк без кешфлоу', rows: bo, widths: [34, 11, 7, 13, 34, 70, 18], money: [3] },
      { name: 'Кешфлоу без банку', rows: co, widths: [34, 11, 9, 8, 14, 13, 70], money: [5] },
      { name: 'Зіставлено', rows: mt, widths: [34, 11, 11, 13, 9, 34, 60, 60], money: [3] },
    ];
  }

  return { bankAccounts, autoMatch, matchAccounts, cashflowItems, cashflowByAccount, crmBalanceAt, bankBalanceAt, bankOpeningAt, countByAmount, periodRecon, reconcile, reportSheets, bankOf, r2,
    cardTail, cardTails, nameTail, staleLocalCard, isCorp, groupItems, ownDirectory, ownKey, ownKind, ownTransfers, sameOwner, pairRows, missingRows, bankKinds, crmKind, KINDS, subsetSum, subsetExact, multiPairs, cardDate, cardTiming,
    cardDays, liqpayGroups, taxDays, payDays, refundPairs, PAY_TAX, TAX_REC, payRow, balOf, ownerOf, ownerCards, CARD_OFF, cptyMarketer, holderOf, personIn, holderCard };
}));
