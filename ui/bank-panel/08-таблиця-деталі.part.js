    function rowHtml(r, hid) {
      const a = r.a, R = r.R, b = r.b, notes = [];
      const closeExtra = !b && r.status !== 'merged' ? `<input class="man" data-man="${a.id}" value="${r.manual !== undefined ? esc(Number(r.manual).toFixed(2).replace('.', ',')) : ''}" placeholder="банк: ввести" inputmode="decimal" title="Залишок у банку на кінець ${dmy(S.to)}, у валюті рахунку CRM (${esc(r.ccy)})">` : undefined;
      let cnt;
      const c = r.card, nB = c && c.missB.length, nC = c && c.missC.length;
      if (r.status === 'merged') cnt = !c ? `<div class="muted">звіряється разом з рахунком банку</div><div class="muted">операцій у CRM: ${R.crm.n}</div>`
        : !nB && !nC ? `<div class="ok">✓ покупки сходяться</div><div class="muted">карткою у виписці: ${c.bank.length} · у CRM: ${c.crm.length}</div>`
        : `<div class="bad">${[nB ? `немає в CRM: ${nB}` : '', nC ? `немає в банку: ${nC}` : ''].filter(Boolean).join(' · ')}</div><div class="muted">карткою у виписці: ${c.bank.length} · у CRM: ${c.crm.length}</div>`;
      else if (r.status === 'ccy') cnt =`<div class="muted">інша валюта — не порівнюється</div><div class="muted">операцій у CRM: ${R.crm.n}</div>`;
      else if (R.covered) cnt = R.amounts.length ? `<div class="bad">${R.amounts.length} ${R.amounts.length === 1 ? 'сума не сходиться' : R.amounts.length < 5 ? 'суми не сходяться' : 'сум не сходяться'}</div><div class="muted">операцій: CRM ${R.crm.n}, банк ${R.bank.n}</div>`
        : `<div class="ok">✓ сходиться</div><div class="muted">операцій: ${R.crm.n} · різних сум: ${R.distinct}${explained(R) ? ` · пояснено: ${explained(R)}` : ''}${R.pay ? ` · ЗП не звіряється: ${R.pay.bank.length + R.pay.crm.length}` : ''}</div>`;
      else cnt = `<div class="muted">${b ? 'виписка не покриває період' : 'потрібна виписка'}</div><div class="muted">операцій у CRM: ${R.crm.n}</div>`;
      if (b) notes.push(esc(srcOf(b) + (b.iban ? ' · ' + tail(b.iban) : '')));
      else if (r.status === 'merged') {
        notes.push(esc(`списує з рахунку «${nameOf(r.into)}» — покупки з його виписки звіряються з витратами картки`));
        const few = (xs, f) => xs.slice(0, 4).map(f).join(' · ') + (xs.length > 4 ? ` і ще ${xs.length - 4}` : '');
        if (nB) notes.push(`<span class="bad" style="font-weight:400">${esc(`покупки карткою, яких немає в CRM: ${few(c.missB, x => `${dmy(Rc.cardDate(x.purpose) || x.date)} ${fmt(Math.abs(x.amount))}${merchantOf(x.purpose) ? ' ' + merchantOf(x.purpose) : ''}`)}`)}</span>`);
        if (nC) notes.push(`<span class="bad" style="font-weight:400">${esc(`витрати картки в CRM без покупки у виписці: ${few(c.missC, x => `${dmy(x.date)} ${fmt(Math.abs(x.amount))} (ID ${x.id})`)}`)}</span>`);
        if (Number(a.balance) < -0.005) notes.push(`<span class="bad" style="font-weight:400">${esc(`баланс у CRM зараз ${fmt(Number(a.balance))}: витрат з картки більше, ніж поповнень — поповнення запропоновано в розділі «Внести в CRM»`)}</span>`);
      }
      else if (r.manual !== undefined) notes.push('залишок банку введено вручну');
      else if (Rc.isCorp(a) && S.dir) notes.push(esc(`картка не звіряється: ${cardWhy(a)}`));
      r.warn.forEach(w => notes.push(`<span class="bad" style="font-weight:400">${esc(w)}</span>`));
      if (r.offset !== undefined && !isZero(r.offset)) notes.push(`<span class="bad" title="balance рахунку в CRM мінус сума всіх його записів">залишок CRM ≠ сума записів: ${fmt(r.offset)}</span>`);
      const [cls, label] = ST[r.status];
      const canDet = R.covered && r.status !== 'ccy', det = canDet && S.open.has(a.id), sub = subHtml(r);
      let h = `<tr data-acc="${a.id}" class="acc s-${r.status}${hid ? ' hid' : ''}"><td><span class="an">${esc(a.name)}</span> <span class="muted">id ${a.id} · ${esc(r.ccy)}</span><div><span class="badge ${cls}">${label}</span></div>${notes.length ? `<div class="nt">${notes.join('<br>')}</div>` : ''}</td>
${metric(r, 'open')}${metric(r, 'cred')}${metric(r, 'deb')}${metric(r, 'close', closeExtra)}<td class="cnt">${cnt}</td>
<td class="act">${canDet ? `<button class="det-btn" data-det="${a.id}" title="${det ? 'Згорнути операції' : 'Усі операції банку й записи CRM за період — зі станом кожної'}">Деталі ${det ? '▴' : '▾'}</button>` : ''}<button class="eye" data-hide="${a.id}" title="${hid ? 'Показати рахунок у таблиці' : 'Сховати рахунок із таблиці'}">${hid ? EYE_OFF : EYE}</button></td></tr>`;
      if (sub) h += `<tr class="sub s-${r.status}${hid ? ' hid' : ''}"><td colspan="7">${sub}</td></tr>`;
      if (det) h += `<tr class="det"><td colspan="7">${detHtml(r)}</td></tr>`;
      return h;
    }
    // скільки різниць пояснено (суми не 1:1, дати проведення покупок карткою) — для вибраного типу
    const explained = R => (R.multi || []).filter(g => S.kind === 'all' || (R.kinds && R.kinds.get(g.bank[0])) === S.kind).length +
      (R.timing || []).filter(t => S.kind === 'all' || S.kind === ((t.bank || t.crm).amount > 0 ? 'credit' : 'debit')).length;
    const opB = x => `${dmy(x.date)}${x.time ? ' ' + x.time : ''} · ${x.cpty || '—'}${x.purpose ? ' · ' + x.purpose : ''}`;
    const opC = x => `${dmy(x.date)} · ID ${x.id}${x.lead ? ' (лід)' : ''} · ${x.comment || x.op}`;
    /* Пояснені групи звірки (periodRecon → multi, why) — словами: під рахунком, у «Деталях» і в звіті (08.11.2026). */
    const GW_HEAD = { '': 'Суми не 1:1', 'card-day': 'Покупки корп. картки за день — одним записом CRM', liqpay: 'LiqPay: оплата ліда + запис «Комісія LiqPay» = зарахування в банку',
      'tax-day': 'Податки із ЗП за день — у CRM по людях', 'pay-day': 'ЗП через транзит за день — у CRM по людях', refund: 'Платіж і його повернення (разом 0)' };
    const GW_SHORT = { '': 'суми не 1:1', 'card-day': 'покупки картки за день', liqpay: 'LiqPay: лід + комісія', 'tax-day': 'податки із ЗП за день', 'pay-day': 'ЗП через транзит за день', refund: 'платіж і його повернення' };
    const gSum = list => fmt(Math.abs(r2(list.reduce((s, x) => s + x.amount, 0))));
    const fewIds = (list, n) => list.slice(0, n || 6).map(c => `ID ${c.id}`).join(' + ') + (list.length > (n || 6) ? ` і ще ${list.length - (n || 6)}` : '');
    function groupText(g) {
      const b0 = g.bank[0], c0 = g.crm[0];
      if (g.why === 'refund') return `${dmy(b0.date)} ${fmt(Math.abs(b0.amount))} ${clean(b0.cpty) || ''} — повернено ${dmy(g.bank[1].date)}`;
      if (g.why === 'liqpay') return `${dmy(b0.date)} зараховано ${fmt(b0.amount)} = ID ${c0.id} (${fmt(c0.amount)}) − комісія ID ${g.crm[1].id} (${fmt(Math.abs(g.crm[1].amount))})`;
      if (g.why === 'card-day') return `картка …${Rc.cardTail(b0.purpose) || '?'} ${dmy(Rc.cardDate(b0.purpose) || b0.date)}: ${g.bank.length} ${plural(g.bank.length, 'покупка', 'покупки', 'покупок')} на ${gSum(g.bank)} = ID ${c0.id}`;
      if (g.why === 'tax-day') return `${dmy(b0.date)} ${g.bank.map(x => taxName(x.purpose)).join(' + ')} на ${gSum(g.bank)} = ${g.crm.length} ${plural(g.crm.length, 'запис', 'записи', 'записів')} (${fewIds(g.crm)})${g.diff ? ` — різниця CRM − банк ${g.diff > 0 ? '+' : ''}${fmt(g.diff)} (копійки округлення: суму запису варто змінити на банківську)` : ''}`;
      if (g.why === 'pay-day') return `${dmy(b0.date)} на ${gSum(g.bank)} = ${g.crm.length} ${plural(g.crm.length, 'запис', 'записи', 'записів')} ЗП (${fewIds(g.crm)})`;
      const bt = x => `${dmy(x.date)} ${fmt(Math.abs(x.amount))}`, ct = c => `ID ${c.id} (${fmt(Math.abs(c.amount))})`;
      return g.bank.length === 1 ? `банк ${bt(b0)} = записи CRM ${g.crm.map(ct).join(' + ')}` : g.crm.length === 1 ? `запис CRM ${ct(c0)} = операції банку ${g.bank.map(bt).join(' + ')}`
        : `операції банку ${g.bank.slice(0, 6).map(bt).join(' + ')}${g.bank.length > 6 ? ` і ще ${g.bank.length - 6}` : ''} = записи CRM ${fewIds(g.crm)} (${gSum(g.crm)})`;
    }
    // стан операції банку (side 'bank') чи запису CRM ('crm') у групі — для «Деталей»
    function groupState(g, side, it) {
      const b0 = g.bank[0], c0 = g.crm[0];
      if (g.why === 'refund') return 'платіж і його повернення — разом 0, у CRM не вносяться';
      if (g.why === 'liqpay') return side === 'bank' ? `= ID ${c0.id} (${fmt(c0.amount)}) − комісія LiqPay ID ${g.crm[1].id} (${fmt(Math.abs(g.crm[1].amount))})`
        : it === c0 ? `разом з комісією ID ${g.crm[1].id} = зарахування LiqPay ${dmy(b0.date)} ${fmt(b0.amount)}` : `комісія до ID ${c0.id}: разом = зарахування LiqPay ${dmy(b0.date)} ${fmt(b0.amount)}`;
      if (g.why === 'card-day') return side === 'bank' ? `покупки картки за ${dmy(Rc.cardDate(b0.purpose) || b0.date)}: разом (${g.bank.length}) = запис CRM ID ${c0.id}` : `= ${g.bank.length} ${plural(g.bank.length, 'покупка', 'покупки', 'покупок')} картки за ${dmy(Rc.cardDate(b0.purpose) || b0.date)} (${gSum(g.bank)})`;
      if (g.why === 'tax-day') return (side === 'bank' ? `податки дня разом (${gSum(g.bank)}) = ${g.crm.length} ${plural(g.crm.length, 'запис', 'записи', 'записів')} податків по людях` : `частина податків ${dmy(b0.date)} (${g.bank.map(x => taxName(x.purpose)).join(' + ')} на ${gSum(g.bank)})`) + (g.diff ? `; різниця CRM − банк ${fmt(g.diff)}` : '');
      if (g.why === 'pay-day') return side === 'bank' ? `= ${g.crm.length} ${plural(g.crm.length, 'запис', 'записи', 'записів')} ЗП по людях (${gSum(g.crm)})` : `частина ЗП через транзит ${dmy(b0.date)} (${gSum(g.bank)})`;
      if (side === 'bank') return g.bank.length === 1 ? `= ${g.crm.length} записи CRM (${fewIds(g.crm)})` : `разом з іншими = ${g.crm.length === 1 ? `запис CRM ID ${c0.id}` : `записи CRM ${fewIds(g.crm)}`} (${gSum(g.bank)})`;
      return g.bank.length === 1 ? `частина операції банку ${dmy(b0.date)} ${fmt(Math.abs(b0.amount))}` : `= ${g.bank.length} операції банку (${gSum(g.bank)})`;
    }
    /* Усі операції банку й записи CRM рахунку за період (з фільтром типу — лише цього типу) і стан кожної:
       пара, суми не 1:1, дата проведення, немає в CRM / в банку. → [{date, time, amount, bank, crm, state, cls}] за датою */
    function detRows(r) {
      const R = r.R, inK = (k) => S.kind === 'all' || k === S.kind, out = [];
      const B = r.b.rows.filter(x => x.date >= S.from && x.date <= S.to && inK(R.kinds.get(x)));
      const C = (r.cf || []).filter(c => c.date >= S.from && c.date <= S.to && inK(Rc.crmKind(c)));
      const pairs = R.pairs || new Map(), pairC = new Map([...pairs].map(([x, c]) => [c, x]));
      const gB = new Map(), gC = new Map(), tB = new Map(), tC = new Map();
      (R.multi || []).forEach(g => { g.bank.forEach(x => gB.set(x, g)); g.crm.forEach(c => gC.set(c, g)); });
      (R.timing || []).forEach(t => (t.kind === 'later' ? tB.set(t.bank, t) : tC.set(t.crm, t)));
      const oX = new Map((R.own ? R.own.xfers : []).map(x => [x.row, x])), maybe = new Set((R.own ? R.own.maybe : []).map(m => m.row));
      const yB = new Set(R.pay ? R.pay.bank : []), yC = new Set(R.pay ? R.pay.crm : []);
      const rlB = new Map((R.ruled || []).map(o => [o.row, o.why])), caC = new Map((R.calc || []).map(o => [o.crm, o.why]));
      for (const x of B) {
        const c = pairs.get(x), g = gB.get(x), t = tB.get(x), o = oX.get(x);
        const [state, cls] = o && o.state === 'missing' ? [`переказу на «${nameOf(o.peer)}» немає в CRM — створити можна в розділі «Внести в CRM»`, 'bad']
          : o && o.state === 'type' ? [`у CRM записано як ${o.item.op} (ID ${o.item.id}) — тип можна змінити в розділі «Виправити»`, 'bad']
          : c ? [`є в CRM${c.date !== x.date ? ` з датою ${dmy(c.date)}` : ''}`, 'ok']
          : g ? [groupState(g, 'bank', x), 'ok']
          : t ? [`банк провів пізніше: покупка ${dmy(t.buy)}, у CRM ID ${t.crm.id} від ${dmy(t.crm.date)}`, 'ok']
          : rlB.has(x) ? [`за правилом не вноситься: ${rlB.get(x)}`, 'muted']
          : maybe.has(x) ? ['схоже на переказ між своїми — виберіть рахунок «куди» в розділі «Внести в CRM»', 'bad']
          : yB.has(x) ? ['ЗП через транзитний рахунок — поштучно не звіряється (підсумок під рахунком)', 'muted']
          : ['немає в CRM', 'bad'];
        out.push({ date: x.date, time: x.time || '', amount: x.amount, bank: `${x.cpty || '—'}${x.purpose ? ' · ' + x.purpose : ''}`, crm: c ? `ID ${c.id}${c.lead ? ' (лід)' : ''}${c.draft ? ' (чернетка)' : ''} · ${c.comment || c.op}` : '', state, cls });
      }
      for (const c of C) {
        if (pairC.has(c)) continue;
        const g = gC.get(c), t = tC.get(c);
        const [state, cls] = g ? [groupState(g, 'crm', c), 'ok']
          : caC.has(c) ? [caC.get(c), 'muted']
          : t ?(t.kind === 'after' ? [`банк провів після періоду: ${dmy(t.bank.date)}`, 'ok'] : ['ще не проведено банком (покупка карткою)', 'ok'])
          : (r.topups || []).includes(c) ? ['поповнення корп. картки записано витратою — тип можна змінити в розділі «Виправити»', 'bad']
          : yC.has(c) ? ['запис ЗП — поштучно не звіряється (ЗП через транзитний рахунок)', 'muted']
          : ['немає в банку', 'bad'];
        out.push({ date: c.date, time: c.time || '', amount: c.amount, bank: '', crm: `ID ${c.id}${c.lead ? ' (лід)' : ''}${c.draft ? ' (чернетка)' : ''} · ${c.comment || c.op}`, state, cls });
      }
      return out.sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : a.date + a.time > b.date + b.time ? 1 : 0));
    }
    function detHtml(r) {
      const R = r.R, list = detRows(r), bad = list.filter(x => x.cls === 'bad').length;
      const all = `<div class="muted" style="margin-bottom:6px">Усі операції за період${S.kind !== 'all' ? ` (${esc(KIND_ONLY[S.kind])})` : ''}: банк ${list.filter(x => x.bank).length}, записів CRM ${new Set(list.filter(x => x.crm).map(x => x.crm)).size}; без пари або з іншим типом — ${bad}.</div>
<table class="amts"><tr><th>Дата</th><th class="n">Сума</th><th>Операція банку</th><th>Запис CRM</th><th>Стан</th></tr>
${list.map(x => `<tr><td style="white-space:nowrap">${esc(dmy(x.date))}${x.time ? ' ' + esc(x.time) : ''}</td><td class="n">${fmt(x.amount)}</td><td>${esc(x.bank) || '<span class="muted">—</span>'}</td><td>${esc(x.crm) || '<span class="muted">—</span>'}</td><td class="${x.cls}" style="font-weight:${x.cls === 'bad' ? 700 : 400}">${esc(x.state)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Операцій за період немає.</td></tr>'}</table>`;
      if (!R.amounts.length) return all;
      return all + `<div class="muted" style="margin:10px 0 6px">Суми, кількість операцій з якими в банку і в CRM різна (сума — зі знаком: «−» — списання). «Різниця» = CRM − банк: «−1» — однієї операції немає в CRM, «+1» — у CRM на одну більше.</div>
<table class="amts"><tr><th class="n">Сума</th><th class="n">Банк</th><th class="n">CRM</th><th class="n">Різниця</th><th>Операції банку</th><th>Записи CRM</th></tr>
${R.amounts.map(x => `<tr><td class="n">${fmt(x.amount)}</td><td class="n">${x.nB}</td><td class="n">${x.nC}</td><td class="n bad">${x.d > 0 ? '+' : ''}${x.d}</td>
<td>${x.bank.map(o => `<div>${esc(opB(o))}</div>`).join('') || '<span class="muted">—</span>'}</td>
<td>${x.crm.map(o => `<div>${esc(opC(o))}</div>`).join('') || '<span class="muted">—</span>'}${x.near.length ? `<div class="warn" style="margin:4px 0 0;padding:4px 8px">з іншою датою: ${x.near.map(o => `${esc(dmy(o.date))} (ID ${o.id})`).join(', ')}</div>` : ''}</td></tr>`).join('')}</table>`;
    }
    // підсумок звірки — плитки над розділами; плитка відкриває свій розділ
    function sumHtml(all) {
      const s = bankSummary(all, S.lastTypes, S.lastNewCards, S.lastReps), noB = !s.covered;
      const tile = (sec, cls, tt, tv, ts) => `<button type="button" class="tile ${cls}" data-go-sec="${sec}"><span class="tt">${esc(tt)}</span><span class="tv">${esc(String(tv))}</span><span class="ts">${esc(ts)}</span></button>`;
      const list = [tile('acc', s.bad ? 't-bad' : s.unk ? 't-warn' : s.accs ? 't-ok' : '', 'Рахунки сходяться', `${s.good} з ${s.accs}`, `розбіжність ${s.bad} · без даних банку ${s.unk}`),
        tile('add', noB ? '' : s.missB ? 't-bad' : 't-ok', 'Операцій банку без запису', noB ? '—' : s.missB, noB ? 'виписок за період немає' : s.missB ? 'внести — «Внести в CRM»' : 'усі є в CRM'),
        tile('add', noB ? '' : s.own + s.topup ? 't-bad' : 't-ok', 'Переказів між своїми без пари', noB ? '—' : s.own + s.topup, noB ? 'виписок за період немає'
          : s.topup ? `${s.own ? `з виписок ${s.own} · ` : ''}поповнень корп. карток: ${s.topup} — «Внести в CRM»` : s.own ? 'створити — «Внести в CRM»' : 'усі є в CRM'),
        s.reps ? tile('fix', 't-bad', 'Записів виправити', s.types + s.reps, `${s.types ? `тип: ${s.types} · ` : ''}поповнень не на ту картку: ${s.reps} — «Виправити»`)
          : tile('fix', s.types ? 't-bad' : 't-ok', 'Записів з неправильним типом', s.types, s.types ? 'змінити — «Виправити»' : 'типи правильні'),
        tile('acc', noB ? '' : s.missC ? 't-warn' : 't-ok', 'Записів CRM без операції в банку', noB ? '—' : s.missC, noB ? 'виписок за період немає' : s.missC ? 'перевірте в CRM — під рахунками' : 'кожен запис є в банку')];
      if (s.cards) list.push(tile('add', 't-warn', 'Корп. карток, яких лінтер не знає', s.cards, 'запам\'ятати — «Внести в CRM»'));
      return `<div class="tiles" style="--n:${list.length}">${list.join('')}</div>`;
    }
    // лічильники в перемикачі розділів
    function navCounts(n) {
      const set = (k, v, cls) => { const e = $('nav').querySelector(`[data-n="${k}"]`); e.hidden = v === null || v === undefined || v === 0 || v === ''; e.textContent = v; e.className = `cnt${cls ? ' ' + cls : ''}`; };
      set('acc', n && n.bad, 'bad'); set('mt', n && n.mt, n && n.mt ? 'bad' : ''); set('add', n && n.add, n && n.add ? 'bad' : ''); set('fix', n && n.fix, n && n.fix ? 'bad' : ''); set('wd', n && n.wd, n && n.wd ? 'bad' : '');
      set('close', n && n.close, n && n.close === '✓' ? 'ok' : n && n.close === '✗' ? 'bad' : '');
    }
    // фільтр статусів «Рахунків»: вибір пам'ятається в браузері (cfl_bank_filter); k — статус, null — показати всі
    function stToggle(k) {
      if (k === null) ST_ORDER.forEach(x => S.filter.add(x));
      else if (S.filter.has(k)) S.filter.delete(k);
      else S.filter.add(k);
      LS.set('cfl_bank_filter', [...S.filter]);
      render();
    }
    function render() {
      updQuick();
      if (!S.accs || !S.items) {
        emptyOut();
        $('sum').innerHTML = ''; $('xlsx').disabled = true; navCounts(null); applySec(); return;
      }
      // неактуальні за назвою рахунки сховано (і ті, що стали такими пізніше), якщо людина не показала їх сама; решта — як вибере людина
      const all = S.lastAll = rows(), hidden = hiddenAccs(S.accs, LS.get('cfl_bank_hide', []), LS.get('cfl_bank_shown', []));
      S.lastNewCards = newCards();
      S.lastReps = repointFixes(all); // до переказів: пропозиція поповнення картки в мінусі показує, що поповнення, можливо, вже є на іншій картці
      S.lastMt = mtCalc(all); // до «Внести в CRM»: операцію з погодженням там не пропонується вносити (її вносять у «Погодженні»)
      const base = all.filter(r => S.showHidden || !hidden.has(r.a.id));
      const c = k => base.filter(r => r.status === k).length, nHid = all.filter(r => hidden.has(r.a.id)).length;
      // «сховано» — окремий перемикач: з ним видно й сховані рахунки (з вибраними статусами; якщо жоден видимий статус не вибрано — усі сховані)
      const anySt = ST_ORDER.filter(k => !ST_RARE.has(k) || c(k)).some(k => S.filter.has(k));
      const vis = all.filter(r => (hidden.has(r.a.id) ? S.showHidden && (!anySt || S.filter.has(r.status)) : S.filter.has(r.status)));
      const xh = S.kind === 'all' || S.kind === 'own' ? xferHtml(all) : (S.lastProps = [], '');
      const rh = recHtml(all), th = typeHtml(all) + repointHtml(), cardsH = cardsHtml(), closeH = closeHtml(all);
      let h = `<div class="card"><div class="sub-h"><h3>Рахунки за ${esc(dmy(S.from))}–${esc(dmy(S.to))}${S.kind !== 'all' ? ` · ${esc(KIND_ONLY[S.kind])}` : ''}</h3>
<div class="chips">${ST_ORDER.filter(k => !ST_RARE.has(k) || c(k)).map(k => `<span class="${ST[k][0]}${S.filter.has(k) ? ' on' : ''}" data-st="${k}" title="Показати / сховати рахунки з цим статусом">${ST[k][1]}: ${c(k)}</span>`).join('')}${nHid ? `<span class="st-locked${S.showHidden ? ' on' : ''}" data-b="showhid" title="Показати сховані рахунки (значок-око в рядку)">сховано: ${nHid}</span>` : ''}</div></div>
<div class="row" style="margin:0 0 10px"><span class="muted small">Статуси — фільтр: натисніть, щоб показати чи сховати рахунки з таким статусом.${vis.length < base.length ? ` Показано ${vis.length} з ${base.length} — вибір пам'ятається.` : ''}</span>${vis.length < base.length ? '<button class="quiet" data-b="stall" style="margin:0">Показати всі</button>' : ''}<button class="quiet" data-b="offs" title="Читає всі записи CRM від початку — до хвилини" style="margin:0 0 0 auto">Порівняти залишки CRM із сумою записів</button></div>
${S.kind !== 'all' ? `<div class="info">Звіряються ${esc(KIND_ONLY[S.kind])}: обороти, кількість операцій і суми — лише цього типу (у CRM — за типом запису${S.kind === 'own' ? ': перекази й обміни' : ''}; у банку — ${S.kind === 'own' ? 'операції з нашими рахунками і ті, що в CRM записано переказом' : S.kind === 'credit' ? 'зарахування, крім переказів між своїми' : 'списання, крім переказів між своїми'}). Різниця залишків на початок і кінець видна (Δ), але на статус з фільтром не впливає. Усе разом — «Що звіряти: усе».</div>` : ''}`;
      if (S.offsets) {
        const off = all.filter(r => !isZero(r.offset));
        h += off.length ? `<div class="warn">У ${off.length} з ${all.length} рахунків залишок, який показує CRM, не дорівнює сумі записів рахунку (примітка в рядку). У кешфлоу цієї різниці немає: це може бути початковий залишок без запису або запис, змінений чи видалений без перерахунку залишку. З банком звіряйте залишок CRM.</div>`
          : '<div class="info">В усіх рахунках залишок CRM дорівнює сумі записів.</div>';
      }
      if (!vis.length) h += `<div class="info">${S.filter.size || S.showHidden ? 'Немає рахунків із вибраними статусами.' : 'Не вибрано жодного статусу — натисніть статус угорі.'}</div>`;
      else {
        h += `<div class="tbl acct"><table class="bal"><colgroup><col><col style="width:128px"><col style="width:128px"><col style="width:128px"><col style="width:146px"><col style="width:150px"><col style="width:140px"></colgroup>
<tr><th>Рахунок CRM</th><th class="n">Залишок на початок ${esc(dmy(S.from))}</th><th class="n">${S.kind === 'own' ? 'Перекази: надійшло' : 'Надходження'}</th><th class="n">${S.kind === 'own' ? 'Перекази: списано' : 'Списання'}</th><th class="n">Залишок на кінець ${esc(dmy(S.to))}</th><th>Кількість за сумами</th><th></th></tr>`;
        for (const g of GROUPS) {
          // у групі спершу рахунки, де є що робити (розбіжність, бракує переказів, неповні дані банку), далі — за назвою
          const gr = vis.filter(r => r.g === g).sort((x, y2) => (ST_FIRST.has(y2.status) ? 1 : 0) - (ST_FIRST.has(x.status) ? 1 : 0) || x.a.name.localeCompare(y2.a.name, 'uk'));
          if (!gr.length) continue;
          h += `<tr class="gh"><td colspan="7">${esc(g[1])}</td></tr>` + gr.map(r => rowHtml(r, hidden.has(r.a.id))).join('');
        }
        h += '</table></div><div class="muted small" style="margin-top:8px">У кожній клітинці: CRM (жирним), банк і різниця CRM − банк (✓ — збігається). Під рахунком — чого саме бракує в CRM чи в банку за період.</div>';
      }
      h += '</div>';
      $('sum').innerHTML = sumHtml(all);
      const add = doneHtml() + (cardsH + xh + rh || '<div class="empty">Вносити нічого: усе, що є у виписках, є й у CRM.</div>') + outsideHtml();
      // прокрутка кожної таблиці з прокруткою (рахунки, «Операції банку, яких немає в CRM», …) — та сама після перемальовування:
      // зміна статті чи маркетолога в довгому списку не повертає на його початок (16.11.2026). Ключ — розділ і номер таблиці в ньому
      const tbls = () => [...$('out').querySelectorAll('.tbl')].map((t, i, l) => { const s = t.closest('[data-sec]'), k = s ? s.dataset.sec : ''; return [`${k}|${l.slice(0, i).filter(o => o.closest('[data-sec]') === s).length}`, t]; });
      const keepAll = new Map(tbls().map(([k, t]) => [k, [t.scrollTop, t.scrollLeft]]));
      const was = $('out').querySelector('.tbl.acct'), keep = was ? [was.scrollTop, was.scrollLeft] : null;
      // розділи одразу з потрібним hidden: браузер розкладає лише видимий (відновлення прокрутки нижче примушує розкладку)
      const sec = (k, body) => `<section data-sec="${k}"${S.sec === k ? '' : ' hidden'}>${body}</section>`;
      $('out').innerHTML = sec('acc', h) + sec('mt', mtHtml()) + sec('add', add)
        + sec('fix', th || '<div class="empty">Виправляти нічого: записів з неправильним типом і поповнень не на ту картку немає.</div>') + sec('wd', wdHtml()) + sec('close', closeH);
      const now = S.sec === 'acc' && $('out').querySelector('.tbl.acct');
      if (now && keep) { now.scrollTop = keep[0]; now.scrollLeft = keep[1]; }
      for (const [k, t] of tbls()) { const v = keepAll.get(k); if (v && t !== now && k.split('|')[0] === S.sec && (v[0] || v[1])) { t.scrollTop = v[0]; t.scrollLeft = v[1]; } }
      const prompts = all.reduce((s, r) => s + (r.R.own ? r.R.own.maybe.length : 0), 0), sm = bankSummary(all, S.lastTypes, S.lastNewCards, S.lastReps), wdS = wdPart();
      const rep = S.close && S.close.from === S.from && S.close.to === S.to && S.kind === 'all' && S.close.lint !== undefined
        ? closeReport(all, { types: S.lastTypes, repoints: S.lastReps, lint: S.close.lint, reg: S.close.reg, wd: wdS, noHelper: S.close.noHelper, newCards: S.lastNewCards.length, drafts: draftItems(), draftsEmpty: S.drafts ? S.drafts.empty : 0 }) : null;
      navCounts({ bad: sm.bad, add: S.lastProps.filter(xok).length + S.lastRecs.filter(p => !p.block && !p.payRow).length + prompts + S.lastNewCards.length, fix: S.lastTypes.length + S.lastReps.length,
        wd: wdS && !wdS.error ? wdS.diff + wdS.none + wdS.extra + wdS.double.length : null,
        mt: S.lastMt ? S.lastMt.res.rows.filter(m => MT.crmState(m.ap) !== 'в CRM').length + S.lastMt.res.amb.length : null,
        close: rep ? (rep.verdict === 'ready' ? '✓' : rep.verdict === 'not' ? '✗' : '—') : null });
      applySec();
      $('sum').querySelectorAll('[data-go-sec]').forEach(b => b.onclick = () => { S.sec = b.dataset.goSec; applySec(); });
      // «відкрити розділ» у висновку закриття місяця: розділ і прокрутка до плиток (над перемикачем розділів)
      $('out').querySelectorAll('[data-go-sec]').forEach(b => b.onclick = () => { S.sec = b.dataset.goSec; applySec(); if ($('sum').scrollIntoView) $('sum').scrollIntoView({ block: 'start' }); });
      $('xlsx').disabled = false;
      bindXfer();
      bindRecs();
      bindTypes();
      bindRepoint();
      bindCards();
      bindWd();
      bindMt();
      wdEnsure(); // погодження для «Виводів з балансу» — у фоні, якщо прочитаних не вистачає для періоду
      // історія рахунку (записи за 120 днів до періоду): стаття, де правила її не дали; маркетолог реклами й зразок коментаря покупки карткою
      // … і проєкт: без правила проєкту він береться з записів рахунку, а в періоді їх може ще не бути (16.11.2026)
      const want = [...new Set(S.lastRecs.filter(p => !p.block && !S.hist.has(p.acc) && (!p.rule.art || !p.rule.proj || p.cardComment !== undefined || artIssue(S.rp.get(p.key).art) === 'marketer')).map(p => p.acc))];
      if (want.length && !S.histBusy) setTimeout(() => loadHist(want), 0);
      // список маркетологів — лише коли він потрібен (стаття з рекламним бюджетом)
      if (S.mks === undefined && S.lastRecs.some(p => !p.block && artIssue(S.rp.get(p.key).art) === 'marketer')) setTimeout(loadMarketers, 0);
      recAiEnsure(); // операції без статті — підказка ШІ через Помічник
      $('out').querySelectorAll('[data-man]').forEach(i => i.onchange = () => {
        const id = +i.dataset.man, man = LS.get('cfl_bank_manual', {}), t = i.value.trim();
        if (t === '') { if (man[id]) delete man[id][S.to]; }
        else {
          const v = parseNum(t);
          if (v === null) { i.classList.add('badin'); i.title = 'Потрібне число, наприклад 12 345,67'; return; }
          (man[id] = man[id] || {})[S.to] = v;
        }
        LS.set('cfl_bank_manual', man);
        render();
      });
      $('out').querySelectorAll('[data-hide]').forEach(e => e.onclick = () => {
        const id = +e.dataset.hide, h2 = new Set(LS.get('cfl_bank_hide', [])), sh = new Set(LS.get('cfl_bank_shown', []));
        // показати неактуальний за назвою — запам'ятати, що його показала людина (інакше він ховається сам)
        if (hiddenAccs(S.accs, [...h2], [...sh]).has(id)) { h2.delete(id); if (OFF_ACC.test(nameOf(id))) sh.add(id); }
        else { h2.add(id); sh.delete(id); }
        LS.set('cfl_bank_hide', [...h2]);
        LS.set('cfl_bank_shown', [...sh]);
        render();
      });
      $('out').querySelectorAll('[data-st]').forEach(e => e.onclick = () => stToggle(e.dataset.st));
      const sa = $('out').querySelector('[data-b="stall"]');
      if (sa) sa.onclick = () => stToggle(null);
      $('out').querySelectorAll('[data-det]').forEach(e => e.onclick = () => {
        const id = +e.dataset.det, open = !S.open.has(id), r = (S.lastAll || []).find(x => x.a.id === id), tr = e.closest('tr');
        if (open) S.open.add(id); else S.open.delete(id);
        if (!r || !tr) { render(); return; }
        let after = tr.nextElementSibling && tr.nextElementSibling.classList.contains('sub') ? tr.nextElementSibling : tr;
        const det = after.nextElementSibling && after.nextElementSibling.classList.contains('det') ? after.nextElementSibling : null;
        if (open && !det) after.insertAdjacentHTML('afterend', `<tr class="det"><td colspan="7">${detHtml(r)}</td></tr>`);
        if (!open && det) det.remove();
        e.textContent = `Деталі ${open ? '▴' : '▾'}`;
        e.title = open ? 'Згорнути операції' : 'Усі операції банку й записи CRM за період — зі станом кожної';
      });
      const sh = $('out').querySelector('[data-b="showhid"]');
      if (sh) sh.onclick = () => { S.showHidden = !S.showHidden; render(); };
      if (opts.go) $('out').querySelectorAll('[data-go]').forEach(e => e.onclick = () => opts.go(e.dataset.go));
      $('out').querySelector('[data-b="offs"]').onclick = offsets;
      const od = $('out').querySelector('[data-b="outside"] details');
      if (od) od.ontoggle = () => { S.outOpen = od.open; };
      Cmb.enhance($('out')); // довгі списки (статті, маркетологи, рахунки) — з пошуком
    }

