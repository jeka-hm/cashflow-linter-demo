/* Тестова збірка закладки для мок-CRM (test/mock_crm_server.py --static work/e2e):
   той самий бандл і завантажувач, що й у dist/, але перевірка домену дозволяє 127.0.0.1, а підпис — тестовим ключем
   work/e2e/e2e-signing-key.json (не ключем розробника). Підписаний бандл — work/e2e/cashflow_linter.js: його віддає
   імітація Помічника (/helper/dist/cashflow_linter.js), його ж можна вибрати файлом у завантажувачі.
   Запуск: node test\e2e\make_e2e.js */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { bundle, loaderSource, toBookmarklet, signCode } = require('../../build/build.js');

const OUT = path.resolve(__dirname, '..', '..', 'work', 'e2e');
const HOST_CHECK = String.raw`/(^|\.)crm\.example\.com$/.test(location.hostname)`;
const E2E_CHECK = String.raw`/^(127\.0\.0\.1|(.+\.)?crm\.example\.com)$/.test(location.hostname)`;
// перевірка домену є в main.js, у вбудованому реєстрі погоджень і в завантажувачі — дозволити 127.0.0.1 усюди
const patchHost = (s, what) => { if (!s.includes(HOST_CHECK)) throw new Error(`не знайдено перевірку домену: ${what}`); return s.split(HOST_CHECK).join(E2E_CHECK); };
fs.mkdirSync(OUT, { recursive: true });
const keyFile = path.join(OUT, 'e2e-signing-key.json');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, JSON.stringify(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })), 'utf8');
const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
fs.writeFileSync(path.join(OUT, 'cashflow_linter.js'), signCode(patchHost(bundle(), 'бандл'), key), 'utf8');
fs.writeFileSync(path.join(OUT, 'bm_view.txt'), toBookmarklet(patchHost(loaderSource({ APPLY: false }, key), 'завантажувач')), 'utf8');
fs.writeFileSync(path.join(OUT, 'bm_apply.txt'), toBookmarklet(patchHost(loaderSource({ APPLY: true }, key), 'завантажувач')), 'utf8');
fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>E2E закладки</title></head><body>
<h1>Мок CRM — тест закладки</h1><button id="v">Закладка: перегляд</button> <button id="a">Закладка: APPLY</button>
<script>
localStorage.setItem('token', '"mock-token-e2e"'); localStorage.setItem('user_id', '1243');
localStorage.setItem('cfl_helper_url', JSON.stringify(location.origin + '/helper')); // імітація Помічника в моку
async function run(f) { const t = await (await fetch('/e2e/' + f, { cache: 'no-store' })).text(); (0, eval)(decodeURIComponent(t.slice('javascript:'.length))); }
document.getElementById('v').onclick = () => run('bm_view.txt');
document.getElementById('a').onclick = () => run('bm_apply.txt');
</script></body></html>`, 'utf8');
// Синтетична виписка у форматі privat_fetch.py (вигадані IBAN і суми) для вкладки «Звірка з банком»:
// мок CRM (--bank work/e2e/bank_test.json) будує з неї записи з навмисними розбіжностями.
function bankTest() {
  const days = n => `2026-10-${String(n).padStart(2, '0')}`;
  const privat = (client, acc, ccy, opening, n, base) => {
    const tx = [];
    let sum = 0;
    for (let i = 1; i <= n; i++) {
      const credit = i % 3 !== 0, amount = Math.round((base + i * 137.31 + (i % 5) * 11.7) * 100) / 100;
      sum += credit ? amount : -amount;
      const d = days(1 + (i * 19) % 20);
      tx.push({ DAT_OD: d.split('-').reverse().join('.'), TIM_P: `${String(9 + i % 9).padStart(2, '0')}:${String(i * 7 % 60).padStart(2, '0')}`, SUM: amount.toFixed(2), TRANTYPE: credit ? 'C' : 'D',
        AUT_CNTR_NAM: credit ? `Клієнт ${i}` : `Постачальник ${i}`, OSND: credit ? `Оплата за послуги, рахунок ${i}` : `Оплата за товар ${i}`, REF: `R${1000 + i}`, PR_PR: 'r', CCY: ccy, AUT_MY_ACC: acc });
    }
    tx.sort((a, b) => a.DAT_OD.split('.').reverse().join('').localeCompare(b.DAT_OD.split('.').reverse().join('')));
    return { acc, ccy, name: `ТОВ ${client}`, bank: 'privat', client, opening, closing: Math.round((opening + sum) * 100) / 100, warnings: [], transactions: tx };
  };
  const mono = () => {
    const tx = [];
    let bal = 4000000; // копійки
    const opening = bal;
    for (let i = 1; i <= 16; i++) {
      const amount = (i % 4 === 0 ? -1 : 1) * (150000 + i * 12345);
      bal += amount;
      tx.push({ id: `m${i}`, time: Math.floor(Date.parse(`${days(1 + i)}T${String(8 + i % 10).padStart(2, '0')}:15:00+03:00`) / 1000), amount, balance: bal, description: amount > 0 ? `Від: Клієнт М${i}` : `Оплата послуг ${i}` });
    }
    return { acc: 'UA000000000000000000000000069', ccy: 'UAH', name: 'Хоменко ФОП', bank: 'mono', client: 'ФОП Хоменко', opening: opening / 100, closing: bal / 100, warnings: [], transactions: tx };
  };
  // перекази між своїми й корп. картка (як у живих виписках): REF «XMISS…» мок CRM не вносить, «XCARD…» — витрата на corpCard 89
  const byDay = (a, b) => a.DAT_OD.split('.').reverse().join('').localeCompare(b.DAT_OD.split('.').reverse().join(''));
  const spec = (acc, list) => {
    for (const [d, s, osnd, cp, cpn, ref] of list) {
      acc.transactions.push({ DAT_OD: days(d).split('-').reverse().join('.'), TIM_P: '12:00', SUM: Math.abs(s).toFixed(2), TRANTYPE: s < 0 ? 'D' : 'C', AUT_CNTR_NAM: cpn, AUT_CNTR_ACC: cp, OSND: osnd, REF: ref, PR_PR: 'r', CCY: acc.ccy, AUT_MY_ACC: acc.acc });
      acc.closing = Math.round((acc.closing + s) * 100) / 100;
    }
    acc.transactions.sort(byDay);
    return acc;
  };
  const LIC = 'Сплата за ліцензійний договір (оферта) №4841 від 01.04.2026р. Без ПДВ.';
  const srv = spec(privat('ПРИКЛАД', 'UA000000000000000000000005608', 'UAH', 250000, 30, 900), [[7, 5600, LIC, 'UA000000000000000000000000068', 'ХОМЕНКО ВСЕВОЛОД СЕРГІЙОВИЧ ФОП', 'XMISS1B'],
    // ЗП через транзитний рахунок «Ціл-ві зарах.»: у банку один переказ, у CRM — записи по людях зі статтею ЗП (на іншу суму)
    [9, -1500, 'Заробітна плата за жовтень 2026', 'UA000000000000000000000000307', 'Ціл-ві зарах.ТОВ ПРИКЛАД СЕРВІС', 'XPAY1'],
    // податки з тієї самої ЗП окремими платежами (як 05.11.2026): у CRM їх немає — одна група, стаття вибирається один раз
    [9, -135, 'Сплата ПДФО за жовтень 2026', 'UA000000000000000000000000310', 'ГОЛОВНЕ УДКСУ У М.КИЄВІ', 'XMISS7'],
    [9, -45, 'Сплата військового збору за жовтень 2026', 'UA000000000000000000000000311', 'ГОЛОВНЕ УДКСУ У М.КИЄВІ', 'XMISS8'],
    [9, -330, 'Сплата ЄСВ за жовтень 2026', 'UA000000000000000000000000312', 'ГОЛОВНЕ УПРАВЛІННЯ ДПС У М.КИЄВІ', 'XMISS9'],
    // звірка жовтня (08.11.2026): LiqPay — у CRM лід і комісія з тим самим LIQPAY ID; податки дня — у CRM по людях, ЄСВ 1,00 — немає
    [12, 393.81, 'LIQPAY ID 2934000808 SOID 21ad0000 PBK i70000000904 DATE 2026-10-12 TYPE acquiring', 'UA000000000000000000000000412', 'Платежi через LiqPay', 'XLIQ1'],
    [16, -500, 'Сплата військового збору за жовтень 2026', 'UA000000000000000000000000311', 'ГОЛОВНЕ УДКСУ У М.КИЄВІ', 'XTAX1'],
    [16, -500, 'Сплата ПДФО за жовтень 2026', 'UA000000000000000000000000310', 'ГОЛОВНЕ УДКСУ У М.КИЄВІ', 'XTAX2'],
    [16, -1, 'Сплата ЄСВ за жовтень 2026', 'UA000000000000000000000000312', 'ГОЛОВНЕ УПРАВЛІННЯ ДПС У М.КИЄВІ', 'XTAXE']]);
  const fopA = spec(privat('ФОП Хоменко', 'UA000000000000000000000000068', 'UAH', 50000, 8, 300), [
    [3, -1011.26, '4246 **** **** 3462 02.10.2026 17:33:33 Цифровi товари: FACEBK *TEST1, FACEBOOK.COM', 'UA000000000000000000000000203', 'USD валютна позицiя (Compass)', 'XCARD1'],
    [4, -1009.46, '4246 **** **** 3462 03.10.2026 00:12:30 Цифровi товари: FACEBK *TEST2, Dublin', 'UA000000000000000000000000203', 'USD валютна позицiя (Compass)', 'XCARD2'],
    [6, -1500, '4246 **** **** 3462 05.10.2026 14:25:29 Цифровi товари: FACEBK *TEST3, Dublin', 'UA000000000000000000000000203', 'USD валютна позицiя (Compass)', 'XCARD3'],
    [7, -5600, LIC, 'UA000000000000000000000005608', 'ТОВ ПРИКЛАД СЕРВІС', 'XMISS1'],
    [8, -2000, 'Переказ власних коштів', 'UA000000000000000000000000069', 'Хоменко Всеволод', 'XTYPE1'],
    [9, -1350, '5363 **** **** 3912 Переказ власних коштів', 'UA000000000000000000000003912', 'ХОМЕНКО ВСЕВОЛОД СЕРГІЙОВИЧ', 'XMISS2'],
    // немає в CRM: комісія банку (пропозиція «Комісії платіжних систем» за R-COMM-01) і зарплата (не пропонується)
    [10, -12.5, 'Комісія банку за переказ коштів', 'UA000000000000000000000000305', 'АТ КБ ПРИВАТБАНК', 'XMISS3'],
    [11, -24000, 'Зарахування заробітної плати згідно відомості №10', 'UA000000000000000000000000306', 'АТ КБ ПРИВАТБАНК', 'XMISS4'],
    // немає в CRM: покупка корп. карткою (реклама) — стаття й маркетолог як у попередніх покупках corpCard 89
    [12, -777.77, '4246 **** **** 3462 12.10.2026 11:11:11 Цифровi товари: FACEBK *TEST4, FACEBOOK.COM', 'UA000000000000000000000000203', 'USD валютна позицiя (Compass)', 'XMISS5'],
    // покупки карткою з іншою датою проведення: 03.10 — банк провів 06.10; 20.10 — банк провів 21.10, після виписки (у CRM — за датою покупки)
    [6, -1234.56, '4246 **** **** 3462 03.10.2026 10:00:00 Цифровi товари: FACEBK *LATE1, Dublin', 'UA000000000000000000000000203', 'USD валютна позицiя (Compass)', 'XLATE1'],
    [21, -987.65, '4246 **** **** 3462 20.10.2026 15:00:00 Цифровi товари: FACEBK *LATE2, Dublin', 'UA000000000000000000000000203', 'USD валютна позицiя (Compass)', 'XLATE2'],
    // одна операція банку = два записи CRM: переказ на картку власника, з неї — дві виплати
    [13, -21348.72, 'Переказ на картку', 'UA000000000000000000000000401', 'Хоменко Всеволод', 'XSPLIT1'],
    // покупка карткою, номера якої лінтер не знає (…6543; 4079 з 02.11.2026 є в назві рахунку CRM): у CRM записано на corpCard 89 — «Нові корп. картки у виписці»
    [14, -321.45, '4246 **** **** 6543 13.10.2026 10:10:10 Цифровi товари: ANTHROPIC* CLAUDE SUB, +1415236059', 'UA000000000000000000000000203', 'USD валютна позицiя (Compass)', 'XNEW1'],
    // покупка карткою ТОВ (…4079, «корп. картка 4079 ТОВ …» у мінусі в CRM) у виписці ФОП: поповнення з ФОП не пропонується — картка іншого власника
    [14, -150, '4246 **** **** 4079 13.10.2026 12:00:00 Цифровi товари: PRNEWS.IO, +3726028888', 'UA000000000000000000000000203', 'USD валютна позицiя (Compass)', 'XOWN1'],
    // немає в CRM: оплата підряднику реклами — маркетолог за контрагентом (rules.json: ФОП Власич → Сливко), проєкт — за Сливком (Україна)
    [15, -8791, 'Оплата за рекламні послуги зг рах від 15.10.2026', 'UA000000000000000000000000407', 'ФОП Власич Оксана Володимирівна', 'XMISS6'],
    // немає в CRM, статті немає ні за правилами, ні з історії рахунку: підказка ШІ з «Взяти» у «Внести в CRM» (05.11.2026)
    [16, -2437.18, 'Оплата послуг нотаріуса: посвідчення довіреності для Польщі', 'UA000000000000000000000000409', 'Приватний нотаріус Коваль О. В.', 'XMISS10'],
    // звірка жовтня (08.11.2026): три покупки картки за 17.10 — у CRM одним записом; платіж і його повернення — у CRM не вносяться
    [18, -310.1, '4246 **** **** 3462 17.10.2026 09:10:00 Цифровi товари: FACEBK *DAY1, FACEBOOK.COM', 'UA000000000000000000000000203', 'USD валютна позицiя (Compass)', 'XDAY1'],
    [18, -220.2, '4246 **** **** 3462 17.10.2026 13:20:00 Цифровi товари: FACEBK *DAY2, FACEBOOK.COM', 'UA000000000000000000000000203', 'USD валютна позицiя (Compass)', 'XDAY2'],
    [18, -130.3, '4246 **** **** 3462 17.10.2026 18:30:00 Цифровi товари: FACEBK *DAY3, Dublin', 'UA000000000000000000000000203', 'USD валютна позицiя (Compass)', 'XDAY3'],
    [17, -640, 'Сплата за товари', 'UA000000000000000000000000410', 'ФОП Тест Повернення', 'XREFA'],
    [17, 640, 'Повернення помилково перерахованих коштів від ФОП Хоменко', 'UA000000000000000000000000410', 'ФОП Тест Повернення', 'XREFB'],
  ]);
  fopA.name = 'Хоменко Всеволод Сергійович ФОП';
  // ФОП Мартиненко, дві корп. картки (04.11.2026): 7850 (ID 91) платила до 08.10, з 14.10 — лише 4546 (ID 104). Поповнення в банку немає (Приват
  // списує покупки картки прямо з рахунку ФОП). У моку CRM поповнення 14.10 без номера й тримача записано на стару 7850 — «Звірка» за випискою
  // пропонує переспрямувати його на 4546; поповнення 16.10 з номером 4546 у коментарі, записане на 7850, — за номером (test/mock_crm_server.py)
  const CMP = 'UA000000000000000000000000203', CMN = 'USD валютна позицiя (Compass)';
  const fopB = spec(privat('ФОП Мартиненко', 'UA000000000000000000000000072', 'UAH', 30000, 0, 0), [
    [3, -812.4, '5169 **** **** 7850 02.10.2026 11:00:00 Цифровi товари: FACEBK *MOS1, FACEBOOK.COM', CMP, CMN, 'XC79A'],
    [6, -905.1, '5169 **** **** 7850 05.10.2026 12:00:00 Цифровi товари: FACEBK *MOS2, FACEBOOK.COM', CMP, CMN, 'XC79B'],
    [9, -640, '5169 **** **** 7850 08.10.2026 09:30:00 Цифровi товари: FACEBK *MOS3, FACEBOOK.COM', CMP, CMN, 'XC79C'],
    [15, -1520.75, '5169 **** **** 4546 14.10.2026 18:00:00 Цифровi товари: FACEBK *MOS4, FACEBOOK.COM', CMP, CMN, 'XC46A'],
    [17, -2210.5, '5169 **** **** 4546 16.10.2026 10:20:00 Цифровi товари: FACEBK *MOS5, FACEBOOK.COM', CMP, CMN, 'XC46B'],
    [19, -980, '5169 **** **** 4546 18.10.2026 14:45:00 Цифровi товари: FACEBK *MOS6, FACEBOOK.COM', CMP, CMN, 'XC46C'],
  ]);
  fopB.name = 'Мартиненко Святослав Олександрович ФОП';
  // операція, яку банк не провів (PR_PR ≠ «r»): у звірку не йде — видно в «Операціях з виписок поза звіркою»
  fopA.transactions.push({ DAT_OD: '16.10.2026', TIM_P: '13:00', SUM: '999.00', TRANTYPE: 'D', AUT_CNTR_NAM: 'ТОВ Сторно', AUT_CNTR_ACC: 'UA000000000000000000000000408', OSND: 'Оплата, сторновано банком', REF: 'XSTORNO1', PR_PR: 'n', CCY: 'UAH', AUT_MY_ACC: fopA.acc });
  fopA.transactions.sort(byDay);
  // службовий рахунок «Ціл-ві зарах.» (ЗП через транзит): у CRM такого рахунку немає — операції лише в «поза звіркою»
  const pay = spec({ acc: 'UA000000000000000000000000307', ccy: 'UAH', name: 'Ціл-ві зарах.ТОВ ПРИКЛАД СЕРВІС', bank: 'privat', client: 'ПРИКЛАД', opening: 0, closing: 0, warnings: [], transactions: [] },
    [[9, 1500, 'Заробітна плата за жовтень 2026', 'UA000000000000000000000005608', 'ТОВ ПРИКЛАД СЕРВІС', 'XPAY1R'],
      // як у живій виписці «Ціл-ві зарах.» (03.11.2026): пакет ЗП Привату з кількістю карток
      [9, -1500, '#261009PB000012345678#ПОПОВНЕННЯ ЗП/КАРТОК ПРОМIНЬ. Пакет:261009PB000012345678,реф.проєкту:23406000642,карток:2', 'UA000000000000000000000000306', 'Ціл-ві зарах.', 'XPAY1S']]);
  const mo = mono();
  const last = mo.transactions[mo.transactions.length - 1];
  mo.transactions.push({ id: 'mx1', time: Math.floor(Date.parse(`${days(19)}T18:00:00+03:00`) / 1000), amount: 200000, balance: last.balance + 200000, description: 'Переказ власних коштів', counterIban: 'UA000000000000000000000000068', counterName: 'Хоменко Всеволод', REF: 'XTYPE2' });
  mo.closing = Math.round((mo.closing + 2000) * 100) / 100;
  return { source: 'bank_api', client: 'ВСІ', from: days(1), to: days(20), fetched_at: '21.10.2026 09:00',
    // порожній валютний рахунок Моно, якого немає в CRM: «звіряти нічого», дії не потребує
    accounts: [srv, privat('ПРИКЛАД', 'UA000000000000000000000000036', 'USD', 1500, 6, 40), fopA, fopB, mo, pay,
      { acc: 'UA000000000000000000000000070', ccy: 'USD', name: 'Хоменко ФОП', bank: 'mono', client: 'ФОП Хоменко', opening: 0, closing: 0, warnings: [], transactions: [] }] };
}
fs.writeFileSync(path.join(OUT, 'bank_test.json'), JSON.stringify(bankTest(), null, 1), 'utf8');
console.log('e2e:', OUT);
