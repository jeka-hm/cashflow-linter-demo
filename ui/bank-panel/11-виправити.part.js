    // ---------- записи з неправильним типом: змінити на «Переказ між рахунками» ----------
    const ccyOf = id => (S.accs.find(a => a.id === id) || {}).currency_id;
    /* Корп. картку поповнюють лише з рахунку її власника (rules.json → reference.card_topup, уточнення 30.10.2026): картки, що годяться
       для поповнення з рахунку acc, — діючі картки того самого ФОП / ТОВ; власника не видно з назви — усі діючі. */
    const SAME_OWNER = !(opts.rulesDoc && opts.rulesDoc.reference && opts.rulesDoc.reference.card_topup && opts.rulesDoc.reference.card_topup.same_owner === false);
    function topupCards(acc) {
      const all = S.accs.filter(a => Rc.isCorp(a) && !Rc.CARD_OFF.test(a.name || '') && a.id !== acc);
      const own = SAME_OWNER ? Rc.ownerCards(S.accs.find(a => a.id === acc), S.accs) : null;
      return own ? own.filter(a => a.id !== acc) : all;
    }
    /* corpCard для поповнення: номер картки в коментарі, тримач картки (rules.json → holders), названий у коментарі, картка, що
       звіряється з цим рахунком (якщо одна), єдина картка власника рахунку, інакше — куди раніше поповнювали з цього рахунку
       (щонайменше 60 % переказів на corpCard). Лише картки власника рахунку (topupCards). Якщо діючих карток у власника кілька
       (з 04.11.2026 — по дві в кожного ФОП), лише номер чи тримач: нова картка ще не платила й не має історії. {id, why} або null. */
    function topupTarget(c, r) {
      const ok = new Set(topupCards(c.acc).map(a => a.id));
      for (const m of String(c.comment || '').matchAll(/(?<!\d)(\d{4})(?!\d)/g)) { const k = S.dir.cards[m[1]]; if (k && k !== c.acc && ok.has(k)) return { id: k, why: `номер картки ${m[1]} у коментарі` }; }
      const h = Rc.holderCard(CARDS, c.comment, c.date, id => ok.has(id));
      if (h && h.id) return { id: h.id, why: `у коментарі ${h.name} — ${h.from ? `з ${dmy(h.from)} ` : ''}тримач картки ${h.last4}` };
      if (ok.size > 1 && SAME_OWNER && Rc.ownerOf(nameOf(c.acc))) return null;
      const mine = (r.cards || []).filter(k => ok.has(k));
      if (mine.length === 1) return { id: mine[0], why: 'картка, що списує з цього рахунку' };
      if (ok.size === 1 && SAME_OWNER && Rc.ownerOf((S.accs.find(a => a.id === c.acc) || {}).name)) return { id: [...ok][0], why: `єдина картка ${Rc.ownerOf((S.accs.find(a => a.id === c.acc) || {}).name)}` };
      const cnt = new Map();
      for (const x of [...(S.items.get(c.acc) || []), ...(S.hist.get(c.acc) || [])]) if (x.opc === 4 && ok.has(x.peer)) cnt.set(x.peer, (cnt.get(x.peer) || 0) + 1);
      const n = [...cnt.values()].reduce((s, v) => s + v, 0), top = [...cnt].sort((a, b) => b[1] - a[1])[0];
      return top && top[1] / n >= 0.6 ? { id: top[0], why: 'куди раніше поповнювали з цього рахунку' } : null;
    }
    /* У виписці переказ між своїми, а в CRM той самий рух — витрата чи дохід (стан «type»); поповнення корп. картки, записане витратою.
       Пропозиція — змінити запис на «Переказ між рахунками». other — другий рахунок переказу; out — гроші йдуть з рахунку запису. */
    function typeFixes(all) {
      const out = [], seen = new Set();
      // запис закритого в CRM місяця (за його періодом) не пропонується: змінити його може лише Адмін
      const add = p => { if (!seen.has(p.item.id) && !shut(p.item)) { seen.add(p.item.id); out.push(p); } };
      for (const r of all) {
        if (r.status === 'ccy') continue;
        for (const x of (r.R.own ? r.R.own.xfers : [])) {
          if (x.state !== 'type' || !x.item || !(x.item.opc === 1 || x.item.opc === 2)) continue;
          add({ item: x.item, other: x.peer, fixed: true, out: x.item.amount < 0,
            why: `у виписці ${dmy(x.row.date)} — переказ ${x.row.amount < 0 ? 'на' : 'з'} «${nameOf(x.peer)}»: ${x.row.cpty || '—'} · ${x.row.purpose || ''}` });
        }
        for (const c of r.topups || []) {
          const k = topupTarget(c, r);
          add({ item: c, other: k ? k.id : null, otherWhy: k ? k.why : '', fixed: false, out: true, why: 'поповнення корп. картки записано витратою' });
        }
      }
      for (const p of out) {
        Object.assign(p, { key: `type:${p.item.id}`, acc: p.item.acc, amount: r2(Math.abs(p.item.amount)), date: p.item.date });
        if (!S.tp.has(p.key)) S.tp.set(p.key, { on: false, other: p.other });
        const st = S.tp.get(p.key);
        if (!p.fixed && !st.other && p.other) st.other = p.other;
        // не змінюються: записи з лідів, до межі роботи, переказ у рахунок іншої валюти (це «Обмін»);
        // автоматичні записи (модуль ЗП, «Підтвердження виведення коштів з балансу») і зарплатні статті — як у «Статтях і проєктах»:
        // зміна типу стерла б статтю й підтвердження виводу (огляд 16.11.2026)
        p.block = p.item.draft ? 'це чернетка CRM — лінтер її не змінює: виправте в CRM («CashFlow» → «Чернетки»)' : p.item.lead ? 'запис створено з ліда CRM — лінтер його не змінює'
          : p.item.auto ? 'запис створено автоматично (модуль ЗП, вивід з балансу) — лінтер його не змінює: якщо це справді переказ, виправте в CRM вручну'
          : salaryArt(p.item.art) ? 'зарплатна стаття — такий запис CRM змінювати не дає: якщо це справді переказ, виправте в CRM вручну'
          : fixFrom && p.date < fixFrom ? `до ${dmy(fixFrom)} лінтер нічого не змінює` : '';
      }
      // той самий переказ записано двічі (витратою на одному рахунку й доходом на другому): змінити лише один, другий — дубль
      out.forEach((p, i) => {
        if (p.block || !S.tp.get(p.key).other) return;
        const [f, t] = typeEnds(p);
        const twin = out.slice(0, i).find(q => !q.block && S.tp.get(q.key).other && typeEnds(q)[0] === f && typeEnds(q)[1] === t && Math.round(q.amount * 100) === Math.round(p.amount * 100) && Math.abs(dayDiff(q.date, p.date)) <= 3);
        if (twin) p.block = `той самий переказ, що й ID ${twin.item.id}: змініть лише його, а цей запис — дубль (видаліть його в CRM вручну)`;
      });
      return out;
    }
    // поповнення корп. картки (не fixed) — лише на картку власника рахунку запису (topupCards)
    const typeOk = p => { const st = S.tp.get(p.key); return !p.block && !!st.other && st.other !== p.acc && ccyOf(st.other) === ccyOf(p.acc) && (p.fixed || topupCards(p.acc).some(a => a.id === st.other)); };
    const typeEnds = p => { const o = S.tp.get(p.key).other; return p.out ? [p.acc, o] : [o, p.acc]; };
    function typeHtml(all) {
      const props = S.lastTypes = typeFixes(all);
      if (!props.length) return '';
      const can = !!opts.applyAllowed && !noFull(), on = props.filter(p => typeOk(p) && S.tp.get(p.key).on);
      let h = `<div class="card" data-b="types"><div class="sub-h"><h3>Записи з неправильним типом</h3><span class="muted small">за правилами це «Переказ між рахунками», а в CRM — витрата чи дохід · ${props.length}</span></div>
<details class="hint" style="margin:0 0 10px"><summary>Що змінюється</summary><div>Лінтер може змінити тип запису — так само, як форма редагування CRM: сума, дата, коментар і проєкт не змінюються. Перед зміною запис зберігається як був (резервна копія), після — перевіряється; повернути можна кнопкою. Нічого не позначено заздалегідь.</div></details>
<div class="tbl" style="max-height:none"><table class="xf"><tr><th></th><th>Дата</th><th>Запис CRM</th><th class="n">Сума</th><th>Стане</th><th>Підстава</th></tr>`;
      for (const p of props) {
        const st = S.tp.get(p.key), ok = typeOk(p), [f, t] = st.other ? typeEnds(p) : [null, null];
        const cards = p.fixed ? [] : topupCards(p.acc).filter(a => a.currency_id === ccyOf(p.acc)), owner = Rc.ownerOf(nameOf(p.acc));
        const otherSel = p.fixed ? '' : `<select data-tother data-wide style="max-width:260px"${can ? '' : ' disabled'}><option value="">— рахунок картки —</option>${cards.map(a => `<option value="${a.id}"${a.id === st.other ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`;
        const note = p.block ? `<div class="bad" style="font-weight:400">${esc(p.block)}</div>`
          : !p.fixed && !cards.length ? `<div class="bad" style="font-weight:400">у CRM немає корп. картки ${esc(owner || 'цього власника')}: картку поповнюють лише з рахунку її власника</div>`
          : !st.other ? '<div class="bad" style="font-weight:400">виберіть рахунок картки</div>'
          : !p.fixed && !cards.some(a => a.id === st.other) ? `<div class="bad" style="font-weight:400">картка іншого власника: з «${esc(nameOf(p.acc))}» поповнюють лише картку ${esc(owner || 'цього власника')}</div>`
          : ccyOf(st.other) !== ccyOf(p.acc) ? '<div class="bad" style="font-weight:400">різна валюта рахунків — це «Обмін», змініть у CRM вручну</div>'
          : !p.fixed && p.otherWhy && st.other === p.other ? `<div class="muted xwhy">${esc(p.otherWhy)}</div>` : '';
        h += `<tr data-tk="${esc(p.key)}"><td><input type="checkbox" data-ton${st.on && ok ? ' checked' : ''}${can && ok ? '' : ' disabled'}></td><td>${esc(dmy(p.date))}</td>
<td>ID ${p.item.id} · ${esc(p.item.op)} · «${esc(nameOf(p.acc))}»<div class="muted" style="font-size:12px">${esc(clean(p.item.comment).slice(0, 120))}</div></td>
<td class="n">${esc(fmt(p.amount))}</td>
<td>«Переказ між рахунками»: ${f ? `«${esc(nameOf(f))}» →<br>«${esc(nameOf(t))}»` : `«${esc(nameOf(p.acc))}» → …`}${otherSel ? `<div style="margin-top:4px">${otherSel}</div>` : ''}${note}</td>
<td class="muted xwhy">${esc(p.why)}</td></tr>`;
      }
      return h + `</table></div><div class="row" style="margin-top:8px"><button class="primary" data-b="tchange"${can && on.length && !S.busy ? '' : ' disabled'}>Змінити позначені (${on.length})</button>
${can ? '<button class="quiet" data-b="tall">Позначити всі</button><button class="quiet" data-b="tnone">Зняти позначки</button>' : ''}
<span class="muted small">${can ? 'Уперше змініть один запис і перевірте його в CRM — потім решту.' : noFull() ? esc(M.noFullText(rights)) : 'Змінювати записи можна в закладці «Лінтер кешфлоу (APPLY)»; тут — лише перегляд.'}</span></div></div>`;
    }
    function bindTypes() {
      const box = $('out'), keyOf = e => e.closest('[data-tk]').dataset.tk, q = k => box.querySelector(`[data-b="${k}"]`);
      // галочка — лише лічильник на кнопці, без перемальовування
      const upd = () => { const n = S.lastTypes.filter(p => typeOk(p) && S.tp.get(p.key).on).length, b = q('tchange');
        if (b) { b.textContent = `Змінити позначені (${n})`; b.disabled = !(opts.applyAllowed && !noFull() && n && !S.busy); } };
      box.querySelectorAll('[data-ton]').forEach(e => e.onchange = () => { S.tp.get(keyOf(e)).on = e.checked; upd(); });
      box.querySelectorAll('[data-tother]').forEach(e => e.onchange = () => { const st = S.tp.get(keyOf(e)); st.other = Number(e.value) || null; if (!st.other) st.on = false; render(); });
      if (q('tall')) q('tall').onclick = () => { S.lastTypes.filter(typeOk).forEach(p => { S.tp.get(p.key).on = true; }); render(); };
      if (q('tnone')) q('tnone').onclick = () => { S.lastTypes.forEach(p => { S.tp.get(p.key).on = false; }); render(); };
      if (q('tchange')) q('tchange').onclick = () => changeTypes(S.lastTypes.filter(p => typeOk(p) && S.tp.get(p.key).on));
    }

    // ---------- поповнення корп. картки не на ту картку власника: переспрямувати (змінити рахунок «куди» переказу) ----------
    const cardNum = id => Object.keys(S.dir.cards || {}).find(t => Number(S.dir.cards[t]) === id) || Rc.nameTail(S.accs.find(a => a.id === id)) || `ID ${id}`;
    /* Перекази «рахунок ФОП / ТОВ → його корп. картка» з MARGIN днів до періоду по кінець періоду, у власника кілька діючих карток
       тієї самої валюти: куди мали піти гроші — wrongTopups (номер чи тримач у коментарі, покупки у виписці). Записи закритого місяця
       не пропонуються (змінює їх лише Адмін), до межі роботи й з лідів — лише з поясненням. */
    function repointFixes(all) {
      const out = [], lo = addDays(S.from, -MARGIN);
      for (const r of all) {
        if (r.status === 'merged' || r.status === 'ccy' || Rc.isCorp(r.a)) continue;
        const own = topupCards(r.a.id).filter(a => a.currency_id === r.a.currency_id);
        if (own.length < 2) continue;
        const ids = new Set(own.map(a => a.id));
        const xfers = (S.items.get(r.a.id) || []).filter(x => x.opc === 4 && ids.has(Number(x.peer)) && x.date >= lo && x.date <= S.to && !shut(x));
        if (!xfers.length) continue;
        const cards = own.map(a => ({ id: a.id, last4: cardNum(a.id), balance: Number(a.balance) }));
        for (const f of wrongTopups({ xfers, cards, tails: S.dir.cards, holders: CARDS, rows: r.b ? r.b.rows : null, fileFrom: r.b ? r.b.fileFrom : null })) {
          const x = f.item, bal = id => (cards.find(c => c.id === id) || {}).balance;
          const wasH = CARDS.find(c => Number(c.account_id) === f.was), wh = wasH && holderOf(wasH, x.date);
          const why = f.how === 'num' ? `у коментарі номер картки ${f.num}`
            : f.how === 'holder' ? `у коментарі ${f.holder.name} — ${f.holder.from ? `з ${dmy(f.holder.from)} ` : ''}тримач картки ${f.holder.last4} (rules.json)${wh ? `, а картку ${cardNum(f.was)} тримає ${wh.name}` : ''}`
            : `після поповнення у виписці платить лише картка ${cardNum(f.to)} (${f.spent.n} ${plural(f.spent.n, 'покупка', 'покупки', 'покупок')} на ${fmt(f.spent.sum)}), карткою ${cardNum(f.was)} — жодної; у CRM на «${nameOf(f.to)}» ${fmt(bal(f.to))}, а на «${nameOf(f.was)}» поповнення не витрачено (залишок ${fmt(bal(f.was))})`;
          out.push({ key: `rp:${x.id}`, item: x, acc: r.a.id, was: f.was, to: f.to, how: f.how, amount: r2(Math.abs(x.amount)), date: x.date, why,
            line: `на картку ${cardNum(f.was)} замість ${cardNum(f.to)}`, cards: own.map(a => a.id),
            block: x.draft ? 'це чернетка CRM — лінтер її не змінює: виправте в CRM («CashFlow» → «Чернетки»)' : x.lead ? 'запис створено з ліда CRM — лінтер його не змінює' : fixFrom && x.date < fixFrom ? `до ${dmy(fixFrom)} лінтер нічого не змінює` : '' });
        }
      }
      for (const p of out) if (!S.rpt.has(p.key)) S.rpt.set(p.key, { on: false, to: p.to });
      return out;
    }
    const repOk = p => { const st = S.rpt.get(p.key); return !p.block && !!st && !!st.to && st.to !== p.was && p.cards.includes(st.to) && ccyOf(st.to) === ccyOf(p.was); };
    function repointHtml() {
      const props = S.lastReps;
      if (!props.length) return '';
      const can = !!opts.applyAllowed && !noFull(), on = props.filter(p => repOk(p) && S.rpt.get(p.key).on);
      let h = `<div class="card" data-b="reps"><div class="sub-h"><h3>Поповнення не на ту картку</h3><span class="muted small">переказ з рахунку на корп. картку записано на іншу картку цього власника · ${props.length}</span></div>
<details class="hint" style="margin:0 0 10px"><summary>Як це видно</summary><div>Самого поповнення корп. картки в банку немає: Приват списує покупки картки прямо з рахунку ФОП, а номер картки є в кожній покупці. Тому лінтер дивиться на коментар поповнення (номер картки, тримач з rules.json) і на покупки у виписці після нього: якщо платить лише інша картка, а ця — ні, поповнення, найпевніше, було для неї. Переспрямувати — змінити рахунок «куди» переказу, як у формі редагування CRM: сума, дата, коментар і проєкт не змінюються. Перед зміною запис зберігається як був, після — перевіряється; повернути можна кнопкою. Нічого не позначено заздалегідь.</div></details>
<div class="tbl" style="max-height:none"><table class="xf"><tr><th></th><th>Дата</th><th>Запис CRM</th><th class="n">Сума</th><th>Стане</th><th>Підстава</th></tr>`;
      for (const p of props) {
        const st = S.rpt.get(p.key), ok = repOk(p);
        const sel = `<select data-rpto data-wide style="max-width:260px"${can && !p.block ? '' : ' disabled'}>${p.cards.filter(id => id !== p.was).map(id => `<option value="${id}"${id === st.to ? ' selected' : ''}>${esc(nameOf(id))}</option>`).join('')}</select>`;
        const note = p.block ? `<div class="bad" style="font-weight:400">${esc(p.block)}</div>` : ccyOf(st.to) !== ccyOf(p.was) ? '<div class="bad" style="font-weight:400">різна валюта рахунків карток</div>' : '';
        h += `<tr data-rpk="${esc(p.key)}"><td><input type="checkbox" data-rpon${st.on && ok ? ' checked' : ''}${can && ok ? '' : ' disabled'}></td><td>${esc(dmy(p.date))}</td>
<td>ID ${p.item.id} · переказ «${esc(nameOf(p.acc))}» → «${esc(nameOf(p.was))}»<div class="muted" style="font-size:12px">${esc(clean(p.item.comment).slice(0, 120))}</div></td>
<td class="n">${esc(fmt(p.amount))}</td>
<td>«${esc(nameOf(p.acc))}» →<div style="margin-top:4px">${sel}</div>${note}</td>
<td class="muted xwhy">${esc(p.why)}</td></tr>`;
      }
      return h + `</table></div><div class="row" style="margin-top:8px"><button class="primary" data-b="rpchange"${can && on.length && !S.busy ? '' : ' disabled'}>Переспрямувати позначені (${on.length})</button>
${can ? '<button class="quiet" data-b="rpall">Позначити всі</button><button class="quiet" data-b="rpnone">Зняти позначки</button>' : ''}
<span class="muted small">${can ? 'Уперше змініть один запис і перевірте його в CRM — потім решту.' : noFull() ? esc(M.noFullText(rights)) : 'Змінювати записи можна в закладці «Лінтер кешфлоу (APPLY)»; тут — лише перегляд.'}</span></div></div>`;
    }
    function bindRepoint() {
      const box = $('out'), keyOf = e => e.closest('[data-rpk]').dataset.rpk, q = k => box.querySelector(`[data-b="${k}"]`);
      const upd = () => { const n = S.lastReps.filter(p => repOk(p) && S.rpt.get(p.key).on).length, b = q('rpchange');
        if (b) { b.textContent = `Переспрямувати позначені (${n})`; b.disabled = !(opts.applyAllowed && !noFull() && n && !S.busy); } };
      box.querySelectorAll('[data-rpon]').forEach(e => e.onchange = () => { S.rpt.get(keyOf(e)).on = e.checked; upd(); });
      box.querySelectorAll('[data-rpto]').forEach(e => e.onchange = () => { const st = S.rpt.get(keyOf(e)); st.to = Number(e.value) || null; if (!st.to) st.on = false; render(); });
      if (q('rpall')) q('rpall').onclick = () => { S.lastReps.filter(repOk).forEach(p => { S.rpt.get(p.key).on = true; }); render(); };
      if (q('rpnone')) q('rpnone').onclick = () => { S.lastReps.forEach(p => { S.rpt.get(p.key).on = false; }); render(); };
      if (q('rpchange')) q('rpchange').onclick = () => repoint(S.lastReps.filter(p => repOk(p) && S.rpt.get(p.key).on));
    }
    // переказ з тим самим рахунком «з» і новим «куди» — як форма редагування CRM (перекази між рахунками однієї валюти)
    const repBody = (from, to) => ({ operation: '3', invoice_from: String(from), invoice_to: String(to), currency_id: String(ccyOf(to)) });
    async function repoint(list) {
      if (!opts.applyAllowed || !list.length || S.busy) return;
      const reqs = list.map(p => ({ p, to: S.rpt.get(p.key).to })), n = reqs.length, p0 = reqs[0].p, b0 = repBody(p0.acc, reqs[0].to);
      const ann = k => (k === 'invoice_from' || k === 'invoice_to' ? ` — ${nameOf(+b0[k])}` : k === 'currency_id' ? ` — ${(S.ccy || {})[b0[k]] || ''}` : k === 'operation' ? ' — переказ' : '');
      const html = `<h3>Переспрямувати ${n === 1 ? 'поповнення' : `поповнення: ${n}`} на іншу корп. картку</h3>
<p>Буде відправлено ${n === 1 ? 'запит' : `${n} запити (по одному на запис)`} <code>PUT /api/invoice-payment/ID</code> — так само переказ змінює форма редагування CRM. ${n === 1 ? 'Запит' : 'Перший'} — ID ${p0.item.id} (${esc(fmt(p0.amount))}, було «${esc(nameOf(p0.acc))}» → «${esc(nameOf(p0.was))}»):</p>
<table class="kv">${Object.entries(b0).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}${esc(ann(k))}</td></tr>`).join('')}</table>
${n > 1 ? `<details><summary>Усі ${n}</summary><ul>${reqs.map(({ p, to }) => `<li>${esc(`ID ${p.item.id} ${dmy(p.date)} ${fmt(p.amount)}: «${nameOf(p.was)}» → «${nameOf(to)}»`)}</li>`).join('')}</ul></details>` : ''}
<p>Сума, дата, коментар і проєкт не змінюються. Перед зміною лінтер перечитує кожен запис (якщо його вже змінили — пропуск) і зберігає, яким він був: резервна копія — файлом і в журналі; після зміни — перевіряє, що це переказ з того самого рахунку на вибрану картку з тією самою сумою й датою.</p>`;
      if (!await opts.dialog(html, n === 1 ? 'Так, переспрямувати' : `Так, переспрямувати ${n}`, true)) return;
      busy(true);
      if (opts.setBusy) opts.setBusy(true);
      const journal = [], backup = [], backupName = `кешфлоу_резервна_копія_тип_${stamp()}.json`;
      const persist = typeJournal(journal);
      let saved = false, kept = null, noRights = false;
      try {
        for (const [i, { p, to }] of reqs.entries()) {
          persist();
          st(`переспрямовую поповнення ${i + 1} з ${n}…`);
          let wrote = false;
          const e = { at: new Date().toISOString(), action: 'переспрямування поповнення корп. картки', id: p.item.id, from: p.acc, fromName: nameOf(p.acc), was: p.was, wasName: nameOf(p.was), to, toName: nameOf(to), amount: p.amount, date: p.date, before: null, result: '', note: '' };
          journal.push(e);
          if (noRights) { e.result = 'пропущено'; e.note = NOT_SENT; continue; }
          try {
            const rec = recOf(await api.get('invoice-payment/' + p.item.id));
            if (!rec || rec.deleted_at || livePays(rec).length !== 2 || !pay(rec, p.acc, [4], p.amount) || !pay(rec, p.was, [3], p.amount)) {
              e.result = 'пропущено'; e.note = 'запис змінили після звірки — не змінено'; continue;
            }
            e.before = { op: 3, from: p.acc, to: p.was, amount: p.amount, date: M.kyivDate(rec.date) };
            backup.push({ id: p.item.id, record: rec });
            if (!saved) { saved = true; kept = await keepFile(backupName, 'application/json', JSON.stringify(backup, null, 1), 'backups'); }
            const res = await api.put('invoice-payment/' + p.item.id, repBody(p.acc, to));
            if (res.status < 200 || res.status >= 300) throw M.crmError(res, 'put');
            wrote = true;
            Object.assign(e, { result: 'перевірте', note: 'переспрямовано, перевіряю…' });
            persist();
            const after = recOf(await api.get('invoice-payment/' + p.item.id)), bad = [];
            if (!pay(after, p.acc, [4], p.amount)) bad.push(`списання з «${nameOf(p.acc)}»`);
            if (!pay(after, to, [3], p.amount)) bad.push(`зарахування на «${nameOf(to)}»`);
            if (livePays(after).length !== 2) bad.push('у записі не два рухи');
            if (after && after.date && M.kyivDate(after.date) !== p.date) bad.push(`дата ${dmy(M.kyivDate(after.date))}`);
            e.result = bad.length ? 'перевірте' : 'ok';
            e.note = bad.length ? `змінено, але не збігається: ${bad.join(', ')}` : 'переспрямовано й перевірено';
          } catch (err) {
            if (wrote) { e.result = 'перевірте'; e.note = `змінено, але не вдалося перевірити: ${err.message}`; continue; }
            noRights = failed(e, err) === 'rights';
            if (err.kind === 'closed' && CL && p.item.per) CL.learn(p.item.per);
          }
        }
      } finally {
        busy(false);
        if (opts.setBusy) opts.setBusy(false);
      }
      if (backup.length > 1 && kept && kept.where === 'helper') { try { await keepFile(backupName, 'application/json', JSON.stringify(backup, null, 1), 'backups'); } catch (e) {} }
      persist();
      await finishTypes(journal, 'Переспрямування поповнень', true);
    }
    // запит — як форма редагування CRM: лише змінені поля (JSON), непотрібні для переказу очищаються порожнім рядком
    function typeBody(p) {
      const [f, t] = typeEnds(p);
      return { operation: '3', invoice_from: String(f), invoice_to: String(t), currency_id: String(ccyOf(t)), invoice_id: '', pnl_category_id: '', pnl_operation_id: '',
        show_response_in_currency: '', ...(p.item.mk ? { marketer_id: '' } : {}) };
    }
    // як було: витрата чи дохід на рахунку запису, зі статтею й маркетологом; переспрямоване поповнення (op 3) — переказ на ту саму картку, що й був
    function restoreBody(b) {
      if (b.op === 3) return repBody(b.from, b.to);
      const c = String(ccyOf(b.acc));
      return { operation: String(b.op), invoice_id: String(b.acc), pnl_category_id: b.cat == null ? '' : String(b.cat), pnl_operation_id: b.opid == null ? '' : String(b.opid),
        show_response_in_currency: c, currency_id: c, invoice_from: '', invoice_to: '', ...(b.mk ? { marketer_id: String(b.mk) } : {}) };
    }
    const recOf = g => (g && g.data && g.data.payments ? g.data : g);
    const livePays = rec => ((rec && rec.payments) || []).filter(x => !x.deleted_at);
    const mbOf = rec => { const m = rec && rec.marketer_balance_history && rec.marketer_balance_history.marketer_balance; return m && m.user_id ? Number(m.user_id) : null; };
    async function changeTypes(list) {
      if (!opts.applyAllowed || !list.length || S.busy) return;
      const reqs = list.map(p => ({ p, body: typeBody(p) })), n = reqs.length, b0 = reqs[0].body, p0 = reqs[0].p;
      const ann = k => (k === 'invoice_from' || k === 'invoice_to' ? ` — ${nameOf(+b0[k])}` : k === 'currency_id' ? ` — ${(S.ccy || {})[b0[k]] || ''}` : b0[k] === '' ? ' — очистити' : k === 'operation' ? ' — переказ' : '');
      const html = `<h3>Змінити тип ${n === 1 ? 'запису' : `записів: ${n}`} на «Переказ між рахунками»</h3>
<p>Буде відправлено ${n === 1 ? 'запит' : `${n} запити (по одному на запис)`} <code>PUT /api/invoice-payment/ID</code> — так само запис змінює форма редагування CRM. ${n === 1 ? 'Запит' : 'Перший'} — ID ${p0.item.id} (${esc(p0.item.op)}, ${esc(fmt(p0.amount))}, «${esc(nameOf(p0.acc))}»):</p>
<table class="kv">${Object.entries(b0).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v === '' ? '""' : v)}${esc(ann(k))}</td></tr>`).join('')}</table>
${n > 1 ? `<details><summary>Усі ${n}</summary><ul>${reqs.map(({ p }) => { const [f, t] = typeEnds(p); return `<li>${esc(`ID ${p.item.id} ${dmy(p.date)} ${fmt(p.amount)}: «${nameOf(f)}» → «${nameOf(t)}»`)}</li>`; }).join('')}</ul></details>` : ''}
<p>Сума, дата, коментар і проєкт не змінюються. Якщо в записі є маркетолог (рекламний бюджет), його буде прибрано (<code>marketer_id</code> — очистити): у переказу маркетолога немає. Перед зміною лінтер перечитує кожен запис (якщо його вже змінили — пропуск) і зберігає, яким він був: резервна копія — файлом і в журналі; після зміни — перевіряє, що запис став переказом між цими рахунками з тією самою сумою й датою і без маркетолога.</p>`;
      if (!await opts.dialog(html, n === 1 ? 'Так, змінити' : `Так, змінити ${n}`, true)) return;
      busy(true);
      if (opts.setBusy) opts.setBusy(true);
      const journal = [], backup = [], backupName = `кешфлоу_резервна_копія_тип_${stamp()}.json`;
      const persist = typeJournal(journal);
      let saved = false, kept = null, noRights = false;
      try {
        for (const [i, { p, body }] of reqs.entries()) {
          persist();
          st(`змінюю тип запису ${i + 1} з ${n}…`);
          let wrote = false;
          const [f, t] = typeEnds(p);
          const e = { at: new Date().toISOString(), action: 'зміна типу на переказ між рахунками', id: p.item.id, from: f, fromName: nameOf(f), to: t, toName: nameOf(t), amount: p.amount, date: p.date, before: null, result: '', note: '' };
          journal.push(e);
          if (noRights) { e.result = 'пропущено'; e.note = NOT_SENT; continue; }
          try {
            const rec = recOf(await api.get('invoice-payment/' + p.item.id)), pays = livePays(rec);
            const x = pays.length === 1 ? pays[0] : null;
            if (!rec || rec.deleted_at || !x || Number(x.invoice_id) !== p.acc || Number(x.operation) !== p.item.opc || Math.abs(Number(x.amount) - p.amount) >= 0.005) {
              e.result = 'пропущено'; e.note = 'запис змінили після звірки — не змінено'; continue;
            }
            // щойно прочитаний запис: інша дата, ніж у звірці, автоматичний або з ліда — теж не змінюється (огляд 16.11.2026);
            // без поля is_manual у відповіді (не знаємо) — вірити списку записів, з якого зроблено звірку
            if (M.kyivDate(rec.date) !== p.date || rec.task_payment_id != null || (rec.is_manual !== undefined && [...Rc.cashflowByAccount([rec]).values()].some(l => l.some(c => c.auto)))) {
              e.result = 'пропущено'; e.note = M.kyivDate(rec.date) !== p.date ? 'дату запису змінили після звірки — не змінено' : 'запис автоматичний або з ліда — лінтер його не змінює'; continue;
            }
            e.before = { op: Number(x.operation), acc: Number(x.invoice_id), cat: x.pnl_category_id, opid: x.pnl_operation_id, mk: mbOf(rec), amount: Number(x.amount), date: M.kyivDate(rec.date) };
            backup.push({ id: p.item.id, record: rec });
            if (!saved) { // резервна копія — до першої зміни (далі доповнюється в журналі)
              saved = true;
              kept = await keepFile(backupName, 'application/json', JSON.stringify(backup, null, 1), 'backups');
            }
            // маркетолог (рекламний бюджет) — лише в записі, прочитаному щойно (у списку записів CRM його немає): у переказу його не лишаємо (07.11.2026)
            const res = await api.put('invoice-payment/' + p.item.id, mbOf(rec) ? { ...body, marketer_id: '' } : body);
            if (res.status < 200 || res.status >= 300) throw M.crmError(res, 'put');
            wrote = true;
            Object.assign(e, { result: 'перевірте', note: 'змінено, перевіряю…' });
            persist(); // журнал з «як було» — одразу після зміни, а не після всього пакета
            const after = recOf(await api.get('invoice-payment/' + p.item.id)), bad = [];
            if (!pay(after, f, [4], p.amount)) bad.push(`списання з «${nameOf(f)}»`);
            if (!pay(after, t, [3], p.amount)) bad.push(`зарахування на «${nameOf(t)}»`);
            if (after && after.date && M.kyivDate(after.date) !== p.date) bad.push(`дата ${dmy(M.kyivDate(after.date))}`);
            if (mbOf(after)) bad.push('маркетолог лишився в записі');
            e.result = bad.length ? 'перевірте' : 'ok';
            e.note = bad.length ? `змінено, але не збігається: ${bad.join(', ')}` : 'змінено й перевірено';
          } catch (err) {
            if (wrote) { e.result = 'перевірте'; e.note = `змінено, але не вдалося перевірити: ${err.message}`; continue; }
            noRights = failed(e, err) === 'rights';
            if (err.kind === 'closed' && CL && p.item.per) CL.learn(p.item.per); // далі цей місяць не звіряється
          }
        }
      } finally {
        busy(false);
        if (opts.setBusy) opts.setBusy(false);
      }
      // уся резервна копія — тим самим файлом у папці Помічника (завантаженням — ні, щоб не плодити файли; «як було» є в журналі)
      if (backup.length > 1 && kept && kept.where === 'helper') { try { await keepFile(backupName, 'application/json', JSON.stringify(backup, null, 1), 'backups'); } catch (e) {} }
      persist();
      await finishTypes(journal, 'Зміна типу на переказ', true);
    }
    // повернути як було — для записів, які лінтер щойно змінив
    async function restoreTypes(entries) {
      if (!opts.applyAllowed || !entries.length || S.busy) return;
      if (!await opts.dialog(`<h3>Повернути ${entries.length === 1 ? 'запис' : `записи: ${entries.length}`} як було</h3><p>Для кожного буде відправлено <code>PUT /api/invoice-payment/ID</code> з типом, рахунками й статтею, які були до зміни. Перший — ID ${entries[0].id}:</p><pre>${esc(JSON.stringify(restoreBody(entries[0].before), null, 2))}</pre>`, 'Так, повернути', true)) return;
      busy(true);
      if (opts.setBusy) opts.setBusy(true);
      const journal = [];
      let noRights = false;
      try {
        for (const e0 of entries) {
          const b = e0.before, e = { at: new Date().toISOString(), action: 'повернення типу як було', id: e0.id, amount: e0.amount, date: e0.date, result: '', note: '' };
          journal.push(e);
          if (noRights) { e.result = 'пропущено'; e.note = NOT_SENT; continue; }
          let wrote = false;
          try {
            const res = await api.put('invoice-payment/' + e0.id, restoreBody(b));
            if (res.status < 200 || res.status >= 300) throw M.crmError(res, 'put');
            wrote = true;
            const after = recOf(await api.get('invoice-payment/' + e0.id));
            const ok = b.op === 3 ? pay(after, b.from, [4], b.amount) && pay(after, b.to, [3], b.amount) && livePays(after).length === 2
              : pays(after, b.acc, [b.op], b.amount).length === 1 && livePays(after).length === 1;
            e.result = ok ? 'ok' : 'перевірте';
            e.note = ok ? 'повернуто й перевірено' : 'повернуто, але запис не такий, як був — перевірте в CRM';
          } catch (err) {
            if (wrote) { e.result = 'перевірте'; e.note = `повернуто, але не вдалося перевірити: ${err.message}`; continue; }
            noRights = failed(e, err) === 'rights';
          }
        }
      } finally {
        busy(false);
        if (opts.setBusy) opts.setBusy(false);
      }
      await finishTypes(journal, 'Повернення як було');
    }
    /* Журнал змін типу в браузері — після кожного запису (з «як було»), а не лише після пакета: вкладку закрили чи перезавантажили
       посеред пакета — у журналі є, які записи вже змінено і якими вони були (07.11.2026). → persist() */
    function typeJournal(journal) {
      const base = LS.get('cfl_type_journal', []);
      return () => LS.set('cfl_type_journal', base.concat(journal).slice(-500));
    }
    async function finishTypes(journal, title, persisted) {
      if (!persisted) LS.set('cfl_type_journal', LS.get('cfl_type_journal', []).concat(journal).slice(-500)); // persisted — уже збережено по одному (typeJournal)
      let saved = { where: 'download' };
      try { saved = await keepFile(`кешфлоу_тип_журнал_${stamp()}.json`, 'application/json', JSON.stringify(journal, null, 1), 'journals'); } catch (e) {}
      const cnt = {};
      journal.forEach(e => { cnt[e.result] = (cnt[e.result] || 0) + 1; });
      await calc(); // перечитати CRM: змінені записи зникнуть зі списку, рахунки перерахуються
      note(`${title}: ${Object.entries(cnt).map(([k, v]) => `${k === 'ok' ? 'зроблено й перевірено' : k} — ${v}`).join(', ')}. Журнал — ${saved.where === 'helper' ? `у папці Помічника: ${saved.path}` : '«кешфлоу_тип_журнал_….json» у «Завантаженнях»'}.`, journal.every(e => e.result === 'ok') ? 'info' : 'warn');
      journal.filter(e => e.result !== 'ok').forEach(e => note(`ID ${e.id}: ${e.note}`, BAD.includes(e.result) ? 'err' : 'warn'));
      refusalNote(journal, 'put');
      const done = journal.filter(e => e.before && (e.result === 'ok' || e.result === 'перевірте'));
      if (done.length && opts.applyAllowed) {
        $('notes').insertAdjacentHTML('beforeend', `<div class="info">Змінено записів: ${done.length}. <span class="lnk" data-b="tundo">Повернути ${done.length === 1 ? 'його' : 'їх'} як було</span></div>`);
        const links = $('notes').querySelectorAll('[data-b="tundo"]');
        links[links.length - 1].onclick = () => restoreTypes(done);
      }
    }
    // резервна копія й журнал — у папку Помічника без вікна «Зберегти як» (storage.keepFile), інакше — завантаженням
    const keepFile = async (name, mime, data, kind) => (storage.keepFile ? storage.keepFile(name, mime, data, kind) : (await storage.saveFile(name, mime, data), { where: 'download' }));
    /* Помилка запиту → рядок журналу. Відмови CRM з оновлення 29.10.2026 (M.crmError: закритий місяць — 422 errors.period,
       бракує прав — 403) — окремим результатом; після відмови в правах решту запитів не надсилаємо. → err.kind */
    const BAD = ['помилка', 'місяць закрито', 'немає прав'], NOT_SENT = 'не надсилалось: CRM відмовив у правах на попередньому записі';
    function failed(e, err) {
      e.result = err.kind === 'closed' ? 'місяць закрито' : err.kind === 'rights' ? 'немає прав' : 'помилка';
      e.note = err.message;
      return err.kind;
    }
    function refusalNote(journal, action) {
      const closed = journal.filter(e => e.result === 'місяць закрито').length;
      if (closed) note(`CRM відмовив через закритий місяць: ${closed}. Змінювати такий місяць може лише Адмін${closedTo() ? `; лінтер запам'ятав «закрито по ${M.monthUa(closedTo())}» — ці місяці більше не звіряються` : ''}.`, 'err');
      if (journal.some(e => e.result === 'немає прав')) note(action === 'post' ? 'CRM відмовив у правах вносити операції — зверніться до адміністратора CRM.' : M.noFullText(rights), 'err');
    }

