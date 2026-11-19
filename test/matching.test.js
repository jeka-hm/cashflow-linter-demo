// «Зіставлення ШІ» (core/matching.js): банк ↔ погодження ↔ CRM — пакети ЗП, 1:1, податки, що піде в ШІ і як береться його відповідь.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const MT = require('../core/matching.js');

const ap = (key, acc, date, amount, recipient, o) => ({ key, acc, date, amount, recipient, text: `${recipient}: ЗП за жовтень`, crmId: 0, action: 'так', ...o });
const bk = (id, acc, date, amount, kind, o) => ({ id, acc, date, amount, kind, cards: 0, crm: null, cpty: '', text: '', ...o });

test('packs: рівно k погоджень на суму пакета; кілька наборів — неоднозначно; без k — найменший розмір', () => {
  const it = v => ({ c: Math.round(v * 100), v });
  const xs = [55800, 44000, 22628.76, 137090, 63000, 82971.24].map(it);
  const r = MT.packs(xs, Math.round(220061.24 * 100), 2);
  assert.deepEqual([r.count, r.sol.map(x => x.v).sort((a, b) => a - b)], [1, [82971.24, 137090]]);
  assert.equal(MT.packs(xs, Math.round(220061.24 * 100), 3).count, 0, '3 картки — такого набору немає');
  const twins = [100, 200, 300, 400].map(it);
  assert.equal(MT.packs(twins, 50000, 2).count, 2, '100+400 і 200+300 — неоднозначно');
  assert.deepEqual(MT.packs(twins, 30000, 0).sol.map(x => x.v), [300], 'без кількості карток — найменший набір (одне погодження)');
});

test('match: пакет ЗП на 4 картки = 4 погодження того самого рахунку на руки; 1:1 — спершу той самий рахунок; податки — групою', () => {
  const A = [ap('a1', 33, '2026-11-05', 137090, 'Лобанов Дмитро', { crmId: 26196 }), ap('a2', 33, '2026-11-05', 63000, 'Егор Григорук', { crmId: 26195 }),
    ap('a3', 33, '2026-11-05', 15000, 'Хтось Ще'), ap('a4', 33, '2026-11-05', 5017, 'Четвертий'),
    ap('a5', 98, '2026-11-04', 8791, 'ФОП Власич Оксана'), ap('a6', 68, '2026-11-04', 8791, 'ФОП Власич Оксана (з ФОП)'),
    ap('a7', 33, '2026-11-05', 4200, 'Без операції')];
  const B = [bk('p1', 33, '2026-11-05', 220107, 'pay', { cards: 4 }), bk('e1', 68, '2026-11-05', 8791, 'exp'),
    bk('t1', 33, '2026-11-05', 12228.17, 'tax', { text: 'Сплата ПДФО за жовтень 2026' }), bk('t2', 33, '2026-11-05', 12228.17, 'tax', { text: 'Сплата військового збору за жовтень 2026' }),
    bk('t3', 33, '2026-11-05', 1, 'tax', { text: 'Сплата ЄСВ за жовтень 2026' }), bk('e2', 33, '2026-11-05', 999, 'exp')];
  const res = MT.match(B, A);
  const row = id => res.rows.find(r => r.bank.id === id);
  assert.deepEqual(row('p1').ap.map(a => a.key).sort(), ['a1', 'a2', 'a3', 'a4']);
  assert.equal(row('p1').how, 'пакет');
  assert.equal(MT.crmState(row('p1').ap), 'частково');
  assert.deepEqual([row('e1').ap[0].key, row('e1').other], ['a6', false], 'той самий рахунок раніше за інший');
  assert.deepEqual(res.taxes.map(g => [g.acc, g.month, g.items.length, g.total]), [[33, 'жовтень 2026', 3, 24457.34]]);
  assert.deepEqual(res.free.bank.map(b => b.id), ['e2']);
  assert.deepEqual(res.free.ap.map(a => a.key), ['a5', 'a7']);
  // погодження лише з іншого рахунку — пара, але з позначкою
  const r2 = MT.match([bk('e3', 68, '2026-11-05', 4200, 'exp')], [ap('x', 33, '2026-11-04', 4200, 'Хтось')]);
  assert.equal(r2.rows[0].other, true);
  // поза вікном дат (погодження за 10 днів до оплати) — ні
  assert.equal(MT.match([bk('e4', 33, '2026-11-15', 4200, 'exp')], [ap('y', 33, '2026-11-04', 4200, 'Хтось')]).rows.length, 0);
  // пакет, який розкладається двома способами, — неоднозначний, погодження вільні (для ШІ)
  const r3 = MT.match([bk('p2', 33, '2026-11-05', 500, 'pay', { cards: 2 })], [100, 200, 300, 400].map((v, i) => ap(`t${i}`, 33, '2026-11-05', v, `Особа ${i}`)));
  assert.deepEqual([r3.rows.length, r3.amb.length, r3.amb[0].count, r3.free.ap.length], [0, 1, 2, 4]);
  assert.deepEqual([MT.crmState([{ crmId: 1 }]), MT.crmState([{ crmId: 0 }])], ['в CRM', 'не внесено']);
});

test('пакет ЗП по людях: одна картка — кілька погоджень людини; інший рахунок тієї самої фірми; тімлід за команду (05.11.2026)', () => {
  const L = 'ТОВ СЕРВІС МАРКЕТ', U = 'ТОВ ПРИКЛАД СЕРВІС';
  const A = [ap('pr', 98, '2026-11-05', 162090, 'Андрій Полуботко', { owner: L, crmId: 26189 }), ap('hr', 98, '2026-11-05', 186600, 'Анна Басова', { owner: L, crmId: 26190 }),
    ap('rop', 98, '2026-11-05', 24314, 'Хоменко', { owner: L, crmId: 26206 }), ap('tg', 98, '2026-11-05', 4275, 'Андрій Полуботко', { owner: L, crmId: 26214 }),
    ap('pm', 98, '2026-11-05', 103400, 'Анна Басова', { owner: L, crmId: 26191 }), ap('bon', 1, '2026-11-05', 1000, 'Хоменко Всеволод', { owner: L }),
    ap('um', 33, '2026-11-05', 1000, 'Хоменко', { owner: U })];
  const B = [bk('p1', 98, '2026-11-05', 378279, 'pay', { cards: 3, owner: L }), bk('p2', 98, '2026-11-05', 103400, 'pay', { cards: 1, owner: L })];
  const res = MT.match(B, A), row = id => res.rows.find(r => r.bank.id === id);
  assert.deepEqual(row('p1').ap.map(a => a.key).sort(), ['bon', 'hr', 'pr', 'rop', 'tg'], '3 людини, 5 погоджень; бонус Хоменка — з 8112 тієї самої фірми');
  assert.equal(row('p1').other, true);
  assert.deepEqual(row('p2').ap.map(a => a.key), ['pm']);
  assert.deepEqual(res.free.ap.map(a => a.key), ['um'], 'погодження іншої фірми не береться');
  // фірми рахунку не знаємо — лише той самий рахунок: 377 279 ≠ 378 279, пакет не розкладено
  const r0 = MT.match([bk('p1', 98, '2026-11-05', 378279, 'pay', { cards: 3 })], A);
  assert.deepEqual([r0.rows.length, r0.amb.length], [0, 1]);
  // три однакові премії однієї людини — не «неоднозначно»: котру з однакових узято, для пакета байдуже
  const T = [13500, 13500, 13500].map((v, i) => ap(`t${i}`, 33, '2026-11-05', v, 'Терещенко')).concat([ap('b', 33, '2026-11-05', 55800, 'Андрій Балух')]);
  const r1 = MT.match([bk('q', 33, '2026-11-05', 69300, 'pay', { cards: 2 })], T);
  assert.deepEqual([r1.rows.length, r1.rows[0].ap.length], [1, 2]);
  // тімлід отримує погодження за свою команду: 2 «людини» в реєстрі, 3 картки в пакеті
  const r2 = MT.match([bk('q', 33, '2026-11-05', 82800, 'pay', { cards: 3 })], T);
  assert.deepEqual(r2.rows[0].ap.map(a => a.amount).sort(), [13500, 13500, 55800]);
  // одна група на людину: «Хоменко» = «Хоменко Всеволод»; «Андрій» підходить двом — окремо
  const g = MT.people(['Хоменко', 'Хоменко Всеволод', 'Андрій Полуботко', 'Андрій Балух', 'Андрій', ''].map((r, i) => ({ a: { recipient: r }, c: i + 1 })));
  assert.deepEqual(g.map(x => x.list.length), [2, 1, 1, 1, 1]);
});

test('огляд 07.11.2026: обірваний пошук — не пара; 1:1 спершу свій рахунок для всіх; короткі імена не залежать від порядку рядків', () => {
  // 1) пошук набору обірвався (over) після першого знайденого — другий міг бути: «неоднозначно», а не пакет
  const names = ['Бондар Іван', 'Коваль Петро', 'Швачук Олег', 'Музичук Ігор', 'Трушук Анна', 'Корчмар Зіна', 'Осадчук Марко', 'Лященко Юрій', 'Рябенко Віра', 'Сенчук Ольга'];
  const A = [500, 400, 300, 250, 200, 150, 120, 100, 80, 50].map((v, i) => ap(`a${i}`, 33, '2026-11-05', v, names[i]));
  const items = A.map(a => ({ a, c: Math.round(a.amount * 100) }));
  let cut = 0;
  for (let n = 1; n <= 300; n++) {
    const r = MT.packPeople(items, 100000, 3, { exact: true, maxNodes: n });
    if (r.count !== 1 || !r.over) continue;
    cut++;
    const res = MT.match([bk('p', 33, '2026-11-05', 1000, 'pay', { cards: 3 })], A, { maxNodes: n });
    assert.deepEqual([res.rows.length, res.amb.length, res.amb[0].over], [0, 1, true], `maxNodes ${n}`);
  }
  assert.ok(cut > 0, 'є обірваний пошук з одним знайденим набором');
  assert.equal(MT.match([bk('p', 33, '2026-11-05', 1000, 'pay', { cards: 3 })], A).amb[0].count, 2, 'без обриву — два набори');
  // 2) операція іншої фірми з тією самою сумою не забирає погодження, пара якого на своєму рахунку теж у виписці
  const B2 = [bk('A', 10, '2026-11-04', 5000, 'exp', { owner: 'ФОП Іванов' }), bk('B', 20, '2026-11-05', 5000, 'exp', { owner: 'ТОВ Альфа' })];
  const r2 = MT.match(B2, [ap('x', 20, '2026-11-03', 5000, 'Постачальник', { owner: 'ТОВ Альфа' })]);
  assert.deepEqual([r2.rows.map(m => m.bank.id), r2.free.bank.map(b => b.id), r2.rows[0].other], [['B'], ['A'], false]);
  // 3) «Андрій» серед «Андрій Полуботко» й «Андрій Балух» — окрема людина за будь-якого порядку рядків
  const P = [['p1', 100, 'Андрій Полуботко'], ['p2', 200, 'Андрій'], ['p3', 300, 'Андрій Балух'], ['p4', 200, 'Сидоренко Олег']].map(([k, v, w]) => ap(k, 33, '2026-11-05', v, w));
  for (const order of [P, [P[0], P[2], P[1], P[3]]]) {
    const r = MT.match([bk('q', 33, '2026-11-05', 600, 'pay', { cards: 3 })], order);
    assert.deepEqual([r.rows.length, r.amb.length, r.amb[0].count], [0, 1, 2], order.map(a => a.key).join());
  }
});

test('ШІ: у запит — лише залишок (без пари в CRM і без погодження, неоднозначні пакети); відповідь — лише з тим, що є, кожне погодження один раз', () => {
  const A = [ap('a1', 33, '2026-11-05', 1000, 'Іван'), ap('a2', 33, '2026-11-05', 2000, 'Петро', { crmId: 7 })];
  const inCrm = bk('c1', 33, '2026-11-05', 777, 'exp', { crm: { id: 5 } });
  const res = MT.match([bk('b1', 33, '2026-11-05', 1010, 'exp', { cpty: 'ІВАН', text: 'Переказ' }), inCrm, bk('p1', 33, '2026-11-05', 3000.5, 'pay', { cards: 2 })], A);
  const pay = MT.aiPayload(res, id => `рахунок ${id}`);
  assert.deepEqual(pay.bank.map(b => [b.id, b.acc, b.kind]), [['b1', 'рахунок 33', 'exp'], ['p1', 'рахунок 33', 'pay']], 'запис, що вже має пару в CRM, — ні');
  assert.deepEqual(pay.approvals.map(a => [a.key, a.entered]), [['a1', false], ['a2', true]]);
  assert.equal(pay.bank[1].cards, 2);
  const out = MT.aiApply(res, [{ bank: 'b1', approvals: ['a1', 'zzz'], confidence: 'середня', why: 'Іван, 1000 + комісія 10' },
    { bank: 'p1', approvals: ['a1', 'a2'], confidence: 'висока', why: 'дубль a1' }, { bank: 'нема', approvals: ['a2'] }, { bank: 'c1', approvals: ['a2'] }]);
  assert.deepEqual(out.map(m => [m.bank.id, m.ap.map(a => a.key), m.conf, m.diff]), [['b1', ['a1'], 'середня', 10], ['p1', ['a2'], 'висока', 1000.5]]);
  assert.deepEqual(MT.aiApply(res, null), []);
});

// ---------- 16.11.2026: ЗП за день разом, «% менеджера» через зарплатний проєкт, спершу погодження дня, «бракує», «немає погоджень» ----------
// склад за зразком одного дня виплат: 25 погоджень = пакети на 4 і 8 карток; імена вигадані.
// Отримувач — не завжди власник картки: тімлід за команду (9 рядків), порожній отримувач, «на картку керівника як ЗП»; 6 рядків — «% менеджера».
const U = 'ТОВ ПРИКЛАД СЕРВІС';
const DAY5 = [['d01', 1500, 'Тесленко'], ['d02', 44000, 'Андрій Панченко'], ['d03', 45000, 'Ярослав Рибачук'], ['d04', 82971.24, 'Штефан Швачук'], ['d05', 63000, 'Егор Грицюк'],
  ['d06', 137090, 'Ладченко Дмитро'], ['d07', 19000, 'Малюк Микола', { zp: false }], ['d08', 70388, 'Юрвідділ', { zp: false }], ['d09', 45000, '', { zp: false }], ['d10', 128402, '', { zp: false }],
  ['d11', 24314, 'Тесленко'], ['d12', 13500, 'Тесленко'], ['d13', 13500, 'Тесленко'], ['d14', 13500, 'Тесленко'], ['d15', 22500, 'Тесленко'], ['d16', 45000, 'Тесленко'], ['d17', 3000, 'Тесленко'],
  ['d18', 119380, 'Тесленко', { pct: true }], ['d19', 2170, 'Цвіток', { pct: true }], ['d20', 20831, 'Малик Данило', { pct: true }], ['d21', 60395, 'Максимюк', { pct: true }],
  ['d22', 25900, 'Гайдай Дмитро', { pct: true }], ['d23', 78012, 'Мудрий', { pct: true }], ['d24', 55800, 'Андрій Бабчук'], ['d25', 22628.76, 'Штефан Швачук']]
  .map(([k, v, w, o]) => ap(k, 33, '2026-11-05', v, w, { owner: U, zp: true, crmId: 1, ...o }));
const P5 = () => [bk('p4', 33, '2026-11-05', 220107, 'pay', { cards: 4, owner: U }), bk('p8', 33, '2026-11-05', 936675, 'pay', { cards: 8, owner: U })];

test('ЗП за день разом (05.11.2026): два пакети дня = усі погодження дня з «% менеджера»; поділ між пакетами — єдиний', () => {
  const res = MT.match(P5(), DAY5), row = id => res.rows.find(r => r.bank.id === id);
  // до виправлення: «% менеджера» в набір не йшли, отримувачів 12 на 8 карток, у тімліда 9 погоджень (бралось 8) — обидва пакети «набору немає»
  assert.deepEqual(res.amb, []);
  assert.deepEqual(row('p4').ap.map(a => a.key).sort(), ['d21', 'd22', 'd23', 'd24']);
  assert.equal(row('p8').ap.length, 21);
  assert.deepEqual([row('p4').day, row('p8').day, row('p4').how], [true, true, 'пакет']);
  assert.deepEqual(res.free.ap, []);
  // «% менеджера» — лише в пакетах: з операцією 1:1 не зіставляється і серед «погоджено, у виписці немає» не показується
  const one = MT.match([bk('e', 33, '2026-11-05', 2170, 'exp', { owner: U })], [DAY5[18]]);
  assert.deepEqual([one.rows.length, one.free.ap.length, one.free.bank.length], [0, 0, 1]);
  // стан у CRM — за звичайними погодженнями пари («% менеджера» реєстр не вносить на всю суму)
  assert.equal(MT.crmState([{ crmId: 5 }, { crmId: 0, pct: true }]), 'в CRM');
  assert.equal(MT.crmState([{ crmId: 0, pct: true }]), 'не внесено');
  // один пакет дня бере всі погодження дня; погодження зарплатного проєкту з іншого рахунку фірми (zp) — коли за своїм рахунком не сходиться
  const L = 'ТОВ МАРКЕТ', one2 = MT.match([bk('q', 98, '2026-11-13', 25807.32, 'pay', { cards: 1, owner: L })],
    [ap('z1', 1, '2026-11-13', 19207.32, 'Олексій Терещук', { owner: L, zp: true }), ap('z2', 1, '2026-11-13', 6600, 'Тацюк Артур', { owner: L, zp: true }),
      ap('z3', 1, '2026-11-13', 22500, 'Повернення клієнту', { owner: L })]);
  assert.deepEqual([one2.rows[0].ap.map(a => a.key).sort(), one2.rows[0].other, one2.free.ap.map(a => a.key)], [['z1', 'z2'], true, ['z3']]);
});

test('спершу погодження дня пакета: давніші вільні погодження не дають хибної пари (06.11 і 11.11.2026)', () => {
  // 06.11: 225 614,00 на 3 картки = 115 000 + 66 000 + «% менеджерів» 44 614; 11.11: 44 000,00 на 1 картку — погодження іншої фірми (тут його немає)
  const A = DAY5.concat([ap('s1', 33, '2026-11-06', 115000, 'Артем Телиженко', { owner: U }), ap('s2', 33, '2026-11-06', 66000, 'Роман Вознесенський', { owner: U }),
    ap('s3', 33, '2026-11-06', 44614, '', { owner: U, pct: true })]);
  const B = P5().concat([bk('p6', 33, '2026-11-06', 225614, 'pay', { cards: 3, owner: U }), bk('p11', 33, '2026-11-11', 44000, 'pay', { cards: 1, owner: U })]);
  const res = MT.match(B, A), row = id => res.rows.find(r => r.bank.id === id);
  assert.deepEqual(row('p6').ap.map(a => a.key).sort(), ['s1', 's2', 's3']); // до виправлення: погодження тімліда й двох людей від 05.11
  assert.equal(row('p11'), undefined); // до виправлення: «Андрій Панченко 44 000» від 05.11
  assert.deepEqual(res.amb.map(a => [a.bank.id, a.count, a.none, a.short]), [['p11', 0, true, null]]);
  // погодження дня є, але набору з них немає, а з давнішими він один — беруться давніші (як і було)
  const old = MT.match([bk('w', 33, '2026-11-07', 300, 'pay', { cards: 1 })], [ap('o1', 33, '2026-11-05', 300, 'Іван Сьомий'), ap('o2', 33, '2026-11-07', 900, 'Іван Сьомий')]);
  assert.deepEqual(old.rows.map(m => m.ap[0].key), ['o1']);
});

test('пакет без набору: «за день погоджень на X, не вистачає Y» замість «кілька наборів» з давніх погоджень; погоджень немає — none (13.11 і 03.11.2026)', () => {
  // 13.11: пакети 65 738 (1 картка) і 169 400 (5 карток); погоджень дня — 208 738: бракує 26 400 (одне погодження ще «Готівка»)
  const D13 = [['f1', 5738, 'Стеценко Євген'], ['f2', 60000, 'Стеценко Євген'], ['f3', 30800, 'Франчук Андрій'], ['f4', 8800, 'Франчук Андрій'], ['f5', 4400, 'Мудрий Микита'], ['f6', 26400, 'Мудрий Микита'],
    ['f7', 8800, 'Павло Максимюк'], ['f8', 6600, 'Павло Максимюк'], ['f9', 6600, 'Павло Максимюк'], ['f10', 17600, 'Тесленко Роман'], ['f11', 13200, 'Тесленко Роман'], ['f12', 13200, 'Тесленко Роман'], ['f13', 6600, 'Тесленко Роман']]
    .map(([k, v, w]) => ap(k, 33, '2026-11-13', v, w, { owner: U, zp: true }));
  // давніші вільні погодження вікна: з ними 169 400 «збирається» кількома способами
  const OLD = [['g1', 126000, 'Кирило Рудник'], ['g2', 13500, 'Тесленко'], ['g3', 13500, 'Тесленко'], ['g4', 1000, 'Субота Тарас'], ['g5', 52300, 'Віталій Гонта'], ['g6', 101904, 'Юрій Вагнер'], ['g7', 2496, 'Субота Тарас']]
    .map(([k, v, w]) => ap(k, 33, '2026-11-08', v, w, { owner: U, zp: true }));
  const res = MT.match([bk('p1', 33, '2026-11-13', 65738, 'pay', { cards: 1, owner: U }), bk('p5', 33, '2026-11-13', 169400, 'pay', { cards: 5, owner: U }),
    bk('p0', 33, '2026-11-03', 111535.7, 'pay', { cards: 1, owner: U })], D13.concat(OLD));
  assert.deepEqual(res.rows.map(m => [m.bank.id, m.ap.map(a => a.key).sort()]), [['p1', ['f1', 'f2']]]);
  const amb = id => res.amb.find(a => a.bank.id === id);
  assert.deepEqual(amb('p5').short, { have: 143000, miss: 26400 }); // до виправлення: count 2 — «цю суму дають кілька наборів»
  assert.equal(amb('p5').none, false);
  assert.deepEqual([amb('p0').none, amb('p0').short, amb('p0').count], [true, null, 0]);
});

test('packPeople: в однієї людини погоджень більше, ніж перебирається, — «не дорахував» (over, big), а не мовчки без решти', () => {
  const xs = Array.from({ length: 13 }, (_, i) => ({ a: { recipient: 'Тесленко' }, c: 2 ** i * 100 })).concat([{ a: { recipient: 'Бабчук Андрій' }, c: 700 }]);
  // набір є лише з тринадцятим (найменшим за порядком перебору) погодженням: 1 + 2 + … + 4096 = 8191, плюс 7 другої людини
  const r = MT.packPeople(xs, 819100 + 700, 2, { exact: true });
  assert.deepEqual([r.over, r.big], [true, true]); // до виправлення: {count: 0, over: false} — «набору немає» (брались перші 8)
  const res = MT.match([bk('p', 33, '2026-11-05', 8198, 'pay', { cards: 2 })], xs.map((x, i) => ap(`k${i}`, 33, '2026-11-04', x.c / 100, x.a.recipient)));
  assert.deepEqual([res.rows.length, res.amb[0].over, res.amb[0].big], [0, true, true]);
  // до 12 погоджень однієї людини перебираються всі
  const ok = MT.packPeople(xs.slice(0, 9).concat(xs.slice(13)), 51100 + 700, 2, { exact: true });
  assert.deepEqual([ok.count, ok.over], [1, false]);
});

test('огляд 16.11.2026: «за день разом» не забирає в пакет ЗП погодження, що мають свою звичайну операцію у виписці', () => {
  const MT0 = require('../core/matching.js');
  const bank = [{ id: 'p', acc: 33, owner: 'ТОВ ПРИКЛАД', date: '2026-11-03', amount: 80000, kind: 'pay', cards: 3 },
    { id: 'e1', acc: 33, owner: 'ТОВ ПРИКЛАД', date: '2026-11-03', amount: 30000, kind: 'exp', cpty: 'ТОВ Оренда' },
    { id: 'e2', acc: 33, owner: 'ТОВ ПРИКЛАД', date: '2026-11-03', amount: 50000, kind: 'exp', cpty: 'ТОВ Реклама' }];
  const ap = [{ key: 'r1', acc: 33, owner: 'ТОВ ПРИКЛАД', date: '2026-11-03', amount: 30000, recipient: 'ТОВ Оренда', text: 'оренда', crmId: 0 },
    { key: 'r2', acc: 33, owner: 'ТОВ ПРИКЛАД', date: '2026-11-03', amount: 50000, recipient: 'ТОВ Реклама', text: 'реклама', crmId: 0 }];
  const res = MT0.match(bank, ap, {});
  const by = id => res.rows.find(m => m.bank.id === id);
  assert.deepEqual([by('e1') && by('e1').ap.map(a => a.key), by('e2') && by('e2').ap.map(a => a.key), by('p')], [['r1'], ['r2'], undefined]);
});

// ---------- 18.11.2026: погодження, яких реєстр не вносить (off); інший рахунок — не сама сума, якщо люди явно різні ----------
test('повернення клієнту (12.11.2026): пара — погодження «Вносити» = «ні» свого рахунку з названим отримувачем, а не чуже з тією самою сумою', () => {
  const H = 'ФОП Хоменко', Mo = 'ФОП Мазовецька';
  const refund = bk('e', 68, '2026-11-12', 6000, 'exp', { owner: H, cpty: 'Гурський Олександр Олексійович', text: 'Часткове повернення коштiв зг. заяви вiд 05.10.2026' });
  const kush = ap('k', 83, '2026-11-06', 6000, 'Дмитро Кобзар', { owner: Mo, text: 'Вивід в адмінці як виконавець з кабінету' });
  const gub = ap('g', 68, '2026-11-12', 6000, 'Гурський Олександр Олексійович', { owner: H, text: 'повернення коштів згідно заяви', action: 'ні', off: true });
  const res = MT.match([refund], [kush, gub]);
  // до виправлення: погодження «ні» сюди не доходило, і операцію забирав «Дмитро Кобзар» з іншого рахунку (other: true)
  assert.deepEqual(res.rows.map(m => [m.bank.id, m.ap.map(a => a.key), !!m.off, m.other, m.how]), [['e', ['g'], true, false, '1:1']]);
  assert.deepEqual(res.free.ap.map(a => a.key), ['k'], 'Кобзар лишається вільним');
  // і без погодження «ні»: Кобзар ≠ Гурський — сама сума з іншого рахунку не пара; операція лишається без погодження
  const r0 = MT.match([refund], [kush]);
  assert.deepEqual([r0.rows.length, r0.free.bank.map(b => b.id), r0.free.ap.map(a => a.key)], [0, ['e'], ['k']]);
  // контроль: з іншого рахунку, але отримувач названий у виписці (відмінок, латинська «i») — пара, як і раніше
  for (const who of ['Гурський О. О.', 'Гурського Олександра']) {
    const r1 = MT.match([refund], [ap('x', 83, '2026-11-10', 6000, who, { owner: Mo })]);
    assert.deepEqual(r1.rows.map(m => [m.ap[0].key, m.other, !!m.off]), [['x', true, false]], who);
  }
  // … і коли імені немає з якогось боку (отримувач порожній чи контрагент без назви) — теж як раніше
  assert.equal(MT.match([refund], [ap('y', 83, '2026-11-10', 6000, '', { owner: Mo })]).rows.length, 1);
  assert.equal(MT.match([{ ...refund, cpty: '', text: '' }], [kush]).rows.length, 1);
  // … і коли контрагента названо в змісті погодження («Сливко: реінвест на ФОП Власич»)
  assert.equal(MT.match([{ ...refund, cpty: 'ФОП Власич Оксана Володимирівна', text: 'Оплата послуг' }], [ap('z', 83, '2026-11-10', 6000, 'Сливко', { owner: Mo, text: 'реінвест на ФОП Власич Оксана' })]).rows.length, 1);
  // свій рахунок — як було: сума й вікно, імена не порівнюються
  assert.equal(MT.match([refund], [{ ...kush, acc: 68, owner: H }]).rows[0].other, false);
  // off — лише свій рахунок і названий отримувач; у пакети ЗП, «за день» і серед вільних погоджень не йде
  assert.equal(MT.match([refund], [{ ...gub, acc: 83, owner: Mo }]).rows.length, 0, 'off з іншого рахунку — не пара');
  assert.equal(MT.match([refund], [{ ...gub, recipient: 'Іваненко Петро' }]).rows.length, 0, 'off без імені у виписці — не пара');
  const pk = MT.match([bk('p', 68, '2026-11-12', 6000, 'pay', { cards: 1, owner: H })], [gub]);
  assert.deepEqual([pk.rows.length, pk.free.ap.length, pk.amb.length], [0, 0, 1]);
  // кілька off на ту саму суму — той, кого названо у виписці
  const two = MT.match([refund], [{ ...gub, key: 'g0', recipient: 'Сенчук Максим Юрійович' }, gub]);
  assert.deepEqual(two.rows.map(m => m.ap[0].key), ['g']);
  assert.deepEqual([MT.nameHits('Гурський Олександр Олексійович', 'ГУРСЬКОГО ОЛЕКСАНДРА'), MT.nameHits('Дмитро Кобзар', 'Гурський Олександр Олексійович'), MT.nameHits('', 'Гурський')], [2, 0, 0]);
});