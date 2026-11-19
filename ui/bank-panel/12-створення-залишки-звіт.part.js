    // ---------- створення в CRM: ті самі запити, що й у реєстрі погоджень 1.9 ----------
    const LOCATION = '1'; // країна призначення в кешфлоу — завжди Україна; проєкт — вибраний (уточнення 27.10.2026)
    function transferForm(p) {
      const st = S.xp.get(p.key), d = crmDate(p.date, p.time);
      const to = S.accs.find(a => a.id === p.to) || {};
      return { operation: '3', amount: String(st.amount), invoice_from: String(p.from), invoice_to: String(p.to), date: d.date, period: d.period,
        comment: st.comment || defaultComment(p), location_id: LOCATION, project_id: String(st.proj), currency_id: String(to.currency_id) };
    }
    // витрата — як «Внести» в реєстрі (operation 2, marketer_id — для статті з рекламним бюджетом); надходження — той самий запит з operation 1. Валюта — рахунку.
    function recordForm(p) {
      const st = S.rp.get(p.key), d = recWhen(p, closedTo()), [cat, op] = st.art.split('/'); // покупка карткою — за датою покупки
      const ccy = String((S.accs.find(a => a.id === p.acc) || {}).currency_id);
      const f = { operation: String(p.op), amount: String(p.amount), invoice_id: String(p.acc), date: d.date, period: d.period, comment: st.comment || p.comment,
        location_id: LOCATION, project_id: String(st.proj) };
      if (artIssue(st.art) === 'marketer' && st.mk) f.marketer_id = String(st.mk);
      return Object.assign(f, { pnl_category_id: cat, pnl_operation_id: op, show_response_in_currency: ccy, currency_id: ccy });
    }
    const formData = f => { const d = new FormData(); Object.entries(f).forEach(([k, v]) => d.append(k, v)); return d; };
    const idOf = res => { const t = res.json && res.json.data !== undefined ? res.json.data : res.json; return t && typeof t === 'object' ? (Number.isInteger(t.transaction_id) ? t.transaction_id : Array.isArray(t.payments) && Number.isInteger(t.id) ? t.id : null) : null; };
    /* Що створюється: form — поля запиту; acc — рахунок для пошуку дублів; check — перед запитом (дубль чи новий запис після звірки → не створювати);
       is — новий запис, коли CRM не повернув ID; verify — розбіжності створеного запису (дату перевіряє createMany). */
    const XFER = {
      one: 'переказ', what: n => (n === 1 ? 'переказ' : `перекази: ${n}`), how: 'так само переказ створює ваш реєстр погоджень', doing: 'створюю переказ',
      dupText: 'такого переказу ще немає (±3 дні)', title: 'Перекази між своїми', ls: 'cfl_xfer_journal', btn: 'xcreate', file: 'кешфлоу_перекази_журнал',
      form: transferForm, acc: p => p.from, action: () => 'створення переказу між рахунками',
      note: (k, v) => (k === 'invoice_from' || k === 'invoice_to' ? nameOf(+v) : ''),
      line: (p, f) => `${dmy(p.date)}: ${nameOf(p.from)} → ${nameOf(p.to)}, ${fmt(Number(f.amount))}`,
      entry: p => ({ from: p.from, fromName: nameOf(p.from), to: p.to, toName: nameOf(p.to) }),
      short: e => `${dmy(e.date)} ${e.fromName} → ${e.toName}, ${fmt(e.amount)}`,
      check: (near, p, amount, known) => xferCheck(near, p, amount, known, d => dmy(M.kyivDate(d))),
      is: (r, p, amount) => pay(r, p.from, [4], amount) && pay(r, p.to, [3], amount),
      verify: (rec, p, f, amount) => [!pay(rec, p.from, [4], amount) && `з рахунку «${nameOf(p.from)}»`, !pay(rec, p.to, [3], amount) && `на рахунок «${nameOf(p.to)}»`].filter(Boolean),
    };
    const REC = {
      one: 'запис', what: n => (n === 1 ? 'запис' : `записи: ${n}`), how: 'так само витрату вносить ваш реєстр погоджень (надходження — тим самим запитом з operation 1)', doing: 'створюю запис',
      dupText: 'на цьому рахунку ще немає запису з цією сумою за ±3 дні (стільки, скільки таких операцій у виписці)', title: 'Записи з виписки', ls: 'cfl_rec_journal', btn: 'rcreate', file: 'кешфлоу_записи_журнал',
      form: recordForm, acc: p => p.acc, action: p => `створення запису з виписки (${SRC[p.src]})${risky(p) ? ' — зарплатна стаття' : ''}`,
      risky: p => risky(p),
      note: (k, v, f) => (k === 'invoice_id' ? nameOf(+v) : k === 'operation' ? (v === '1' ? 'надходження' : 'витрата') : k === 'pnl_operation_id' ? artLabel(`${f.pnl_category_id}/${v}`)
        : k === 'marketer_id' ? mkName(v) : k === 'currency_id' ? (S.ccy || {})[v] || '' : ''),
      line: (p, f) => `${dmy(dayOfCrm(f.date) || p.date)}: «${nameOf(p.acc)}» ${SRC[p.src]} ${fmt(Number(f.amount))} — ${artLabel(`${f.pnl_category_id}/${f.pnl_operation_id}`)}${f.marketer_id ? `, маркетолог ${mkName(f.marketer_id)}` : ''}, ${projName(f.project_id)}`,
      entry: (p, f) => ({ account: p.acc, accountName: nameOf(p.acc), operation: Number(f.operation), article: `${f.pnl_category_id}/${f.pnl_operation_id}`,
        articleName: artLabel(`${f.pnl_category_id}/${f.pnl_operation_id}`), ...(f.marketer_id ? { marketer: Number(f.marketer_id), marketerName: mkName(f.marketer_id) } : {}),
        bank: `${p.row.cpty || ''} · ${p.row.purpose || ''}` }),
      short: e => `${dmy(e.date)} «${e.accountName}» ${fmt(e.amount)}`,
      check: (near, p, amount) => {
        const have = near.filter(r => pay(r, p.acc, p.op === 2 ? [2, 4, 6] : [1, 3, 5], amount));
        return have.length >= p.peers ? { result: 'вже є', id: have[0].id, note: `на рахунку вже є ${have.length} запис(и) з цією сумою за ±3 дні (ID ${have.map(r => r.id).join(', ')}), а у виписці таких операцій ${p.peers} — не створено` } : null;
      },
      is: (r, p, amount) => pay(r, p.acc, [p.op], amount),
      verify: (rec, p, f, amount) => {
        const x = pays(rec, p.acc, [p.op], amount)[0];
        if (!x) return [`рахунок «${nameOf(p.acc)}», тип чи сума`];
        const bad = Number(x.pnl_category_id) === Number(f.pnl_category_id) && Number(x.pnl_operation_id) === Number(f.pnl_operation_id) ? [] : [`стаття ${x.pnl_category_id}/${x.pnl_operation_id}`];
        // маркетолог — у marketer_balance_history запису (як його читає реєстр); якщо CRM цього поля не віддав, не перевіряється
        if (f.marketer_id && rec && 'marketer_balance_history' in rec) {
          const mb = rec.marketer_balance_history && rec.marketer_balance_history.marketer_balance;
          if (!mb || Number(mb.user_id) !== Number(f.marketer_id)) bad.push(mb ? `маркетолог ${mkName(mb.user_id)}` : 'маркетолога не збережено');
        }
        return bad;
      },
    };
    // підсумок для вікна підтвердження: скільки й на яку суму — окремо витрати, надходження, перекази й кожна валюта
    function createTotals(reqs) {
      const KIND_UA = { 1: 'надходження', 2: 'витрати', 3: 'перекази' }, m = new Map();
      for (const { f } of reqs) {
        const code = (S.ccy || {})[f.currency_id] || '', k = `${f.operation}|${code}`, v = m.get(k) || { op: f.operation, code, n: 0, sum: 0 };
        v.n++; v.sum = r2(v.sum + Number(f.amount));
        m.set(k, v);
      }
      return [...m.values()].map(v => `${KIND_UA[v.op] || 'записи'} — ${v.n} на ${fmt(v.sum)}${v.code === 'UAH' ? ' грн' : v.code ? ' ' + v.code : ''}`).join('; ');
    }
    /* Підсумок щойно зробленого — там, де людина натискала (над списками розділу «Внести в CRM»), а не лише в повідомленнях угорі
       вкладки; лишається до наступної звірки (S.done.gen — номер звірки, після якої його показано). */
    function doneHtml() {
      const d = S.done;
      if (!d || d.gen !== S.gen) return '';
      return `<div class="${d.cls}" data-b="done" style="margin:0 0 10px"><b>Щойно:</b> ${esc(d.text)}${d.bad.length ? `<ul style="margin:6px 0 0;padding-left:18px">${d.bad.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>`;
    }
    async function createMany(list, K) {
      if (!opts.applyAllowed || !list.length || S.busy) return;
      const reqs = list.map(p => ({ p, f: K.form(p) })), f0 = reqs[0].f, n = reqs.length, draft = dOn(); // режим — на весь пакет
      const ann = (k, v) => (k === 'project_id' || k === 'location_id' ? projName(v) : K.note(k, v, f0));
      // ризиковані записи (зарплатна стаття): CRM не дасть їх ні змінити, ні видалити — окреме попередження й перелік
      const risk = K.risky ? reqs.filter(({ p }) => K.risky(p)) : [];
      const riskHtml = risk.length ? `<div class="err" style="margin:10px 0"><b>Зарплатна стаття — ${risk.length} ${plural(risk.length, 'запис', 'записи', 'записів')}.</b> CRM не дає змінювати й видаляти записи із зарплатною статтею («Операції по зарплаті не доступні для редагування»): якщо в сумі, даті, статті, рахунку чи коментарі помилка, виправить її лише адміністратор CRM. Перевірте ще раз:<ul style="margin:6px 0 0">${risk.map(({ p, f }) => `<li>${esc(K.line(p, f))} — «${esc(f.comment)}»</li>`).join('')}</ul></div>` : '';
      // спершу — що саме створюється, словами: підсумок і весь перелік (до 15 рядків одразу, решта — «Ще N»); поля запиту — згорнуто (16.11.2026)
      const li = ({ p, f }) => `<li>${esc(K.line(p, f))}${f.comment ? ` <span class="muted">— «${esc(f.comment)}»</span>` : ''}</li>`;
      const html = `<h3>Створити ${K.what(n)} ${draft ? 'у чернетках CRM' : 'у CRM'}</h3>${draft ? '<div class="info" style="margin:10px 0">Режим чернеток: записи створюються в «Чернетках» кешфлоу. У кешфлоу й залишки рахунків вони потраплять, коли їх проведе бухгалтер.</div>' : ''}${draft ? '' : riskHtml}
<p><b>Разом:</b> ${esc(createTotals(reqs))}</p>
<ul style="margin:6px 0 10px;padding-left:18px">${reqs.slice(0, 15).map(li).join('')}</ul>
${n > 15 ? `<details><summary>Ще ${n - 15}</summary><ul style="margin:6px 0 10px;padding-left:18px">${reqs.slice(15).map(li).join('')}</ul></details>` : ''}
<details><summary>Технічно: запит до CRM</summary><p>Буде відправлено ${n === 1 ? 'запит' : `${n} ${plural(n, 'запит', 'запити', 'запитів')} (по одному на ${K.one})`} <code>POST /api/${draft ? CFD.PATH : 'invoice-payment'}</code> — ${draft ? 'ті самі поля, що й у звичайного запису' : K.how}. ${n === 1 ? 'Запит' : 'Перший'}:</p>
<table class="kv">${Object.entries(f0).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}${ann(k, v) ? ` — ${esc(ann(k, v))}` : ''}</td></tr>`).join('')}</table></details>
<p>Перед кожним запитом лінтер перевіряє, чи ${K.dupText}, а після — що створений запис збігається. Журнал збережеться файлом. ${draft ? 'Чернетку можна змінити чи видалити в CRM: «CashFlow» → «Чернетки».' : 'Записів лінтер не видаляє: скасувати створене можна лише вручну в CRM.'}</p>`;
      if (!await opts.dialog(html, risk.length && !draft ? `Так, створити${n > 1 ? ` ${n}` : ''} (зарплатних: ${risk.length})` : n === 1 ? 'Так, створити' : `Так, створити ${n}`, true)) return;
      busy(true); // одразу: поки читаються чернетки, друге натискання не має запустити другий пакет
      if (draft) { // чернетки мають читатися: без цього дублі не перевірити — нічого не створюємо
        try { await DR.list(); } catch (e) { busy(false); note(`Не вдалося прочитати чернетки CRM (${e.message}) — нічого не створено. Якщо у вашої ролі немає доступу до чернеток, вимкніть «у чернетки» в шапці панелі.`, 'err'); return; }
      }
      if (opts.setBusy) opts.setBusy(true);
      const known = new Set([...S.items.values()].flatMap(v => v.map(x => x.id)));
      const journal = [];
      // журнал — у браузері після кожного запису, а не після всього пакета: закрита чи перезавантажена вкладка не губить, що вже створено (07.11.2026)
      const base = LS.get(K.ls, []), persist = () => LS.set(K.ls, base.concat(journal).slice(-500));
      let noRights = false;
      // хід — і на самій кнопці, яку натиснули (рядок стану — угорі вкладки, його звідси не видно)
      const btnEl = K.btn ? $('out').querySelector(`[data-b="${K.btn}"]`) : null;
      try {
        for (const [i, { p, f }] of reqs.entries()) {
          persist();
          st(`${K.doing} ${i + 1} з ${n}…`);
          if (btnEl) btnEl.textContent = `Створюю ${i + 1} з ${n}…`;
          // дата, яку надсилаємо (покупка карткою — дата покупки), і день банку: дублі шукаються за ±3 дні від обох
          const amount = Number(f.amount), acc = K.acc(p), day = dayOfCrm(f.date) || p.date, lo = day < p.date ? day : p.date, hi = day > p.date ? day : p.date;
          const e = { at: new Date().toISOString(), action: K.action(p), id: null, ...K.entry(p, f), amount, date: day, ...(day !== p.date ? { bankDate: p.date } : {}), project: Number(f.project_id), comment: f.comment, result: '', note: '' };
          journal.push(e);
          if (noRights) { e.result = 'пропущено'; e.note = NOT_SENT; continue; }
          const nearQ = `invoice-payment?date_from=${dash(addDays(lo, -3))}&date_to=${dash(addDays(hi, 3))}&amount_from=${amount}&amount_to=${amount}&invoice_ids[]=${acc}&per_page=100`;
          // у режимі чернеток дублі шукаються і серед чернеток (список чернеток CRM не фільтрує — фільтр той самий, у core/drafts.js)
          // спершу чернетки, потім записи: чернетку, яку провели між двома запитами, буде видно хоч в одному зі списків
          const around = async () => { const dn = draft ? await DR.near(nearQ) : [], live = listOf(await api.get(nearQ)).filter(r => !r.deleted_at), have = new Set(live.map(r => r.id)); return live.concat(dn.filter(r => !have.has(r.id))); };
          let wrote = false;
          try {
            const stop = K.check(await around(), p, amount, known);
            if (stop) { Object.assign(e, stop); continue; }
            // у журнал браузера — ще до запиту: вкладку закрили, поки CRM відповідав, — слід про можливо створений запис лишається
            Object.assign(e, { result: 'перевірте', note: 'запит надіслано, відповіді ще немає — перевірте в кешфлоу перед повтором' });
            persist();
            const res = draft ? await DR.post(formData(f)) : await api.post('invoice-payment', formData(f));
            if (res.status < 200 || res.status >= 300) throw M.crmError(res, 'post');
            // CRM прийняв: далі запис уже є, навіть якщо перевірка не вдасться
            wrote = true;
            Object.assign(e, { result: 'перевірте', note: 'створено, перевіряю…' });
            persist();
            let id = idOf(res);
            if (!id) { const again = (await around()).filter(r => !known.has(r.id) && K.is(r, p, amount)); if (again.length === 1) id = again[0].id; }
            if (!id) { e.result = 'перевірте'; e.note = 'CRM прийняв запит, але не повернув ID, і новий запис не знайдено — перевірте в кешфлоу перед повтором'; continue; }
            e.id = id;
            known.add(id);
            const g = draft ? await DR.get(id) : await api.get('invoice-payment/' + id), rec = g && g.data && g.data.payments ? g.data : g;
            if (draft) e.draft = true;
            const bad = K.verify(rec, p, f, amount);
            if (rec && rec.date && M.kyivDate(rec.date) !== day) bad.push(`дата ${dmy(M.kyivDate(rec.date))}`);
            e.result = bad.length ? 'перевірте' : 'ok';
            e.note = bad.length ? `${draft ? 'чернетку створено' : 'створено'}, але не збігається: ${bad.join(', ')}` : draft ? 'чернетку створено й перевірено' : 'створено й перевірено';
          } catch (err) {
            // запит прийнято, не вдалось лише перечитати запис — це не «помилка»: запис є, вносити вдруге не треба
            if (wrote) { e.result = 'перевірте'; e.note = `створено, але не вдалося перевірити: ${err.message}`; continue; }
            noRights = failed(e, err) === 'rights';
            if (err.kind === 'closed' && CL) CL.learn(f.period); // період нового запису ('01-ММ-РРРР') — закритий місяць
          }
        }
      } finally {
        busy(false);
        if (opts.setBusy) opts.setBusy(false);
      }
      persist();
      // журнал — у папку Помічника без вікна «Зберегти як» (storage.keepFile); без Помічника — завантаженням
      const jname = `${K.file}_${stamp()}.json`, jdata = JSON.stringify(journal, null, 1);
      let saved = { where: 'download' };
      try { if (storage.keepFile) saved = await storage.keepFile(jname, 'application/json', jdata, 'journals'); else await storage.saveFile(jname, 'application/json', jdata); } catch (e) {}
      const cnt = {};
      journal.forEach(e => { cnt[e.result] = (cnt[e.result] || 0) + 1; });
      await calc(); // перечитати CRM: створене зникне зі списку, рахунки перерахуються
      const total = `${K.title}: ${Object.entries(cnt).map(([k, v]) => `${k === 'ok' ? 'зроблено й перевірено' : k} — ${v}`).join(', ')}.`;
      note(`${total} Журнал — ${saved.where === 'helper' ? `у папці Помічника: ${saved.path}` : `файл «${K.file}_….json» у «Завантаженнях»`}.`, journal.every(e => e.result === 'ok') ? 'info' : 'warn');
      journal.filter(e => e.result !== 'ok').forEach(e => note(`${K.short(e)}: ${e.note}`, BAD.includes(e.result) ? 'err' : 'warn'));
      refusalNote(journal, 'post');
      // те саме — над списками розділу, де натискали кнопку (і кнопка — знову з лічильником)
      S.done = { gen: S.gen, text: total, cls: journal.some(e => BAD.includes(e.result)) ? 'err' : journal.every(e => e.result === 'ok') ? 'info' : 'warn', bad: journal.filter(e => e.result !== 'ok').map(e => `${K.short(e)}: ${e.note}`) };
      render();
      const db = $('out').querySelector('[data-b="done"]');
      if (db && db.scrollIntoView) db.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    // ---------- залишок CRM проти суми записів ----------
    async function offsets() {
      if (S.busy || !S.accs) return;
      busy(true);
      try {
        const recs = await pages(`invoice-payment?date_from=01-01-2015&date_to=${dash(addDays(today(), 730))}`, (p, n) => st(`усі записи CRM: сторінка ${p}/${n || '?'}`));
        const m = Rc.cashflowByAccount(recs);
        // залишок CRM — без чернеток (balanceLive): тут він порівнюється з сумою всіх проведених записів
      S.offsets = new Map(S.accs.map(a => [a.id, r2(Number(a.balanceLive !== undefined ? a.balanceLive : a.balance) - (m.get(a.id) || []).reduce((s, x) => s + x.amount, 0))]));
        render();
        st(`порівняно: ${recs.length} записів (якщо щойно вносили записи — спершу «Звірити»)`);
      } catch (e) { note(e.message, 'err'); st('помилка'); }
      finally { busy(false); }
    }

    // ---------- звіт ----------
    $('xlsx').onclick = () => {
      if (!S.accs || !S.items) return;
      const all = rows().sort((x, y2) => GROUPS.indexOf(x.g) - GROUPS.indexOf(y2.g) || x.a.name.localeCompare(y2.a.name, 'uk'));
      const B = r => r.R.bank || {}, D = r => r.R.diff || {};
      const sum = [['Група', 'Рахунок CRM', 'ID', 'Валюта', 'Статус', `Залишок на початок ${dmy(S.from)}: CRM`, 'банк', 'різниця', 'Надходження: CRM', 'банк', 'різниця', 'Списання: CRM', 'банк', 'різниця',
        `Залишок на кінець ${dmy(S.to)}: CRM`, 'банк', 'різниця', 'Операцій CRM', 'Операцій банк', 'Сум не сходиться', 'Немає в CRM', 'Немає в банку (лише в CRM)', 'Джерело банку', 'Примітки', 'Залишок CRM − сума записів', 'Що звіряли']];
      const amt = [['Рахунок CRM', 'Сума', 'Банк, шт', 'CRM, шт', 'Різниця', 'Операції банку', 'Записи CRM', 'Записи CRM з іншою датою']];
      const bo = [['Рахунок CRM', 'Дата', 'Час', 'Сума', 'Контрагент', 'Призначення', 'Референс']];
      const co = [['Рахунок CRM', 'Дата', 'ID запису', 'Тип', 'Сума', 'Коментар']];
      for (const r of all) {
        const R = r.R;
        sum.push([r.g[1], r.a.name, r.a.id, r.ccy, ST[r.status][1], R.crm.open, B(r).open, D(r).open, R.crm.cred, B(r).cred, D(r).cred, R.crm.deb, B(r).deb, D(r).deb,
          R.crm.close, B(r).close, D(r).close, R.crm.n, B(r).n, R.covered ? R.amounts.length : '', R.covered ? lacks(R).miss : '', R.covered ? lacks(R).extra : '', r.b ? srcOf(r.b) : r.manual !== undefined ? 'вручну' : '', r.warn.join('; '), r.offset === undefined ? '' : r.offset, KIND[S.kind]]);
        for (const x of R.amounts) amt.push([r.a.name, x.amount, x.nB, x.nC, x.d, x.bank.map(opB).join('\n'), x.crm.map(opC).join('\n'), x.near.map(o => `${dmy(o.date)} (ID ${o.id})`).join(', ')]);
        if (r.b) r.b.rows.filter(x => x.date >= S.from && x.date <= S.to).forEach(x => bo.push([r.a.name, x.date, x.time, x.amount, x.cpty, x.purpose, x.ref]));
        if (R.bank) (S.items.get(r.a.id) || []).filter(x => x.date >= S.from && x.date <= S.to).forEach(x => co.push([r.a.name, x.date, x.id, x.op, x.amount, x.comment]));
      }
      // перекази між своїми: чого немає в CRM, що записано не переказом, що невідомо куди
      // пояснені різниці: суми не 1:1 і покупки карткою з іншою датою проведення
      const ex = [['Рахунок CRM', 'Що', 'Операції банку', 'Записи CRM', 'Сума']];
      const TK = { later: 'банк провів пізніше (покупка карткою)', after: 'у CRM у періоді, банк провів після нього', pending: 'ще не проведено банком (покупка карткою)' };
      for (const r of all) {
        for (const g of r.R.multi || []) ex.push([r.a.name, GW_SHORT[g.why || ''], g.bank.map(opB).join('\n'), g.crm.map(opC).join('\n'), Math.abs(g.why === 'refund' ? g.bank[0].amount : r2(g.bank.reduce((s, x) => s + x.amount, 0)))]);
        for (const o of r.R.calc || []) ex.push([r.a.name, o.why, '', opC(o.crm), Math.abs(o.crm.amount)]);
        for (const t of r.R.timing || []) ex.push([r.a.name, TK[t.kind] + (t.buy ? `, покупка ${dmy(t.buy)}` : ''), t.bank ? opB(t.bank) : '', opC(t.crm), Math.abs(t.crm.amount)]);
        // ЗП через транзитний рахунок — поштучно не звіряється
        for (const x of r.R.pay ? r.R.pay.bank : []) ex.push([r.a.name, 'ЗП через транзитний рахунок — поштучно не звіряється', opB(x), '', Math.abs(x.amount)]);
        for (const c of r.R.pay ? r.R.pay.crm : []) ex.push([r.a.name, 'запис ЗП — поштучно не звіряється (ЗП через транзитний рахунок)', '', opC(c), Math.abs(c.amount)]);
      }
      const xf = [['Дата', 'З рахунку', 'На рахунок', 'Сума', 'Стан', 'ID у CRM', 'Операція банку / підстава']];
      const XS = { missing: 'немає в CRM', type: 'у CRM записано не переказом', peer: 'у CRM переказ з іншим рахунком' };
      for (const r of all) {
        if (r.R.own) {
          for (const x of r.R.own.xfers) if (x.state !== 'ok') xf.push([x.row.date, x.row.amount < 0 ? r.a.name : nameOf(x.peer), x.row.amount < 0 ? nameOf(x.peer) : r.a.name, Math.abs(x.row.amount), XS[x.state], x.item ? x.item.id : '', `${x.row.cpty || ''} · ${x.row.purpose || ''}`]);
          for (const m of r.R.own.maybe) xf.push([m.row.date, m.row.amount < 0 ? r.a.name : '?', m.row.amount < 0 ? '?' : r.a.name, Math.abs(m.row.amount), 'схоже на переказ — рахунок «куди» невідомий', '', `${m.row.cpty || ''} · ${m.row.purpose || ''}`]);
        }
        (r.topups || []).forEach(x => xf.push([x.date, r.a.name, 'corpCard', Math.abs(x.amount), 'поповнення корп. картки записано витратою', x.id, x.comment]));
        if (r.status === 'merged' && Number(r.a.balance) < -0.005) xf.push([today(), nameOf(r.into), r.a.name, r2(-Number(r.a.balance)), 'корп. картка в CRM у мінусі — бракує поповнення', '', '']);
      }
      // операції банку, яких немає в CRM: що лінтер пропонує створити і чому решту — ні
      const rc = [['Дата', 'Рахунок CRM', 'Сума', 'Тип', 'Стаття', 'Маркетолог', 'Проєкт', 'Коментар у CRM', 'Операція банку', 'Не створюється, бо']];
      for (const p of recProposals(all)) {
        const s = S.rp.get(p.key), iss = artIssue(s.art);
        rc.push([p.buy || p.date, nameOf(p.acc), p.op === 1 ? p.amount : -p.amount, SRC[p.src], s.art ? artLabel(s.art) : '', iss === 'marketer' && s.mk ? mkName(s.mk) : '', projName(s.proj), s.comment,
          `${p.row.cpty || ''} · ${p.row.purpose || ''}`, p.block || (iss === 'salary' ? ISSUE.salary : iss === 'marketer' && !s.mk ? 'потрібен маркетолог' : !s.art ? 'потрібна стаття' : '')]);
      }
      // виводи з балансу ↔ погодження «% менеджера / м-рів / тімліда» — якщо погодження з реєстру прочитано
      const wdX = wdCalc(), wv = [['Дата оплати', 'Отримувач', 'Зміст погодження', 'Погоджено', 'Виведено', 'Стан', 'Виводи з балансу (записи CRM)']];
      if (wdX) {
        for (const r of wdX.res.rows.filter(x => x.a.report !== false)) wv.push([r.a.date, r.a.recipient, r.a.content, r.a.amount, (r.status === 'ok' && r.how !== 'registry') || r.cands.length ? r.sum : '',
          wdText(r, today()).text + (wdX.sum.double.includes(r) ? ' · реєстр уніс на всю суму, і є вивід — витрата двічі?' : ''), (r.status === 'ok' ? r.items : r.cands).map(w => `${wdWho(w)} · ${fmt(w.amount)} · ${dmy(w.date)} · ID ${w.id}`).join('\n')]);
        for (const { w, near } of wdX.sum.extraList) wv.push([w.date, wdWho(w), 'вивід без погодження', '', w.amount, wdNear(near) || 'без погодження', `ID ${w.id}${w.acc != null ? ' · ' + nameOf(w.acc) : ''}`]);
      }
      // операції з виписок поза звіркою (службові й незіставлені рахунки, не проведені банком) — лише довідка
      const oz = [['Рахунок банку', 'Власник рахунку', 'Дата', 'Сума', 'Контрагент · призначення', 'Чому поза звіркою']];
      for (const g of outsideList()) for (const o of g.list) oz.push([`${g.b.bank === 'mono' ? 'Моно' : 'Приват'} ${tail(g.b.iban)}`, g.b.owner || g.b.client || '', o.x.date, o.x.amount, `${o.x.cpty || ''} · ${o.x.purpose || ''}`, o.why]);
      storage.saveFile(`Звірка_з_банком_${S.from}_${S.to}${S.kind !== 'all' ? '_' + KIND[S.kind].replace(/\s+/g, '_') : ''}.xlsx`, XLSX_MIME, X.buildXlsx([
        { name: 'Підсумок', rows: sum, widths: [20, 40, 6, 7, 16, 15, 15, 12, 15, 15, 12, 15, 15, 12, 15, 15, 12, 9, 9, 9, 40, 40, 34, 50, 16, 16], money: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 24] },
        { name: 'Немає в CRM — створити', rows: rc, widths: [11, 40, 13, 14, 44, 24, 14, 60, 80, 50], money: [2] },
        { name: 'Суми, що не сходяться', rows: amt, widths: [40, 13, 9, 9, 9, 70, 70, 30], money: [1] },
        { name: 'Пояснені різниці', rows: ex, widths: [40, 44, 70, 70, 13], money: [4] },
        { name: 'Операції банку', rows: bo, widths: [40, 11, 7, 13, 34, 70, 18], money: [3] },
        { name: 'Записи CRM', rows: co, widths: [40, 11, 9, 14, 13, 70], money: [4] },
        { name: 'Перекази між своїми', rows: xf, widths: [11, 40, 40, 13, 36, 9, 80], money: [3] },
        ...(wdX ? [{ name: 'Виводи з балансу', rows: wv, widths: [11, 30, 60, 13, 13, 60, 70], money: [3, 4] }] : []),
        ...(oz.length > 1 ? [{ name: 'Поза звіркою', rows: oz, widths: [18, 40, 11, 13, 80, 60], money: [3] }] : []),
      ]));
    };

    // syncPeriod — панель кличе, коли вкладку показано знову; act — дії рядків і фільтра (ті самі функції, що в обробниках; для перевірок без сторінки)
    return { element: el, get state() { return S; }, syncPeriod, act: { stToggle, recPickArt, recSpreadArt } };
  }

  return { mount, GROUPS, lacks, classify, recComment, histArt, histMk, histRef, mkInComment, cardComment, refParts, ruleHints, holderOf, mkByName, clampToOpen, monthBounds, defaultMonth, closeReport, bankSummary, mergeLocalCards, merchantOf, findNewCards, hiddenAccs, OFF_ACC, wrongTopups,
    laterBank, notFetched, partialFetchText, xferOtherType, xferCheck, crmDate, dayOfCrm, cardTime, recWhen, FILE_SHOW };
}));
