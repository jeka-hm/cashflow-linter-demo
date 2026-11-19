    // ---------- читання CRM (лише GET) ----------
    async function pages(path, onPage) {
      const byId = new Map();
      for (let p = 1; p <= 1000; p++) {
        const j = await api.get(`${path}&per_page=500&page=${p}`);
        for (const r of listOf(j)) byId.set(r.id, r);
        if (onPage) onPage(p, j && j.last_page);
        if (Array.isArray(j) || !j.last_page || p >= j.last_page) break;
      }
      return [...byId.values()];
    }
    async function loadAccounts() {
      const all = new Map();
      for (let p = 1; p <= 50; p++) {
        const j = await api.get(`invoice?page=${p}&per_page=100`);
        for (const a of listOf(j)) all.set(a.id, a);
        if (Array.isArray(j) || !j.last_page || p >= j.last_page) break;
      }
      const live = [...all.values()].filter(a => !a.deleted_at);
      if (!live.some(a => a.balance !== undefined && a.balance !== null)) throw new Error('CRM не віддав залишки рахунків (поле balance у списку рахунків) — порахувати залишки неможливо.');
      S.accs = live;
      pruneLocalCards();
      if (!S.ccy) S.ccy = Object.fromEntries(listOf(await api.get('currency')).map(c => [c.id, c.code]));
    }
    // картки, запам'ятані в цьому браузері, які тепер видно з назв рахунків CRM (рахунок перейменували з номером чи завели новий), — прибрати
    function pruneLocalCards() {
      const local = LS.get(LOCAL_CARDS, []), gone = new Set(local.filter(c => Rc.staleLocalCard(c, S.accs)).map(c => String(c.last4)));
      if (!gone.size) return;
      LS.set(LOCAL_CARDS, local.filter(c => !gone.has(String(c.last4))));
      const ref = opts.rulesDoc && opts.rulesDoc.reference;
      if (ref && ref.cards) ref.cards = ref.cards.filter(x => !(x.local && gone.has(String(x.last4))));
      for (let i = CARDS.length - 1; i >= 0; i--) if (CARDS[i].local && gone.has(String(CARDS[i].last4))) CARDS.splice(i, 1);
      S.bv++;
      note(`${gone.size === 1 ? 'Картку' : 'Картки'} ${[...gone].map(t => '…' + t).join(', ')} тепер видно з назв рахунків у CRM — запам'ятане в цьому браузері прибрано.`, 'info');
    }
    async function calc() {
      $('notes').innerHTML = '';
      const p = period();
      if (!p) return;
      if (p.to === today()) note(LIVE, 'info');
      busy(true);
      let prevAccs = null;
      try {
        st('читаю рахунки й залишки CRM…');
        prevAccs = S.accs;
        await loadAccounts();
        if (S.cfg === undefined) { try { S.cfg = await api.get('pnl/operation-config'); } catch (e) { S.cfg = null; } }
        const lo = addDays(p.from, -MARGIN);
        let recs = await pages(`invoice-payment?date_from=${dash(lo)}&date_to=${dash(addDays(today(), 730))}`, (n, last) => st(`записи CRM з ${dmy(lo)}: сторінка ${n}/${last || '?'}`));
        /* Режим чернеток (перемикач у шапці): чернетки CRM звіряються як записи — щоб не внести ту саму операцію вдруге. Залишок
           рахунку CRM чернеток не містить, тому до нього додається їхня сума: звірка показує стан «коли чернетки проведуть».
           Вимкнено — жодного запиту до чернеток, усе як раніше. */
        let drafts = null; // у S — лише разом з новими записами: невдале читання не має стерти відомості про чернетки попередньої звірки
        if (dOn()) {
          st('читаю чернетки CRM…');
          let dr;
          try { dr = await DR.list(); } catch (e) {
            throw new Error(`Не вдалося прочитати чернетки CRM (${e.message}) — звірку не виконано. Якщо у вашої ролі немає доступу до чернеток, вимкніть «у чернетки» в шапці панелі.`);
          }
          const liveIds = new Set(recs.map(r => r.id));
          dr = dr.filter(r => !liveIds.has(r.id)); // чернетку щойно провели — вона вже серед записів
          // у звірку й у залишок ідуть ті самі чернетки: з рахунком, сумою й датою (недозаповнені — ні)
          const full = dr.filter(r => r.payments.length && r.date), eff = CFD.balanceEffect(full);
          S.accs = S.accs.map(a => (eff.has(a.id) ? { ...a, balance: r2(Number(a.balance) + eff.get(a.id)), balanceLive: a.balance } : a));
          const inRange = full.filter(r => M.kyivDate(r.date) >= lo);
          recs = recs.concat(inRange);
          drafts = { n: dr.length, used: inRange.length, early: full.length - inRange.length, empty: dr.length - full.length };
        }
        Object.assign(S, { items: Rc.cashflowByAccount(recs), drafts, itemsFrom: lo, from: p.from, to: p.to, offsets: null, hist: new Map(), gen: S.gen + 1 });
        Object.assign(S.wd, { rows: null, error: '' }); // погодження «Виводів з балансу» — теж заново (render прочитає реєстр)
        matchBanks(); renderFiles(); render();
        if (S.drafts) note(`Режим чернеток: враховано чернеток CRM — ${S.drafts.used}${S.drafts.n > S.drafts.used ? ` з ${S.drafts.n}` : ''}${S.drafts.early ? ` (до ${dmy(lo)} — ${S.drafts.early}: вони лише в залишках)` : ''}${S.drafts.empty ? ` (без рахунку, суми чи дати — ${S.drafts.empty}, вони не звіряються)` : ''}. Вони звіряються як записи, а залишки CRM показано так, ніби чернетки вже проведено. Нові записи теж підуть у чернетки.`, 'info');
        st(`готово: ${S.accs.length} ${plural(S.accs.length, 'рахунок', 'рахунки', 'рахунків')} за ${dmy(p.from)}–${dmy(p.to)}; залишки CRM станом на ${new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}`);
      } catch (e) {
        // звірка не вдалась: на екрані лишається попередня — з її ж залишками (інакше нові залишки змішались би зі старими записами й чернетками)
        if (prevAccs && S.items) S.accs = prevAccs;
        note(e.message, 'err'); st('помилка');
      }
      finally { busy(false); }
    }
    $('calc').onclick = calc;
    const onPeriod = () => {
      updQuick();
      let from = $('from').value;
      const to = $('to').value;
      if (!S.items || !from || !to || from > to) return;
      const c = clampToOpen(from, to, closedTo());
      if (!c) { st(`${dmy(from)}–${dmy(to)}: місяці закрито в CRM — не звіряються`); return; }
      if (c.cut) { from = c.cut; $('from').value = from; }
      if (from >= addDays(S.itemsFrom, MARGIN)) { S.from = from; S.to = to; render(); st(`період ${dmy(from)}–${dmy(to)}`); }
      else st('для ранішого періоду натисніть «Звірити»');
    };
    $('from').onchange = onPeriod;
    $('to').onchange = onPeriod;

    // ---------- виписки: Помічник кешфлоу або файл ----------
    function addBankJson(json, name) {
      if (!json || !Array.isArray(json.accounts)) throw new Error('немає списку рахунків');
      const accs = Rc.bankAccounts(json, name).filter(b => b.rows.length || b.opening != null || b.closing != null);
      if (!accs.length) throw new Error('у файлі немає ні операцій, ні залишків');
      S.banks = S.banks.filter(b => b.fileName !== name).concat(accs);
      S.bv++;
    }
    async function afterStatements() {
      if (!S.accs) { try { st('читаю рахунки CRM…'); await loadAccounts(); } catch (e) { note(e.message, 'err'); } }
      matchBanks(); renderFiles();
      if (S.items) render();
    }
    $('pick').onclick = () => $('file').click();
    $('file').onchange = async () => {
      const files = [...$('file').files];
      $('file').value = '';
      for (const f of files) {
        try { addBankJson(JSON.parse(await f.text()), f.name); } catch (e) { note(`${f.name}: не схоже на виписку з «Помічника» чи privat_fetch.py (${e.message}).`, 'err'); }
      }
      await afterStatements();
    };
    const helperUrl = () => String(LS.get('cfl_helper_url', 'http://127.0.0.1:8765')).replace(/\/+$/, '');
    async function hreq(path, init) {
      const r = await fetch(helperUrl() + path, { cache: 'no-store', ...(init || {}) });
      let j = null;
      try { j = await r.json(); } catch (e) {}
      if (!r.ok) throw Object.assign(new Error((j && j.error) || `Помічник: HTTP ${r.status}`), { helper: true });
      return j;
    }
    const flog = (lines, cls) => { $('flog').innerHTML = lines && lines.length ? `<pre class="${cls || ''}" style="margin:8px 0 0;max-height:150px">${esc(lines.join('\n'))}</pre>` : ''; };
    async function fetchStatements(force) {
      $('notes').innerHTML = '';
      const p = period();
      if (!p) return;
      if (p.to > today()) { note('Дата «по» пізніша за сьогодні.', 'err'); return; }
      // файл, вивантажений не пізніше останнього дня періоду, міг бути проміжним (день ще не закрито): беремо заново —
      // для періоду по сьогодні, якщо він старший за 30 хв, для минулого періоду — завжди (інакше вчорашні вечірні операції губились)
      const live = p.to === today();
      const stale = f => String(f.mtime || '').slice(0, 10) <= p.to && (!live || Date.now() - new Date(f.mtime).getTime() > 30 * 60000);
      const later = []; // підказки після звірки: calc() очищає повідомлення
      busy(true);
      try {
        let info;
        try { info = await hreq('/api/panel/bank/status'); } catch (e) { if (e.helper) throw e; note(HELPER_DOWN, 'err'); return; }
        // Помічник віддає лінтер із своєї папки: якщо там новіша збірка, ніж відкрита зараз, — підказати
        if (info.linter && typeof CF_BUILD === 'string' && info.linter > CF_BUILD) later.push([`Є новіша версія лінтера (зібрано ${new Date(info.linter).toLocaleString('uk-UA')}): закрийте панель (✕) і натисніть закладку ще раз.`, 'info']);
        if (!info.bank || !info.bank.script) { note(`У папці виписок Помічника (${(info.bank && info.bank.dir) || '?'}) немає privat_fetch.py — вкажіть папку в «Налаштуваннях» Помічника.`, 'err'); return; }
        const name = `виписка_ВСІ_${dmy(p.from)}_${dmy(p.to)}.json`;
        const have = (await hreq('/api/panel/bank/files')).files.find(f => f.name === name);
        // файл записано цим вивантаженням (час файлу — до хвилини, початок — до секунди), а не лишився від попереднього
        const fromJob = (f, j) => !!(f && j && j.started && String(f.mtime || '') >= String(j.started).slice(0, 16));
        if (have && !force && !stale(have) && !(info.job && info.job.running)) {
          addBankJson(await hreq('/api/panel/bank/file?name=' + encodeURIComponent(name)), name);
          flog(null);
          $('flog').innerHTML = `<div class="info">Узято вже вивантажені виписки за ${esc(dmy(p.from))}–${esc(dmy(p.to))} (файл від ${esc(have.mtime.replace('T', ' '))}). <span class="lnk" data-b="refetch">Вивантажити заново</span></div>`;
          $('flog').querySelector('[data-b="refetch"]').onclick = () => fetchStatements(true);
          // цей файл — з вивантаження, де частину не вивантажено: нагадати, чого в ньому бракує (07.11.2026)
          const j0 = info.job || {};
          if (j0.code !== 0 && j0.code != null && j0.file === name && fromJob(have, j0)) later.push([partialFetchText(j0.log, j0.code)]);
        } else {
          if (!(info.job && info.job.running)) await hreq('/api/panel/bank/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: p.from, to: p.to }) });
          let job = info.job || {};
          // Моно віддає 1 запит на хвилину: довго — лише з валютними рахунками (галочка в Помічнику) чи за період понад 31 день
          const slow = !!(info.bank && info.bank.mono_currency) || dayDiff(p.to, p.from) >= 31;
          for (let i = 0; ; i++) {
            await new Promise(r => setTimeout(r, i ? 1500 : 400));
            job = await hreq('/api/panel/bank/job');
            st(job.running ? `Помічник вивантажує виписки${job.args ? ` за ${dmy(job.args[0])}–${dmy(job.args[1])}` : ''}…${slow ? ' (Моно віддає 1 запит на хвилину — це може тривати кілька хвилин)' : ''}` : '');
            flog((job.log || []).slice(-8));
            if (!job.running) break;
          }
          /* privat_fetch.py записує файл з усім, що вдалось, і повертає код 1, якщо не вдалось хоч одного клієнта чи банку (токен, збій банку):
             такий файл звіряємо, з попередженням, чого бракує (07.11.2026). Без свіжого файлу — помилка, як і було */
          const partial = job.code !== 0 && !!job.file;
          if (partial && !fromJob((await hreq('/api/panel/bank/files')).files.find(f => f.name === job.file), job)) job.file = null;
          if (!job.file) { flog((job.log || []).slice(-15), 'err'); note(`Вивантаження завершилось з помилкою (код ${job.code}), виписок не отримано. Журнал — вище; той самий журнал є в Помічнику.`, 'err'); return; }
          if (job.args && (job.args[0] !== p.from || job.args[1] !== p.to)) later.push([`Помічник щойно вивантажив інший період (${dmy(job.args[0])}–${dmy(job.args[1])}) — натисніть «Отримати виписки й звірити» ще раз.`]);
          addBankJson(await hreq('/api/panel/bank/file?name=' + encodeURIComponent(job.file)), job.file);
          if (partial) {
            later.push([partialFetchText(job.log, job.code)]);
            flog((job.log || []).slice(-15), 'err');
            $('flog').insertAdjacentHTML('beforeend', `<div class="warn">Виписки отримано о ${new Date().toTimeString().slice(0, 5)} не всі: ${esc(job.file)}. <span class="lnk" data-b="refetch">Вивантажити заново</span></div>`);
            $('flog').querySelector('[data-b="refetch"]').onclick = () => fetchStatements(true);
          } else {
            flog(null);
            $('flog').innerHTML = `<div class="info">Виписки отримано о ${new Date().toTimeString().slice(0, 5)}: ${esc(job.file)}.</div>`;
          }
        }
        if (!S.items || S.from !== p.from || S.to !== p.to) { busy(false); await calc(); } else { if (live) note(LIVE, 'info'); await afterStatements(); }
        later.forEach(([t, c]) => note(t, c));
      } catch (e) { note(e.message, 'err'); st('помилка'); }
      finally { busy(false); }
    }
    $('fetch').onclick = () => fetchStatements(false);

    // ---------- закриття місяця: звірка за весь місяць + «Статті й проєкти» + погодження → чи можна закривати ----------
    /* Веб-застосунок реєстру, дія bank — лише читання рядків «Реєстру» й «Архіву» за датою оплати (посилання й ключ — налаштування
       реєстру в цьому браузері). → відповідь {rows, startDate, …} або null (реєстр тут не налаштовано) */
    const regCfg = () => { const c = LS.get('pogodzh_cfg_v1', null); return c && c.url && c.key ? c : null; };
    async function regFetch(from, to) {
      const cfg = regCfg();
      if (!cfg) return null;
      /* Дія bank читає «Реєстр» як є, а нові погодження потрапляють у нього лише при оновленні (дія pending — та сама, що «1. Отримати
         й перевірити» у «Погодженні»). Без неї «Звірка» не бачила погоджень останніх днів: 16.11.2026 — 5 пакетів ЗП і реінвест
         ФОП Привільної за 12–13.11 лишились «без погодження». Тому перед читанням реєстр оновлюється (не частіше ніж раз на 5 хвилин);
         не вдалось — читаємо як є і кажемо про це. */
      if (!S.wd.sync || Date.now() - S.wd.sync.at > 5 * 60 * 1000) {
        const sync = { at: Date.now(), error: '' };
        try {
          const rs = await fetch(`${cfg.url}${cfg.url.includes('?') ? '&' : '?'}action=pending&key=${encodeURIComponent(cfg.key)}`, { redirect: 'follow' });
          const js = await rs.json();
          if (!js.ok) sync.error = js.error || `HTTP ${rs.status}`; else if (js.syncError) sync.error = js.syncError;
        } catch (e) { sync.error = e.message || String(e); }
        if (sync.error) sync.at = 0; // наступного разу — ще одна спроба
        S.wd.sync = sync;
        if (sync.error) note(`Реєстр погоджень не вдалося оновити з таблиці «Погодження виплат» (${sync.error}) — погодження останніх днів можуть бути не враховані. Оновіть його у вкладці «Погодження» («1. Отримати й перевірити») і звірте ще раз.`, 'warn');
      }
      const r = await fetch(`${cfg.url}${cfg.url.includes('?') ? '&' : '?'}action=bank&key=${encodeURIComponent(cfg.key)}&from=${from}&to=${to}`, { redirect: 'follow' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    }
    /* Погодження з from по to, ще не внесені в кешфлоу. Рядки до «Починати з дати» реєстру не беруться — їх реєстр і не вносить.
       → {from, to, open: «так», check: «перевірити»} */
    function regOpen(j, from, to) {
      const start = j.startDate && j.startDate > from ? j.startDate : from;
      const rows = (j.rows || []).filter(x => x.date >= start && x.date <= to && !x.id && !['внесено', 'вже є', 'зник у погодженнях', 'змінено після внесення'].includes(x.status));
      return { from: start, to, open: rows.filter(x => x.action === 'так'), check: rows.filter(x => x.action === 'перевірити') };
    }
    // погодження для «Виводів з балансу» (S.wd); відповідь старішого запиту, ніж останній, відкидається
    async function wdLoad(from, to) {
      const seq = ++S.wd.seq;
      Object.assign(S.wd, { busy: true, error: '' });
      try {
        const j = await regFetch(from, to);
        // ver — номер прочитаних даних: кеш «Зіставлення ШІ» й «Виводів» тримається на ньому, а не на номері запиту (seq змінюється ще до
        // відповіді — і розрахунок на старих рядках лишався в кеші назавжди: після зміни періоду погодження нових днів не бачились, огляд 16.11.2026)
        if (seq === S.wd.seq) { Object.assign(S.wd, j ? { from, to, rows: j.rows || [] } : { rows: null }); S.wd.ver = (S.wd.ver || 0) + 1; }
        return j;
      } catch (e) {
        if (seq === S.wd.seq) S.wd.error = e.message || String(e);
        throw e;
      } finally {
        if (seq === S.wd.seq) S.wd.busy = false;
      }
    }
    // вікно погоджень для звірки виводів за період: від WD_BACK днів до «з» до WD_AHEAD днів після «по»
    const wdWin = () => ({ from: addDays(S.from, -WD_BACK), to: addDays(S.to, WD_AHEAD) });
    // після звірки чи зміни періоду — прочитати погодження, якщо прочитаних не вистачає (у фоні; «Закриття місяця» читає реєстр саме)
    function wdEnsure() {
      if (!S.items || S.closing || S.wd.busy || S.wd.error || !regCfg()) return;
      const w = wdWin();
      if (S.wd.rows && S.wd.from <= w.from && S.wd.to >= w.to) return;
      const show = () => { if (S.busy) setTimeout(show, 300); else render(); }; // поки йде звірка, вона сама перемалює вкладку наприкінці
      wdLoad(w.from, w.to).catch(() => {}).then(show);
    }
    /* Зіставлення виводів з балансу (усі записи «Підтвердження виведення коштів…», прочитані звіркою) з погодженнями реєстру:
       показуються погодження з датою оплати в періоді; решта — лише щоб їхні виводи не були «без погодження».
       → {res, sum, nW: виводів за період} або null (погоджень ще немає) */
    function wdCalc() {
      if (!S.items || !S.wd.rows) return null;
      const key = [S.gen, S.from, S.to, S.wd.ver || 0, S.wd.busy ? 'b' + S.wd.seq : ''].join('|');
      if (S.wdm && S.wdm.key === key) return S.wdm;
      const ap = S.wd.rows.filter(x => !WD_GONE.has(x.status)).map(x => { const a = WD.parseApproval(x); if (a) a.report = x.date >= S.from && x.date <= S.to; return a; }).filter(Boolean);
      const ws = [], seen = new Set();
      for (const list of S.items.values()) for (const x of list) { const w = !seen.has(x.id) && WD.parseWithdrawal(x); if (w) { seen.add(x.id); ws.push(w); } }
      const res = WD.match(ap, ws, { teams: LS.get(WD_TEAMS, {}), today: today() });
      LS.set(WD_TEAMS, res.teams);
      S.wdm = { key, res, sum: WD.summary(res, S.from, S.to), nW: ws.filter(w => w.date >= S.from && w.date <= S.to).length };
      return S.wdm;
    }
    // для «Закриття місяця» і лічильника: підсумок, {error} або null (реєстр не налаштовано чи ще читається)
    const wdPart = () => (S.wd.error ? { error: S.wd.error } : !regCfg() ? null : (wdCalc() || {}).sum || null);
    const WD_ROW = { ok: 's-ok', diff: 's-bad', none: 's-bad', ambig: 's-part', wait: '' }, WD_ORDER = { none: 0, diff: 1, ambig: 2, wait: 3, ok: 4 };
    // розділ «Виводи з балансу»: погодження періоду (спершу ті, що не зійшлися) і виводи без погодження
    function wdHtml() {
      const head = `<div class="card" data-b="wd"><div class="sub-h"><h3>Виводи з балансу за ${esc(dmy(S.from))}–${esc(dmy(S.to))}</h3><span class="muted small">погодження «% менеджера / м-рів / тімліда» ↔ записи «Підтвердження виведення коштів з балансу…» у CRM</span></div>
<details class="hint" style="margin:0 0 10px"><summary>Як це звіряється</summary><div>Кожне підтвердження виведення у вкладці «Баланс» CRM — окремий запис кешфлоу на одну людину. Погодження «% м-рів та тімліда» — це вивід тімліда і виводи його менеджерів разом: склад команди CRM не віддає, тож лінтер шукає набір виводів, що дає рівно суму погодження (лише якщо такий набір один), і запам'ятовує склад для наступних тижнів (у цьому браузері). Вивід шукається спершу в найближчі дні після дати оплати погодження, потім — від 3 днів до неї до 10 днів після. Погодження до 05.10.2026 «разом з податками»: на руки = сума × 0,9. Погодження, яке реєстр уніс на всю суму, — витрата в кешфлоу вже є: вивід з балансу до нього означав би витрату двічі. Лише звірка — нічого не створюється й не змінюється.</div></details>`;
      if (!regCfg()) return `${head}<div class="info">Реєстр погоджень у цьому браузері не налаштовано (⚙ у вкладці «Погодження») — звіряти виводи немає з чим.</div></div>`;
      if (S.wd.error) return `${head}<div class="err">Реєстр погоджень не відповів: ${esc(S.wd.error)} <span class="lnk" data-b="wdretry">Спробувати ще раз</span></div></div>`;
      const W = wdCalc();
      if (!W) return `${head}<div class="info">Читаю погодження з реєстру…</div></div>`;
      const s = W.sum, t0 = today(), nT = Object.keys(LS.get(WD_TEAMS, {})).length;
      const teams = nT ? `<div class="muted small" style="margin-top:10px">Запам'ятаний склад команд: ${nT} <span class="lnk" data-b="wdreset">скинути</span></div>` : '';
      const rep = W.res.rows.filter(r => r.a.report !== false).sort((p, q) => (WD_ORDER[p.status] - WD_ORDER[q.status]) || (p.a.date < q.a.date ? -1 : p.a.date > q.a.date ? 1 : 0));
      if (!rep.length && !s.extra) return `${head}<div class="empty">За період погоджень «% менеджера / м-рів / тімліда» немає${W.nW ? ` — виводи з балансу за період (${W.nW}) за погодженнями попередніх днів` : ', виводів з балансу — теж'}.</div>${teams}</div>`;
      const pill = (cls, t) => `<span class="pill ${cls}">${esc(t)}</span>`;
      let h = `${head}<div class="row" style="margin:0 0 10px"><span>Погоджень: <b>${s.n}</b>${s.n ? ` на ${esc(fmt(s.approved))}` : ''}</span>${s.ok ? pill('st-ok', `виведено повністю: ${s.ok}`) : ''}${s.diff ? pill('st-manual', `сума не збігається: ${s.diff}`) : ''}${s.none ? pill('st-manual', `виводу немає: ${s.none}`) : ''}${s.ambig ? pill('st-review', `не вдалося розкласти: ${s.ambig}`) : ''}${s.wait ? pill('st-locked', `чекаємо вивід: ${s.wait}`) : ''}${pill(s.extra ? 'st-manual' : 'st-locked', `виводів без погодження: ${s.extra}`)}${s.double.length ? pill('st-manual', `схоже на витрату двічі: ${s.double.length}`) : ''}</div>`;
      const wl = w => `<div>${esc(wdWho(w))} · <b>${esc(fmt(w.amount))}</b> · ${esc(dmy(w.date).slice(0, 5))} <span class="muted">ID ${w.id}</span></div>`;
      if (rep.length) {
        h += `<div class="tbl" style="max-height:64vh"><table class="xf"><tr><th>Дата оплати</th><th>Погодження</th><th class="n">Погоджено</th><th class="n">Виведено</th><th>Стан</th><th>Виводи з балансу (записи CRM)</th></tr>`;
        for (const r of rep) {
          const a = r.a, st = wdText(r, t0), dbl = s.double.includes(r), list = r.status === 'ok' ? r.items : r.cands;
          h += `<tr class="${WD_ROW[r.status]}"><td style="white-space:nowrap">${esc(dmy(a.date))}</td>
<td><b>${esc(a.recipient || '—')}</b><div class="muted" style="font-size:12px">${esc(a.content.slice(0, 140))}</div></td>
<td class="n">${esc(fmt(a.amount))}${a.gross ? '<div class="muted" style="font-weight:400;font-size:12px">разом з податками</div>' : ''}</td>
<td class="n">${r.status === 'ok' && r.how !== 'registry' || r.cands.length ? esc(fmt(r.sum)) : '<span class="muted">—</span>'}</td>
<td class="${st.cls === 'warn' ? '' : st.cls}" style="font-weight:${st.cls === 'bad' ? 700 : 400}">${esc(st.text)}${dbl ? `<div class="warn" style="margin:4px 0 0;padding:4px 8px;font-weight:400">реєстр уніс це погодження на всю суму (ID ${a.id}), і є вивід з балансу — витрата двічі?</div>` : ''}</td>
<td class="xwhy">${list.length ? (r.status === 'ok' ? '' : '<div class="muted">знайдено лише:</div>') + list.map(wl).join('') : r.status === 'none' || r.status === 'wait' ? `<span class="muted">шукав з ${esc(dmy(addDays(a.date, -3)))} по ${esc(dmy(addDays(a.date, 10)))}</span>` : '<span class="muted">—</span>'}</td></tr>`;
        }
        h += '</table></div>';
      }
      if (s.extra) {
        h += `<div class="lbl" style="margin:14px 0 6px">Виводи без погодження · ${s.extra}</div><div class="tbl" style="max-height:40vh"><table class="xf"><tr><th>Дата</th><th>Хто</th><th class="n">Сума</th><th>Рахунок CRM</th><th>Запис CRM</th></tr>
${s.extraList.map(({ w, near }) => `<tr class="s-bad"><td style="white-space:nowrap">${esc(dmy(w.date))}</td><td>${esc(wdWho(w))}</td><td class="n">${esc(fmt(w.amount))}</td><td>${esc(w.acc != null ? nameOf(w.acc) : '—')}</td><td>ID ${w.id}${near ? `<div class="muted xwhy">${esc(wdNear(near))}</div>` : ''}</td></tr>`).join('')}</table></div>`;
      }
      return h + teams + '</div>';
    }
    function bindWd() {
      const q = k => $('out').querySelector(`[data-b="${k}"]`);
      if (q('wdretry')) q('wdretry').onclick = () => { S.wd.error = ''; render(); };
      if (q('wdreset')) q('wdreset').onclick = () => { LS.set(WD_TEAMS, {}); S.wdm = null; render(); };
    }

