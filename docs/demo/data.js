/* Демо-дані «Лінтера кешфлоу»: усе вигадане — фірма, люди, рахунки, суми.
   make({year, month, articles}) → довідники CRM, записи кешфлоу за місяць і виписки банків у форматі install/bank/privat_fetch.py.
   Набір навмисно з розбіжностями — щоб у «Звірці з банком» було видно кожен розділ:
     1) переказ між своїми рахунками (є в обох виписках і в CRM) і переказ, якого в CRM бракує;
     2) продаж валюти: гривня від продажу доларів — переказ з валютного рахунку тієї самої фірми, а не дохід;
     3) LiqPay: банк зарахував суму без комісії, у CRM — оплата повністю й окремий запис комісії з тим самим LIQPAY ID;
     4) покупка корп. карткою: у CRM — датою покупки, банк провів на три дні пізніше;
     5) податки із зарплати: банк платить ПДФО і військовий збір двома платежами, у CRM податки записано по людях;
     6) платіж і його повернення того самого дня — у CRM не вносяться;
     7) підписка за тарифом: надходження з сумою тарифу — пропозиція запису зі статтею «Підписки юристів»;
     8) операції, яких немає в CRM (комісія банку, покупка карткою) — пропозиція створити чернетку;
     9) поповнення корп. картки, записане витратою, — пропозиція змінити тип запису на переказ;
    10) для «Статей і проєктів»: оплата сервера зі статтею «Офіс» — за правилом має бути «Інфраструктура». */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CFDemoData = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const pad = n => String(n).padStart(2, '0');
  const IBAN = tail => 'UA' + String(tail).padStart(27, '0');
  const ACC = { tov: 33, usd: 36, fop: 68, mono: 69, card: 89 };
  const IB = { tov: IBAN(5608), usd: IBAN(36), fop: IBAN(68), mono: IBAN(69), pay: IBAN(307), fx: IBAN(203) };
  const CARD = '3462', MARKETER = 1235;
  const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];

  /** Попередній повний місяць за київським часом (для сторінки демо). */
  function previousMonth(now) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit' }).formatToParts(now || new Date());
    let y = Number(p.find(x => x.type === 'year').value), m = Number(p.find(x => x.type === 'month').value) - 1;
    if (m < 1) { m = 12; y--; }
    return { year: y, month: m };
  }

  function make(opts) {
    const year = opts.year, month = opts.month, articles = opts.articles || [];
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = n => `${year}-${pad(month)}-${pad(n)}`;
    const dmy = iso => iso.split('-').reverse().join('.');
    const prev = new Date(Date.UTC(year, month - 1, 0));
    const before = `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(prev.getUTCDate())}`;
    const mName = `${MONTHS[month - 1]} ${year}`;
    const iso = d => `${d}T10:00:00.000000Z`; // полудень-пів на першу за Києвом: дата та сама і взимку, і влітку

    // ---------- довідники CRM ----------
    const accounts = [
      { id: ACC.tov, name: 'Приват ТОВ ПРИКЛАД СЕРВІС 5608', currency_id: 1, deleted_at: null },
      { id: ACC.usd, name: 'Приват долар ТОВ ПРИКЛАД СЕРВІС 0036', currency_id: 2, deleted_at: null },
      { id: ACC.fop, name: 'ФОП Хоменко Всеволод Сергійович Приват', currency_id: 1, deleted_at: null },
      { id: ACC.mono, name: 'ФОП Хоменко Всеволод Сергійович Моно', currency_id: 1, deleted_at: null },
      { id: ACC.card, name: `корп. картка ${CARD} ФОП Хоменко Всеволод Сергійович`, currency_id: 1, deleted_at: null },
    ];
    const currencies = [{ id: 1, code: 'UAH' }, { id: 2, code: 'USD' }, { id: 3, code: 'EUR' }];
    const cats = new Map(), ops = new Map();
    for (const a of articles) { cats.set(a.category_id, a.category); ops.set(a.operation_id, { name: a.name, operation: a.type }); }
    const users = [
      { id: 5, name: 'Демо Бухгалтерка', role: { name: 'Бухгалтер' }, is_working: true },
      { id: MARKETER, name: 'Дмитро Миколаївський', role: { name: 'Маркетолог' }, is_working: true },
      { id: 208, name: 'Демо Маркетологиня', role: { name: 'Маркетолог' }, is_working: true },
    ];

    // ---------- записи CRM ----------
    const records = [];
    let rid = 41000;
    const rec = (d, acc, op, cat, opid, amount, comment, x) => {
      const id = ++rid, o = x || {};
      records.push({ id, user_id: 5, location_id: null, project_id: o.prj || 1, task_payment_id: o.lead ? 700 + id % 100 : null, comment, date: iso(d), period: iso(d.slice(0, 8) + '01'),
        created_at: iso(d), updated_at: iso(d), deleted_at: null, is_manual: !o.auto, is_edited: false, kyiv: d,
        marketer_balance_history: o.mk ? { marketer_balance: { user_id: o.mk } } : null,
        payments: [{ id: id * 10, transaction_id: id, invoice_id: acc, operation: op, pnl_category_id: cat, pnl_operation_id: opid, amount: Math.round(Math.abs(amount) * 100) / 100, deleted_at: null, comment: null, tax: null }] });
      return records[records.length - 1];
    };
    const xfer = (d, from, to, amount, comment, amountTo) => {
      const r = rec(d, from, 4, null, null, amount, comment);
      r.payments.push({ ...r.payments[0], id: r.id * 10 + 1, invoice_id: to, operation: 3, amount: amountTo || r.payments[0].amount });
      return r;
    };

    // ---------- виписки ----------
    let seq = 0;
    const privat = (key, ccy, name, client, opening) => ({ acc: IB[key], ccy, name, bank: 'privat', client, opening, closing: opening, warnings: [], transactions: [] });
    const row = (acc, n, sum, osnd, cp, cpn, time) => {
      acc.transactions.push({ ID: `D${++seq}`, DAT_OD: dmy(day(n)), TIM_P: time || '12:00', SUM: Math.abs(sum).toFixed(2), TRANTYPE: sum < 0 ? 'D' : 'C', AUT_CNTR_NAM: cpn, AUT_CNTR_ACC: cp,
        OSND: osnd, REF: `DEMO${seq}`, PR_PR: 'r', CCY: acc.ccy, AUT_MY_ACC: acc.acc });
      acc.closing = Math.round((acc.closing + sum) * 100) / 100;
    };
    const tov = privat('tov', 'UAH', 'ТОВ ПРИКЛАД СЕРВІС', 'ПРИКЛАД', 250000);
    const usd = privat('usd', 'USD', 'ТОВ ПРИКЛАД СЕРВІС', 'ПРИКЛАД', 3000);
    const fop = privat('fop', 'UAH', 'Хоменко Всеволод Сергійович ФОП', 'ФОП Хоменко', 60000);
    const pay = privat('pay', 'UAH', 'Ціл-ві зарах.ТОВ ПРИКЛАД СЕРВІС', 'ПРИКЛАД', 0);
    const mono = { acc: IB.mono, ccy: 'UAH', name: 'Хоменко ФОП', bank: 'mono', client: 'ФОП Хоменко', opening: 40000, closing: 40000, warnings: [], transactions: [] };
    const mrow = (n, sum, description, x) => {
      const bal = Math.round((mono.closing + sum) * 100);
      mono.transactions.push({ id: `dm${++seq}`, time: Math.floor(Date.parse(`${day(n)}T10:15:00Z`) / 1000), amount: Math.round(sum * 100), balance: bal, description, ...(x || {}) });
      mono.closing = bal / 100;
    };

    // вхідні залишки: у CRM — записом останнього дня попереднього місяця
    rec(before, ACC.tov, 1, 46, 23, tov.opening, 'Вхідний залишок (демо)');
    rec(before, ACC.usd, 1, 46, 23, usd.opening, 'Вхідний залишок (демо)');
    rec(before, ACC.fop, 1, 46, 23, fop.opening, 'Вхідний залишок (демо)');
    rec(before, ACC.mono, 1, 46, 23, mono.opening, 'Вхідний залишок (демо)');

    // --- ТОВ, гривня: звичайні оплати клієнтів і витрати — є і в банку, і в CRM ---
    const clients = [['Тополя Орест', 4800], ['Вишнева Юліана', 12500], ['ТОВ «Зразок Буд»', 36000], ['Савчин Юліан', 2600], ['Гнатів Соломія', 7400]];
    clients.forEach(([who, sum], i) => {
      const n = 2 + i * 5;
      row(tov, n, sum, `Оплата за юридичні послуги згідно рахунку №${310 + i} від ${dmy(day(n))}. Без ПДВ.`, IBAN(500 + i), who, `1${i}:2${i}`);
      rec(day(n), ACC.tov, 1, 45, i === 2 ? 63 : 21, sum, `Оплата замовлення №${8100 + i} — ${who}`, { lead: true, auto: true });
    });
    row(tov, 4, -3200, 'Оплата за послуги хостингу згідно рахунку №77. Без ПДВ.', IBAN(520), 'ТОВ «Хостинг Демо»');
    rec(day(4), ACC.tov, 2, 71, 77, 3200, 'Хостинг: сервери за місяць');
    row(tov, 11, -9500, 'Оплата за оренду офісу. Без ПДВ.', IBAN(521), 'ФОП Орендодавець Демо');
    rec(day(11), ACC.tov, 2, 57, 52, 9500, 'Оренда офісу');
    // для вкладки «Статті й проєкти»: сервер записали в «Офіс» — правило каже «Інфраструктура»
    row(tov, 19, -1850, 'Оплата за послуги Hetzner Online GmbH, оренда сервера', IBAN(522), 'Hetzner Online GmbH');
    rec(day(19), ACC.tov, 2, 57, 52, 1850, 'Hetzner: сервер за місяць');
    // (8) комісія банку — у CRM немає: лінтер пропонує запис зі статтею «Комісії платіжних систем»
    row(tov, 5, -45, 'Комiсiя за розрахунково-касове обслуговування', IBAN(305), 'АТ КБ ПРИВАТБАНК');
    // (1) переказ між своїми, якого в CRM бракує: з ФОП на ТОВ (є в обох виписках)
    row(tov, 7, 5600, 'Сплата за ліцензійний договір (оферта) №41 від 01.04. Без ПДВ.', IB.fop, 'ХОМЕНКО ВСЕВОЛОД СЕРГІЙОВИЧ ФОП');
    // (2) продаж валюти: 1 000 доларів → гривня; у CRM переказу ще немає
    row(usd, 8, -1000, 'Списання коштів для продажу валюти згiдно заяви', IB.fx, 'Продаж USD клiєнтiв');
    row(tov, 8, 41250, 'Гривнi вiд продажу 1000.00 USD по курсу 41.25', IB.fx, 'Продаж UAH клiєнтiв');
    row(tov, 8, -123.75, 'Списання комiсiї за продаж валюти згiдно договору, сума продажу 1000.00 USD, по курсу 41.25', IBAN(305), 'Ком.за в/о');
    // (3) LiqPay: банк — нетто, CRM — оплата повністю + комісія з тим самим LIQPAY ID
    row(tov, 12, 838.95, `LIQPAY ID 2900000101 SOID 21ad0001 PBK i70000000101 DATE ${day(12)} TYPE acquiring`, IBAN(412), 'Платежi через LiqPay', '16:21');
    rec(day(12), ACC.tov, 1, 45, 21, 850, 'Оплата замовлення №8120 (Акаунт #9001) через LiqPay', { lead: true, auto: true });
    rec(day(12), ACC.tov, 2, 76, 82, 11.05, 'Комісія LiqPay 16:21: оплата 850.00, зараховано 838.95, LIQPAY ID 2900000101', { auto: true });
    // (5) зарплата через транзитний рахунок і податки з неї: банк — три платежі, CRM — по людях
    row(tov, 15, -27000, `Заробітна плата за ${mName}`, IB.pay, 'Ціл-ві зарах.ТОВ ПРИКЛАД СЕРВІС');
    row(pay, 15, 27000, `Заробітна плата за ${mName}`, IB.tov, 'ТОВ ПРИКЛАД СЕРВІС');
    row(pay, 15, -27000, '#DEMO000012345678#ПОПОВНЕННЯ ЗП/КАРТОК. Пакет:DEMO000012345678,реф.проєкту:23400000001,карток:3', IBAN(306), 'Ціл-ві зарах.');
    [['Іваненко Іван', 12600], ['Петренко Петро', 9000], ['Сидоренко Олена', 5400]].forEach(([who, net]) => {
      rec(day(15), ACC.tov, 2, 55, 47, net, `ЗП за ${mName} — ${who} (на руки)`);
      rec(day(15), ACC.tov, 2, 55, 47, Math.round(net / 9 * 100) / 100, `Податки 10 % з ${(net / 0.9).toFixed(2)} (на руки ${net.toFixed(2)}) — ${who}: ЗП за ${mName}`);
    });
    row(tov, 15, -1500, `Сплата військового збору за ${mName}`, IBAN(311), 'ГОЛОВНЕ УДКСУ У М.КИЄВІ');
    row(tov, 15, -1500, `Сплата ПДФО за ${mName}`, IBAN(310), 'ГОЛОВНЕ УДКСУ У М.КИЄВІ');

    // --- ФОП, Приват ---
    // (7) підписка за тарифом PRO (1 699): у CRM запису ще немає
    row(fop, 3, 1699, 'Оплата за доступ до онлайн-сервісу для юристів, підписка на 1 місяць, від Мельничук Злати Петрівни', IBAN(601), 'Мельничук Злата Петрівна');
    row(fop, 9, 5200, 'Оплата юридичних послуг згідно договору', IBAN(602), 'Бойчишин Маркіян Ігорович');
    rec(day(9), ACC.fop, 1, 45, 21, 5200, 'Оплата замовлення №8131 — Бойчишин Маркіян', { lead: true, auto: true });
    // (1) переказ між своїми: є в CRM
    row(fop, 6, -2000, 'Переказ власних коштів', IB.mono, 'Хоменко Всеволод');
    mrow(6, 2000, 'Переказ власних коштів', { counterIban: IB.fop, counterName: 'Хоменко Всеволод' });
    xfer(day(6), ACC.fop, ACC.mono, 2000, 'Переказ власних коштів: Приват → Моно');
    // … і той, якого в CRM бракує (пара до надходження на ТОВ)
    row(fop, 7, -5600, 'Сплата за ліцензійний договір (оферта) №41 від 01.04. Без ПДВ.', IB.tov, 'ТОВ ПРИКЛАД СЕРВІС');
    // покупки корп. карткою списуються з рахунку ФОП; у CRM вони — на рахунку картки, з маркетологом
    const buy = (posted, bought, sum, merchant, inCrm) => {
      row(fop, posted, -sum, `4246 **** **** ${CARD} ${dmy(day(bought))} 17:33:33 Цифровi товари: ${merchant}`, IB.fx, 'USD валютна позицiя (Compass)');
      if (inCrm) rec(day(bought), ACC.card, 2, 20, 30, sum, `Facebook ${pad(bought)}.${pad(month)} Миколаївський Дмитро (реінвест Україна): ${sum.toFixed(2)} UAH, корп. картка ${CARD}`, { mk: MARKETER });
    };
    buy(3, 2, 1011.26, 'FACEBK *DEMO1, FACEBOOK.COM', true);
    buy(10, 9, 1500, 'FACEBK *DEMO2, Dublin', true);
    buy(16, 13, 1234.56, 'FACEBK *DEMO3, Dublin', true);   // (4) банк провів на три дні пізніше
    buy(18, 18, 777.77, 'FACEBK *DEMO4, FACEBOOK.COM', false); // (8) у CRM немає
    // поповнення картки в CRM — переказом (у банку його немає: покупки картки Приват списує прямо з рахунку ФОП)
    xfer(day(2), ACC.fop, ACC.card, 3000, `поповнення корп картки ${CARD}`);
    // (9) … а це поповнення записали витратою, ще й з опискою
    rec(day(14), ACC.fop, 2, 20, 41, 1600, 'Дмитро Миколаївський: Поповнення корп каркти, для реклами ФБ', { mk: MARKETER });
    // (6) платіж і його повернення
    row(fop, 20, -640, 'Сплата за товари згідно рахунку №15', IBAN(410), 'ФОП Постачальник Демо');
    row(fop, 20, 640, 'Повернення помилково перерахованих коштів від ФОП Хоменко', IBAN(410), 'ФОП Постачальник Демо', '15:40');

    // --- ФОП, monobank ---
    mrow(5, 3400, 'Від: Ковальчук Андріана');
    rec(day(5), ACC.mono, 1, 45, 21, 3400, 'Оплата замовлення №8140 — Ковальчук Андріана', { lead: true, auto: true });
    mrow(17, -820, 'Канцтовари для офісу');
    rec(day(17), ACC.mono, 2, 57, 52, 820, 'Канцтовари для офісу');
    mrow(22, 2150, 'Від: Калинич Орися');
    rec(day(22), ACC.mono, 1, 45, 21, 2150, 'Оплата замовлення №8152 — Калинич Орися', { lead: true, auto: true });

    const byDay = (a, b) => a.DAT_OD.split('.').reverse().join('').localeCompare(b.DAT_OD.split('.').reverse().join(''));
    for (const a of [tov, usd, fop, pay]) a.transactions.sort(byDay);
    const from = day(1), to = day(last);
    const bank = { source: 'bank_api', client: 'ВСІ', from, to, fetched_at: `${dmy(to)} 23:59`, accounts: [tov, usd, fop, mono, pay] };
    return { year, month, from, to, monthName: mName, accounts, currencies, cats: [...cats].map(([id, name]) => ({ id, name })),
      ops: [...ops].map(([id, o]) => ({ id, name: o.name, operation: o.operation })), users, records, bank, ids: ACC };
  }

  return { make, previousMonth };
});
