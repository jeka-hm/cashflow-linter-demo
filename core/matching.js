/* =====================================================================
   «Зіставлення ШІ» у «Звірці з банком» (05.11.2026): операції банку за період ↔ погодження реєстру ↔ записи CRM.
   Спершу без ШІ — за сумою, датою й рахунком:
     • ЗП одним переказом на транзитний рахунок («пакет» Привату на N карток) — погодження на руки N людей, що разом дають суму
       пакета до копійки; одна людина може отримати кілька погоджень на одну картку (приклад: пакет на 3 картки —
       двоє людей мають по два погодження, третя людина — одне). Спершу той самий рахунок, потім інші рахунки тієї самої
       фірми (погодження «з 8112», а заплатили пакетом з 8296); спершу рівно N людей, потім менше (тімлід-отримувач погодження
       за кількох людей). Лише якщо такий набір один (кілька — «неоднозначно»: вирішує ШІ чи людина);
     • ЗП за день разом (16.11.2026): усі пакети рахунку за день = усі вільні погодження цього дня до копійки (з «% менеджера» через
       зарплатний проєкт) — пакети беруть їх без поділу по людях; кілька пакетів — кожен свій набір, якщо поділ один;
     • інша витрата — одне погодження з тією самою сумою (спершу той самий рахунок і найближча дата);
     • податки із ЗП (ПДФО, ВЗ, ЄСВ одного дня й місяця) — група з підсумком: у CRM їх розносять по людях.
   Що лишилось, — ШІ через «Помічник кешфлоу» (aiPayload → Claude → aiApply): лише підказки, нічого не змінюється.
   Чисті функції; показ — ui/bank-panel.js.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CFMatch = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const cents = v => Math.round(Number(v) * 100);
  const r2 = v => Math.round(Number(v) * 100) / 100;
  const dayDiff = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 864e5);

  /* Набори рівно з k елементів items ({c — копійки}) із сумою target (копійки); без k — найменший розмір від 1 до maxK.
     Рахується до cap наборів (2 — щоб побачити неоднозначність). → {count, sol, size, over — забагато варіантів, не дорахував} */
  function packs(items, target, k, o) {
    o = o || {};
    const cap = o.cap || 2, maxNodes = o.maxNodes || 200000, maxK = o.maxK || 8;
    const xs = (items || []).filter(x => x.c > 0 && x.c <= target).sort((p, q) => q.c - p.c), n = xs.length, pre = [0];
    xs.forEach((x, i) => { pre[i + 1] = pre[i] + x.c; });
    let nodes = 0, over = false;
    for (const size of k ? [k] : Array.from({ length: maxK }, (_, i) => i + 1)) {
      if (size > n) break;
      let count = 0, sol = null;
      const pick = [];
      (function dfs(i, s) {
        if (count >= cap || over) return;
        if (++nodes > maxNodes) { over = true; return; }
        const left = size - pick.length;
        if (!left) { if (s === target) { count++; if (!sol) sol = pick.map(j => xs[j]); } return; }
        for (let j = i; j <= n - left; j++) {
          if (s + pre[j + left] - pre[j] < target) break; // навіть найбільші з решти не дотягують (далі — лише менші)
          const s2 = s + xs[j].c;
          if (left > 1 && s2 + pre[n] - pre[n - left + 1] > target) continue; // навіть з найменшими рештою — забагато
          pick.push(j);
          dfs(j + 1, s2);
          pick.pop();
          if (count >= cap || over) return;
        }
      }(0, 0));
      if (count || over) return { count, sol: sol || [], size, over };
    }
    return { count: 0, sol: [], size: 0, over };
  }

  /* Хто отримує погодження: слова імені (від 3 літер, без регістру й апострофів). Погодження однієї людини — одна група: однакові
     слова чи одне ім'я містить усі слова іншого («Хоменко» = «Хоменко Всеволод»); спільне слово має бути від 4 літер, а якщо
     підходить кілька груп («Андрій» → «Андрій Полуботко» і «Андрій Балух») — окрема група. Без отримувача — кожне окремо. */
  const whoWords = s => String(s || '').toLowerCase().replace(/[’ʼ`']/g, '').split(/[^\p{L}]+/u).filter(w => w.length >= 3);
  /* Чи названо когось з names (отримувач погодження, контрагент банку) у тексті text (18.11.2026): спільне слово від 4 літер — однакове
     чи з тим самим початком без відмінкового закінчення («Гурський» = «Гурського»); латинська «i» в кириличних словах виписки — «і».
     → скільки слів збіглося (0 — нікого) */
  const nameWords = s => whoWords(String(s || '').replace(/i/g, 'і').replace(/I/g, 'І')).filter(w => w.length >= 4);
  function nameHits(names, text) {
    const a = [...new Set(nameWords(names))], b = [...new Set(nameWords(text))];
    const same = (x, y) => { if (x === y) return true; const n = Math.max(4, Math.min(x.length, y.length) - 2); return x.slice(0, n) === y.slice(0, n) && Math.abs(x.length - y.length) <= 3; };
    return a.filter(x => b.some(y => same(x, y))).length;
  }
  function people(items) {
    const gs = [];
    // спершу повні імена, потім короткі: інакше «Андрій», що трапився раніше за «Андрій Балух», приєднувався до єдиного вже
    // знайденого «Андрій Полуботко», і чи пакет однозначний, залежало від порядку рядків реєстру
    const order = (items || []).map((it, i) => ({ it, i, n: whoWords(it.a && it.a.recipient).length })).sort((p, q) => q.n - p.n || p.i - q.i);
    for (const { it } of order) {
      const w = new Set(whoWords(it.a && it.a.recipient));
      const sub = (x, y) => [...x].every(v => y.has(v)) && [...x].some(v => v.length >= 4);
      const hit = w.size ? gs.filter(g => g.w.size && (sub(w, g.w) || sub(g.w, w))) : [];
      if (hit.length === 1) { hit[0].list.push(it); if (w.size > hit[0].w.size) hit[0].w = w; }
      else gs.push({ w, list: [it] });
    }
    return gs;
  }
  /* Пакет ЗП на cards карток: набір людей (people), від кожної — одне чи кілька її погоджень, сума — target (копійки).
     exact: рівно cards людей; інакше — менше людей, але погоджень щонайменше cards (тімлід отримує погодження за свою команду).
     Варіанти однієї людини з тими самими сумами погоджень (одна з трьох премій по 13 500) — один варіант: для пакета байдуже, котре
     з однакових; а 100 + 400 і 200 + 300 — різні (у тімліда це різні люди команди) → «неоднозначно».
     → {count (до cap), sol: [item], over — забагато варіантів, не дорахував} */
  function packPeople(items, target, cards, o) {
    o = o || {};
    const cap = o.cap || 2, maxNodes = o.maxNodes || 300000, exact = o.exact !== false, maxSub = o.maxSub || 12;
    if (!(cards > 0) || !(target > 0)) return { count: 0, sol: [], over: false };
    /* в однієї людини погоджень більше, ніж перебирається (maxSub): решту раніше мовчки відкидали (8 — а «Терещенко» 05.11.2026 мав 9, з
       13.11 — 12), тож набір з дев'ятим погодженням не знаходився, а знайдений міг бути не єдиним. Тепер це «не дорахував» (over, big) —
       16.11.2026 */
    let big = false;
    const gs = people((items || []).filter(x => x.c > 0 && x.c <= target)).map(g => {
      if (g.list.length > maxSub) big = true;
      const xs = g.list.slice(0, maxSub), seen = new Map();
      for (let mask = 1; mask < 1 << xs.length; mask++) {
        let c = 0;
        const list = [];
        xs.forEach((x, i) => { if (mask & (1 << i)) { c += x.c; list.push(x); } });
        const k = list.map(x => x.c).sort((p, q) => p - q).join(',');
        if (c <= target && !seen.has(k)) seen.set(k, { c, list });
      }
      const opts = [...seen.values()].sort((p, q) => q.c - p.c);
      return { opts, max: opts.length ? opts[0].c : 0 };
    }).filter(g => g.opts.length).sort((p, q) => q.max - p.max);
    const n = gs.length, maxG = exact ? cards : cards - 1;
    if (!maxG || n < (exact ? cards : 1)) return { count: 0, sol: [], over: big, big };
    const pre = [0];
    gs.forEach((g, i) => { pre[i + 1] = pre[i] + g.max; });
    const best = (j, k) => pre[Math.min(n, j + k)] - pre[j]; // найбільше, що дадуть k людей, починаючи з j-ї (групи — за спаданням max)
    let nodes = 0, over = false, count = 0, sol = null;
    const pick = [];
    (function dfs(i, s, g, nAp) {
      if (count >= cap || over) return;
      if (++nodes > maxNodes) { over = true; return; }
      if (s === target) {
        if (exact ? g === cards : nAp >= cards) { count++; if (!sol) sol = pick.flatMap(p => p.list); }
        return;
      }
      if (g === maxG || (exact && n - i < cards - g)) return;
      for (let j = i; j < n; j++) {
        if (s + best(j, maxG - g) < target) break; // навіть найбільші з решти не дотягують
        if (exact && n - j < cards - g) break;
        for (const op of gs[j].opts) {
          if (s + op.c > target) continue;
          pick.push(op);
          dfs(j + 1, s + op.c, g + 1, nAp + op.list.length);
          pick.pop();
          if (count >= cap || over) return;
        }
      }
    }(0, 0, 0, 0));
    return { count, sol: sol || [], over: over || big, big };
  }
  /* Набори будь-якого розміру з items ({c — копійки}) на суму target; погодження з однаковою сумою взаємозамінні (один набір, а не
     кілька). Для поділу погоджень дня між пакетами того самого дня (dayTotal). → {count (до cap), sol, over} */
  function sums(items, target, o) {
    o = o || {};
    const cap = o.cap || 2, maxNodes = o.maxNodes || 300000;
    const xs = (items || []).filter(x => x.c > 0 && x.c <= target).sort((p, q) => q.c - p.c), n = xs.length, suf = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) suf[i] = suf[i + 1] + xs[i].c;
    let nodes = 0, over = false, count = 0, sol = null;
    const pick = [];
    (function dfs(i, s) {
      if (count >= cap || over) return;
      if (++nodes > maxNodes) { over = true; return; }
      if (s === target) { count++; if (!sol) sol = pick.slice(); return; }
      if (s + suf[i] < target) return;
      for (let j = i; j < n; j++) {
        if ((j > i && xs[j].c === xs[j - 1].c) || s + xs[j].c > target) continue;
        pick.push(xs[j]);
        dfs(j + 1, s + xs[j].c);
        pick.pop();
        if (count >= cap || over) return;
      }
    }(0, 0));
    return { count, sol: sol || [], over };
  }

  // податки із ЗП: місяць у призначенні («за жовтень 2026», «за 10 2026»)
  const MONTH = /за\s+(\p{L}+\s+\d{4}|\d{1,2}[.\s]+\d{4})/iu;
  /* Податки із ЗП (kind 'tax') — групи «рахунок | день | місяць у призначенні» з підсумком. → [{acc, date, month, items, total}] */
  function taxGroups(list) {
    const m = new Map();
    for (const b of list || []) {
      const month = ((MONTH.exec(b.text || '') || [])[1] || '').toLowerCase();
      const k = `${b.acc}|${b.date}|${month}`;
      if (!m.has(k)) m.set(k, { acc: b.acc, date: b.date, month, items: [], total: 0 });
      const g = m.get(k);
      g.items.push(b);
      g.total = r2(g.total + b.amount);
    }
    return [...m.values()];
  }

  /* bank — списання періоду [{id, acc, owner (фірма рахунку), date, amount (> 0), kind: 'pay' (ЗП на транзит) | 'tax' (податки із ЗП) |
     'exp', cards (карток у пакеті, 0 — невідомо), crm — пара в CRM чи null}]; ap — погодження реєстру [{key, acc, owner, date (оплати),
     amount (> 0, на руки), recipient, text, crmId (ID запису, якщо реєстр уже вніс), action}]. o — {back: днів погодження до оплати (7),
     ahead: після (1), payBack: для пакета ЗП (12)}.
     Погодження може мати zp (оплата через зарплатний проєкт) і pct («% менеджера» — на руки; лише для пакетів ЗП, не 1:1, і не
     серед free.ap: сам вивід — у «Виводах з балансу»).
     off — реєстр погодження не вносить («Вносити» = «ні»): лише пара з операцією свого рахунку, де названо отримувача (рядок off: true),
     серед free.ap таких немає.
     → {rows: [{bank, ap: [...], how: 'пакет' | '1:1', other: погодження з іншого рахунку, day: пакет зібрано «за день разом», off}],
        amb: [{bank, count, over, big: в однієї людини забагато погоджень, short: {have, miss} — погоджень дня менше, ніж у пакетах,
        none: погоджень дня немає}] — пакети без однозначного набору, taxes: групи податків,
        free: {bank: без погодження (крім податків), ap: погодження без операції}} */
  function match(bank, ap, o) {
    o = o || {};
    const back = o.back == null ? 7 : o.back, ahead = o.ahead == null ? 1 : o.ahead, payBack = o.payBack == null ? 12 : o.payBack;
    const used = new Set(), rows = [], amb = [];
    /* off — погодження, яке реєстр не вносить («Вносити» = «ні»: повернення коштів клієнтам тощо; 18.11.2026): у пакетах ЗП, «за день»
       і звичайних 1:1 участі не бере (A — без них) — лише окремий прохід нижче: той самий рахунок, сума, вікно й отримувач у виписці */
    const B = bank || [], A = (ap || []).filter(a => !a.off), OFF = (ap || []).filter(a => a.off);
    const inWin = (b, a) => dayDiff(b.date, a.date) >= -ahead && dayDiff(b.date, a.date) <= payBack;
    const done = new Map(), fail = new Map(); // пакет → пара; пакет → чому не розклався ({count, over, big, wide})
    const sumC = l => l.reduce((s, a) => s + cents(a.amount), 0);
    const take = (b, list, extra) => {
      list.forEach(a => used.add(a.key));
      const m = { bank: b, ap: list, how: 'пакет', other: list.some(a => a.acc !== b.acc), ...extra };
      rows.push(m); done.set(b, m); fail.delete(b);
    };
    /* Вільні погодження дня пакета: з того самого рахунку; якщо за ними не сходиться — зарплатного проєкту (zp: «зп ПРИКЛАД», «зп Маркет»)
       тієї самої фірми з будь-якого її рахунку (погодження «зп Маркет» записано на 8112, а пакет пішов з 8296). */
    /* Перший прохід «за день» (до 1:1) не бере погодження, для якого у виписці є своя звичайна операція з цією сумою: інакше дві
       оплати дня (оренда 30 000 + реклама 50 000) «склали» б пакет ЗП 80 000 без погоджень, а самі лишились би «без погодження» —
       і їх унесли б удруге (огляд 16.11.2026). Другий прохід (після 1:1) бачить лише те, що лишилось. */
    const has1 = a => B.some(x => x.kind === 'exp' && !done.has(x) && cents(x.amount) === cents(a.amount) && inWin(x, a));
    const dayPools = (b, first) => {
      const d = A.filter(a => !used.has(a.key) && a.date === b.date && (!first || a.pct || !has1(a)));
      return [d.filter(a => a.acc === b.acc), b.owner ? d.filter(a => a.zp && a.owner === b.owner) : []];
    };
    /* ЗП за день разом (16.11.2026): усі пакети рахунку за день = усі вільні погодження цього дня, до копійки. Погодження — рядками
       «кому погоджено», а не «на чию картку»: 05.11.2026 з ПРИКЛАД пішло два пакети (4 і 8 карток) за 25 погодженнями —
       отримувач-тімлід за команду, порожній отримувач («на картку Мефодієва як ЗП»), «% менеджерів» через зарплатний проєкт — і по
       людях (packPeople) таке не збирається. Один пакет бере всі погодження дня; кілька — кожен свій набір, якщо поділ один
       (від найменшого пакета; однакові суми взаємозамінні). Поділ не один чи суми дня не рівні — далі по людях (pack). */
    const dayTotal = first => {
      const groups = new Map();
      for (const b of B) if (b.kind === 'pay' && !done.has(b)) { const k = `${b.acc}|${b.date}`; groups.set(k, (groups.get(k) || []).concat(b)); }
      for (const G of groups.values()) {
        const total = sumC(G);
        for (const pool of dayPools(G[0], first)) {
          if (!pool.length || sumC(pool) !== total) continue;
          let rest = pool.map(a => ({ a, c: cents(a.amount) }));
          const left = G.slice().sort((p, q) => p.amount - q.amount), plan = [];
          while (left.length > 1) {
            const r = sums(rest, cents(left[0].amount), { maxNodes: o.maxNodes });
            if (r.count !== 1 || r.over) break;
            const s = new Set(r.sol);
            plan.push([left.shift(), r.sol]);
            rest = rest.filter(x => !s.has(x));
          }
          if (left.length === 1) { plan.push([left[0], rest]); plan.forEach(([b, l]) => take(b, l.map(x => x.a), { day: true })); }
          break;
        }
      }
    };
    /* Пакет з відомою кількістю карток — по людях (packPeople): той самий рахунок, потім рахунки тієї самої фірми; у кожному — спершу
       рівно cards людей, потім менше. Перший крок, де щось знайшлося, і вирішує: один набір — пара, кілька — «неоднозначно».
       Карток не видно — як було: найменший набір погоджень того самого рахунку (packs).
       Спершу — лише погодження дня пакета, і лише коли з них набору немає — за все вікно (16.11.2026): із давнішими погодженнями,
       які лишились вільними, пакет 11.11.2026 (44 000, одна картка) «знаходив» погодження іншої людини від 05.11, а пакет 13.11
       (169 400) — понад 50 випадкових наборів замість «за день бракує 26 400». */
    const tryPools = (b, free) => {
      const target = cents(b.amount), pools = [free.filter(a => a.acc === b.acc)];
      if (b.cards > 0 && b.owner) pools.push(free.filter(a => a.acc !== b.acc && a.owner === b.owner).concat(pools[0]));
      let r = { count: 0, sol: [], over: false };
      for (const pool of pools) {
        const items = pool.map(a => ({ a, c: cents(a.amount) }));
        for (const exact of b.cards > 0 ? [true, false] : [null]) {
          r = exact === null ? packs(items, target, 0, { maxNodes: o.maxNodes }) : packPeople(items, target, b.cards, { exact, maxNodes: o.maxNodes });
          if (r.count || r.over) break;
        }
        if (r.count || r.over) break;
      }
      return r;
    };
    const pack = b => {
      if (done.has(b)) return;
      const free = A.filter(a => !used.has(a.key) && inWin(b, a));
      let r = tryPools(b, free.filter(a => a.date === b.date)), wide = false;
      if (!r.count && !r.over) { r = tryPools(b, free); wide = true; }
      // пошук обірвався (over) — знайдений набір може бути не єдиним: «неоднозначно», а не пара (інакше операцію блоковано б
      // погодженнями інших людей, а погодження справжніх отримувачів лишились би вільними — і їх унесли б удруге)
      if (r.count === 1 && !r.over) take(b, r.sol.map(x => x.a));
      else fail.set(b, { count: r.count, over: r.over, big: !!r.big, wide });
    };
    const big = list => list.slice().sort((p, q) => q.amount - p.amount);
    // 0) ЗП за день разом; 1) пакети ЗП з відомою кількістю карток — найсильніша умова; 2) інші витрати — 1:1; 2а) ще раз «за день»
    // (1:1 забрало з рахунку звичайні оплати того дня — лишились погодження ЗП); 3) пакети, де карток не видно
    dayTotal(true);
    big(B.filter(b => b.kind === 'pay' && b.cards > 0)).forEach(pack);
    /* 1:1 — двома проходами: спершу всі операції з погодженнями свого рахунку, потім решта — з іншими рахунками (спершу тієї самої
       фірми, далі найближча дата). Одним проходом операція іншої фірми з тією самою сумою, що трапилась раніше, забирала погодження,
       чия пара на своєму рахунку теж є у виписці. */
    const exps = big(B.filter(x => x.kind === 'exp')), got1 = new Set();
    /* Запис CRM, з яким звірено операцію (crmIds — пара чи група «суми не 1:1»), — від погодження з тим самим ID: таке погодження
       береться першим, а погодження, чий запис звірено з іншою операцією, — останнім. Інакше дві однакові суми хрестились: внесене
       погодження діставалось чужій операції, а невнесене — операції, що вже є в CRM (08.11.2026). */
    const crmBank = new Map();
    for (const b of B) for (const id of crmIdsOf(b)) crmBank.set(id, b);
    const rank = (b, a) => (!a.crmId ? 1 : crmIdsOf(b).includes(a.crmId) ? 0 : crmBank.has(a.crmId) ? 2 : 1);
    /* Спершу — погодження, яких реєстр не вносить (off), з операцією свого рахунку: та сама сума, вікно й отримувач погодження названий у
       контрагенті чи призначенні (12.11.2026: «Гурський Олександр Олексійович — повернення коштів», 6 000,00 з «ФОП Хоменко приват»).
       Без цього операцію забирало погодження іншої людини з іншого рахунку з тією самою сумою, і «Внести в CRM» відсилало в «Погодження»,
       де такого рядка немає. Пара позначена off: вносити — у «Внести в CRM». Кілька — більше слів імені, далі найближча дата. */
    const bankWho = b => `${b.cpty || ''} ${b.text || ''}`;
    for (const b of exps) {
      const c = cents(b.amount);
      const cand = OFF.map(a => ({ a, n: used.has(a.key) || cents(a.amount) !== c || a.acc !== b.acc || dayDiff(b.date, a.date) < -ahead || dayDiff(b.date, a.date) > back ? 0 : nameHits(a.recipient, bankWho(b)) }))
        .filter(x => x.n > 0).sort((p, q) => q.n - p.n || Math.abs(dayDiff(b.date, p.a.date)) - Math.abs(dayDiff(b.date, q.a.date)));
      if (!cand.length) continue;
      used.add(cand[0].a.key);
      got1.add(b);
      rows.push({ bank: b, ap: [cand[0].a], how: '1:1', other: false, off: true });
    }
    /* Інший рахунок (другий прохід): сама сума — не пара, якщо отримувач погодження й контрагент банку — явно різні люди чи фірми:
       в обох є ім'я, і ні отримувача немає в контрагенті й призначенні, ні контрагента — в отримувачі й змісті погодження (18.11.2026:
       «Дмитро Кобзар», вивід з «ФОП Мазовецька», і повернення Гурському з «ФОП Хоменко» — обидва по 6 000,00). Таку операцію лишаємо
       без пари — вирішить ШІ чи людина. Свій рахунок (перший прохід) — як було: рахунок, сума й вікно. */
    const strangers = (b, a) => nameWords(a.recipient).length > 0 && nameWords(b.cpty).length > 0 && !nameHits(a.recipient, bankWho(b)) && !nameHits(b.cpty, `${a.recipient || ''} ${a.text || ''}`);
    for (const own of [true, false]) {
      for (const b of exps) {
        if (got1.has(b)) continue;
        const c = cents(b.amount);
        const cand = A.filter(a => {
          // «% менеджера» (pct) — лише в пакетах ЗП: сам вивід з балансу звіряють «Виводи з балансу»
          if (used.has(a.key) || a.pct || cents(a.amount) !== c || (a.acc === b.acc) !== own || (!own && strangers(b, a))) return false;
          const d = dayDiff(b.date, a.date);
          return d >= -ahead && d <= back;
        }).sort((p, q) => rank(b, p) - rank(b, q) || (b.owner && p.owner === b.owner ? 0 : 1) - (b.owner && q.owner === b.owner ? 0 : 1)
          || Math.abs(dayDiff(b.date, p.date)) - Math.abs(dayDiff(b.date, q.date)));
        if (!cand.length) continue;
        used.add(cand[0].key);
        got1.add(b);
        rows.push({ bank: b, ap: [cand[0]], how: '1:1', other: cand[0].acc != null && b.acc != null && cand[0].acc !== b.acc });
      }
    }
    dayTotal();
    big(B.filter(b => b.kind === 'pay' && !(b.cards > 0))).forEach(pack);
    /* Пакети, що не розклались: скільки погоджень дня лишилось вільними (have) проти нерозкладених пакетів цього рахунку й дня.
       short — погоджень дня менше, ніж у пакетах (13.11.2026: за день 143 000,00, пакет 169 400,00 — бракує 26 400,00: погодження ще
       з «Готівка» у «Звідки оплата»); показується, коли набору з погоджень дня немає (а «кілька наборів» дали давніші погодження).
       none — погоджень дня немає взагалі й набору немає: ЗП з відомості бухгалтерії (03.11.2026: одна сума «за вересень»). */
    for (const b of big(B.filter(x => x.kind === 'pay' && !done.has(x)))) {
      const f = fail.get(b) || { count: 0, over: false, big: false, wide: true };
      const pool = dayPools(b).find(p => p.length) || [], have = sumC(pool), need = sumC(B.filter(x => x.kind === 'pay' && !done.has(x) && x.acc === b.acc && x.date === b.date));
      const noDay = f.wide || (!f.count && !f.over);
      amb.push({ bank: b, count: f.count, over: f.over, big: f.big,
        short: noDay && have > 0 && have < need ? { have: r2(have / 100), miss: r2((need - have) / 100) } : null, none: !f.count && !f.over && !have });
    }
    const got = new Set(rows.map(m => m.bank));
    return { rows, amb, taxes: taxGroups(B.filter(b => b.kind === 'tax')),
      free: { bank: B.filter(b => b.kind !== 'tax' && !got.has(b)), ap: A.filter(a => !used.has(a.key) && !a.pct) } };
  }

  // ID записів CRM, з якими звірено операцію банку: crmIds (пара чи група «суми не 1:1», ЗП за день) або пара crm
  function crmIdsOf(b) { return b && b.crmIds && b.crmIds.length ? b.crmIds : b && b.crm && b.crm.id ? [b.crm.id] : []; }
  // стан погоджень пари в CRM: усі внесено (є ID запису), жодного, частково
  // «% менеджера» (pct) не рахується, якщо в парі є й звичайні погодження: реєстр вносить з нього лише податки, сам вивід створює CRM
  const crmState = aps => {
    const all = aps || [], own = all.filter(a => !a.pct), xs = own.length ? own : all, n = xs.filter(a => a.crmId).length;
    return n && n === xs.length ? 'в CRM' : n ? 'частково' : 'не внесено';
  };

  /* Що піде в ШІ: операції банку без пари в CRM і без погодження (і пакети ЗП, які не розклались однозначно) та погодження, що
     лишились. accName — назва рахунку. Не більше maxBank / maxAp (у Помічнику ще й приховуються номери). → {bank, approvals} */
  function aiPayload(res, accName, o) {
    o = o || {};
    const name = id => (id == null ? '' : accName ? accName(id) : String(id));
    const inAmb = new Set(((res && res.amb) || []).map(x => x.bank));
    const bank = ((res && res.free && res.free.bank) || []).filter(b => !b.crm || inAmb.has(b)).slice(0, o.maxBank || 80)
      .map(b => ({ id: b.id, date: b.date, amount: b.amount, acc: name(b.acc), cpty: b.cpty || '', text: b.text || '', kind: b.kind, ...(b.cards ? { cards: b.cards } : {}) }));
    const approvals = ((res && res.free && res.free.ap) || []).slice(0, o.maxAp || 200)
      .map(a => ({ key: a.key, date: a.date, amount: a.amount, acc: name(a.acc), recipient: a.recipient || '', text: a.text || '', entered: !!a.crmId }));
    return { bank, approvals };
  }

  /* Відповідь ШІ ([{bank, approvals: [ключі], confidence, why}]) → підказки лише з тим, що справді є серед залишку: кожне погодження —
     не більше ніж до однієї операції; різниця — сума банку мінус сума погоджень. → [{bank, ap, conf, why, diff}] */
  function aiApply(res, matches) {
    const byId = new Map(((res && res.free && res.free.bank) || []).map(b => [String(b.id), b]));
    const byKey = new Map(((res && res.free && res.free.ap) || []).map(a => [String(a.key), a]));
    const usedB = new Set(), usedA = new Set(), out = [];
    for (const m of Array.isArray(matches) ? matches : []) {
      const b = m && byId.get(String(m.bank));
      if (!b || usedB.has(b)) continue;
      const aps = [...new Set((Array.isArray(m.approvals) ? m.approvals : []).map(String))].map(k => byKey.get(k)).filter(a => a && !usedA.has(a.key));
      if (!aps.length) continue;
      usedB.add(b);
      aps.forEach(a => usedA.add(a.key));
      out.push({ bank: b, ap: aps, conf: ['висока', 'середня', 'низька'].includes(m.confidence) ? m.confidence : 'низька', why: String(m.why || '').slice(0, 300),
        diff: r2(b.amount - aps.reduce((s, a) => s + a.amount, 0)) });
    }
    return out;
  }

  return { packs, packPeople, sums, people, nameHits, match, taxGroups, crmState, crmIdsOf, aiPayload, aiApply, MONTH };
}));
