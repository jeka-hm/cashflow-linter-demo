// Вкладка «Звірка з банком»: текст «чого бракує» з розбіжних сум (приклад користувача); що пропонувати створити з операцій банку.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Rc = require('../core/recon.js');
const R = require('../core/rules-engine.js');
const WD = require('../core/withdrawals.js');
const { lacks, classify, recComment, histArt, histMk, histRef, mkInComment, cardComment, refParts, ruleHints, holderOf, mkByName, clampToOpen, monthBounds, defaultMonth, closeReport, bankSummary,
  mergeLocalCards, merchantOf, findNewCards, hiddenAccs, OFF_ACC, wrongTopups } = require('../ui/bank-panel.js');
const RULES = require('../rules/rules.json');

const plain = s => s.replace(/[\u00a0\u202f]/g, ' ');
const rows = list => list.map((amount, i) => ({ date: '2026-10-22', amount, id: i + 1 }));

test('lacks: у банку 1000, 1000, 200, 500, 300, у CRM 1000, 1000, 500 → немає в CRM надходжень 200 і 300', () => {
  const r = Rc.countByAmount(rows([1000, 1000, 200, 500, 300]), rows([1000, 1000, 500]), [], '2026-10-22', '2026-10-22');
  const l = lacks({ amounts: r.mismatched });
  assert.equal(plain(l.miss), 'надходження 200,00 · 300,00 (разом 500,00)');
  assert.equal(l.extra, '');
});

test('lacks: зайве в CRM і повтори однієї суми', () => {
  const r = Rc.countByAmount(rows([-150, 400]), rows([-150, -150, -150, 400, -10598.18]), [], '2026-10-22', '2026-10-22');
  const l = lacks({ amounts: r.mismatched });
  assert.equal(l.miss, '');
  assert.equal(plain(l.extra), 'списання 150,00 ×2 · 10 598,18 (разом 10 898,18)');
});

test('classify: комісія, витрата, надходження; зарплата — із застереженням (з 05.11.2026), еквайринг — не пропонується', () => {
  assert.deepEqual(classify({ amount: -5, purpose: 'Комісія за переказ коштів' }), { src: 'fee' });
  assert.deepEqual(classify({ amount: -150, purpose: 'Плата за обслуговування рахунку за жовтень' }), { src: 'fee' });
  assert.deepEqual(classify({ amount: -30, purpose: 'Комісія за поповнення карток для виплат' }), { src: 'fee' }, 'комісія — не зарплата');
  assert.deepEqual(classify({ amount: -2500, purpose: 'Оплата за рекламу', cpty: 'ТОВ РЕКЛАМА' }), { src: 'exp' });
  assert.deepEqual(classify({ amount: -100, purpose: 'Оплата за ЗПС-модуль' }), { src: 'exp' }, '«зп» лише окремим словом');
  assert.deepEqual(classify({ amount: 500, purpose: 'Повернення коштів за договором' }), { src: 'inc' });
  // зарплатну виплату можна внести (ризиковано) — з застереженням, що в CRM ЗП зазвичай вносять по людях
  for (const [amount, purpose] of [[-48000, 'Зарахування заробітної плати згідно відомості'], [-12000, 'Поповнення карток для виплат'], [-9000, 'Перерахування на рахунок ціл-ві зарах']]) {
    const c = classify({ amount, purpose });
    assert.deepEqual([c.src, c.block], ['exp', undefined], purpose);
    assert.match(c.payroll, /у CRM ЗП зазвичай вносять по людях .* лише якщо цієї ЗП у CRM ще немає/);
  }
  assert.match(classify({ amount: 15200, purpose: 'Відшкодування за операціями з платіжними картками' }).block, /еквайрингу/);
  assert.deepEqual(classify({ amount: -15200, purpose: 'Відшкодування за операціями' }), { src: 'exp' }, 'еквайринг — лише надходження');
});

test('recComment: «Отримувач: призначення»; комісія — «Комісія банку: …»', () => {
  assert.equal(recComment({ cpty: 'ТОВ Google', purpose: 'Оплата за  рекламу' }, 'exp'), 'ТОВ Google: Оплата за рекламу');
  assert.equal(recComment({ cpty: 'ТОВ Google', purpose: 'Оплата ТОВ Google за рекламу' }, 'exp'), 'Оплата ТОВ Google за рекламу');
  assert.equal(recComment({ cpty: 'АТ КБ ПРИВАТБАНК', purpose: 'Плата за обслуговування рахунку' }, 'fee'), 'Комісія банку: Плата за обслуговування рахунку');
  assert.equal(recComment({ cpty: '', purpose: 'Комісія за переказ' }, 'fee'), 'Комісія за переказ');
});

test('ruleHints: комісія банку — «Комісії платіжних систем» за R-COMM-01; поповнення корп. картки — переказ', () => {
  const compiled = R.compileRules(RULES);
  const rec = (text, type) => ({ id: 0, date: '2026-10-20', period: '2026-10-01', created: '2026-10-27', text, comment: text, n_payments: 1, type, category_id: null, operation_id: null,
    project_id: null, account_ids: [5], account_names: ['ФОП Хоменко Приват ГРН'], amount: 15, currency: '', is_lead: false, is_auto: false, is_salary: false });
  const fee = ruleHints(compiled, rec(recComment({ purpose: 'Плата за обслуговування рахунку' }, 'fee'), 'expense'));
  assert.equal(fee.art.art, '76/82');
  assert.match(fee.art.why, /R-COMM-01/);
  assert.equal(fee.transfer, undefined);
  assert.equal(ruleHints(compiled, rec('Поповнення корп картки 3462', 'expense')).transfer, 'R-NP-CORPCARD-01');
  assert.deepEqual(ruleHints(compiled, rec('щось зовсім інше', 'income')), { reasons: [] });
  // Приват пише «Комiсiя» з латинською «i»: це комісія банку, як і «Списання комiсiї на … валютно-обмiнної операцiї»
  const lat = { amount: -3, cpty: 'ЗА ДЕБЕТУВАННЯ РАХУНКУ(UAH)', purpose: 'Комiсiя за виконання платежiв в нацiональнiй валютi у сумi 45000.00 грн вiд 01.10.2026' };
  const fx = { amount: -2496.71, cpty: 'Ком.за в/о (крім, по курсу НБУ з ком)(', purpose: 'Списання комiсiї на здiйснення валютно-обмiнної операцiї вiд 05.10.2026, 37000.00, USD' };
  assert.deepEqual([classify(lat), classify(fx)], [{ src: 'fee' }, { src: 'fee' }]);
  assert.equal(recComment(lat, 'fee'), lat.purpose, 'коментар — як у банку');
  assert.equal(recComment(fx, 'fee'), `Комісія банку: ${fx.purpose}`);
  for (const x of [lat, fx]) assert.equal(ruleHints(compiled, rec(recComment(x, 'fee'), 'expense')).art.art, '76/82');
});

test('histArt: стаття з попередніх записів рахунку з цим контрагентом', () => {
  const items = [{ opc: 2, art: '20/30', comment: 'Google Ads реклама', id: 1 }, { opc: 2, art: '20/30', comment: 'google ads', id: 2 }, { opc: 2, art: '58/53', comment: 'OpenAI API', id: 3 },
    { opc: 1, art: '46/23', comment: 'Google повернення', id: 4 }];
  const h = histArt(items, { cpty: 'Google Ireland Limited', purpose: 'Оплата послуг' }, 2);
  assert.deepEqual([h.art, h.n, h.ex.id], ['20/30', 2, 1]);
  assert.equal(histArt(items, { cpty: 'Нова Пошта', purpose: 'Доставка' }, 2), null);
  // без назви контрагента — слова з призначення
  assert.equal(histArt(items, { cpty: '', purpose: 'OPENAI *CHATGPT SUBSCR' }, 2).art, '58/53');
});

// покупки корп. карткою: контрагент у виписці — транзитний рахунок банку, продавець — у призначенні
const CARD = (id, art, merchant, mk) => ({ id, opc: 2, art, mk: mk || null, comment: `4246 **** **** 3462 02.10.2026 17:33:33 Цифровi товари: ${merchant}` });
const BUYS = [CARD(1, '20/30', 'FACEBK *A1, FACEBOOK.COM', 208), CARD(2, '20/30', 'FACEBK *A2, Dublin', 208), CARD(3, '20/30', 'FACEBK *A3, Dublin', 208),
  CARD(4, '20/30', 'FACEBK *A4, Dublin', 1249), CARD(5, '58/53', 'OPENAI *CHATGPT SUBSCR', null), CARD(6, '58/53', 'OPENAI *CHATGPT SUBSCR', null)];
const buy = merchant => ({ cpty: 'USD валютна позицiя (Compass)', purpose: `4246 **** **** 3462 12.10.2026 11:11:11 Цифровi товари: ${merchant}` });

test('histArt: загальні слова («Цифровi товари» в усіх покупках) не рахуються — стаття за продавцем', () => {
  assert.equal(histArt(BUYS, buy('FACEBK *B7, FACEBOOK.COM'), 2).art, '20/30');
  assert.equal(histArt(BUYS, buy('OPENAI *CHATGPT SUBSCR'), 2).art, '58/53');
  assert.equal(histArt(BUYS, buy('NOTION LABS'), 2), null, 'новий продавець — статтю вибирають');
  // продавець, що є в більшості покупок рахунку («Facebook … FACEBK *…» у коментарях), — теж підказка: слова продавця рахуються завжди
  const FB = (id, art) => ({ id, opc: 2, art, comment: `Facebook 15:44 Татоян Артем, FACEBK *D${id}` });
  const OFTEN = [FB(1, '20/30'), FB(2, '20/30'), FB(3, '20/30'), FB(4, '20/30'), { id: 5, opc: 2, art: '58/53', comment: 'OpenAI 10:00 Татоян Артем' }];
  assert.equal(histArt(OFTEN, buy('FACEBK *22AH55AK24, FACEBOOK.COM'), 2).art, '20/30');
  assert.equal(histArt(OFTEN, buy('NOTION LABS'), 2), null, '«Татоян Артем» у призначенні банку немає — і запису не підказано');
});

test('histMk: маркетолог рекламної статті — найчастіший у схожих записах рахунку; «певний» лише коли він один', () => {
  const m = histMk(BUYS, buy('FACEBK *B7, FACEBOOK.COM'), '20/30');
  assert.deepEqual(m, { id: 208, n: 3, sure: false }, 'три покупки — 208, одна — 1249');
  assert.deepEqual(histMk(BUYS.slice(0, 3), buy('FACEBK *B7'), '20/30'), { id: 208, n: 3, sure: true });
  // інший продавець — найчастіший маркетолог рахунку з цією статтею
  assert.deepEqual(histMk(BUYS, buy('TIKTOK ADS'), '20/30'), { id: 208, n: 3, sure: false });
  assert.equal(histMk(BUYS, buy('FACEBK'), '20/40'), null, 'записів з цією статтею немає');
});

test('довідник карток: хто тримає картку на дату покупки — маркетолог її покупок', () => {
  const card = { last4: '7365', account_id: 90, holders: [{ name: 'Татоян Артем' }, { from: '2026-10-23', name: 'Сидоричев Андрій' }, { from: '2026-10-28', name: 'Симонович Сергій' }] };
  assert.deepEqual(['2026-10-02', '2026-10-23', '2026-10-27', '2026-10-28', '2026-11-05'].map(d => holderOf(card, d).name),
    ['Татоян Артем', 'Сидоричев Андрій', 'Сидоричев Андрій', 'Симонович Сергій', 'Симонович Сергій']);
  assert.equal(holderOf({ holders: [{ from: '2026-11-01', name: 'X' }] }, '2026-10-30'), null, 'до першого власника — нікого');
  const mks = [{ id: 193, name: 'Артем Татоян' }, { id: 1324, name: 'Сергій Симонович' }, { id: 1328, name: 'Андрій Сидоричев' }, { id: 7, name: 'Олена Сидоричева' }];
  assert.deepEqual(['Татоян Артем', 'Сидоричев Андрій', 'Симонович Сергій', 'Хтось Новий'].map(n => mkByName(mks, n)), [193, 1328, 1324, null]);
});

test('закриті в CRM місяці не звіряються: «з» — з першого відкритого дня, увесь закритий період — null', () => {
  assert.deepEqual(clampToOpen('2026-10-20', '2026-11-05', '2026-10'), { from: '2026-11-01', to: '2026-11-05', cut: '2026-11-01' });
  assert.equal(clampToOpen('2026-10-01', '2026-10-31', '2026-10'), null);
  assert.deepEqual(clampToOpen('2026-11-02', '2026-11-05', '2026-10'), { from: '2026-11-02', to: '2026-11-05', cut: null });
  assert.deepEqual(clampToOpen('2026-10-01', '2026-10-31', null), { from: '2026-10-01', to: '2026-10-31', cut: null });
});
test('правило R-NP-CORPCARD-01 і нові назви: на рахунку самої картки («корп. картка …») поповнення — не переказ', () => {
  const c = R.compileRules(RULES);
  const rec = acc => ({ id: 1, date: '2026-10-29', period: '2026-10-01', created: '2026-10-29', type: 'expense', category_id: 59, operation_id: 55, project_id: 1, n_payments: 1,
    text: 'Поповнення корп картки 7365 на рекламу', comment: 'Поповнення корп картки 7365 на рекламу', account_ids: [1], account_names: [acc], amount: 1000, currency: 'UAH', is_lead: false, is_auto: false, is_salary: false });
  const xfer = acc => { const res = R.evaluate(rec(acc), c); return !!(res && res.applicable.some(r => r.id === 'R-NP-CORPCARD-01' && r.set.type === 'transfer')); };
  assert.equal(xfer('ФОП Мазовецька Корнелія Олександрівна Приват'), true);
  assert.equal(xfer('корп. картка 7365 ФОП Мазовецька Корнелія Олександрівна'), false);
  assert.equal(xfer('майбутня корп карта ФОП Мазовецька Корнелія Олександрівна'), false);
  assert.equal(xfer('corpCard №5 ФОП Мазовецька_UAH_2044'), false);
  assert.equal(RULES.reference.cards.find(x => x.last4 === '7365').account_id, 90, 'картка 7365 — рахунок ID 90 «корп. картка 7365 …»');
});
test('закриття місяця: межі місяця, місяць за замовчуванням', () => {
  assert.deepEqual(monthBounds('2026-10', '2026-10-30'), { from: '2026-10-01', last: '2026-10-31', to: '2026-10-30', full: false });
  assert.deepEqual(monthBounds('2026-10', '2026-11-03'), { from: '2026-10-01', last: '2026-10-31', to: '2026-10-31', full: true });
  assert.deepEqual(monthBounds('2026-12', '2027-01-02'), { from: '2026-12-01', last: '2026-12-31', to: '2026-12-31', full: true });
  assert.equal(monthBounds('2028-02', '2028-03-15').last, '2028-02-29');
  assert.deepEqual(['2026-10-30', '2026-11-03', '2026-11-10', '2026-11-11', '2027-01-05'].map(defaultMonth), ['2026-10', '2026-10', '2026-10', '2026-11', '2026-12']);
});

test('закриття місяця: висновок — усе гаразд, є що зробити, не все перевірено', () => {
  const acc = (id, name, status, o) => ({ a: { id, name }, status, b: status === 'none' ? null : { rows: [] }, manual: undefined,
    R: { crm: { n: 3 }, covered: status !== 'none' && status !== 'part', diff: { close: 0 }, missing: { bank: [], crm: [] }, own: { xfers: [], maybe: [] }, ...(o || {}) } });
  const okAll = [acc(1, 'Приват ТОВ … 8112', 'ok'), acc(68, 'ФОП Хоменко … Приват', 'timing'), acc(89, 'корп. картка 3462 …', 'merged'),
    { ...acc(14, 'НеАктуальний ФОП …', 'none'), b: null, R: { crm: { n: 0 }, covered: false, diff: null } }];
  const reg = { from: '2026-10-01', to: '2026-10-31', open: [], check: [] }, lint = { checked: 1200, counts: { ok: 900, 'locked-auto': 4 } };
  // виводи з балансу: погодження «% м-ра» 15.10 і вивід 16.10 на ту саму суму
  const wdItem = (id, name, amount, date) => WD.parseWithdrawal({ id, date, acc: 33, amount: -amount, opc: 2, comment: `Підтвердження виведення коштів з балансу менеджера ${name} від ${date.split('-').reverse().join('.')} по проекту Україна на суму ${amount}.00 грн` });
  const wdAp = (key, date, rec, text, a) => WD.parseApproval({ key, date, recipient: rec, content: text, textAmount: a });
  const wdOk = WD.summary(WD.match([wdAp('a', '2026-10-15', 'Цвях Богдан', '% менеджера Цвях за період з 05-11.10', 2170)], [wdItem(1, 'Цвях Богдан', 2170, '2026-10-16')]), '2026-10-01', '2026-10-31');
  const ready = closeReport(okAll, { types: [], lint, reg, wd: wdOk });
  assert.equal(ready.verdict, 'ready');
  assert.deepEqual(ready.items.map(i => [i.key, i.ok]), [['reg', true], ['wd', true], ['bank', true], ['own', true], ['type', true], ['crm', true], ['bal', true], ['lint', true]]);
  assert.match(plain(ready.items.find(i => i.key === 'wd').text), /погоджень: 1 — усі виведено \(2 170,00\)/);
  assert.match(ready.items.find(i => i.key === 'bal').text, /сходиться 2 з 2/, 'corpCard, зведений з рахунком, і рахунок без руху не рахуються');
  // поповнення не на ту корп. картку власника — теж «Виправити»
  const rp = closeReport(okAll, { types: [], repoints: [{ date: '2026-11-04', amount: 4719, item: { id: 26133 }, line: 'на картку 7850 замість 4546' }], lint, reg, wd: wdOk });
  const ti = rp.items.find(i => i.key === 'type');
  assert.deepEqual([rp.verdict, ti.ok], ['not', false]);
  assert.match(ti.text, /^поповнення не на ту корп\. картку: 1 — розділ «Виправити»$/);
  assert.deepEqual(ti.list.map(plain), ['04.11.2026 · ID 26133 · 4 719,00 · на картку 7850 замість 4546']);
  // є що зробити: операція банку без запису, переказ без пари, неправильний тип, розбіжність залишку, правила, невнесене погодження
  const x = { date: '2026-10-15', amount: -1500, cpty: 'Постачальник', purpose: 'оплата' };
  const tp = { id: 900074, date: '2026-10-15', amount: -1600, comment: 'Поповнення корп каркти' }; // поповнення картки витратою — лише в «Типах записів»
  const bad = [{ ...acc(1, 'Приват ТОВ … 8112', 'bad', { diff: { close: -1500 }, missing: { bank: [x], crm: [tp] }, own: { xfers: [{ state: 'missing', row: { date: '2026-10-20', amount: -2000 } }], maybe: [] } }), topups: [tp] },
    acc(43, 'ФОП Житинська … Універсал', 'none'), acc(70, 'ФОП Мартиненко … Приват', 'ok')];
  const types = [{ date: '2026-10-15', amount: 1600, item: { id: 900074 }, why: 'поповнення корп. картки записано витратою' }, { date: '2026-10-02', amount: 50, item: { id: 5 }, why: 'x', block: 'запис з ліда' }];
  // виводи: погодження без виводу і вивід без погодження
  const wdBad = WD.summary(WD.match([wdAp('b', '2026-10-01', 'Сидорук Тарас', '% менеджера Сидорук за період з 21-27.09', 8188)], [wdItem(2, 'Нова Особа', 5000, '2026-10-21')]), '2026-10-01', '2026-10-31');
  const not = closeReport(bad, { types, lint: { checked: 1200, counts: { fix: 3, review: 1 } }, reg: { ...reg, open: [{ date: '2026-10-29', recipient: 'Клод', amount: 4600, action: 'так' }], check: [] }, wd: wdBad, today: '2026-11-03' });
  assert.equal(not.verdict, 'not');
  const it = k => not.items.find(i => i.key === k);
  assert.deepEqual(not.items.filter(i => i.ok === false).map(i => i.key), ['reg', 'wd', 'bank', 'own', 'type', 'bal', 'lint']);
  assert.deepEqual(not.items.filter(i => i.ok === false).map(i => i.fail), ['невнесені погодження', 'виводи з балансу', 'операції банку без запису в CRM', 'перекази між своїми', 'записи з неправильним типом', 'розбіжності залишків', 'статті й проєкти']);
  assert.match(it('wd').text, /виводу немає: 1, виводів без погодження: 1 — розділ «Виводи з балансу»/);
  assert.deepEqual(it('wd').list.map(plain), ['01.10.2026 · Сидорук Тарас · 8 188,00 · виводу немає', '21.10.2026 · Нова Особа · 5 000,00 · без погодження · ID 2']);
  assert.equal(it('crm').ok, true, 'поповнення картки, записане витратою, — не «запис без операції в банку»');
  assert.match(it('reg').text, /не внесено: 1/);
  assert.equal(it('reg').list.length, 1);
  assert.match(plain(it('reg').list[0]), /^29\.10\.2026 · Клод · 4 600,00$/);
  assert.match(it('bank').text, /немає в CRM: 1/);
  assert.match(it('type').text, /2 \(1 змінить лінтер, 1 — лише вручну в CRM\)/);
  assert.match(plain(it('bal').list.join('|')), /Приват ТОВ … 8112: на кінець CRM − банк = -1 500,00\|ФОП Житинська … Універсал: немає виписки/);
  assert.match(it('lint').text, /виправити: 3, перевірити: 1/);
  // не все перевірено: немає реєстру в браузері, не вдалася перевірка правил, рахунок без виписки — без розбіжностей
  const partial = closeReport([acc(70, 'ФОП Мартиненко … Приват', 'ok'), acc(43, 'ФОП Житинська … Універсал', 'none')], { types: [], lint: { error: 'немає мережі' }, reg: null, wd: null });
  assert.equal(partial.verdict, 'partial');
  assert.deepEqual(partial.items.filter(i => i.ok === null).map(i => i.key), ['reg', 'wd', 'bal', 'lint']);
  assert.match(partial.items.find(i => i.key === 'wd').text, /реєстр погоджень у цьому браузері не налаштовано/);
  // кілька наборів виводів дають суму погодження — не перевірено (а не «є що зробити»)
  const amb = closeReport(okAll, { types: [], lint, reg, wd: { ...wdOk, ok: 0, ambig: 1, bad: [{ a: { date: '2026-10-08', recipient: 'Малигин', amount: 40000 }, status: 'ambig', items: [], cands: [], sum: 0 }] } });
  assert.deepEqual([amb.verdict, amb.items.find(i => i.key === 'wd').ok], ['partial', null]);
  // свіже погодження без виводу («чекаємо») — не помилка, але й не «усе виведено»: місяць ще не перевірено до кінця
  const wait = closeReport(okAll, { types: [], lint, reg, wd: { ...wdOk, wait: 1, bad: [{ a: { date: '2026-10-31', recipient: 'Цвях Богдан', amount: 2170 }, status: 'wait', items: [], cands: [], sum: 0 }] }, today: '2026-11-01' });
  const wi = wait.items.find(i => i.key === 'wd');
  assert.deepEqual([wait.verdict, wi.ok], ['partial', null]);
  assert.match(wi.text, /чекаємо вивід \(свіже погодження\): 1/);
  // виписок немає зовсім (Помічник не відповів) — операції банку не перевірено
  const none = closeReport([acc(43, 'ФОП Житинська … Універсал', 'none')], { types: [], lint, reg, wd: wdOk, noHelper: true });
  assert.deepEqual(none.items.filter(i => i.ok === null).map(i => i.key), ['bank', 'own', 'crm', 'bal']);
  assert.match(none.items.find(i => i.key === 'bal').text, /Помічник кешфлоу» не відповів/);
});

test('плитки звірки: рахунки сходяться / з розбіжністю / без даних банку; «схоже на переказ» і поповнення картки витратою — не двічі', () => {
  const acc = (id, name, status, o) => ({ a: { id, name }, status, b: status === 'none' ? null : { rows: [] }, manual: undefined,
    R: { crm: { n: 3 }, covered: status !== 'none' && status !== 'part', diff: { close: 0 }, missing: { bank: [], crm: [] }, own: { xfers: [], maybe: [] }, ...(o || {}) } });
  const x = { date: '2026-10-15', amount: -1500 }, y = { date: '2026-10-16', amount: -700 }, tp = { id: 900074, amount: -1600 }, c = { id: 900075, amount: -90 };
  const all = [
    { ...acc(1, 'Приват ТОВ … 8112', 'bad', { missing: { bank: [x, y], crm: [tp, c] }, own: { xfers: [{ state: 'missing' }, { state: 'type' }], maybe: [{ row: y }] } }), topups: [tp] },
    acc(68, 'ФОП Хоменко … Приват', 'timing'), acc(89, 'корп. картка 3462 …', 'merged'), acc(43, 'ФОП Житинська … Універсал', 'none'),
    { ...acc(14, 'НеАктуальний ФОП …', 'none'), b: null, R: { crm: { n: 0 }, covered: false } }];
  assert.deepEqual(bankSummary(all, [{}, {}], [{ last4: '4079' }], [{}]), { accs: 3, good: 1, bad: 1, unk: 1, covered: 2, missB: 1, missC: 1, own: 2, topup: 0, types: 2, cards: 1, reps: 1 });
  assert.deepEqual(bankSummary([], null, null), { accs: 0, good: 0, bad: 0, unk: 0, covered: 0, missB: 0, missC: 0, own: 0, topup: 0, types: 0, cards: 0, reps: 0 });
  // corpCard у мінусі в CRM — пропозиція поповнення: плитка переказів її рахує (раніше показувала 0 при трьох пропозиціях)
  all[2] = { ...all[2], a: { id: 89, name: 'корп. картка 3462 …', balance: -1250.5 } };
  assert.equal(bankSummary(all, [], []).topup, 1);
});

test('сховані рахунки: неактуальні за назвою — самі (і перейменовані пізніше), якщо людина не показала їх; вибір людини — як був', () => {
  const accs = [{ id: 14, name: 'НеАктуальний ФОП Тихоненко … Приват' }, { id: 74, name: '1 ГРН Маркет Приват ТОВ (видалити)' }, { id: 78, name: 'Not actual Ukraine' },
    { id: 33, name: 'Приват ТОВ ПРИКЛАД СЕРВІС 5608' }, { id: 87, name: 'корп. картка 1665 ТОВ …' }];
  assert.deepEqual([...hiddenAccs(accs, [], [])].sort((a, b) => a - b), [14, 74, 78]);
  assert.deepEqual([...hiddenAccs(accs, [87], [78])].sort((a, b) => a - b), [14, 74, 87], 'показаний людиною неактуальний — видно; сховане людиною — сховано');
  assert.ok(OFF_ACC.test('НеАктуальний 1 ГРН Польша Ісаєв Є. ФОП') && !OFF_ACC.test('Актуальний рахунок'));
});

// покупки корп. карткою: маркетолога в списку записів CRM немає — він в імені в коментарі (так пишуть у CRM)
const MKS = [{ id: 1335, name: 'Ларіоненко Тимур' }, { id: 1235, name: 'Дмитро Миколаївський' }, { id: 195, name: 'Євген Сливко' }, { id: 410, name: 'СЛИВКО ПАРТНЕРИ | TRAFFZONE' },
  { id: 1352, name: 'Сидоричев Андрій' }];
test('маркетолог з коментаря: усі слова імені в будь-якому порядку й відмінку, лише один такий маркетолог', () => {
  assert.equal(mkInComment(MKS, 'Facebook 30.10 Ларіоненко Тимур (тест США): 5000.00 UAH з подвійною конвертацією = 5037.61 UAH, корп. картка 7850'), 1335);
  assert.equal(mkInComment(MKS, 'Facebook 01.11 Миколаївський Дмитро (тест США): 1200.00 UAH, корп. картка 3462'), 1235, 'прізвище й ім\'я в іншому порядку, ніж у CRM');
  assert.equal(mkInComment(MKS, 'реклама Сливка Євгена'), 195, 'відмінок; «СЛИВКО ПАРТНЕРИ» — не всі слова');
  assert.equal(mkInComment(MKS, 'Google Ads 19:32 Сидоричев (реінвест Україна)'), null, 'лише прізвище — не певно');
  assert.equal(mkInComment(MKS, 'USD валютна позицiя (Compass, ISS1): 4246 **** **** 3462 01.11.2026 10:00:00 Цифровi товари: FACEBK *Q1, FACEBOOK.COM'), null);
  assert.equal(mkInComment(null, 'Ларіоненко Тимур'), null, 'список маркетологів ще не прочитано');
});

const fbBuy = (date, time) => ({ date, cpty: 'USD валютна позицiя (Compass, ISS1)', purpose: `4246 **** **** 3462 ${date.split('-').reverse().join('.')} ${time} Цифровi товари: FACEBK *ZX${time.slice(0, 2)}, FACEBOOK.COM` });
const HIST = [
  { id: 25100, date: '2026-10-10', opc: 2, art: '20/41', proj: 1, comment: 'Facebook 10.10 Сидоричев Андрій (тест Україна): 900.00 UAH, корп. картка 3462' },
  { id: 25600, date: '2026-10-29', opc: 2, art: '20/41', proj: 4, comment: 'Facebook 29.10 Миколаївський Дмитро (тест США): 1500.00 UAH, корп. картка 3462, залишок 2000.00' },
  { id: 25700, date: '2026-10-31', opc: 2, art: '20/41', proj: 4, comment: 'Facebook 31.10 Миколаївський Дмитро (тест США): 2500.00 UAH, корп. картка 3462' },
  { id: 25975, date: '2026-11-03', opc: 2, art: '20/41', proj: 1, comment: 'USD валютна позицiя (Compass, ISS1): 4246 **** **** 3462 03.11.2026 09:00:00 Цифровi товари: FACEBK *Q1, FACEBOOK.COM' },
  { id: 25200, date: '2026-10-15', opc: 2, art: '58/53', proj: 1, comment: 'OpenAI 15.10 Татоян Артем (підписка): 20.00 USD = 830.00 UAH, корп. картка 3462' },
];
test('histMk: маркетолог з імені в коментарі, найближчі за датою записи (картку передали іншому маркетологу)', () => {
  assert.equal(histMk(HIST, fbBuy('2026-11-02', '17:33:33'), '20/41'), null, 'без списку маркетологів імен не розпізнати, а в списку записів CRM маркетолога немає');
  assert.deepEqual(histMk(HIST, fbBuy('2026-11-02', '17:33:33'), '20/41', MKS), { id: 1235, n: 2, sure: false }, 'два найближчі — Миколаївський, давніший — Сидоричев');
  assert.deepEqual(histMk(HIST.slice(1), fbBuy('2026-11-02', '17:33:33'), '20/41', MKS), { id: 1235, n: 2, sure: true });
  assert.deepEqual(histMk(HIST, fbBuy('2026-10-11', '08:00:00'), '20/41', MKS), { id: 1235, n: 2, sure: false }, 'рахуються до 5 найближчих — більшість');
  assert.deepEqual(histMk([HIST[0], HIST[2]], fbBuy('2026-10-11', '08:00:00'), '20/41', MKS), { id: 1352, n: 1, sure: false }, 'порівну — того, чий запис ближчий');
});

test('покупка карткою: коментар як у CRM — сервіс, дата й час покупки, маркетолог, мета, сума, картка; проєкт і мета — зі схожого запису', () => {
  const x = fbBuy('2026-11-02', '17:33:33');
  const ref = histRef(HIST, x, '20/41', 1235, MKS);
  assert.equal(ref.id, 25700, 'найближчий схожий запис з цим маркетологом і статтею');
  assert.deepEqual(refParts(ref.comment), { svc: 'Facebook', who: 'Миколаївський Дмитро', what: 'тест США' });
  const o = { who: 'Дмитро Миколаївський', sameWho: w => mkInComment([{ id: 1, name: 'Дмитро Миколаївський' }], w) === 1, art: '20/41', proj: 4, projName: 'США', ccy: 'UAH', amount: 1234.5, ref };
  assert.equal(cardComment(x, o), 'Facebook 02.11 17:33 Миколаївський Дмитро (тест США): 1234.50 UAH, корп. картка 3462', 'ім\'я — як написано в зразку');
  assert.equal(cardComment(x, { ...o, proj: 1, projName: 'Україна' }), 'Facebook 02.11 17:33 Миколаївський Дмитро (тест Україна): 1234.50 UAH, корп. картка 3462', 'інший проєкт — мета зі статті й проєкту');
  assert.equal(cardComment(x, { ...o, ref: null, who: '' }), 'Facebook 02.11 17:33 (тест США): 1234.50 UAH, корп. картка 3462', 'маркетолога ще не вибрано');
  const g = { cpty: 'USD валютна позицiя (Compass, ISS1)', date: '2026-11-03', purpose: '4246 **** **** 7365 03.11.2026 19:32:10 Цифровi товари: GOOGLE *ADS5510633184, cc§google.com' };
  assert.equal(cardComment(g, { who: 'Сергій Симонович', art: '20/30', proj: 4, projName: 'США', ccy: 'UAH', amount: 4000 }), 'Google Ads 03.11 19:32 Сергій Симонович (реінвест США): 4000.00 UAH, корп. картка 7365');
  const n = { date: '2026-11-03', purpose: '4246 **** **** 3462 03.11.2026 08:15:00 Цифровi товари: NOTION LABS, SAN FRANCISCO' };
  assert.equal(cardComment(n, { who: 'Татоян Артем', art: '58/53', proj: 1, projName: 'Україна', ccy: 'UAH', amount: 400 }), 'Notion Labs 03.11 08:15 Татоян Артем: 400.00 UAH, корп. картка 3462', 'не реклама — без слова статті');
  assert.equal(refParts('USD валютна позицiя (Compass, ISS1): 4246 **** **** 3462 03.11.2026 09:00:00 Цифровi товари: FACEBK'), null, 'коментар з виписки — не зразок');
  assert.deepEqual(refParts('Hetzner Online (сервер) 14:06 Татоян Артем (розхідники PrykladM): 37.30 USD = 1711.01 UAH, корп. картка 7365'), { svc: 'Hetzner Online (сервер)', who: 'Татоян Артем', what: 'розхідники PrykladM' });
  assert.equal(histRef(HIST, x, '20/41', 1335, MKS), null, 'у цього маркетолога схожих записів немає');
});

test('нові корп. картки у виписці: невідомий номер, підказка рахунку за записами CRM, без покупок у CRM — картка без номера, якої не взяла інша', () => {
  const ACC = [[97, 'Приват ТОВ СЕРВІС МАРКЕТ 1437'], [98, 'Приват ТОВ СЕРВІС МАРКЕТ 8296'], [68, 'ФОП Хоменко Всеволод Сергійович Приват'],
    [84, 'корп. картка ТОВ СЕРВІС МАРКЕТ'], [87, 'корп. картка 1665 ТОВ СЕРВІС МАРКЕТ'], [88, 'корп. картка 2474 ТОВ СЕРВІС МАРКЕТ'],
    [89, 'корп. картка 3462 ФОП Хоменко Всеволод Сергійович']].map(([id, name]) => ({ id, name, currency_id: 1 }));
  const known = Rc.cardTails(ACC, null, RULES.reference.cards);
  const buy = (date, amount, last4, d, what) => ({ date, amount, purpose: `4246 **** **** ${last4} ${d.split('-').reverse().join('.')} 10:00:00 Цифровi товари: ${what}, +14152360590` });
  const banks = [
    // як у живих виписках жовтня 2026: …4079 на …8296 (у реєстрі — картка №1, рахунок 84 без номера), нова картка на …1437 (у CRM покупок немає;
    // тоді це була …5802 — з 06.11.2026 вона в rules.json, тож тут вигаданий номер …5793)
    { cfId: 98, rows: [buy('2026-10-01', -3770.59, '4079', '2026-09-29', 'ANTHROPIC* CLAUDE SUB'), buy('2026-10-04', -7203.62, '4079', '2026-10-02', 'PRYKLAD M'), buy('2026-10-14', -20814.48, '4079', '2026-10-13', 'FACEBK *X1')] },
    { cfId: 97, rows: [buy('2026-10-16', -1959.73, '5793', '2026-10-15', 'FACEBK *EJA3XAEMG4'), buy('2026-10-16', -755.17, '5793', '2026-10-15', 'FACEBK *MLZU3CAMG4'),
      buy('2026-10-16', -1959.73, '5793', '2026-10-15', 'FACEBK *EJA3XAEMG4')] }, // той самий рядок удруге (дві виписки) — не рахується
    { cfId: 68, rows: [buy('2026-10-10', -500, '3462', '2026-10-09', 'FACEBK *K'), { date: '2026-10-21', amount: -1350, purpose: '5363 **** **** 3912 Переказ власних коштів' }] },
    { cfId: null, rows: [buy('2026-10-05', -10, '9999', '2026-10-04', 'X')] }, // рахунок банку не зіставлено з CRM
  ];
  const items = new Map([[84, [{ opc: 2, amount: -3770.59, date: '2026-09-30' }, { opc: 2, amount: -7203.62, date: '2026-10-02' }]], [87, [{ opc: 2, amount: -7203.62, date: '2026-10-01' }]]]);
  const out = findNewCards({ banks, known, items, accs: ACC, from: '2026-10-01', to: '2026-10-30' });
  assert.deepEqual(out.map(c => [c.last4, c.debit, c.rows.length, c.sum, c.from, c.to, c.sug && c.sug.id]), [
    ['4079', 98, 3, -31788.69, '2026-10-01', '2026-10-14', 84], // 84: 2 з 3 покупок, 87 — лише 1
    ['5793', 97, 2, -2714.9, '2026-10-16', '2026-10-16', null], // у CRM покупок немає; 84 уже взяла …4079 — не підказується
  ]);
  assert.equal(out[0].sug.why, 'у CRM на цей рахунок записано 2 з 3 покупок');
  assert.deepEqual(out[0].cands.map(a => a.id), [84, 87, 88], 'лише корп. картки власника рахунку банку (ТОВ СЕРВІС МАРКЕТ)');
  // без покупок у CRM і без іншої нової картки — єдина картка власника без номера в назві
  const one = findNewCards({ banks: [banks[1]], known, items: new Map(), accs: ACC, from: '2026-10-01', to: '2026-10-30' });
  assert.deepEqual(one[0].sug, { id: 84, why: 'єдина корп. картка власника без номера в назві' });
  assert.deepEqual(['4246 **** **** 1665 02.10.2026 04:28:07 Цифровi товари: FACEBK *22AH55AK24, FACEBOOK.COM', '4246 **** **** 4079 02.10.2026 16:27:02 Послуги: PRYKLAD M, +10000000113',
    '4246 **** **** 4079 29.09.2026 18:02:46 Цифровi товари: ANTHROPIC* CLAUDE SUB, +1415236059'].map(merchantOf), ['FACEBK', 'PRYKLAD M', 'ANTHROPIC']);
});

test('запам\'ятані в цьому браузері корп. картки — до довідника; картка з rules.json з тим самим номером сильніша', () => {
  const store = new Map([['cfl_cards_local', JSON.stringify([{ last4: '4079', account_id: 84, debit_account_id: 98 }, { last4: '7365', account_id: 94 }, { last4: 'x', account_id: 1 }])]]);
  globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  try {
    const doc = JSON.parse(JSON.stringify(RULES));
    const added = mergeLocalCards(doc);
    assert.deepEqual(added.map(c => c.last4), ['4079']);
    assert.deepEqual(doc.reference.cards.map(c => [c.last4, c.account_id, !!c.local]), [['7365', 90, false], ['4546', 104, false], ['7850', 91, false], ['3462', 89, false], ['4323', 102, false], ['2804', 92, false], ['5802', 101, false], ['4079', 84, true]]);
    assert.equal(Rc.cardTails([], null, doc.reference.cards)['4079'], 84);
  } finally { delete globalThis.localStorage; }
});
test('поповнення не на ту картку власника: номер чи тримач у коментарі; за випискою — після поповнення платить лише інша картка', () => {
  const tails = { 7850: 91, 4546: 104, 3462: 89 };
  const holders = [{ last4: '4546', account_id: 104, holders: [{ from: '2026-11-04', name: 'Сидоричев Андрій' }] }];
  const cards = [{ id: 91, last4: '7850', balance: 9000 }, { id: 104, last4: '4546', balance: -2500 }];
  const t = (id, date, amount, comment, peer = 91) => ({ id, date, amount: -amount, opc: 4, peer, comment });
  const buy = (date, amount, last4, d) => ({ date, amount: -amount, purpose: `5169 **** **** ${last4} ${d.split('-').reverse().join('.')} 10:00:00 Цифровi товари: FACEBK *X, FACEBOOK.COM` });
  // Приват: самого поповнення в банку немає — лише покупки з номером картки (7850 — до 04.11, далі платить лише 4546)
  const rows = [buy('2026-11-03', 700, '7850', '2026-11-02'), buy('2026-11-06', 1000, '4546', '2026-11-05'), buy('2026-11-07', 1500, '4546', '2026-11-06')];
  const xfers = [
    t(1, '2026-11-04', 4719, 'Тимур Ларіоненко: реінвест за 03.11 на корп картку - США'),  // коментар нічого не каже — за випискою
    t(2, '2026-11-04', 3000, 'Андрій Сидоричев: поповнення корп картки на тестування'),    // тримач 4546 з 04.11 (rules.json)
    t(3, '2026-11-05', 1000, 'поповнення корп картки 4546'),                                // номер іншої картки
    t(4, '2026-11-05', 500, 'поповнення корп картки 7850'),                                 // номер саме цієї — правильне
    t(5, '2026-11-02', 800, 'Тимур Ларіоненко: реінвест'),                                   // після 02.11 карткою 7850 платили — правильне
    t(6, '2026-11-05', 2000, 'Андрій Сидоричев: поповнення', 104),                           // уже на картці тримача
  ];
  const out = wrongTopups({ xfers, cards, tails, holders, rows, fileFrom: '2026-11-01' });
  assert.deepEqual(out.map(f => [f.item.id, f.was, f.to, f.how]), [[1, 91, 104, 'bank'], [2, 91, 104, 'holder'], [3, 91, 104, 'num']]);
  assert.deepEqual(out[0].spent, { n: 2, sum: 2500 });
  assert.deepEqual([out[1].holder.name, out[1].holder.from, out[2].num], ['Сидоричев Андрій', '2026-11-04', '4546']);
  const only = (o, ids) => wrongTopups({ xfers: xfers.filter(x => ids.includes(x.id)), cards, tails, holders, rows, fileFrom: '2026-11-01', ...o }).map(f => f.item.id);
  // за випискою — ні, якщо: виписка не покриває день поповнення; стара картка теж платила після нього; на ній поповнення вже витрачено;
  // нова картка в CRM не в мінусі; у власника одна картка
  assert.deepEqual(only({ fileFrom: '2026-11-05' }, [1]), []);
  assert.deepEqual(only({ rows: [...rows, buy('2026-11-06', 300, '7850', '2026-11-05')] }, [1]), []);
  assert.deepEqual(only({ cards: [{ ...cards[0], balance: 3000 }, cards[1]] }, [1]), []);
  assert.deepEqual(only({ cards: [cards[0], { ...cards[1], balance: 0 }] }, [1]), []);
  assert.deepEqual(only({ cards: [cards[0]] }, [1, 2, 3]), []);
  assert.deepEqual(only({ rows: null }, [1, 2, 3]), [2, 3], 'без виписки — лише за коментарем');
  // картки іншого власника в коментарі не беруться (cards — лише діючі картки власника рахунку)
  assert.deepEqual(only({}, []).concat(wrongTopups({ xfers: [t(7, '2026-11-05', 100, 'поповнення корп картки 3462')], cards, tails, holders, rows: null }).map(f => f.item.id)), []);
});
// ---------- виправлення за оглядом 07.11.2026 ----------
const BP = require('../ui/bank-panel.js');

test('R2: «Погашення простроченої заборгованості за РКО» — комісія банку з «Комісія банку:»', () => {
  const x = { amount: -408.39, cpty: 'ПАТ КБ ПРИВАТБАНК', purpose: 'Погашення простроченої заборгованостi за РКО' }; // латинська «i», як у Привату
  assert.deepEqual(classify(x), { src: 'fee' });
  assert.equal(recComment(x, 'fee'), `Комісія банку: ${x.purpose}`);
  assert.deepEqual(classify({ amount: -5, purpose: 'Комісія за розрахунково-касове обслуговування за жовтень' }), { src: 'fee' });
  assert.deepEqual(classify({ amount: -100, purpose: 'Погашення кредиту' }), { src: 'exp' });
});

test('M2: laterBank — файл, що покриває період; рівно — завантажений пізніше', () => {
  const A = { fileFrom: '2026-11-01', fileTo: '2026-11-07', n: 'ранок' }, B = { fileFrom: '2026-11-07', fileTo: '2026-11-07', n: 'вечір' };
  assert.equal(BP.laterBank(B, A, '2026-11-07', '2026-11-07'), true, 'обидва покривають, кінець той самий — новіший');
  assert.equal(BP.laterBank(A, null, '2026-11-07', '2026-11-07'), true);
  assert.equal(BP.laterBank(B, A, '2026-11-01', '2026-11-07'), false, 'B не покриває місяця');
  assert.equal(BP.laterBank({ fileFrom: '2026-11-01', fileTo: '2026-11-08' }, A, '2026-11-07', '2026-11-07'), true, 'закінчується пізніше');
  assert.equal(BP.laterBank({ fileFrom: '2026-11-01', fileTo: '2026-11-06' }, A, '2026-11-07', '2026-11-07'), false);
  // як вибирає bankFor: прохід у порядку завантаження
  const pick = (list, f, t) => list.reduce((cur, x) => (BP.laterBank(x, cur, f, t) ? x : cur), null).n;
  assert.equal(pick([A, B], '2026-11-07', '2026-11-07'), 'вечір');
  assert.equal(pick([A, B], '2026-11-03', '2026-11-05'), 'ранок');
});

test('U2: що не вивантажено — з журналу privat_fetch.py, і що робити', () => {
  const log = ['== ФОП Хоменко', '  Приват: 12 рахунків', '  Моно: ПОМИЛКА: HTTP 403', 'Файл: виписка_ВСІ_07.11.2026_07.11.2026.json', 'НЕ вивантажено:', '  ФОП Хоменко (Моно): HTTP 403 Forbidden', '  ТОВ ПРИКЛАД (Приват): timed out'];
  assert.deepEqual(BP.notFetched(log), ['ФОП Хоменко (Моно): HTTP 403 Forbidden', 'ТОВ ПРИКЛАД (Приват): timed out']);
  assert.deepEqual(BP.notFetched(['усе гаразд']), []);
  const t = BP.partialFetchText(log, 1);
  assert.match(t, /Не вивантажено: ФОП Хоменко \(Моно\): HTTP 403 Forbidden; ТОВ ПРИКЛАД \(Приват\): timed out\./);
  assert.match(t, /решту — звірено/);
  assert.match(t, /«Вивантажити заново»/);
  assert.match(BP.partialFetchText([], 1), /див\. журнал вище/);
});

test('W1: переказ, рух якого вже є в CRM записом іншого типу, — не пропонується', () => {
  const p = { from: 1, to: 2, amount: 10000, date: '2026-11-05' };
  const A = [{ id: 11, opc: 2, amount: -10000, date: '2026-11-04' }], B = [{ id: 21, opc: 1, amount: 10000, date: '2026-11-06' }];
  assert.equal(BP.xferOtherType(p, A, []).id, 11, 'витрата на «звідки»');
  assert.equal(BP.xferOtherType(p, [], B).id, 21, 'надходження на «куди»');
  assert.equal(BP.xferOtherType(p, [{ ...A[0], date: '2026-11-01' }], []), null, 'понад 3 дні');
  assert.equal(BP.xferOtherType(p, [{ ...A[0], amount: -9999 }], []), null, 'інша сума');
  assert.equal(BP.xferOtherType(p, [{ ...A[0], opc: 4 }], [{ ...B[0], opc: 2 }]), null, 'переказ і не той знак — ні');
});

test('W4 / W1: xferCheck — «вже є» лише коли в CRM стільки ж переказів, скільки у виписці; витрата на «звідки» — стоп', () => {
  const tr = (id, date) => ({ id, date: `${date}T10:00:00Z`, payments: [{ invoice_id: 1, operation: 4, amount: '50000.00' }, { invoice_id: 2, operation: 3, amount: '50000.00' }] });
  const exp = id => ({ id, date: '2026-11-04T10:00:00Z', payments: [{ invoice_id: 1, operation: 2, amount: '50000.00' }] });
  const d = s => s.slice(0, 10);
  const p = { from: 1, to: 2, peers: 2 };
  assert.equal(BP.xferCheck([tr(5, '2026-11-03')], p, 50000, new Set([5]), d), null, 'два перекази в банку, один у CRM — створювати');
  const both = BP.xferCheck([tr(5, '2026-11-03'), tr(6, '2026-11-05')], p, 50000, new Set([5, 6]), d);
  assert.equal(both.result, 'вже є');
  assert.equal(BP.xferCheck([tr(5, '2026-11-03')], { from: 1, to: 2, peers: 1 }, 50000, new Set([5]), d).result, 'вже є');
  const e = BP.xferCheck([exp(7)], { from: 1, to: 2, peers: 1 }, 50000, new Set([7]), d);
  assert.equal(e.result, 'перевірте', 'витрата відома звірці — однаково стоп');
  assert.match(e.note, /ID 7.*«Записи з неправильним типом»/);
  const out = { id: 8, date: '2026-11-04T10:00:00Z', payments: [{ invoice_id: 1, operation: 4, amount: '50000.00' }, { invoice_id: 3, operation: 3, amount: '50000.00' }] };
  assert.equal(BP.xferCheck([out], { from: 1, to: 2, peers: 1 }, 50000, new Set(), d).result, 'перевірте', 'новий переказ на інший рахунок після звірки');
  assert.equal(BP.xferCheck([out], { from: 1, to: 2, peers: 1 }, 50000, new Set([8]), d), null, 'відомий переказ на інший рахунок — не заважає');
});

test('M4: покупка корп. карткою — у CRM за датою й часом покупки; закритий місяць — період перший відкритий', () => {
  const pur = '4246 **** **** 7365 31.10.2026 17:33:05 Цифровi товари: FACEBK *22AH55AK24';
  assert.equal(BP.cardTime(pur), '17:33');
  assert.equal(BP.cardTime('Оплата послуг'), '');
  const p = { date: '2026-11-01', time: '09:10', buy: Rc.cardDate(pur), buyTime: BP.cardTime(pur) };
  assert.deepEqual(BP.recWhen(p, null), { date: '31-10-2026 17:33', period: '01-10-2026' });
  assert.deepEqual(BP.recWhen(p, '2026-10'), { date: '31-10-2026 17:33', period: '01-11-2026' }, 'жовтень закрито');
  assert.deepEqual(BP.recWhen({ ...p, buyTime: '' }, '2026-09'), { date: '31-10-2026 12:00', period: '01-10-2026' }, 'без часу — полудень');
  assert.deepEqual(BP.recWhen({ date: '2026-11-01', time: '09:10' }, '2026-10'), { date: '01-11-2026 09:10', period: '01-11-2026' }, 'не покупка карткою — як було');
  assert.equal(BP.dayOfCrm('31-10-2026 17:33'), '2026-10-31');
});

test('файли виписок: неповна виписка й операція двічі — показуються біля файлу', () => {
  assert.match('виписка неповна: вхідний + рух ≠ вихідний на 42 346,00 грн — вивантажте заново', BP.FILE_SHOW);
  assert.match('API повернув операцію двічі — дубль пропущено', BP.FILE_SHOW);
  assert.doesNotMatch('рахунок CRM зіставлено з 2 рахунками банку — звіряються разом', BP.FILE_SHOW);
});