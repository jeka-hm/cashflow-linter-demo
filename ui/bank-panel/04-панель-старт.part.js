  function mount(el, opts) {
    const api = opts.api, storage = opts.storage;
    // чернетки CRM (core/drafts.js): opts.drafts — {on(), list(), near(запит), post(форма), get(id)}; перемикач — у шапці панелі
    const DR = opts.drafts || null, dOn = () => !!(DR && DR.on());
    // перемикач змінили — звірити заново (з чернетками чи без); якщо панель саме зайнята — одразу після того
    if (DR && DR.subscribe) DR.subscribe(() => { if (S.busy) S.redo = true; else if (S.items) calc(); }); // перемикач змінили — звірити заново (з чернетками чи без)
    // accs — рахунки з balance; items — рух рахунків із записів, датованих з itemsFrom; banks — рахунки з виписок
    // dir — довідник своїх рахунків (Rc.ownDirectory); into — corpCard → рахунок, з яким він звіряється; xp — вибір у списку переказів
    // kind — що звіряти (KIND); rp — вибір у списку «створити запис»; hist — записи рахунків за 120 днів до періоду (підказка статті);
    // cfg — pnl/operation-config (статті з маркетологом, зарплатна категорія); gen — номер звірки (запізнілі відповіді відкидаються);
    // mks — маркетологи [{id, name}] (undefined — ще не читали, null — читаються)
    // фільтр статусів «Рахунків» пам'ятається (cfl_bank_filter, 16.11.2026): щоранку не треба знову ховати «немає даних банку» тощо.
    // Статуси, де є що робити (ST_FIRST), на початку завжди показано — запам'ятаний фільтр не сховає нову розбіжність
    const ST_FIRST = new Set(['bad', 'xfer', 'part']);
    const filter0 = (() => { const v = LS.get('cfl_bank_filter', null); return new Set(Array.isArray(v) ? ST_ORDER.filter(k => v.includes(k) || ST_FIRST.has(k)) : ST_ORDER); })();
    /* Спільний період «Звірки з банком» і «Статей і проєктів» (cfl_period, 16.11.2026): останній звірений чи перевірений СЬОГОДНІ —
       одна вкладка підхоплює період іншої, і він не губиться, коли панель відкрили знову. Іншого дня — як і раніше, сьогодні. */
    const sharedPeriod = () => { const v = LS.get('cfl_period', null), ok = s => /^\d{4}-\d\d-\d\d$/.test(String(s || '')); return v && v.day === today() && ok(v.from) && ok(v.to) && v.from <= v.to ? v : null; };
    let periodSeen = null; // позначка (n) спільного періоду, яку ця вкладка вже врахувала
    const S = { accs: null, ccy: null, items: null, itemsFrom: null, from: null, to: null, banks: [], offsets: null, showHidden: false, busy: false, open: new Set(), filter: filter0,
      dir: null, into: new Map(), xp: new Map(), kind: 'all', rp: new Map(), lastRecs: [], hist: new Map(), histBusy: false, cfg: undefined, gen: 0, mapOpen: false, mks: undefined,
      tp: new Map(), lastTypes: [], cp: new Map(), lastNewCards: [], // tp — вибір у списку «Записи з неправильним типом»; cp — рахунок нової картки (номер → id)
      rpt: new Map(), lastReps: [], // rpt — вибір у списку «Поповнення не на ту картку» (ключ → {on, to})
      sec: ['acc', 'mt', 'add', 'fix', 'wd', 'close'].includes(LS.get('cfl_bank_sec', 'acc')) ? LS.get('cfl_bank_sec', 'acc') : 'acc', rg: new Map(), // sec — розділ вкладки; rg — групи «Операцій банку» (рахунок → розгорнуто)
      mt: null, lastMt: null, mtAi: null, mtBusy: false, // «Зіставлення ШІ»: розрахунок (кеш), відповідь ШІ, ШІ думає
      // bv — версія даних банку: виписки, зіставлення рахунків, картки, вибір переказів (ключ кешу «Зіставлення ШІ»; без неї після
      // повторного вивантаження виписок за той самий період «Внести в CRM» переставав блокувати операції з погодженням)
      bv: 0,
      // ra — підказки ШІ для «Внести в CRM» (операції без статті): набір, про який питали, відповіді за ключем, ще думає, запитів
      ra: { sig: '', res: {}, pending: 0, busy: false, polls: 0, timer: null },
      // wd — погодження реєстру для «Виводів з балансу»: вікно дат, рядки дії bank (null — ще не читали), помилка, номер запиту; wdm — зіставлення (кеш)
      wd: { from: null, to: null, rows: null, error: '', busy: false, seq: 0 }, wdm: null };
    const projects = Object.entries(opts.projects || { 'Україна': 1 });
    // права на кешфлоу (opts.rights — проміс від панелі): без «Повного редагування операцій Cash Flow» CRM не дасть змінити тип запису
    let rights = null;
    const noFull = () => !!(rights && !rights.full);
    if (opts.rights) opts.rights.then(r => { rights = r; if (noFull() && !S.busy && (S.lastTypes.length || S.lastReps.length)) render(); });
    // закриті місяці CRM (opts.closed — від панелі: get / learn / on): не звіряються, записи з них не змінюються й не створюються
    const CL = opts.closed || null, closedTo = () => (CL ? CL.get() : null);
    const shut = x => !!(x && x.per && M.isClosedMonth(x.per, closedTo()));
    const nameOf = id => ((S.accs || []).find(a => a.id === id) || {}).name || `рахунок ${id}`;
    const compiled = opts.rulesDoc ? R.compileRules(opts.rulesDoc) : null;
    const fixFrom = compiled && compiled.fixFrom;
    // корп. картки з довідника rules.json (номер, рахунок corpCard, з якого рахунку списує, хто тримає)
    const CARDS = ((opts.rulesDoc && opts.rulesDoc.reference && opts.rulesDoc.reference.cards) || []).filter(c => c && /^\d{4}$/.test(String(c.last4)) && Number(c.account_id) > 0);
    /* Кошти броніків (rules.json → reference.bronik_accounts; ПРАВИЛА BR-11): на рахунку броніків надходження, ЗП броніків через транзит
       і податки за них у CRM не вносяться — поза звіркою, не «немає в CRM»; дохід компанії — розрахунковий запис «1.5% від бронювання»
       на рахунку share_account_id, руху в банку в нього немає. Перекази між своїми звіряються як завжди (08.11.2026, звірка жовтня). */
    const BRON = (opts.rulesDoc && opts.rulesDoc.reference && opts.rulesDoc.reference.bronik_accounts) || null;
    const BRON_LIST = ((BRON && BRON.accounts) || []).filter(a => a && Number(a.account_id) > 0);
    const BRON_ACC = new Set(BRON_LIST.map(a => Number(a.account_id)));
    const BRON_SHARE = new Set(BRON_LIST.map(a => Number(a.share_account_id)).filter(id => id > 0));
    const BRON_RE = (() => { try { return BRON && BRON.share_regex ? new RegExp(BRON.share_regex, 'iu') : null; } catch (e) { return null; } })();
    // спершу транзит ЗП: повернення з транзитного рахунку (невдала виплата броніку) — теж ЗП броніків, а не їхні кошти з «1.5 %»
    const BRON_IN = 'кошти броніків: у CRM не вносяться — дохід компанії записується окремо, «1.5% від бронювання»';
    const bronSkip = (x, k) => (k === 'own' ? null : k === 'pay' ? 'ЗП броніків через транзитний рахунок — у CRM не вноситься'
      : x.amount > 0 ? BRON_IN : Rc.PAY_TAX.test(x.purpose || '') ? 'податки за броніків — у CRM не вносяться' : null);
    const bronCalc = c => (c.opc === 1 && BRON_RE && BRON_RE.test(c.comment || '') ? 'розрахунковий запис «1.5% від бронювання» — дохід з коштів броніків, руху в банку в нього немає' : null);
    const ARTS =((opts.rulesDoc && opts.rulesDoc.reference && opts.rulesDoc.reference.articles) || [])
      .map(a => ({ key: `${a.category_id}/${a.operation_id}`, type: a.type, group: a.group, label: R.articleLabelOf(a) }));
    const artLabel = k => (ARTS.find(a => a.key === k) || {}).label || `стаття ${k}`;
    const projName = id => (projects.find(([, v]) => Number(v) === Number(id)) || [''])[0];
    /* Особлива стаття: CRM вимагає маркетолога (рекламний бюджет) — 'marketer', його вибирають у рядку;
       зарплатна (CRM може відмовити, 422) — 'salary', такий запис тут не створюється. */
    const salaryArt = k => {
      if (!k) return false;
      const [c, o] = k.split('/').map(Number);
      return c === ((S.cfg && S.cfg.salary && S.cfg.salary.category_id) || M.SALARY_CATEGORY_DEFAULT) || M.SALARY_OPS_DEFAULT.includes(o);
    };
    function artIssue(k) {
      if (!k) return '';
      if (M.marketerArtsOf(S.cfg).has(k)) return 'marketer';
      return salaryArt(k) ? 'salary' : '';
    }
    /* Зарплатна стаття (з 05.11.2026) — запис можна створити, але це ризик: CRM не дає змінювати («Операції по зарплаті не доступні
       для редагування») і видаляти такі записи, тож помилку виправить лише адміністратор CRM. Вікно створення окремо про це попереджає. */
    const ISSUE = { marketer: 'для цієї статті CRM вимагає маркетолога — виберіть його', salary: 'зарплатна стаття: після створення CRM не дасть цей запис ні змінити, ні видалити — перевірте суму, дату, статтю й коментар' };
    // маркетологи — як у реєстрі погоджень: працюють і мають роль «маркетолог» / «маркетинг» або є в його списку
    const MK_IDS = [193, 1249, 1324, 124, 208, 1297, 1328];
    const mkName = id => ((S.mks || []).find(m => m.id === Number(id)) || {}).name || `маркетолог ID ${id}`;
    async function loadMarketers() {
      if (S.mks !== undefined) return;
      S.mks = null;
      let list = [];
      try {
        list = listOf(await api.get('user/?all=true')).filter(u => u.is_working !== false && ((u.role && /маркетолог|маркетинг/i.test(u.role.name || '')) || MK_IDS.includes(Number(u.id))))
          .map(u => ({ id: Number(u.id), name: String(u.name || '').trim() })).sort((a, b) => a.name.localeCompare(b.name, 'uk'));
      } catch (e) {} // без списку — лише маркетологи з попередніх записів рахунку
      S.mks = list;
      if (!S.busy) render();
    }
    el.innerHTML = `
<div class="card">
 <div class="ctl-row">
  <div class="fld"><div class="lbl">Період · дати за Києвом, включно</div><div class="row"><input type="date" data-b="from"><span class="muted">—</span><input type="date" data-b="to">
   <span class="seg sm"><button type="button" data-b="d-t">Сьогодні</button><button type="button" data-b="d-y">Вчора</button><button type="button" data-b="d-m">Цей місяць</button></span></div></div>
  <div class="fld"><div class="lbl">Що звіряти</div><span class="seg" data-b="kind">${Object.entries(KIND).map(([k, t]) => `<button type="button" data-kind="${k}"${k === 'all' ? ' class="on"' : ''}>${t.charAt(0).toUpperCase() + t.slice(1)}</button>`).join('')}</span></div>
  <div class="acts">
   <button class="primary" data-b="fetch" title="Приват і Моно: виписки за період вивантажить «Помічник кешфлоу» вашим privat_fetch.py, потім — звірка">Отримати виписки й звірити</button>
   <button data-b="calc" title="Звірити з уже доданими виписками, без нового вивантаження">Звірити</button>
   <button class="quiet" data-b="pick">Додати файл .json</button><input type="file" data-b="file" accept=".json,application/json" multiple hidden>
   <button class="quiet" data-b="xlsx" disabled>Звіт .xlsx</button>
  </div>
 </div>
 <div class="row" style="margin:8px 0 0"><span class="muted small" data-b="st"></span><span class="muted small" data-b="closed"></span></div>
 <div data-b="flog"></div>
 <div class="muted small" data-b="files" style="margin-top:4px"></div>
 <div data-b="map"></div>
 <details class="hint"><summary>Як читати звірку</summary><div>По кожному рахунку: залишок на початок і кінець періоду, надходження й списання — CRM проти банку, і кількість операцій за кожною сумою (суми бувають не 1:1 з банком, тому рахуються штуки). CRM — так, як його показує CRM. Угорі — підсумок; плитка відкриває свій розділ. «Зіставлення ШІ» — операції банку ↔ погодження реєстру ↔ записи CRM (пакети ЗП по людях, податки, що лишилось — ШІ на кнопку). «Внести в CRM» — чого бракує в CRM (перекази між своїми, операції банку, нові корп. картки), «Виправити» — записи з неправильним типом, «Виводи з балансу» — виводи менеджерів і тімлідів проти погоджень «% менеджера / м-рів / тімліда», «Закриття місяця» — чи можна закривати місяць. Без вашої дії в CRM нічого не змінюється.<br>«Разом з корп. карткою» — картка списує прямо з рахунку: поповнення картки в CRM — рух усередині, а покупки з виписки звіряються з витратами картки. «Різниця залишку … накопичено раніше» — щоб знайти, коли вона з'явилась, поставте ранішу дату «з».</div></details>
</div>
<div data-b="notes"></div>
<div data-b="sum"></div>
<div class="secnav"><span class="seg" data-b="nav"><button type="button" data-sec="acc">Рахунки<span class="cnt" data-n="acc" hidden></span></button><button type="button" data-sec="mt">Зіставлення ШІ<span class="cnt" data-n="mt" hidden></span></button><button type="button" data-sec="add">Внести в CRM<span class="cnt" data-n="add" hidden></span></button><button type="button" data-sec="fix">Виправити<span class="cnt" data-n="fix" hidden></span></button><button type="button" data-sec="wd">Виводи з балансу<span class="cnt" data-n="wd" hidden></span></button><button type="button" data-sec="close">Закриття місяця<span class="cnt" data-n="close" hidden></span></button></span></div>
<div class="card" data-b="closebar" hidden>
 <div class="sub-h"><h3>Закриття місяця</h3><span class="muted small">звірка за весь місяць, «Статті й проєкти», погодження й виводи з балансу — і висновок, чи можна закривати. Нічого не змінює.</span></div>
 <div class="row" style="margin:0"><select data-b="cm"></select><button class="primary" data-b="cm-go" style="margin:0">Перевірити місяць</button><span class="muted small" data-b="cm-st"></span></div>
</div>
<div data-b="out"></div>`;
    const $ = k => el.querySelector(`[data-b="${k}"]`);
    const st = t => { $('st').textContent = t; };
    const note = (t, cls) => $('notes').insertAdjacentHTML('beforeend', `<div class="${cls || 'warn'}">${esc(t)}</div>`);
    const t0 = today(), sp0 = sharedPeriod();
    $('from').value = sp0 ? sp0.from : t0; // за замовчуванням — сьогоднішній день або період, з яким сьогодні вже працювали
    $('to').value = sp0 ? sp0.to : t0;
    if (sp0) periodSeen = sp0.n;
    // вкладку показали знову: період, перевірений тим часом у «Статтях і проєктах», — у поля дат; звірку запускає людина («Звірити»)
    function syncPeriod() {
      const v = sharedPeriod();
      if (!v || v.n === periodSeen || S.busy) return;
      periodSeen = v.n;
      if (v.by === 'bank' || ($('from').value === v.from && $('to').value === v.to)) return;
      $('from').value = v.from; $('to').value = v.to;
      updQuick();
      st(`період ${dmy(v.from)}–${dmy(v.to)} — як у «Статтях і проєктах»; натисніть «Звірити»`);
    }
    // швидкі періоди — сегментований перемикач; позначено той, що збігається з вибраними датами
    function updQuick() {
      const f = $('from').value, t = $('to').value, d = today(), y = addDays(d, -1);
      $('d-y').classList.toggle('on', f === y && t === y);
      $('d-t').classList.toggle('on', f === d && t === d);
      $('d-m').classList.toggle('on', f === d.slice(0, 8) + '01' && t === d && f !== d);
    }
    const setDay = (f, t) => { $('from').value = f; $('to').value = t || f; updQuick(); onPeriod(); };
    $('d-y').onclick = () => setDay(addDays(today(), -1));
    $('d-t').onclick = () => setDay(today());
    $('d-m').onclick = () => setDay(today().slice(0, 8) + '01', today());
    updQuick();
    // розділи вкладки: «Рахунки», «Внести в CRM», «Виправити», «Виводи з балансу», «Закриття місяця» (вибір пам'ятається)
    function applySec() {
      $('nav').querySelectorAll('[data-sec]').forEach(b => b.classList.toggle('on', b.dataset.sec === S.sec));
      $('out').querySelectorAll('section[data-sec]').forEach(s => { s.hidden = s.dataset.sec !== S.sec; });
      $('closebar').hidden = S.sec !== 'close';
      LS.set('cfl_bank_sec', S.sec);
      fitComs($('out').querySelectorAll('section[data-sec]:not([hidden]) textarea.xcom')); // висота полів коментаря — коли розділ видно
    }
    $('nav').querySelectorAll('[data-sec]').forEach(b => b.onclick = () => { S.sec = b.dataset.sec; applySec(); });
    // до першої звірки — пояснення в розділах (закриття місяця — свій рядок з вибором місяця)
    function emptyOut() {
      $('out').innerHTML = ['acc', 'mt', 'add', 'fix', 'wd'].map(k => `<section data-sec="${k}"><div class="empty">Ще не звірено — виберіть період і натисніть «Отримати виписки й звірити» (або «Звірити», якщо виписки вже є).</div></section>`).join('') + '<section data-sec="close"></section>';
    }
    emptyOut();
    applySec();
    $('kind').querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
      S.kind = b.dataset.kind;
      $('kind').querySelectorAll('[data-kind]').forEach(x => x.classList.toggle('on', x === b));
      render();
    });
    $('files').textContent = HINT;
    // поки йдуть запити: головні кнопки вимкнено, решта (у таблиці) приглушена й перевіряє S.busy
    /* чернетки періоду звірки (режим чернеток; інакше undefined): по одному рядку на чернетку — для «Закриття місяця» */
    function draftItems() {
      if (!S.drafts || !S.items) return undefined;
      const seen = new Map();
      for (const [acc, list] of S.items) for (const x of list) if (x.draft && x.date >= S.from && x.date <= S.to && !seen.has(x.id)) seen.set(x.id, { id: x.id, date: x.date, amount: Math.abs(x.amount), name: nameOf(acc) });
      return [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    }
    function busy(on) {
      S.busy = on;
      ['calc', 'fetch', 'pick'].forEach(k => { $(k).disabled = on; });
      $('cm-go').disabled = on || !!S.closing || !$('cm').value;
      el.classList.toggle('is-busy', on);
      // перемикач чернеток змінили, поки панель працювала: звірити заново, щойно вона звільниться (і лише якщо є що звіряти)
      if (!on && S.redo) setTimeout(() => { if (S.busy || !S.redo) return; S.redo = false; if (S.items) calc(); }, 0);
    }
    function period() {
      const from = $('from').value, to = $('to').value;
      if (!from || !to || from > to) { note('Перевірте період: дата «з» має бути не пізніше дати «по».', 'err'); return null; }
      // закриті в CRM місяці не звіряються: «з» — не раніше першого відкритого дня
      const c = clampToOpen(from, to, closedTo());
      if (!c) {
        S.items = null; $('out').innerHTML = '';
        note(`${dmy(from)}–${dmy(to)}: ці місяці закрито в CRM (по ${M.monthUa(closedTo())}) — їх не звіряємо: змінювати їх може лише Адмін.`, 'warn');
        return null;
      }
      if (c.cut) { $('from').value = c.cut; note(`Місяці по ${M.monthUa(closedTo())} закрито в CRM — звіряю з ${dmy(c.cut)}.`, 'info'); }
      // період, який справді звіряють, — спільний з «Статтями й проєктами»
      periodSeen = Date.now();
      LS.set('cfl_period', { from: c.from, to: c.to, day: today(), by: 'bank', n: periodSeen });
      return { from: c.from, to: c.to };
    }
    function updClosed() { $('closed').textContent = closedTo() ? `· закрито в CRM по ${M.monthUa(closedTo())} — не звіряється` : ''; }
    updClosed();
    // «Закриття місяця»: місяці від межі роботи (fix_from) і першого відкритого в CRM до поточного; закриті не пропонуються
    function fillMonths() {
      const cur = today().slice(0, 7), want = $('cm').value || defaultMonth(today()), list = [];
      for (let m = [M.monthOf(fixFrom) || cur, closedTo() ? M.openFrom(closedTo()).slice(0, 7) : null].filter(Boolean).sort().pop(); m <= cur; m = M.openFrom(m).slice(0, 7)) list.push(m);
      $('cm').innerHTML = list.length ? list.map(x => `<option value="${x}"${x === want ? ' selected' : ''}>${esc(monthName(x))}</option>`).join('') : '<option value="">— відкритих місяців немає —</option>';
      $('cm-go').disabled = S.busy || !!S.closing || !list.length;
    }
    fillMonths();
    if (CL) CL.on(() => {
      updClosed();
      fillMonths();
      if (!S.items || S.busy) return;
      const c = clampToOpen(S.from, S.to, closedTo());
      if (!c) { S.items = null; $('out').innerHTML = ''; st(`${dmy(S.from)}–${dmy(S.to)}: місяці закрито в CRM — не звіряються`); return; }
      if (c.cut) { S.from = c.cut; $('from').value = c.cut; }
      render();
    });

