// Виводи з балансу ↔ погодження «% менеджера / м-рів / тімліда» (core/withdrawals.js) — на сумах за зразком двох місяців; імена вигадані.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const WD = require('../core/withdrawals.js');

const SV = 33, MT = 1; // «Приват ТОВ ПРИКЛАД СЕРВІС 5608» (зп ПРИКЛАД), «Приват ТОВ СЕРВІС МАРКЕТ 8112» (зп Маркет)
const item = (id, role, name, amount, acc, date) => ({ id, date, acc, amount: -amount, opc: 2,
  comment: `Підтвердження виведення коштів з балансу ${role === 'lead' ? 'тімліда' : 'менеджера'} ${name} від ${date.split('-').reverse().join('.')} по проекту Україна на суму ${amount}.00 грн` });
const reg = (key, date, recipient, content, textAmount, extra) => ({ key, date, recipient, content, textAmount, ...extra });
const ids = row => row.items.map(w => w.id).sort((a, b) => a - b);

// виводи 04.09.2026 (записи CRM 9703–9734)
const SEP = [
  [9734, 'lead', 'Малигин Никита', 22838, SV], [9733, 'm', 'Фалатенко Андрій Ігорович', 32142, SV], [9732, 'm', 'Химич Дарина', 13255, SV],
  [9731, 'm', 'Пархович Інесса', 5548, SV], [9730, 'm', 'Яцко Марія', 5945, SV], [9729, 'm', 'Білоконов Максим', 9152, SV],
  [9728, 'lead', 'Валентин Божко (ТЛ)', 6782, SV], [9727, 'm', 'Коваль Олександра', 19277, SV], [9726, 'm', 'Лащук Ірина', 6307, SV],
  [9725, 'm', 'Сидорук Тарас Артемович', 9139, SV], [9724, 'm', 'Шаталова Ніна', 4200, SV], [9723, 'm', 'Борисов Андрій', 20888, SV],
  [9722, 'm', 'Малахов Данил', 6238, SV], [9721, 'm', 'Сьомін Владислав Миколайович', 2968, SV], [9720, 'm', 'Анна Дубенок', 6868, SV],
  [9719, 'lead', 'Терещенко Роман', 16847, SV], [9717, 'lead', 'Хоменко Всеволод - ТЛ', 10776, MT], [9716, 'm', 'Хаба Олександр', 4000, MT],
  [9715, 'm', 'Ігнатка Олександр', 9800, MT], [9714, 'm', 'Цвях Богдан', 2940, MT], [9713, 'm', 'Голованов Андрій', 1296, MT],
  [9712, 'm', 'Пархович Максим', 2346, MT], [9711, 'lead', 'Таценко Артур ТЛ', 23303, MT], [9710, 'm', 'Гомін Андрій', 9338, MT],
  [9709, 'm', 'Рохманов Микита', 19766, MT], [9708, 'm', 'Труш Арина', 22752, MT], [9707, 'm', 'Грабар Яна', 5850, MT],
  [9706, 'm', 'Осипенко Руслан', 8269, MT], [9703, 'm', 'Нетреба Андрій', 4430, MT],
].map(([id, role, name, amount, acc]) => item(id, role, name, amount, acc, '2026-09-04'));
// погодження 03.09.2026: «% м-рів та ТімЛіда за період з 24.08-30.08»
const T = '% м-рів та ТімЛіда за період з 24.08-30.08';
const SEP_REG = [['Таценко', 93708], ['Хоменко', 31158], ['Терещенко', 64316], ['Меліксетян Павло', 26059], ['Малигин', 56738], ['Сидорук Тарас', 9139], ['Фалатенко Андрій', 32142]]
  .map(([rec, a], i) => reg(`03.09.2026#${i}`, '2026-09-03', rec, T, a, { action: 'ні' }));

test('виводи: розбір запису CRM — роль, ім\'я без «ТЛ», сума', () => {
  const w = WD.parseWithdrawal(SEP[6]);
  assert.deepEqual([w.id, w.role, w.name, w.amount, w.acc, w.date], [9728, 'lead', 'Валентин Божко', 6782, SV, '2026-09-04']);
  assert.equal(WD.parseWithdrawal(SEP[16]).name, 'Хоменко Всеволод');
  assert.equal(WD.parseWithdrawal(SEP[22]).name, 'Таценко Артур');
  assert.equal(WD.parseWithdrawal({ id: 1, opc: 1, amount: 5, comment: SEP[0].comment }), null, 'надходження — не вивід');
  assert.equal(WD.parseWithdrawal({ id: 1, opc: 2, amount: -5, comment: 'Зарплата за жовтень' }), null);
});

test('погодження: що з них — % з балансу, тімлід, людина, суми «разом з податками»', () => {
  const p = c => WD.parseApproval(reg('k', '2026-11-03', 'Хоменко', c, 1000));
  assert.equal(p('Заробітня плата за жовтень'), null);
  assert.equal(p('% РОП за жовтень'), null, '«% РОП» реєстр вносить на всю суму');
  assert.deepEqual(['team', 'lead', 'person'].map(k => p('% м-рів тімліда Копинецька І.  за період з 12-25.10')[k]), [true, 'копинецька', '']);
  assert.deepEqual(['team', 'lead'].map(k => p('% Тл. Порфирова і команди за період з 12-18.10')[k]), [true, 'порфирова']);
  assert.deepEqual(['team', 'lead'].map(k => p('% м-рів та тімліда команди Порфиров, як зп Лобанов')[k]), [true, 'порфиров']);
  assert.deepEqual(['team', 'person'].map(k => p('% менеджера Борисов А.  тімлід Терещенко.  за період з 12-25.11')[k]), [false, 'борисов']);
  assert.deepEqual(['team', 'person'].map(k => p('% м-ра  Мартиненко Святослав, тімлід Терещенко.  за період з 12-25.10')[k]), [false, 'мартиненко']);
  assert.deepEqual(['team', 'lead'].map(k => p('% м-рів та ТімЛіда за період з 24.08-30.08')[k]), [true, 'хоменко'], 'тімлід — з отримувача');
  assert.equal(p('% ТімЛіда Копинецька за період з 05-11.10').person, 'копинецька');
  const g = WD.parseApproval(reg('k', '2026-10-02', 'Фалатенко Андрій', '% менеджера за період з 21.09-27.09 (разом з податками)', 31979.88889));
  assert.deepEqual([g.person, g.gross, g.targets], ['фалатенко', true, [3197989, 2878190, 2878100]]);
  assert.equal(WD.parseApproval(reg('k', '2026-10-02', 'X', T, 100, { tax: true })), null, 'рядок податків ЗП — не погодження %');
  // «% Тл.» без «за період» (07.11.2026: \b без прапорця u кирилиці не знав — такі рядки йшли в «Зіставлення ШІ» звичайними погодженнями)
  for (const c of ['% Тл. Малигин і команди', '% тл Малигин', '% ТЛ Малигин за жовтень']) assert.ok(p(c), c);
  assert.equal(p('% тлумачення договору'), null);
});

test('допуск ±1 грн — лише «разом з податками»: на руки 10 000 і вивід 9 999,01 — розбіжність, а не «гаразд»', () => {
  const W = [WD.parseWithdrawal(item(1, 'm', 'Іваненко Петро', 0, SV, '2026-11-04'))].map(w => ({ ...w, amount: 9999.01 }));
  const net = WD.parseApproval(reg('n', '2026-11-03', 'Іваненко Петро', '% менеджера Іваненко Петро за період з 26.10-01.11', 10000));
  assert.equal(net.tol, 0);
  const r = WD.match([net], W).rows[0];
  assert.deepEqual([r.status, r.sum], ['diff', 9999.01]);
  const gross = WD.parseApproval(reg('g', '2026-10-02', 'Іваненко Петро', '% менеджера за період з 21.09-27.09 (разом з податками)', 11110));
  const W2 = [{ ...W[0], amount: 9999.50, date: '2026-10-03' }];
  assert.equal(WD.match([gross], W2).rows[0].status, 'ok', '«разом з податками» × 0,9 = 9 999 — у межах ±1 грн');
});

test('імена: відмінки, і/и, одна помилка', () => {
  const s = (a, b) => WD.sameName(WD.fold(a), WD.fold(b));
  assert.ok(s('Малигін', 'Малигин'));
  assert.ok(s('Порфирова', 'Порфиров'));
  assert.ok(s('Копинецька', 'Копинецької'));
  assert.ok(s('Божко', 'Божка'));
  assert.ok(s('Меліксетян', 'Мелікестян'));
  assert.ok(s('Рахманов', 'Рохманов'));
  assert.ok(s('Горобенко', 'Горобченко'));
  assert.ok(!s('Пархович', 'Пархова'));
  assert.ok(!s('Хаба', 'Хабот'));
});

test('04.09.2026: кожна командна сума розкладається на тімліда й менеджерів, без зайвих виводів', () => {
  const res = WD.match(SEP_REG.map(WD.parseApproval), SEP.map(WD.parseWithdrawal));
  const by = rec => res.rows.find(r => r.a.recipient === rec);
  for (const r of res.rows) assert.equal(r.status, 'ok', `${r.a.recipient}: ${r.status}`);
  assert.deepEqual(ids(by('Малигин')), [9729, 9730, 9731, 9732, 9734]);
  assert.deepEqual(ids(by('Терещенко')), [9719, 9720, 9721, 9722, 9723, 9724, 9726]);
  assert.deepEqual(ids(by('Хоменко')), [9712, 9713, 9714, 9715, 9716, 9717]);
  assert.deepEqual(ids(by('Таценко')), [9703, 9706, 9707, 9708, 9709, 9710, 9711]);
  assert.deepEqual(ids(by('Меліксетян Павло')), [9727, 9728], 'платить Меліксетян, команда Божка: вивід тімліда Божка + Коваль');
  assert.deepEqual(ids(by('Сидорук Тарас')), [9725]);
  assert.deepEqual(ids(by('Фалатенко Андрій')), [9733]);
  assert.equal(res.extra.length, 0);
  assert.deepEqual(res.teams['малигин'].sort(), ['білоконов', 'пархович', 'химич', 'яцко'].map(WD.fold).sort());
  const sm = WD.summary(res);
  assert.deepEqual([sm.n, sm.ok, sm.extra, sm.approved, sm.withdrawn], [7, 7, 0, 313260, 313260]);
});

test('місяць: тижневі набори тих самих людей не змішуються — кожне погодження бере свій тиждень', () => {
  const NEXT = [[9801, 'lead', 'Малигин Никита', 15000], [9802, 'm', 'Химич Дарина', 10000], [9803, 'm', 'Пархович Інесса', 6000], [9804, 'm', 'Яцко Марія', 5000],
    [9805, 'm', 'Білоконов Максим', 4000], [9806, 'm', 'Фалатенко Андрій Ігорович', 32142]].map(([id, role, name, amount]) => item(id, role, name, amount, SV, '2026-09-11'));
  const ap = [reg('a', '2026-09-03', 'Малигин', T, 56738), reg('b', '2026-09-10', 'Малигин', '% м-рів та ТімЛіда за період з 31.08-06.09', 40000),
    reg('c', '2026-09-03', 'Фалатенко Андрій', T, 32142), reg('d', '2026-09-10', 'Фалатенко Андрій', '% менеджера за період з 31.08-06.09', 32142)].map(WD.parseApproval);
  const res = WD.match(ap, SEP.filter(w => w.acc === SV).map(WD.parseWithdrawal).concat(NEXT.map(WD.parseWithdrawal)));
  const by = k => res.rows.find(r => r.a.key === k);
  assert.deepEqual(['a', 'b', 'c', 'd'].map(k => by(k).status), ['ok', 'ok', 'ok', 'ok']);
  assert.deepEqual(ids(by('a')), [9729, 9730, 9731, 9732, 9734]);
  assert.deepEqual(ids(by('b')), [9801, 9802, 9803, 9804, 9805]);
  assert.deepEqual([ids(by('c')), ids(by('d'))], [[9733], [9806]], 'однакова сума двох тижнів — кожному свій вивід');
});

test('склад команди з минулого тижня: той самий тімлід — ті самі менеджери, навіть якщо за сумою наборів кілька', () => {
  const res = WD.match([WD.parseApproval(reg('k', '2026-09-03', 'Малигин', T, 56738))], SEP.map(WD.parseWithdrawal),
    { teams: { [WD.fold('Малигин')]: ['химич', 'пархович', 'яцко', 'білоконов'].map(WD.fold) } });
  assert.equal(res.rows[0].how, 'learned');
  assert.deepEqual(ids(res.rows[0]), [9729, 9730, 9731, 9732, 9734]);
});

test('02.10.2026: «разом з податками» (на руки / 0,9 і ще + 1 грн), рядок «% менеджера» тімліда — командний', () => {
  const OCT = [
    [15913, 'lead', 'Валентин Божко (ТЛ)', 12134, SV], [15912, 'm', 'Меліксетян Павло', 34487, SV], [15911, 'm', 'Петькін Анатолій', 6600, MT],
    [15910, 'lead', 'Таценко Артур ТЛ', 11511, MT], [15909, 'm', 'Гомін Андрій', 1440, MT], [15908, 'm', 'Миненко Микита', 5000, MT],
    [15907, 'm', 'Рохманов Микита', 8138, MT], [15906, 'm', 'Пархович Інесса', 10825, SV], [15905, 'm', 'Фалатенко Андрій Ігорович', 28781, SV],
    [15904, 'lead', 'Малигин Никита', 16090, SV], [15903, 'm', 'Малахов Данил', 35495, SV], [15897, 'm', 'Горобченко Дмитро Григорович', 6300, SV],
    [15894, 'm', 'Голованов Андрій', 3670, MT], [15893, 'm', 'Ігнатка Олександр', 2800, MT], [15892, 'm', 'Хаба Олександр', 13600, MT],
    [15891, 'lead', 'Хоменко Всеволод - ТЛ', 9037, MT], [14459, 'm', 'Яцко Марія', 7516, SV],
  ].map(([id, role, name, amount, acc]) => item(id, role, name, amount, acc, '2026-10-02'));
  const G = '(разом з податками)';
  const R = [['Малахов Даниїл', `% м-рів та ТімЛіда за період з 21.09-27.09 ${G}`, 39438.88889], ['Горобенко Дмитро', `% менеджера за період з 21.09-27.09 ${G}`, 7001],
    ['Малигин Микита', `% менеджера за період з 21.09-27.09 ${G}`, 38257.66667], ['Фалатенко Андрій', `% менеджера за період з 21.09-27.09 ${G}`, 31979.88889],
    ['Божко Валентин', `%ТімЛіда за період з 21.09-27.09 ${G}`, 13483.22222], ['Меліксетян Павло', `% менеджера за період з 21.09-27.09 ${G}`, 38319.88889],
    ['Хоменко Всеволод', `% м-рів та ТімЛіда за період з 21.09-27.09 ${G}`, 32342.11111]].map(([rec, c, a], i) => reg(`02.10.2026#${i}`, '2026-10-02', rec, c, a));
  const res = WD.match(R.map(WD.parseApproval), OCT.map(WD.parseWithdrawal));
  const by = rec => res.rows.find(r => r.a.recipient === rec);
  for (const r of res.rows) assert.equal(r.status, 'ok', `${r.a.recipient}: ${r.status}`);
  assert.deepEqual(ids(by('Малахов Даниїл')), [15903]);
  assert.deepEqual(ids(by('Горобенко Дмитро')), [15897]);
  assert.deepEqual(ids(by('Малигин Микита')), [14459, 15904, 15906], 'тімлід + Пархович + Яцко');
  assert.deepEqual(ids(by('Хоменко Всеволод')), [15891, 15892, 15893, 15894]);
  assert.deepEqual(ids(by('Божко Валентин')), [15913]);
  assert.deepEqual(ids(by('Меліксетян Павло')), [15912]);
  assert.deepEqual(res.extra.map(w => w.id).sort(), [15907, 15908, 15909, 15910, 15911], 'команда Таценка — без погодження в цьому наборі');
});

test('немає виводу, частково, без погодження; «внесено реєстром і є вивід» — схоже на двічі', () => {
  const ws = [item(1, 'm', 'Цвях Богдан', 2000, SV, '2026-10-20'), item(2, 'm', 'Нова Особа', 5000, SV, '2026-10-21')].map(WD.parseWithdrawal);
  const res = WD.match([
    WD.parseApproval(reg('a', '2026-10-19', 'Цвях Богдан', '% менеджера Цвях за період з 05-11.10', 2170)),
    WD.parseApproval(reg('b', '2026-10-19', 'Сидорук Тарас', '% менеджера Сидорук за період з 05-11.10', 8188)),
    WD.parseApproval(reg('c', '2026-10-01', 'Копинецька', '% м-ра Копинецька за період', 5000, { id: 777 })),
  ], ws.concat(WD.parseWithdrawal(item(3, 'm', 'Копинецька Інесса', 5000, SV, '2026-10-02'))));
  const st = k => res.rows.find(r => r.a.key === k);
  assert.deepEqual([st('a').status, st('a').sum, st('a').cands.map(w => w.id)], ['diff', 2000, [1]]);
  assert.equal(st('b').status, 'none');
  assert.equal(st('c').status, 'ok');
  assert.deepEqual(res.extra.map(w => w.id), [2]);
  const sm = WD.summary(res, '2026-10-01', '2026-10-31');
  assert.deepEqual([sm.ok, sm.diff, sm.none, sm.extra, sm.double.map(r => r.a.key)], [1, 1, 1, 1, ['c']]);
});

test('вивід періоду, схожий на погодження поза періодом, — серед «без погодження», з підказкою', () => {
  const a = WD.parseApproval(reg('z', '2026-10-28', 'Цвях Богдан', '% менеджера Цвях за період з 19-25.10', 2170));
  a.report = false;
  const sm = WD.summary(WD.match([a], [WD.parseWithdrawal(item(5, 'm', 'Цвях Богдан', 2000, SV, '2026-11-01'))]), '2026-11-01', '2026-11-30');
  assert.deepEqual([sm.n, sm.extra, sm.extraList[0].w.id, sm.extraList[0].near.a.key], [0, 1, 5, 'z']);
});

test('ім\'я в погодженні: «Сидорук Тарас» не бере вивід «Сидорук Інесси» (випадок 04.11.2026); ініціал — перша літера; без імені — за прізвищем', () => {
  const ws = [item(25597, 'm', 'Сидорук Інесса Артемівна', 7938, SV, '2026-11-02'), item(25598, 'm', 'Сидорук Тарас Артемович', 6100, SV, '2026-11-02')].map(WD.parseWithdrawal);
  const a = WD.parseApproval(reg('t', '2026-11-01', 'Сидорук Тарас', '% менеджера за період з 19-25.10', 7938));
  assert.deepEqual([a.person, a.pfirst], ['сидорук', 'тарас'], 'ім\'я — з отримувача');
  const res = WD.match([a], ws);
  assert.deepEqual([res.rows[0].status, res.rows[0].cands.map(w => w.id)], ['diff', [25598]], 'вивід Тараса є, але на іншу суму');
  assert.deepEqual(res.extra.map(w => w.id), [25597], 'вивід Інесси — без погодження');
  const b = WD.parseApproval(reg('b', '2026-11-01', 'Сидорук', '% м-ра Сидорук І. за період з 19-25.10', 7938));
  assert.equal(b.pfirst, 'и', 'ініціал з крапкою');
  assert.deepEqual(WD.match([b], ws).rows[0].items.map(w => w.id), [25597]);
  const c = WD.parseApproval(reg('c', '2026-11-01', 'Сидорук', '% менеджера Сидорук за період з 19-25.10', 7938));
  assert.equal(c.pfirst, '');
  assert.deepEqual(WD.match([c], ws).rows[0].items.map(w => w.id), [25597]);
  assert.equal(WD.parseApproval(reg('d', '2026-11-01', 'Х', '% м-ра  Мартиненко Святослав, тімлід Терещенко.  за період', 100)).pfirst, 'святослав');
  assert.equal(WD.parseApproval(reg('e', '2026-11-01', 'Х', '% м-рів тімліда Копинецька І.  за період з 12-25.10', 100)).lfirst, 'и');
});

test('свіже погодження без виводу — «чекаємо», не «виводу немає» (не в лічильнику); через 4 дні — уже «немає»', () => {
  const a = () => WD.parseApproval(reg('w', '2026-11-03', 'Цвях Богдан', '% менеджера Цвях за період з 26.10-01.11', 2170));
  const fresh = WD.match([a()], [], { today: '2026-11-04' });
  assert.equal(fresh.rows[0].status, 'wait');
  const sm = WD.summary(fresh, '2026-11-01', '2026-11-30');
  assert.deepEqual([sm.none, sm.wait, sm.bad.length], [0, 1, 1]);
  assert.equal(WD.match([a()], [], { today: '2026-11-07' }).rows[0].status, 'none');
  assert.equal(WD.match([a()], []).rows[0].status, 'none', 'без today — як раніше');
});

test('погодження, внесене реєстром на всю суму, без виводу — гаразд (витрата є), з виводом — двічі', () => {
  const a = () => WD.parseApproval(reg('r', '2026-10-15', 'Копинецька', '% м-ра Копинецька за період', 5000, { id: 778 }));
  const no = WD.match([a()], []);
  assert.deepEqual([no.rows[0].status, no.rows[0].how, WD.summary(no).double.length], ['ok', 'registry', 0]);
  const yes = WD.match([a()], [WD.parseWithdrawal(item(6, 'm', 'Копинецька Інесса', 5000, SV, '2026-10-16'))]);
  assert.deepEqual([yes.rows[0].how, WD.summary(yes).double.length], ['person', 1]);
});
