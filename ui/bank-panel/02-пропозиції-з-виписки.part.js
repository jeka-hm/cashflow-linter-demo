  // ---------- операції банку, яких немає в CRM: що створити ----------
  const SRC = { exp: 'витрата', fee: 'комісія банку', inc: 'надходження', pay: 'ЗП через транзитний рахунок' };
  // перевіряється на тексті з кирилицею замість латинських двійників (у Привату «Комiсiя», «Списання комiсiї» — з латинською «i»)
  // «Погашення простроченої заборгованості за РКО» — теж плата банку за обслуговування (07.11.2026)
  const FEE_RE = /^\s*(?:(?:списання\s+)?коміс|плата\s+за\s+(?:обслуг|рко|користув|розрахунк|ведення)|обслуговування\s+рахунк|абонентськ\p{L}*\s+плат|погашення\s+простроч\p{L}*\s+заборгован\p{L}*\s+за\s+рко)/iu;
  // зарплата в CRM — по людях за реєстром ЗП, еквайринг — оплати замовлень (ліди): суми не 1:1 з банком, тож запис не пропонується
  const PAYROLL_RE = /зарплат|заробітн|(?<![\p{L}\d])(?:з\s*\/\s*п|зп)(?![\p{L}\d])|для\s+виплат|мас\p{L}*\.?\s*вип|ціл\p{L}*[-\s.]*\p{L}*\s*зарах|поповн\p{L}*\s+(?:зп|карток)/iu;
  // «Оплата частинами» Привату (контрагент «Розрахунки "Оплата Частинами"», «Оплата частинами.Сума договору: 1279.20 грн…», зараховано
  // 1 233,15) — теж оплата замовлення без комісії банку, як LiqPay (огляд 16.11.2026); звичайне «оплата частинами» від клієнта сюди не входить
  const ACQ_RE = /еквайр|liqpay|wayforpay|fondy|portmone|interkassa|platon|stripe|paypal|відшкод\p{L}*\s+(?:за\s+)?(?:операц|торг)|оплат\p{L}*\s+частинами[\s.,:;]*сума\s+договор|розрахунки\s+[^\p{L}\d]*оплата\s+частинами/iu;
  const STOPW = new Set(['оплата', 'оплату', 'оплати', 'послуги', 'послуг', 'згідно', 'рахунок', 'рахунку', 'договір', 'договору', 'товар', 'товари', 'товарів', 'сума',
    'призначення', 'платежу', 'платіж', 'картка', 'картки', 'карткою', 'переказ', 'коштів', 'кошти', 'покупка', 'безготівкова', 'операція', 'payment', 'card', 'with', 'from']);
  const words = s => new Set((R.toCyr(String(s || '')).toLowerCase().replace(/[’ʼ`]/g, "'").match(/\p{L}[\p{L}'-]{3,}/gu) || []).filter(w => !STOPW.has(w)));
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  // коментар у CRM — один рядок: перенесення рядків з поля прибираються
  const oneLine = clean;
  // поле коментаря — на кілька рядків, щоб увесь текст було видно (≈ 34 знаки в рядку, 2–5 рядків)
  const comRows = s => Math.min(5, Math.max(2, Math.ceil(String(s || '').length / 34)));
  // висота поля за текстом (довгі номери й назви переносяться по-різному — рахується після розкладки; у схованому розділі — rows)
  function fitCom(e) {
    if (!e.offsetParent) return;
    e.style.height = 'auto';
    e.style.height = `${Math.min(e.scrollHeight + 2, 160)}px`;
  }
  /* усі поля разом: спершу всі «auto», потім усі виміри, потім усі висоти — дві розкладки сторінки на все, а не по чотири на кожне поле
     (на сотнях рядків «Внести в CRM» кожна зміна статті чи маркетолога гальмувала) */
  function fitComs(list) {
    const vis = [...list].filter(e => e.offsetParent);
    vis.forEach(e => { e.style.height = 'auto'; });
    const hs = vis.map(e => e.scrollHeight);
    vis.forEach((e, i) => { e.style.height = `${Math.min(hs[i] + 2, 160)}px`; });
  }
  // Enter не переносить рядок, а закінчує введення (коментар CRM однорядковий); висота — за текстом під час введення (решту
  // полів підганяє applySec — разом, один раз на перемальовування)
  function comField(e) {
    e.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); e.blur(); } };
    e.oninput = () => fitCom(e);
  }
  /* Операція банку без запису в CRM: {src: 'fee' | 'exp' | 'inc', payroll?: застереження} або {block: чому лінтер запис не пропонує}.
     Зарплатну виплату (з 05.11.2026, за потреби) можна внести — з
     застереженням: у CRM ЗП зазвичай вносять по людях за реєстром ЗП.
     payroll — будь-яке застереження класифікатора (не лише про ЗП): рядок показується в «Внести в CRM» попередженням, а операція не
     потрапляє в «Позначити всі витрати зі статтею». Огляд 16.11.2026 — ще три (лише попередження, як вносити — вирішує людина):
     позика («поворотна фінансова допомога»), зняття готівки в касі банку, повернення нашого платежу. */
  const LOAN_RE = /фінансов\p{L}*\s+допомог|(?:надання|повернення|погашення)\s+(?:\p{L}+\s+)?позик|договор\p{L}*\s+позик/iu; // реальні описки: «повортної фінансовой допомоги»
  const LOAN_NOTE = 'схоже на поворотну фінансову допомогу (позику): це не дохід від клієнта і не звичайна витрата — статтю з історії не беріть; як вносити позику та її повернення — за рішенням власника';
  // Приват: контрагент «Каса Приватбанку <касир>», рахунок каси 1002, «Видача 4246 **** **** 1421 {{DABR=K7D0}}»
  const cashOut = x => x.amount < 0 && /^\s*видача(?!\p{L})/iu.test(R.toCyr(x.purpose || '')) && (/^\s*каса\s/iu.test(R.toCyr(x.cpty || '')) || Rc.balOf(x.cpIban) === '1002');
  const CASH_NOTE = 'зняття готівки в касі банку: це не оплата контрагенту — якщо готівку внесено в касу, у CRM це переказ на рахунок каси; якщо її взяв власник ФОП — витрата за тим, на що пішли гроші';
  const REFUND_IN_RE = /поверн\p{L}*\s+(?:помилков|надміру|зайво)|помилково\s+(?:сплачен|перерахован|зарахован)/iu;
  const REFUND_NOTE = 'схоже на повернення нашого платежу, а не дохід від клієнта: знайдіть витрату, яку повернули, і внесіть повернення з огляду на неї (не новим доходом «з історії»)';
  const PAYROLL_NOTE = 'зарплатна виплата: у CRM ЗП зазвичай вносять по людях (реєстр ЗП, погодження) — вносьте одним записом, лише якщо цієї ЗП у CRM ще немає';
  /* Податки із ЗП, які ТОВ платить окремими платежами (ПДФО, військовий збір, ЄСВ «за жовтень 2026»). У CRM їх розносили по людях
     зі статтею відділу («Податки з ЗП за вересень 2026 (ПДФО, ВЗ, ЄСВ) — Терещенко Роман (ЗП відділу продажів)…»), тож статтю з
     історії за словами не вгадуємо: 05.11.2026 ВЗ і ЄСВ випадково отримали «Розробку» (слово «жовтень» у ЗП розробників), а ПДФО — ні
     (слово «ПДФО» — у записах десятка відділів). Податки однієї ЗП (рахунок, день, місяць у призначенні) — одна група з однією статтею. */
  const PAY_TAX_RE = /пдфо|військов\p{L}*\s+зб[іо]р|(?<!\p{L})єсв(?!\p{L})|єдин\p{L}*\s+соц/iu;
  const ESV_RE = /(?<!\p{L})єсв(?!\p{L})|єдин\p{L}*\s+соц/iu;
  const TAX_MONTH = /за\s+(\p{L}+\s+\d{4}|\d{1,2}[.\s]+\d{4})/iu;
  const TAX_PAID = /сплата\s+(?:пдфо|військов|єсв)/iu; // запис, внесений з платежу податку банку (а не рознесений по людях)
  // запис податків по людях: «Податки 10 % з … (на руки …) — …», «1120,01*2= 2240,02 податки із …», «Податки з ЗП … — Гудимко»;
  // податок цілим платежем називає сам податок: «Сплата ПДФО за …», «ПДФО із зп …», «ЄСВ 1грн із зп …»
  // (за ознаками, а не за самим «подат»: «Військовий збір (податок із ЗП) за …» — цілим платежем)
  const TAX_PERSON = /на\s+руки|\d\s*\*\s*2\s*=|(?<!^[^\p{L}\d]*(?:сплата\s+)?(?:пдфо|військов\p{L}*\s+зб\p{L}*|єсв).*)(?:подат\p{L}*\s+\d|\d\s*%\s*подат|подат\p{L}*\s+(?:з|із|зі)\s+(?:зп|з\/п|зарплат|заробітн|\d))/iu;
  // «подат» у коментарі, але це не податки із ЗП по людях: ЗП чи % «(разом з податками)», єдиний податок, ЄСВ самого ФОП, податок на прибуток, ПДВ
  const TAX_OTHER = /разом\s+з\s+податк|єдин\p{L}*\s+подат|по\s+фоп|податок\s+на\s+прибут|(?<!\p{L})пдв(?!\p{L})/iu;
  const cyr = s => R.toCyr(String(s || '')); // латинські двійники («Сплата ЄСВ», «Комiсiя») — кирилицею
  const taxName = s => { const t = cyr(s); return /пдфо/i.test(t) ? 'ПДФО' : /військов/i.test(t) ? 'ВЗ' : /єсв|єдин\p{L}*\s+соц/iu.test(t) ? 'ЄСВ' : 'податок'; };
  function classify(x) {
    const p = R.toCyr(x.purpose || ''), t = `${p} ${R.toCyr(x.cpty || '')}`;
    // комісія — і за поповнення карток для виплат: статтю відділу правило R-COMM-02 лишає людині
    if (x.amount < 0 && FEE_RE.test(p)) return { src: 'fee' };
    if (PAYROLL_RE.test(t)) return { src: x.amount < 0 ? 'exp' : 'inc', payroll: PAYROLL_NOTE };
    if (x.amount > 0 && ACQ_RE.test(t)) return { block: 'надходження від еквайрингу чи платіжної системи: у CRM це оплати замовлень (ліди), суми не 1:1 з банком' };
    const note = LOAN_RE.test(p) ? LOAN_NOTE : cashOut(x) ? CASH_NOTE : x.amount > 0 && REFUND_IN_RE.test(p) ? REFUND_NOTE : '';
    return { src: x.amount < 0 ? 'exp' : 'inc', ...(note ? { payroll: note } : {}) };
  }
  // коментар нового запису — як у реєстрі «Отримувач: призначення»; комісія — «Комісія банку: …» (так її впізнає правило R-COMM-01)
  function recComment(x, src) {
    // зняття готівки в касі: без прізвища касира й службової мітки банку «{{DABR=K7D0}}» (огляд 16.11.2026)
    if (cashOut(x)) { const t4 = Rc.cardTail(x.purpose); return `Зняття готівки в касі банку${t4 ? `, картка *${t4}` : ''}`; }
    const p = clean(String(x.purpose || '').replace(/\s*\{\{[^{}]*\}\}/g, '')), c = clean(x.cpty);
    const t = src === 'fee' ? (/^коміс/i.test(R.toCyr(p)) ? p : `Комісія банку: ${p}`) : c && !p.toLowerCase().includes(c.toLowerCase()) ? (p ? `${c}: ${p}` : c) : p;
    return t.slice(0, 250);
  }
  // продавець у покупці карткою: «4246 **** **** 1665 02.10.2026 04:28:07 Цифровi товари: FACEBK *22AH55AK24, FACEBOOK.COM» → «FACEBK *22AH55AK24, FACEBOOK.COM»
  const VENDOR = /\*{2,}[\s*xх]*\d{4}\s+\d{2}\.\d{2}\.\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s+[^:]*:\s*(.+)$/i;
  const vendorOf = s => { const m = VENDOR.exec(String(s || '')); return m ? m[1] : ''; };
  /* Записи CRM, схожі на операцію банку x: того самого типу (opc), зі статтею, у коментарі є слово з назви контрагента чи з призначення.
     Надто загальні слова (є в понад 40 % записів, наприклад «Цифровi товари» в усіх покупках карткою) не рахуються — крім слів продавця
     в покупці карткою: «facebook» може бути в більшості покупок, але саме він і визначає статтю. */
  // слова коментаря запису — один раз на запис (записи не змінюються на місці; нові приходять новими об'єктами)
  const WORDS = new WeakMap();
  const itemWords = c => { let v = WORDS.get(c); if (!v) WORDS.set(c, v = words(c.comment)); return v; };
  // записи → {opc → кандидати, їхні слова, у скількох записах кожне слово}: не залежить від операції банку — один раз на масив записів
  // (раніше — на кожну операцію «Внести в CRM» на кожне перемальовування)
  const SIMB = new WeakMap();
  function simBase(items, opc) {
    let m = SIMB.get(items);
    if (!m) SIMB.set(items, m = new Map());
    let v = m.get(opc);
    if (!v || v.n !== items.length) {
      const cand = items.filter(c => c.opc === opc && c.art), cw = cand.map(itemWords), df = new Map();
      cw.forEach(s => s.forEach(k => df.set(k, (df.get(k) || 0) + 1)));
      m.set(opc, v = { cand, cw, df, n: items.length });
    }
    return v;
  }
  function similar(items, x, opc) {
    if (!items || !items.length) return [];
    const { cand, cw, df } = simBase(items, opc);
    if (!cand.length) return [];
    const seller = words(vendorOf(x.purpose));
    const w = [...new Set([...words(x.cpty), ...words(x.purpose)])].filter(k => seller.has(k) || !(cand.length >= 5 && df.get(k) / cand.length > 0.4));
    return cand.filter((c, i) => w.some(k => cw[i].has(k)));
  }
  /* Стаття з історії рахунку: найчастіша серед схожих записів, якщо на неї припадає щонайменше 60 % з них. {art, n, ex} або null. */
  function histArt(items, x, opc) {
    const m = similar(items, x, opc), cnt = new Map();
    for (const c of m) { const v = cnt.get(c.art) || { k: 0, ex: c }; v.k++; cnt.set(c.art, v); }
    if (!cnt.size) return null;
    const [art, v] = [...cnt].sort((a, b) => b[1].k - a[1].k)[0];
    return v.k / m.length >= 0.6 ? { art, n: v.k, ex: v.ex } : null;
  }
  /* Маркетолог за ім'ям у коментарі запису. У списку записів CRM маркетолога немає (marketer_balance_history віддає лише запит
     одного запису), а покупки корп. карткою в CRM пишуть з ім'ям: «Facebook 30.10 Ларіоненко Тимур (тест США): …». → id з mks
     [{id, name}], якщо в коментарі є всі слова його імені (будь-який порядок, відмінкове закінчення) і такий маркетолог один; інакше null. */
  const nameWords = s => String(s || '').toLowerCase().replace(/[’ʼ`']/g, '').split(/[^\p{L}]+/u).filter(w => w.length >= 2);
  function mkInComment(mks, comment) {
    const cw = nameWords(comment);
    if (!cw.length || !mks || !mks.length) return null;
    const has = w => cw.some(c => c === w || (w.length >= 4 && c.length <= w.length + 2 && c.startsWith(w.slice(0, -1))));
    const hit = mks.filter(m => { const nw = nameWords(m.name); return nw.length >= 2 && nw.every(has); });
    return hit.length === 1 ? hit[0].id : null;
  }
  // маркетолог запису історії: з запису або з імені в коментарі — один раз на запис і список маркетологів (вкладку перемальовують часто)
  const MKC = new WeakMap();
  function mkOfItem(c, mks) {
    if (c.mk) return c.mk;
    if (!mks || !mks.length) return null;
    let m = MKC.get(mks);
    if (!m) MKC.set(mks, m = new WeakMap());
    let v = m.get(c);
    if (v === undefined) m.set(c, v = mkInComment(mks, c.comment) || 0);
    return v || null;
  }
  // дата операції для порівняння з історією: покупка карткою — дата покупки з призначення
  const opDate = x => Rc.cardDate(x.purpose) || x.date;
  /* n записів list, найближчих за датою до d (рівно — новіший ID). День запису рахується один раз на запис: сортування з розбором
     дат у порівнянні на тисячах записів історії гальмувало кожну зміну статті чи маркетолога в «Внести в CRM» на секунди. */
  const DAYN = new WeakMap();
  const dayNum = c => { let v = DAYN.get(c); if (v === undefined) DAYN.set(c, v = c.date ? Math.round(Date.parse(`${c.date}T12:00:00Z`) / 864e5) : NaN); return v; };
  function nearest(list, d, n) {
    const t = d ? Math.round(Date.parse(`${d}T12:00:00Z`) / 864e5) : NaN;
    const dist = c => { const v = Math.abs(dayNum(c) - t); return Number.isFinite(v) ? v : 0; };
    // n найближчих — за один прохід (без сортування всієї історії): ближча дата, а рівно — новіший ID
    const top = [], after = (a, v, id) => a.v > v || (a.v === v && a.id < id);
    for (const c of list) {
      const v = dist(c), id = c.id || 0;
      if (top.length === n && !after(top[n - 1], v, id)) continue;
      let i = top.length;
      top.push(null);
      while (i > 0 && after(top[i - 1], v, id)) { top[i] = top[i - 1]; i--; }
      top[i] = { c, v, id };
      if (top.length > n) top.pop();
    }
    return top.map(o => o.c);
  }
  /* Маркетолог для витрати зі статтею art (рекламний бюджет): серед схожих записів рахунку з цією статтею, інакше — серед усіх записів
     рахунку з нею. Маркетолог запису — з запису (mk) або з імені в коментарі (mks — список маркетологів CRM). Рахуються до 5 записів,
     найближчих за датою до операції (корп. картку передають від маркетолога маркетологу); рівно — того, чий запис ближчий.
     {id, n, sure} або null; sure — у цих записах маркетолог один, і записів щонайменше два. */
  // підмножини записів (за статтею, маркетологом) — один раз на масив записів і список маркетологів: той самий масив щоразу, тож і кеш
  // схожості (simBase) спрацьовує, а не рахується заново на кожну операцію «Внести в CRM»
  const SUBS = new WeakMap();
  function subOf(items, key, dep, make) {
    let m = SUBS.get(items);
    if (!m) SUBS.set(items, m = new Map());
    let v = m.get(key);
    if (!v || v.n !== items.length || v.dep !== dep) m.set(key, v = { n: items.length, dep, val: make() });
    return v.val;
  }
  function histMk(items, x, art, mks) {
    items = items || [];
    const { of, withMk } = subOf(items, `mk|${art}`, mks, () => {
      const m = new Map();
      for (const c of items) {
        if (c.opc !== 2 || c.art !== art) continue;
        const id = mkOfItem(c, mks);
        if (id) m.set(c, id);
      }
      return { of: m, withMk: [...m.keys()] };
    });
    const d = opDate(x);
    const pick = list => {
      if (!list.length) return null;
      const near = nearest(list, d, 5), cnt = new Map();
      near.forEach(c => cnt.set(of.get(c), (cnt.get(of.get(c)) || 0) + 1));
      const [id, n] = [...cnt].sort((a, b) => b[1] - a[1])[0];
      return { id, n, sure: cnt.size === 1 && n >= 2 };
    };
    return pick(similar(withMk, x, 2)) || pick(withMk);
  }
  /* Зразок для покупки корп. карткою: найближчий за датою схожий запис рахунку з тією самою статтею (і маркетологом mk, якщо він є) —
     з нього сервіс, мета в дужках і проєкт. → запис або null */
  function histRef(items, x, art, mk, mks) {
    if (!art) return null;
    items = items || [];
    const list = subOf(items, `ref|${art}|${mk || ''}`, mks, () => items.filter(c => c.opc === 2 && c.art === art && (!mk || mkOfItem(c, mks) === mk)));
    return nearest(similar(list, x, 2), opDate(x), 1)[0] || null;
  }
  // сервіс покупки карткою — як його пишуть у CRM («Facebook 30.10 …», «Google Ads 19:32 …»)
  const SERVICES = [[/facebk|facebook|(?<![\p{L}])meta(?![\p{L}])/iu, 'Facebook'], [/google/i, 'Google Ads'], [/hetzner/i, 'Hetzner Online'], [/openai|chatgpt/i, 'OpenAI'],
    [/tiktok/i, 'TikTok Ads'], [/anthropic|claude\.ai/i, 'Anthropic'], [/linkedin/i, 'LinkedIn'], [/twitter|(?<![\p{L}])x corp/iu, 'X Ads']];
  // з коментаря CRM: «Hetzner Online (сервер) 14:06 Татоян Артем (розхідники PrykladM): …» → сервіс, хто, мета в дужках
  const REF_RE = /^\s*([^\d:]{2,40}?)\s+\d{1,2}[.:]\d{2}(?:\s+\d{1,2}:\d{2})?\s+([^():\d]{3,60}?)\s*(?:\(([^)]{1,60})\))?\s*[:,]/;
  const refParts = s => { const m = REF_RE.exec(String(s || '')); return m ? { svc: m[1].trim(), who: m[2].trim(), what: (m[3] || '').trim() } : null; };
  // слово статті реклами в коментарі: «(тест США)», «(реінвест Україна)»
  const ART_WORD = { '20/41': 'тест', '20/30': 'реінвест', '20/40': 'дотування' };
  const titleCase = s => String(s || '').toLowerCase().replace(/(^|[\s.-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  const CARD_TIME = /\*{2,}[\s*xх]*\d{4}\s+\d{2}\.\d{2}\.\d{4}\s+(\d{1,2}:\d{2})/i;
  /* Коментар покупки корп. карткою — як у CRM: «Facebook 30.10 17:33 Ларіоненко Тимур (тест США): 5000.00 UAH, корп. картка 7850».
     o: {who — маркетолог чи хто тримає картку, art, proj, projName, ccy, amount, ref — histRef}. Сервіс — як у зразку, інакше за
     продавцем; ім'я — як написано в зразку (той самий маркетолог); мета — як у зразку, якщо в нього та сама стаття й проєкт, інакше слово
     статті реклами й проєкт. */
  function cardComment(x, o) {
    const rp = o.ref ? refParts(o.ref.comment) : null, merch = vendorOf(x.purpose) || merchantOf(x.purpose);
    const known = SERVICES.find(([re]) => re.test(merch));
    const svc = (rp && rp.svc) || (known ? known[1] : titleCase(merchantOf(x.purpose))) || 'Покупка карткою';
    const who = o.who && rp && rp.who && o.sameWho && o.sameWho(rp.who) ? rp.who : o.who || '';
    const same = o.ref && o.ref.art === o.art && Number(o.ref.proj) === Number(o.proj);
    const what = (same && rp && rp.what) || (ART_WORD[o.art] ? [ART_WORD[o.art], o.projName].filter(Boolean).join(' ') : '');
    const t = (CARD_TIME.exec(String(x.purpose || '')) || [])[1] || '', last4 = Rc.cardTail(x.purpose);
    return `${svc} ${dmy(opDate(x)).slice(0, 5)}${t ? ' ' + t : ''}${who ? ' ' + who : ''}${what ? ` (${what})` : ''}: ${Number(o.amount).toFixed(2)} ${o.ccy || 'UAH'}${last4 ? `, корп. картка ${last4}` : ''}`.slice(0, 250);
  }
  /* Сховані рахунки таблиці «Рахунки»: вибрані людиною (значок-око; hide — cfl_bank_hide) і неактуальні за назвою («НеАктуальний …»,
     «Not actual …», «… (видалити)»), якщо людина не показала їх сама (shown — cfl_bank_shown). Рахунок, який перейменували на
     неактуальний пізніше, теж ховається. → Set id */
  const OFF_ACC = /неактуал|not actual|\(видалити\)/i;
  function hiddenAccs(accs, hide, shown) {
    const h = new Set(hide || []), sh = new Set(shown || []);
    for (const a of accs || []) if (OFF_ACC.test(a.name || '') && !sh.has(a.id)) h.add(a.id);
    return h;
  }
  // хто тримає корп. картку на дату (rules.json → reference.cards[].holders) — спільне з вкладкою «Погодження»
  const holderOf = Rc.holderOf;
  /* Поповнення корп. картки, записане не на ту картку власника (04.11.2026: у кожного ФОП по дві діючі картки, і поповнення для нової
     картки Мартиненка 4546 записалось на стару 7850). Самого поповнення в банку немає: Приват списує покупки корп. картки прямо
     з рахунку ФОП, а номер картки є в кожній покупці. Тож куди мали піти гроші, видно з коментаря поповнення і з покупок після нього.
     o: xfers — записи рахунку ФОП «переказ на корп. картку» (opc 4, peer — картка); cards — діючі картки власника тієї самої валюти
     [{id, last4, balance}] (balance — залишок у CRM зараз); tails — номер картки → id; holders — довідник карток (rules.json);
     rows, fileFrom — виписка рахунку ФОП (null — виписки немає).
     Картка, на яку мало піти поповнення (how):
       num — у коментарі номер іншої картки власника (номер саме цієї картки — поповнення правильне);
       holder — у коментарі названо того, хто на дату поповнення тримає іншу картку (тримача цієї картки — правильне);
       bank — коментар нічого не каже, а у виписці після поповнення платить лише інша картка (є покупки з її номером), цією — жодної;
              у CRM та картка в мінусі, а на цій поповнення лишилось невитраченим (її залишок не менший за суму поповнення).
     → [{item, was, to, how, num?, holder?, spent?: {n, sum}}] */
  function wrongTopups(o) {
    const out = [], cards = (o && o.cards) || [], ids = new Set(cards.map(c => c.id)), tails = (o && o.tails) || {};
    if (ids.size < 2) return out;
    const cardOf = id => cards.find(c => c.id === id);
    for (const x of o.xfers || []) {
      const was = Number(x.peer), amount = Math.abs(Number(x.amount));
      if (!ids.has(was)) continue;
      const com = String(x.comment || '');
      const nums = [...com.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map(m => m[1]).filter(n => ids.has(Number(tails[n])));
      if (nums.some(n => Number(tails[n]) === was)) continue;
      if (nums.length) { out.push({ item: x, was, to: Number(tails[nums[0]]), how: 'num', num: nums[0] }); continue; }
      const h = Rc.holderCard(o.holders, com, x.date, id => ids.has(id));
      if (h && (h.ambig || h.id === was)) continue;
      if (h) { out.push({ item: x, was, to: h.id, how: 'holder', holder: h }); continue; }
      // за випискою — лише якщо вона покриває день поповнення
      if (!o.rows || !o.fileFrom || x.date < o.fileFrom) continue;
      const by = id => o.rows.filter(y => y.amount < 0 && (Rc.cardDate(y.purpose) || y.date) >= x.date && Number(tails[Rc.cardTail(y.purpose)]) === id);
      if (by(was).length || !(Number(cardOf(was).balance) - amount >= -0.005)) continue;
      const cand = cards.filter(c => c.id !== was && Number(c.balance) < -0.005 && by(c.id).length);
      if (cand.length !== 1) continue;
      const sp = by(cand[0].id);
      out.push({ item: x, was, to: cand[0].id, how: 'bank', spent: { n: sp.length, sum: r2(-sp.reduce((s, y) => s + y.amount, 0)) } });
    }
    return out;
  }
  /* Період звірки без закритих у CRM місяців (through — «закрито по РРРР-ММ»; їх не звіряємо: змінює їх лише Адмін).
     → {from, to, cut}, де cut — перший відкритий день, якщо «з» довелось пересунути; null — увесь період закрито. */
  function clampToOpen(from, to, through) {
    const open = M.openFrom(through);
    if (!open || from >= open) return { from, to, cut: null };
    return to < open ? null : { from: open, to, cut: open };
  }
  /* Котрий з двох файлів виписки того самого рахунку банку брати за період: що покриває період, з них — що закінчується пізніше; рівно —
     завантажений пізніше (b; S.banks — у порядку завантаження): вечірнє вивантаження за сьогодні замінює ранкове (07.11.2026). */
  const coversP = (x, from, to) => !!(x.fileFrom && x.fileTo && x.fileFrom <= from && x.fileTo >= to);
  function laterBank(b, cur, from, to) {
    if (!cur) return true;
    const a = coversP(b, from, to), c = coversP(cur, from, to);
    return a !== c ? a : (b.fileTo || '') >= (cur.fileTo || '');
  }
  /* Що privat_fetch.py не вивантажив (код ≠ 0): рядки журналу після «НЕ вивантажено:» — «  ФОП … (Моно): HTTP 403 …» → ['ФОП … (Моно): HTTP 403 …'] */
  function notFetched(log) {
    const L = (log || []).map(String), i = L.map(s => /^\s*НЕ вивантажено:/.test(s)).lastIndexOf(true), out = [];
    if (i < 0) return out;
    for (const s of L.slice(i + 1)) { if (!/^\s+\S/.test(s)) break; out.push(s.trim().slice(0, 200)); }
    return out;
  }
  // виписку вивантажено не всю (07.11.2026): що саме не вийшло й що робити — решту все одно звіряємо
  function partialFetchText(log, code) {
    const miss = notFetched(log);
    return `Виписки вивантажено не всі (код ${code}). ${miss.length ? `Не вивантажено: ${miss.join('; ')}.` : 'Частину клієнтів чи банків не вивантажено — див. журнал вище (той самий є в Помічнику).'} Рахунки ${miss.length === 1 ? 'цього клієнта' : 'цих клієнтів'} звірено без нових даних банку (старіша виписка або «немає даних банку»), решту — звірено як завжди. Що робити: трохи пізніше натисніть «Вивантажити заново» (банк міг бути тимчасово недоступний); якщо помилка повторюється — перевірте токен цього клієнта у файлі токенів у папці виписок.`;
  }
  /* Переказ між своїми, якого немає в CRM, а його рух уже є записом іншого типу (витрата на рахунку «звідки» чи надходження на рахунку
     «куди», та сама сума, ±3 дні): створений переказ подвоїв би рух — тип того запису змінюють у «Виправити» (07.11.2026). → запис чи null */
  function xferOtherType(p, fromItems, toItems) {
    const c = Math.round(p.amount * 100), near = x => Math.round(Math.abs(x.amount) * 100) === c && !!x.date && Math.abs(dayDiff(x.date, p.date)) <= 3;
    return (fromItems || []).find(x => x.opc === 2 && near(x)) || (toItems || []).find(x => x.opc === 1 && near(x)) || null;
  }
  // запис invoice-payment: живі рухи рахунку inv з операцією з ops і цією сумою
  const pays = (r, inv, ops, amount) => ((r && r.payments) || []).filter(x => !x.deleted_at && Number(x.invoice_id) === inv && ops.includes(Number(x.operation)) && Math.abs(Number(x.amount) - amount) < 0.005);
  const pay = (r, inv, ops, amount) => pays(r, inv, ops, amount).length > 0;
  /* Перед створенням переказу p (near — записи рахунку «звідки» з цією сумою за ±3 дні, known — ID записів, відомих звірці):
     «вже є» — лише якщо таких переказів у CRM стільки, скільки їх у виписці (p.peers: два однакові перекази за кілька днів — не дубль);
     витрата з тією самою сумою на рахунку «звідки» — навіть відома звірці — стоп: це, можливо, той самий рух іншим типом (07.11.2026). */
  function xferCheck(near, p, amount, known, dmyOf) {
    const dup = near.filter(r => pay(r, p.from, [4], amount) && pay(r, p.to, [3], amount));
    if (dup.length && dup.length >= (p.peers || 1)) return { result: 'вже є', id: dup[0].id, note: `такий переказ уже є: ${dup.map(r => `ID ${r.id} від ${dmyOf(r.date)}`).join(', ')}${(p.peers || 1) > 1 ? ` (у виписці таких ${p.peers})` : ''}` };
    const exp = near.filter(r => pay(r, p.from, [2], amount));
    if (exp.length) return { result: 'перевірте', note: `на рахунку «звідки» є витрата з тією самою сумою за ±3 дні (ID ${exp.map(r => r.id).join(', ')}) — переказ не створено: якщо це той самий рух, змініть тип запису в «Виправити» → «Записи з неправильним типом»` };
    const fresh = near.filter(r => !known.has(r.id) && pay(r, p.from, [4], amount));
    return fresh.length ? { result: 'перевірте', note: `після звірки з'явився запис ID ${fresh.map(r => r.id).join(', ')} з тією самою сумою — переказ не створено, перевірте вручну` } : null;
  }
  // дата для CRM: 'ДД-ММ-РРРР ГГ:ХХ' і період '01-ММ-РРРР'; без часу — полудень
  const crmDate = (iso, time) => {
    const [Y, Mo, D] = iso.split('-'), t = /^\d{1,2}:\d{2}/.test(time || '') ? time.slice(0, 5).padStart(5, '0') : '12:00';
    return { date: `${D}-${Mo}-${Y} ${t}`, period: `01-${Mo}-${Y}` };
  };
  const dayOfCrm = s => { const m = /^(\d{2})-(\d{2})-(\d{4})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; }; // 'ДД-ММ-РРРР …' → РРРР-ММ-ДД
  // час покупки карткою з призначення: «4246 **** **** 7365 31.10.2026 17:33:05 …» → '17:33' (CARD_TIME — вище, у cardComment)
  const cardTime = s => { const m = CARD_TIME.exec(String(s || '')); return m ? m[1] : ''; };
  /* Дата й період нового запису з виписки. Покупка корп. карткою (p.buy) — за датою й часом покупки з призначення, як у CRM (банк
     проводить її за 1–3 дні, і покупка 31.10 потрапляла в листопад); якщо місяць покупки вже закрито в CRM (through — «закрито по»),
     період — перший відкритий місяць, дата лишається датою покупки (07.11.2026). */
  function recWhen(p, through) {
    const d = crmDate(p.buy || p.date, p.buy ? p.buyTime : p.time);
    if (p.buy && through && M.isClosedMonth(p.buy, through)) { const o = M.openFrom(through); if (o) d.period = `01-${o.slice(5, 7)}-${o.slice(0, 4)}`; }
    return d;
  }
  /* Корп. картки, які «Звірка з банком» запам'ятала в цьому браузері (нова картка: номера ще немає ні в назві рахунку CRM, ні в
     rules.json). mergeLocalCards додає їх до довідника rulesDoc.reference.cards — для всіх вкладок панелі; картка з rules.json
     з тим самим номером сильніша. → додані */
  const LOCAL_CARDS = 'cfl_cards_local';
  function mergeLocalCards(rulesDoc) {
    if (!rulesDoc) return [];
    const ref = rulesDoc.reference = rulesDoc.reference || {}, cards = ref.cards = ref.cards || [];
    const add = LS.get(LOCAL_CARDS, []).filter(c => c && /^\d{4}$/.test(String(c.last4)) && Number(c.account_id) > 0 && !cards.some(x => String(x.last4) === String(c.last4)));
    cards.push(...add.map(c => ({ ...c, local: true })));
    return add;
  }
  // продавець з рядка покупки карткою: «4246 **** **** 1665 02.10.2026 04:28:07 Цифровi товари: FACEBK *22AH55AK24, FACEBOOK.COM» → «FACEBK»
  const merchantOf = s => String(s || '').replace(/^.*?\d{2}:\d{2}(?::\d{2})?\s*/, '').replace(/^[^:]{0,40}:\s*/, '').split(',')[0].replace(/\s*\*.*$/, '').trim();
  /* Нові корп. картки у виписках: покупки карткою, номера якої немає в known (номер → рахунок corpCard: назви рахунків CRM і довідник
     rules.json). banks — рахунки з виписок (cfId — рахунок CRM), items — рух рахунків CRM (cashflowByAccount), accs — рахунки CRM.
     Рахунок картки — корп. картка власника рахунку банку, на яку в CRM записано найбільше цих покупок (та сама сума; дата — від дня
     перед покупкою до дня після проведення); без покупок у CRM — єдина картка власника без номера в назві, якої не взяла інша нова картка.
     → [{last4, debit, rows, sum, from, to, cands, sug: {id, why} | null}] */
  function findNewCards({ banks, known, items, accs, from, to }) {
    const nameOf = id => ((accs || []).find(a => a.id === id) || {}).name || `рахунок ${id}`;
    const byT = new Map();
    for (const b of banks || []) {
      if (!b.cfId) continue;
      for (const x of b.rows) {
        if (x.date < from || x.date > to || !(x.amount < 0)) continue;
        const t = Rc.cardTail(x.purpose), d = t && Rc.cardDate(x.purpose);
        if (!d || known[t]) continue;
        const g = byT.get(t) || { last4: t, rows: [], debitN: new Map() };
        byT.set(t, g);
        if (g.rows.some(y => y.date === x.date && y.amount === x.amount && y.purpose === x.purpose)) continue; // той самий рядок з двох виписок
        g.rows.push({ date: x.date, amount: x.amount, purpose: x.purpose, buy: d });
        g.debitN.set(b.cfId, (g.debitN.get(b.cfId) || 0) + 1);
      }
    }
    const corp = (accs || []).filter(a => Rc.isCorp(a));
    const out = [...byT.values()].map(g => {
      const debit = [...g.debitN].sort((a, b) => b[1] - a[1])[0][0], own = Rc.ownerOf(nameOf(debit));
      const cands = corp.filter(a => !own || String(Rc.ownerOf(a.name)).toLowerCase() === own.toLowerCase());
      const hits = new Map();
      for (const x of g.rows) for (const a of cands) {
        if ((items.get(a.id) || []).some(c => c.opc === 2 && Math.abs(Math.abs(c.amount) - Math.abs(x.amount)) < 0.005 && c.date >= addDays(x.buy, -1) && c.date <= addDays(x.date, 1))) hits.set(a.id, (hits.get(a.id) || 0) + 1);
      }
      const best = [...hits].sort((a, b) => b[1] - a[1])[0], dates = g.rows.map(x => x.date).sort();
      return { last4: g.last4, rows: g.rows, debit, cands, sum: r2(g.rows.reduce((s, x) => s + x.amount, 0)), from: dates[0], to: dates[dates.length - 1],
        sug: best ? { id: best[0], why: `у CRM на цей рахунок записано ${best[1]} з ${g.rows.length} ${plural(g.rows.length, 'покупки', 'покупок', 'покупок')}` } : null };
    });
    const taken = new Set(out.filter(c => c.sug).map(c => c.sug.id));
    for (const c of out) {
      if (c.sug) continue;
      const bare = c.cands.filter(a => !/(?<!\d)\d{4}(?!\d)/.test(a.name) && !taken.has(a.id));
      if (bare.length === 1) { c.sug = { id: bare[0].id, why: 'єдина корп. картка власника без номера в назві' }; taken.add(bare[0].id); }
    }
    return out.sort((a, b) => a.last4.localeCompare(b.last4));
  }
  /* «Закриття місяця»: межі місяця m («РРРР-ММ») — з 1-го по останній день, поточний місяць — по сьогодні (full = false:
     місяць ще не закінчився). */
  function monthBounds(m, todayIso) {
    const from = `${m}-01`, last = addDays(M.openFrom(m), -1);
    return { from, last, to: last < todayIso ? last : todayIso, full: last < todayIso };
  }
  // місяць за замовчуванням — поточний, а в перші 10 днів — попередній (його саме закривають)
  const defaultMonth = todayIso => (Number(todayIso.slice(8, 10)) <= 10 ? addDays(todayIso.slice(0, 8) + '01', -1) : todayIso).slice(0, 7);
  const monthName = m => { const s = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, 15)).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric', timeZone: 'UTC' }); return s.charAt(0).toUpperCase() + s.slice(1); };
  // касовий метод (уточнення 07.11.2026): виплати 1–5 числа — у місяці оплати, тож «Закриття місяця» не читає погоджень наступного місяця
  const OK_ST = new Set(['ok', 'timing', 'pay', 'expl']);
  // «Виводи з балансу»: погодження реєстру — від 12 днів до періоду (їхні виводи можуть бути в періоді) до 3 днів після; запам'ятаний склад команд
  const WD_BACK = 12, WD_AHEAD = 3, WD_TEAMS = 'cfl_wd_teams';
  const WD_GONE = new Set(['зник у погодженнях']); // рядок прибрано з погоджень — не погодження
  const nPeople = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;
  /* Стан погодження «% з балансу» (рядок CFWithdrawals.match) — для розділу «Виводи з балансу» і «Закриття місяця». → {cls, text} */
  function wdText(r, todayIso) {
    const a = r.a, leads = r.items.filter(w => w.role === 'lead').length, mans = r.items.length - leads;
    if (r.status === 'ok') {
      if (r.how === 'registry') return { cls: 'ok', text: `виводу з балансу немає, але реєстр уніс погодження на всю суму (ID ${a.id}) — витрата в кешфлоу є` };
      const parts = leads && mans ? ` (тімлід + ${nPeople(mans, 'менеджер', 'менеджери', 'менеджерів')})` : r.items.length > 1 ? ` (${nPeople(r.items.length, 'вивід', 'виводи', 'виводів')})` : '';
      return { cls: 'ok', text: `виведено повністю${parts}${a.gross ? ' · сума погодження разом з податками: на руки × 0,9' : ''}` };
    }
    if (r.status === 'ambig') return { cls: 'warn', text: 'не вдалося розкласти: цю суму дають кілька наборів виводів — перевірте вручну' };
    if (r.status === 'wait') return { cls: 'muted', text: 'чекаємо вивід: погодження свіже (виводять зазвичай за 1–3 дні після оплати)' };
    if (r.status === 'none') return { cls: 'bad', text: `виводу ${a.date >= addDays(todayIso, -10) ? 'ще ' : ''}немає` };
    if ((a.team || r.cands.some(w => w.role === 'lead')) && r.sum < a.amount) return { cls: 'bad', text: `вивід тімліда є (${fmt(r.sum)}), а виводів менеджерів на решту ${fmt(r2(a.amount - r.sum))} не знайдено` };
    return { cls: 'bad', text: r.sum < a.amount ? `виведено частково: ${fmt(r.sum)} з ${fmt(a.amount)}` : `виведено більше, ніж погоджено: ${fmt(r.sum)} з ${fmt(a.amount)}` };
  }
  const wdWho = w => `${w.role === 'lead' ? 'тімлід ' : ''}${w.name}`;
  // вивід без погодження: схожий на погодження поза періодом (near) — з підказкою
  const wdNear = n => (n ? `схоже на погодження ${dmy(n.a.date)} «${n.a.recipient}» на ${fmt(n.a.amount)}, але сума не збігається` : '');
  /* Підсумок звірки для плиток над розділами вкладки: рахунки (з рухом, випискою чи залишком, введеним вручну; corpCard, зведений
     з рахунком банку, — у його рядку) — скільки сходиться, розбіжностей і без даних банку; операцій банку без запису (без «схоже на
     переказ» — вони в переказах), записів CRM без операції (без поповнень картки витратою — вони в типах), переказів між своїми без
     пари, записів з неправильним типом, нових корп. карток, поповнень не на ту картку (reps); covered — рахунків, виписка яких покриває період. */
  function bankSummary(all, types, newCards, reps) {
    const accs = all.filter(r => r.status !== 'merged' && (r.R.crm.n > 0 || r.b || r.manual !== undefined));
    const good = accs.filter(r => OK_ST.has(r.status)).length, bad = accs.filter(r => r.status === 'bad' || r.status === 'xfer').length;
    const maybeRows = r => new Set((r.R.own ? r.R.own.maybe : []).map(m => m.row));
    const cnt = f => accs.reduce((s, r) => s + f(r), 0);
    return { accs: accs.length, good, bad, unk: accs.length - good - bad, covered: accs.filter(r => r.R.covered).length,
      missB: cnt(r => (r.R.missing ? r.R.missing.bank.filter(x => !maybeRows(r).has(x)).length : 0)),
      missC: cnt(r => (r.R.missing ? r.R.missing.crm.filter(c => !(r.topups || []).includes(c)).length : 0)),
      own: cnt(r => (r.R.own ? r.R.own.xfers.filter(x => x.state === 'missing' || x.state === 'peer').length + r.R.own.maybe.length : 0)),
      // corpCard, зведений з рахунком банку, у мінусі в CRM — пропозиція поповнення (у переказах між своїми)
      topup: all.filter(r => r.status === 'merged' && Number(r.a.balance) < -0.005).length,
      types: (types || []).length, cards: (newCards || []).length, reps: (reps || []).length };
  }
  /* Готовність місяця до закриття. all — рахунки вкладки (rows()) за місяць, «Що звіряти: усе»; parts: types — «Записи з
     неправильним типом» (typeFixes); lint — перевірка «Статей і проєктів» {checked, counts} або {error}, null — не перевірено;
     reg — погодження з реєстру {from, open, check} або {error}, null — реєстр у цьому браузері не налаштовано; wd — «Виводи з
     балансу» за місяць (CFWithdrawals.summary) або {error}, null — не перевірено; noHelper — Помічник
     не відповів (виписок Привату й Моно немає). Пункт: ok — true (гаразд), false (є що зробити), null (не перевірено).
     → { verdict: 'ready' | 'partial' | 'not', items: [{key, title, ok, text, list}] } */
