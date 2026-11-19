/* =====================================================================
   Виводи з балансу менеджерів і тімлідів ↔ погодження «% менеджера / м-рів / тімліда».
   CRM: кожне підтвердження виведення у вкладці «Баланс» — окремий автоматичний запис кешфлоу:
   «Підтвердження виведення коштів з балансу менеджера|тімліда <ПІБ> від ДД.ММ.РРРР по проекту <країна> на суму N грн».
   Погодження (реєстр, дія bank): «% менеджера X», «% м-ра X, тімлід Y», «% м-рів (та) тімліда Y», «% менеджерів тімлід Y»,
   «% Тл. Y і команди»… Сума — на руки (з 05.10.2026; раніше «разом з податками»: на руки / 0,9, інколи ще + 1 грн).
   Командний рядок — це вивід тімліда і виводи його менеджерів: приклад: «Малигин 56 000» = 22 000 (тімлід) + 13 000 + 6 000 +
    6 000 + 9 000. Склад команди CRM не віддає, тож він знаходиться за сумою (набір виводів, що дає рівно суму погодження, —
   лише якщо такий набір один) і запам'ятовується для наступних тижнів. Лише звірка: нічого не створює й не змінює.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CFWithdrawals = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const r2 = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
  const cents = x => Math.round(Number(x) * 100);
  const clean = s => String(s == null ? '' : s).replace(/[   ​]/g, ' ').replace(/\s+/g, ' ').trim();
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const TOL = 100; // копійок: «разом з податками» рахували з округленням, ±1 грн

  // ---------- імена ----------
  /* «Малигін» = «Малигин», «Соловьев» = «Соловьєв»: регістр, апостроф, і/и/ї/й, е/є/ё, г/ґ — однаково */
  const fold = s => clean(s).toLowerCase().replace(/[’ʼ'`]/g, '').replace(/[іїйиы]/g, 'и').replace(/[єёэ]/g, 'е').replace(/ґ/g, 'г');
  const words = s => fold(s).split(/[^a-zа-я]+/).filter(w => w.length >= 3);
  // відстань Дамерау — Левенштейна ≤ 1: заміна, вставка, видалення чи перестановка сусідніх («Меліксетян» / «Мелікестян»)
  function near1(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) {
      if (a.slice(i + 1) === b.slice(i + 1)) return true;
      return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
    }
    const [s, l] = a.length < b.length ? [a, b] : [b, a];
    return s.slice(i) === l.slice(i + 1);
  }
  /* те саме прізвище (вже fold): однаково; відмінок — різниця лише в закінченні з голосних (і -м, -х): «Порфирова» / «Порфиров»,
     «Копинецька» / «Копинецької», «Божко» / «Божка», але «Пархович» ≠ «Пархова»; одна помилка — від 6 літер («Рахманов» / «Рохманов») */
  const END = /^[аеиоуяюмх]{0,3}$/;
  function sameName(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    let p = 0;
    while (p < s.length && s[p] === l[p]) p++;
    if (s.length >= 5 && p >= 4 && p >= s.length - 1 && /^[аеиоуяю]?$/.test(s.slice(p)) && END.test(l.slice(p))) return true;
    return s.length >= 6 && near1(a, b);
  }
  const hasName = (ws, key) => ws.some(w => sameName(w, key));

  // ---------- записи CRM ----------
  const WD_RE = /виведення коштів з балансу\s+(менеджера|т[іи]мліда|\S+)\s+(.+?)\s+від\s+(\d{2})\.(\d{2})\.(\d{4})\s+по проекту\s+(.+?)\s+на суму/i;
  /* запис кешфлоу (рух рахунку: {id, date, amount, comment, acc, opc}) → вивід {id, date, acc, amount (>0), role: lead|manager, name, ws, prj}
     або null. Позначки «(ТЛ)», «- ТЛ» у імені прибираються. */
  function parseWithdrawal(x) {
    if (!x || (x.opc != null && Number(x.opc) !== 2)) return null;
    const m = WD_RE.exec(clean(x.comment));
    if (!m) return null;
    const name = clean(m[2].replace(/\(\s*тл\s*\)|[-–—]?\s*(?<![\p{L}])тл(?![\p{L}])/giu, ' ')).replace(/[\s\-–—]+$/, '');
    return { id: x.id, date: x.date || `${m[5]}-${m[4]}-${m[3]}`, acc: x.acc != null ? Number(x.acc) : null, amount: r2(Math.abs(Number(x.amount))),
      role: /^т[іи]мліда$/i.test(m[1]) ? 'lead' : 'manager', name, ws: words(name), prj: clean(m[6]) };
  }

  // ---------- погодження ----------
  // «% м-ра», «% менеджерів», «% тімліда», «% … за період» — % з балансу; «% РОП» реєстр вносить на всю суму — не вивід
  // «тл» — межа слова Unicode (\b без прапорця u кирилиці не знає, і «% Тл. Малигин і команди» не розпізнавалось)
  const PCT_RE = /%\s?(м-р|менедж|т[іи]млід|тл(?!\p{L})|[^\d%]{2,40}за період)|виведення коштів з балансу менеджера/iu;
  const ROP_RE = /%\s?роп(?![а-яіїєґ])/i;
  const PLURAL_RE = /м-рів|менеджерів|команд/i;
  const STOP = new Set(['за', 'та', 'і', 'и', 'з', 'по', 'команди', 'команда', 'період', 'разом']);
  /* перше слово з великої літери після ключового (у тексті як є): «тімліда Копинецька І.» → «Копинецька» */
  function nameAfter(text, kw) {
    kw.lastIndex = 0;
    let m;
    while ((m = kw.exec(text))) {
      const w = /^[\s.,:]*(?:команди\s+)?([^\s,.;:()]+)/i.exec(text.slice(m.index + m[0].length));
      if (w && /^\p{Lu}/u.test(w[1]) && !STOP.has(fold(w[1]))) return w[1];
    }
    return '';
  }
  /* ім'я після прізвища key (fold) у тексті: «% менеджера Сидорук Тарас» → «тарас», «Копинецька І.» → «и» (ініціал), «Мартиненко
     Святослав, тімлід …» → «святослав»; наступне слово з малої літери чи службове («ТЛ», «тімлід») — '' (ім'я невідоме) */
  const NOT_NAME = /^(?:т[іи]млід|тл|м-р|менедж|команд)/i;
  function nextName(text, key) {
    if (!key) return '';
    const ws = clean(text).split(/[\s,;:()]+/).filter(Boolean);
    for (let i = 0; i < ws.length; i++) {
      if (!sameName(fold(ws[i]).replace(/[^a-zа-я]/g, ''), key)) continue;
      const raw = ws[i + 1] || '', nx = raw.replace(/\.+$/, '');
      if (!nx || !/^\p{Lu}/u.test(nx) || NOT_NAME.test(nx)) return '';
      const f = fold(nx).replace(/[^a-zа-я]/g, '');
      if (f.length === 1) return /\.$/.test(raw) ? f : ''; // ініціал — лише з крапкою («І.»; «І» без крапки може бути й сполучником)
      return STOP.has(f) ? '' : f;
    }
    return '';
  }
  const LEAD_KW = /(?<![\p{L}])(?:т[іи]млід\p{L}*|тл)\.?/giu;
  const TEAM_KW = /(?<![\p{L}])команд\p{L}*/giu;
  const PERSON_KW = /(?<![\p{L}])(?:м-ра|менеджера|менеджер|т[іи]мліда)(?![\p{L}])/giu;
  /* рядок реєстру (regCompact_: {key, date, recipient, content, textAmount, acc, id, action, status, share, tax, bank}) → погодження
     {key, date, recipient, content, amount, targets (копійки: на руки; «разом з податками» — ще × 0,9 і (− 1) × 0,9), team, person,
     lead, pfirst / lfirst (ім'я людини / тімліда, якщо є в тексті чи отримувачі: «Сидорук Тарас» — не вивід «Сидорук Інесси»), acc, id,
     entered (реєстр уже вніс рядок на всю суму)} або null (не % з балансу) */
  function parseApproval(r) {
    if (!r || r.tax || r.bank) return null;
    const text = clean(r.content), rec = clean(r.recipient);
    if (!PCT_RE.test(text) || ROP_RE.test(text)) return null;
    const a = Number(r.textAmount != null ? r.textAmount : r.amount);
    if (!(a > 0)) return null;
    const gross = /разом з податками/i.test(text);
    const targets = gross ? [cents(a), cents(a * 0.9), cents((a - 1) * 0.9)] : [cents(a)];
    const team = PLURAL_RE.test(text);
    const lead = nameAfter(text, LEAD_KW) || nameAfter(text, TEAM_KW);
    const person = team ? '' : nameAfter(text, PERSON_KW);
    const recKey = words(rec)[0] || '';
    const pk = fold(person).replace(/[^a-zа-я]/g, '') || (!team ? recKey : ''), lk = fold(lead).replace(/[^a-zа-я]/g, '') || (team ? recKey : '');
    // допуск ±1 грн — лише «разом з податками» (там рахували з округленням); на руки — до копійки: 9 999,01 за погодження 10 000 — розбіжність
    return { key: r.key, date: r.date, recipient: rec, content: text, amount: r2(a), gross, targets, tol: gross ? TOL : 0, team, person: pk, lead: lk,
      pfirst: nextName(text, pk) || nextName(rec, pk), lfirst: nextName(text, lk) || nextName(rec, lk),
      recKey, acc: r.acc != null ? Number(r.acc) : null, id: Number(r.id) || 0, entered: !!(Number(r.id) && !r.share) };
  }

  // ---------- набір виводів на суму ----------
  /* Набори items (у кожного c — копійки), сума яких дорівнює будь-якій із targets (± tol копійок; без tol — ± TOL). Пошук із відсіканням;
     рахується до cap наборів (2 — щоб побачити неоднозначність). → {count, sol: [items], over: true — забагато варіантів} */
  function subsets(items, targets, cap, maxNodes, tol) {
    cap = cap || 2; maxNodes = maxNodes || 400000; tol = tol == null ? TOL : tol;
    const xs = items.slice().sort((p, q) => q.c - p.c), n = xs.length, suf = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) suf[i] = suf[i + 1] + xs[i].c;
    const lo = Math.min(...targets) - tol, hi = Math.max(...targets) + tol, hit = s => targets.some(t => Math.abs(s - t) <= tol);
    let count = 0, sol = null, nodes = 0, over = false;
    const pick = [];
    (function dfs(i, s) {
      if (count >= cap || over) return;
      if (++nodes > maxNodes) { over = true; return; }
      if (hit(s)) { count++; if (!sol) sol = pick.slice(); return; }
      if (i >= n || s > hi || s + suf[i] < lo) return;
      pick.push(xs[i]);
      dfs(i + 1, s + xs[i].c);
      pick.pop();
      dfs(i + 1, s);
    }(0, 0));
    return { count, sol: sol || [], over };
  }

  /* Зіставлення. approvals — parseApproval (з report: true — показувати; false — лише щоб не вважати їхні виводи «без погодження»);
     withdrawals — parseWithdrawal; opts.teams — {тімлід (fold): [прізвища менеджерів]} з минулих звірок; opts.before / after — вікно
     дат виводу відносно дати погодження (дні, за замовчуванням 3 / 10). Спершу — найближчі дні (від дня до погодження до 3 днів
     після: зазвичай виводять того ж чи наступного дня), потім усе вікно: у місяці кілька тижневих наборів виводів тих самих людей.
     У кожному вікні: людина (вивід цієї людини на ту саму суму, до 4 частин) → команда за запам'ятаним складом → команда за сумою
     (лише однозначний набір; спершу рядки, де є вивід самого тімліда, і той самий рахунок, що в нього; поки щось знаходиться) → ще
     раз, дозволивши вивід іншого тімліда (у погодженні отримувач — не тімлід, а той, через кого платять).
     Людина — за прізвищем, а якщо в погодженні є ім'я (pfirst / lfirst) — і за ним: «Сидорук Тарас» не бере вивід «Сидорук Інесси».
     opts.today (рррр-мм-дд): погодження без виводу, якому щонайбільше opts.wait днів (3), — «wait» (вивід ще можуть зробити), не «none».
     → {rows: [{a, status: ok|diff|ambig|none|wait, how: person|learned|team, items, sum, cands}], extra: [виводи без погодження], teams} */
  function match(approvals, withdrawals, opts) {
    opts = opts || {};
    const before = opts.before == null ? 3 : opts.before, after = opts.after == null ? 10 : opts.after;
    const waitFrom = opts.today ? addDays(opts.today, -(opts.wait == null ? 3 : opts.wait)) : null;
    /* ім'я з погодження: решта слів виводу (крім прізвища) мають його містити; ініціал — перша літера; у виводі лише прізвище — гаразд.
       Ім'я порівнюється м'яко — лише щоб не сплутати різних людей з одним прізвищем: «Даниїл» = «Данил», «Микита» = «Никита» */
    const sameFirst = (x, f) => (f.length === 1 ? x[0] === f : x.slice(0, 4) === f.slice(0, 4) || sameName(x, f) || (Math.min(x.length, f.length) >= 4 && near1(x, f)));
    const firstOk = (w, key, first) => {
      if (!first) return true;
      const rest = w.ws.filter(x => !sameName(x, key));
      return !rest.length || rest.some(x => sameFirst(x, first));
    };
    const isWho = (w, key, first) => hasName(w.ws, key) && firstOk(w, key, first);
    const W = (withdrawals || []).map(w => ({ ...w, c: cents(w.amount) })).sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
    const used = new Set(), learned = {};
    Object.entries(opts.teams || {}).forEach(([k, v]) => { learned[k] = (v || []).slice(); });
    const rows = (approvals || []).map(a => ({ a, status: null, how: null, items: [], sum: 0, cands: [], ambig: false }))
      .sort((p, q) => (p.a.date < q.a.date ? -1 : p.a.date > q.a.date ? 1 : 0));
    const take = (row, items, how) => {
      items.forEach(w => used.add(w));
      Object.assign(row, { status: 'ok', how, items: items.slice().sort((p, q) => q.c - p.c), sum: r2(items.reduce((s, w) => s + w.amount, 0)) });
    };
    const leadOf = row => row.a.lead || row.a.person, leadFirst = row => (row.a.lead ? row.a.lfirst : row.a.pfirst);
    const tolOf = row => (row.a.tol != null ? row.a.tol : row.a.gross ? TOL : 0);
    // виводи тімліда — найближчого дня у вікні (ws — за датою): у ширшому вікні є й вивід наступного тижня
    const leadW = (row, ws) => { const t = ws.filter(w => w.role === 'lead' && isWho(w, leadOf(row), leadFirst(row))); return t.filter(w => w.date === (t[0] || {}).date); };
    // командний рядок: вивід тімліда + виводи менеджерів; рядок «% менеджера» тімліда (за отримувачем) — теж може бути командним
    const isTeam = row => row.a.team || leadW(row, W).length > 0;
    let win = null;
    for (const [b, f] of [[Math.min(1, before), Math.min(3, after)], [before, after]]) {
      win = a => W.filter(w => !used.has(w) && w.date >= addDays(a.date, -b) && w.date <= addDays(a.date, f));
      // 1) людина: її виводи на ту саму суму (один чи кілька, до 4)
      for (const row of rows) {
        const key = row.a.person || row.a.lead, first = row.a.person ? row.a.pfirst : row.a.lfirst;
        if (row.status || !key) continue;
        const own = win(row.a).filter(w => isWho(w, key, first));
        if (!own.length) continue;
        const s = subsets(own.slice(0, 12), row.a.targets, 2, 0, tolOf(row));
        if (s.count === 1 && s.sol.length <= 4) take(row, s.sol, 'person');
        else if (s.count > 1) take(row, s.sol.slice().sort((p, q) => p.date < q.date ? -1 : 1), 'person'); // однакові виводи — бере будь-який
      }
      // 2) команда за запам'ятаним складом
      for (const row of rows) {
        if (row.status || !isTeam(row)) continue;
        const lk = leadOf(row), mem = lk && learned[lk];
        if (!mem || !mem.length) continue;
        const ws = win(row.a), tl = leadW(row, ws), ms = ws.filter(w => w.role === 'manager' && mem.some(k => hasName(w.ws, k)));
        const s = subsets(ms, row.a.targets.map(t => t - tl.reduce((x, w) => x + w.c, 0)), 2, 0, tolOf(row));
        if (s.count === 1) take(row, tl.concat(s.sol), 'learned');
      }
      // 3) команда за сумою: однозначний набір; повторювати, поки знаходиться (кожен знайдений звужує вибір для інших).
      // Рядок, де вивід тімліда є, — першим: набір, що випадково дає суму рядка без виводів, не забере чужих менеджерів
      for (const others of [false, true]) {
        for (const needTl of [true, false]) {
          for (let found = true; found;) {
            found = false;
            for (const row of rows) {
              if (row.status || !isTeam(row)) continue;
              const ws = win(row.a), tl = leadW(row, ws), base = tl.reduce((x, w) => x + w.c, 0);
              if (needTl && !tl.length) continue;
              const pool = ws.filter(w => !tl.includes(w) && (w.role === 'manager' || others));
              const tg = row.a.targets.map(t => t - base);
              const acc = tl.length ? tl[0].acc : row.a.acc;
              let s = acc != null ? subsets(pool.filter(w => w.acc === acc), tg, 2, 0, tolOf(row)) : { count: 0, sol: [] };
              if (s.count === 0) s = subsets(pool, tg, 2, 0, tolOf(row));
              if (s.count === 1 && !s.over) { take(row, tl.concat(s.sol), 'team'); found = true; }
              else if (s.count > 1 || s.over) row.ambig = true;
            }
          }
        }
      }
    }
    // 4) решта: що є в цієї людини / тімліда (не забирається), інакше «виводу немає» / «кілька варіантів»
    for (const row of rows) {
      if (row.status) continue;
      const key = leadOf(row), ws = win(row.a);
      row.cands = key ? ws.filter(w => isWho(w, key, leadFirst(row))) : [];
      row.sum = r2(row.cands.reduce((s, w) => s + w.amount, 0));
      row.status = row.ambig ? 'ambig' : row.cands.length ? 'diff' : 'none';
      // виводу немає, але реєстр уніс погодження на всю суму — витрата в кешфлоу є, лише не через «Баланс»
      if (row.status === 'none' && row.a.entered) Object.assign(row, { status: 'ok', how: 'registry' });
      // свіже погодження: вивід зазвичай роблять того ж чи наступного дня — ще чекаємо
      else if (row.status === 'none' && waitFrom && row.a.date >= waitFrom) row.status = 'wait';
    }
    // склад команд — на наступні звірки (лише однозначно знайдені за сумою чи підтверджені)
    for (const row of rows) {
      if (row.status !== 'ok' || (row.how !== 'team' && row.how !== 'learned')) continue;
      const lk = leadOf(row), ms = row.items.filter(w => w.role === 'manager').map(w => w.ws[0]).filter(Boolean);
      if (lk && ms.length) learned[lk] = [...new Set(ms)];
    }
    const shown = new Set(rows.flatMap(r => r.cands));
    // free — усі незабрані виводи (summary покаже й ті, що схожі на погодження поза періодом)
    return { rows, extra: W.filter(w => !used.has(w) && !shown.has(w)), free: W.filter(w => !used.has(w)), teams: learned };
  }

  /* Підсумок для розділу, «Закриття місяця» й лічильника: погодження з a.report !== false; виводи за період без погодження —
     незабрані й не показані біля погодження періоду (near — погодження поза періодом, на яке вивід схожий, або null).
     wait — свіжі погодження без виводу (не розбіжність: не в none і не в лічильнику; у bad — щоб їх було видно в списку). */
  function summary(res, from, to) {
    const rep = res.rows.filter(r => r.a.report !== false), seen = new Set(rep.flatMap(r => r.cands));
    const ex = (res.free || res.extra).filter(w => !seen.has(w) && (!from || w.date >= from) && (!to || w.date <= to))
      .map(w => ({ w, near: res.rows.find(r => r.cands.includes(w)) || null }));
    const by = st => rep.filter(r => r.status === st);
    return { n: rep.length, ok: by('ok').length, diff: by('diff').length, none: by('none').length, ambig: by('ambig').length, wait: by('wait').length, extra: ex.length,
      approved: r2(rep.reduce((s, r) => s + r.a.amount, 0)), withdrawn: r2(rep.reduce((s, r) => s + (r.status === 'ok' ? r.sum : 0), 0)),
      bad: rep.filter(r => r.status !== 'ok'), extraList: ex, double: rep.filter(r => r.status === 'ok' && r.a.entered && r.how !== 'registry') };
  }

  return { parseWithdrawal, parseApproval, match, summary, subsets, sameName, fold, words };
}));
