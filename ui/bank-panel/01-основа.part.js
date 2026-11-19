/* =====================================================================
   Вкладка «Звірка з банком» панелі лінтера: рахунки за період — CRM проти банку.
   По кожному рахунку: залишок на початок і кінець періоду, надходження, списання
   і кількість операцій за кожною сумою (core/recon.js → periodRecon): суми можуть бути
   не 1:1 з банком, тому порівнюються штуки, а не пари «операція — запис».
   CRM: залишок, який показує сам CRM (balance рахунку), відкочений записами з пізнішою датою.
   Банк: виписки Привату й Моно вивантажує «Помічник кешфлоу» (ваш privat_fetch.py) на запит
   панелі; без Помічника — файл .json; для Erste, Wise, Stripe, каси — залишок вручну.
   Перекази між своїми рахунками: corpCard, картка якого списує прямо з рахунку банку, звіряється разом із цим
   рахунком (поповнення картки в CRM — рух усередині); переказ, якого немає в CRM, — у списку пропозицій.
   «Що звіряти»: усе, лише надходження, лише списання чи лише перекази між рахунками — обороти, кількість і суми
   рахуються для вибраного типу.
   Операції банку, яких немає в CRM, — у списку пропозицій «створити запис»: витрата, комісія банку чи надходження,
   стаття — за правилами rules.json, інакше як у попередніх записах рахунку з цим контрагентом, інакше її вибирають;
   для статті з рекламним бюджетом — маркетолог (список з CRM, як у реєстрі; за замовчуванням — як у попередніх записах рахунку).
   У CRM — лише GET-запити; єдиний POST — створення переказу чи запису з цих списків, лише в закладці APPLY і після
   вікна з точним запитом. Нічого не змінюється й не видаляється.
   «Нові корп. картки у виписці»: покупки карткою, номера якої лінтер не знає, — з підказкою рахунку картки в CRM (на який записано
   ці покупки) і кнопкою «Запам'ятати» (у цьому браузері, LS cfl_cards_local → довідник карток для всіх вкладок; mergeLocalCards).
   «Закриття місяця»: звірка за весь місяць, «Статті й проєкти» (opts.lintPeriod — перевірка від панелі) і погодження реєстру
   (лише читання) — пункти й висновок, чи можна закривати місяць (closeReport). opts.go(вкладка) — перейти до вкладки.
   «Виводи з балансу»: погодження «% менеджера / м-рів / тімліда» з реєстру ↔ авто-записи «Підтвердження виведення коштів з балансу…»
   (core/withdrawals.js): виведено повністю, частково, виводу немає; виводи без погодження. Лише звірка — нічого не змінює.
   CFBankPanel.mount(container, { api, storage, applyAllowed, dialog, setBusy, projects, rulesDoc, closed, lintPeriod, go })
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../core/recon.js'), require('../core/crm-model.js'), require('../core/xlsx.js'), require('../core/rules-engine.js'), require('../core/withdrawals.js'), require('./combo.js'), require('../core/matching.js'), require('../core/drafts.js'));
  else root.CFBankPanel = factory(root.CFRecon, root.CFModel, root.CFXlsx, root.CFRules, root.CFWithdrawals, root.CFCombo, root.CFMatch, root.CFDrafts);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Rc, M, X, R, WD, Cmb, MT, CFD) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // один форматер на всі суми: toLocaleString створює новий на кожен виклик, а в таблицях звірки їх сотні
  const NF2 = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt = x => (x === null || x === undefined ? '—' : NF2.format(Number(x)));
  const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const r2 = Rc.r2;
  const today = () => M.kyivNow().slice(0, 10);
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dash = iso => iso.split('-').reverse().join('-'); // РРРР-ММ-ДД → ДД-ММ-РРРР (формат фільтра сайту)
  const dmy = iso => (iso ? iso.split('-').reverse().join('.') : '');
  const listOf = j => (Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []));
  const isZero = v => v !== null && v !== undefined && Math.abs(v) < 0.005;
  const parseNum = s => { const t = String(s == null ? '' : s).replace(/[\s  ']/g, '').replace('−', '-').replace(',', '.'); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null; };
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const MARGIN = 7; // днів CRM до періоду: залишок на початок і підказки «запис з іншою датою»
  // групи рахунків за назвою в CRM (у порядку показу); корпкартки — першими при пошуку, бо «Mono біла» — теж корпкартка.
  // Назви — і старі («corpCard …», «Готівка Україна», «1 PLN Polska LLC»), і нові з 30.10.2026 («корп. картка …», «Каса», «… Ерсте злотий», «… Вайз»)
  const GROUPS = [
    ['privat', 'Приват', /приват|privat/i],
    ['mono', 'Універсал (Моно)', /універсал|universal|моно|mono/i],
    ['erste', 'Erste Bank Polska', /polska|злоті в польщі|ерсте|erste/i],
    ['wise', 'Wise', /wise|вайз/i],
    ['stripe', 'Stripe', /stripe|страйп/i],
    ['corp', 'Корпоративні картки', /corp\s*card|корп\.?\s*карт/i],
    ['cash', 'Готівка', /готівк|cash|(?<!\p{L})кас[аи](?!\p{L})/iu],
    ['other', 'Інші рахунки', /[\s\S]/],
  ];
  const groupOf = a => GROUPS.find(g => g[0] === 'corp' && g[2].test(a.name || '')) || GROUPS.find(g => g[2].test(a.name || ''));
  const srcOf = b => `${b.bank === 'mono' ? 'API monobank' : 'API Привату'} · виписка ${dmy(b.fileFrom)}–${dmy(b.fileTo)}`;
  const HINT = 'Виписок ще немає. «Отримати виписки й звірити» — Приват і Моно вивантажить «Помічник кешфлоу» (ваш privat_fetch.py; програма має бути запущена). Без нього — «Додати файл .json». Для Erste, Wise, Stripe і каси залишок банку на кінець періоду можна ввести в таблиці.';
  const LIVE = 'Сьогоднішній день ще не закрито: дані банку — на момент вивантаження виписки (пізніші операції в них не ввійшли), а в CRM сьогоднішні операції можуть бути ще не внесені.';
  const HELPER_DOWN = 'Не бачу «Помічника кешфлоу»: запустіть «Помічник кешфлоу.bat» і натисніть ще раз (виписки вивантажує він, вашим privat_fetch.py). «Оновити.bat» сам зупиняє й знову запускає Помічник; якщо його не було запущено — запустіть. Якщо Помічник запущено, а помилка лишається, браузер не пускає запит до нього — тоді вивантажте виписки в самому Помічнику й додайте файл .json.';
  const ST = { ok: ['st-ok', 'сходиться'], timing: ['st-ok', 'сходиться, крім дат проведення'], pay: ['st-ok', 'сходиться, крім ЗП через транзит'], expl: ['st-ok', 'сходиться з поясненнями'], bad: ['st-manual', 'розбіжність'],
    xfer: ['st-review', 'бракує переказів між своїми'], part: ['st-review', 'неповні дані банку'], ccy: ['st-review', 'інша валюта'], merged: ['st-ok', 'звіряється з рахунком банку'], none: ['st-locked', 'немає даних банку'] };
  const ST_ORDER = ['ok', 'timing', 'pay', 'expl', 'bad', 'xfer', 'part', 'ccy', 'merged', 'none'];
  const ST_RARE = new Set(['timing', 'pay', 'expl', 'xfer', 'ccy', 'merged']); // у фільтрі — лише коли такі рахунки є
  // поповнення корп. картки, записане в CRM витратою (як у правилі R-NP-CORPCARD-01; з описками «корп каркти»), — не комісія за нього
  const CARD_TOPUP_RE = /поповн\p{L}*\s+(?:на\s+)?корп|на\s+корп\p{L}*\.?\s*ка\p{L}{0,2}т/iu;
  const isTopup = s => CARD_TOPUP_RE.test(s || '') && !/^\s*коміс/i.test(s || '');
  const dayDiff = (a, b) => Math.round((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 864e5);
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  // попередження, однакові для всіх рахунків виписки, показуються один раз біля файлу
  const FILE_WARN = /^Підсумкова виписка банку є лише до/;
  // неповна виписка (вхідний + рух ≠ вихідний) чи операція, яку банк віддав двічі (recon, privat_fetch.py; 07.11.2026), — і біля файлу,
  // з номером рахунку, щоб її було видно до будь-якої звірки; у картці рахунку лишається
  const FILE_SHOW = /виписка неповна|операцію двічі/i;
  const tail = iban => (iban ? '…' + String(iban).slice(-6) : '');
  const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };

  /* Чого бракує: суми, кількість операцій з якими різна, — «немає в CRM» (у банку більше) і «немає в банку» (у CRM більше),
     окремо надходження і списання; × — скільки разів. */
  function lacks(R) {
    const miss = [], extra = [];
    for (const x of R.amounts) (x.d < 0 ? miss : extra).push({ amount: x.amount, k: Math.abs(x.d), near: x.near || [] });
    const side = list => {
      const one = x => `${fmt(Math.abs(x.amount))}${x.k > 1 ? ' ×' + x.k : ''}${x.near.length ? ` (у CRM є з іншою датою: ${x.near.slice(0, 2).map(o => dmy(o.date).slice(0, 5)).join(', ')}${x.near.length > 2 ? ` і ще ${x.near.length - 2}` : ''})` : ''}`;
      const part = (arr, label) => (arr.length ? `${label} ${arr.map(one).join(' · ')}${arr.length + arr.reduce((t, x) => t + x.k - 1, 0) > 1 ? ` (разом ${fmt(Math.abs(arr.reduce((t, x) => t + x.amount * x.k, 0)))})` : ''}` : '');
      const asc = arr => arr.slice().sort((x, y) => Math.abs(x.amount) - Math.abs(y.amount));
      return [part(asc(list.filter(x => x.amount > 0)), 'надходження'), part(asc(list.filter(x => x.amount < 0)), 'списання')].filter(Boolean).join('; ');
    };
    return { miss: side(miss), extra: side(extra) };
  }
  // «Що звіряти» (core/recon.js → periodRecon, own.kind)
  const KIND = { all: 'усе', credit: 'надходження', debit: 'списання', own: 'перекази між рахунками' };
  const KIND_ONLY = { credit: 'лише надходження', debit: 'лише списання', own: 'лише перекази між рахунками' };

