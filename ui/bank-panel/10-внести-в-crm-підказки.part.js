    // ---------- підказка ШІ для операції, якій лінтер не визначив статті (з 05.11.2026; щоденна модель Помічника) ----------
    /* Операції «Внести в CRM» без статті ні за правилами, ні з історії рахунку (крім ЗП через транзит і податків із ЗП — їх розносять
       по людях) ідуть у «Помічник кешфлоу», як записи без правил із «Статей і проєктів»: ШІ підказує статтю й проєкт, а Помічник ще й
       запам'ятовує їх для тижневого перегляду правил — що лінтер сам не розпізнав. Лише підказка: «Взяти» ставить її в
       рядок, як вибір людини. Ключ — хеш ключа рядка (у Помічник не йдуть ні номер рахунку, ні референс банку). */
    const fnv = (s, h) => { for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); };
    const raKey = p => `b:${fnv(p.key, 2166136261)}${fnv(p.key, 374761393)}`;
    const raNeed = p => !p.block && !p.payRow && !p.taxKey && !p.rule.art && !p.hist;
    const raHint = p => S.ra.res[raKey(p)] || null;
    const raArt = (p, h) => { const k = h && h.a ? h.a.replace(':', '/') : ''; return ARTS.find(a => a.key === k && a.type === p.op) || null; };
    const raProj = h => (h && h.p ? projects.find(([n]) => n === h.p) || null : null);
    async function recAiAsk() {
      clearTimeout(S.ra.timer);
      const list = S.lastRecs.filter(p => raNeed(p) && S.hist.has(p.acc) && !S.rp.get(p.key).art);
      if (!opts.aiHints || !list.length) return;
      const sig = list.map(raKey).sort().join(',');
      S.ra.busy = true;
      S.ra.sig = sig;
      let j;
      try {
        j = await opts.aiHints({ records: list.map(p => ({ k: raKey(p), src: 'bank', date: p.date, type: p.op === 1 ? 'income' : 'expense', amount: p.amount,
          ccy: (p.bank && p.bank.ccy) || 'UAH', acc: nameOf(p.acc), cmt: p.comment, art: '', art_label: '', prj: '' })) });
      } catch (e) { j = null; }
      S.ra.busy = false;
      if (!j || S.ra.sig !== sig) return; // Помічник не відповів (тоді й підказок немає) чи набір уже інший
      const res = j.results || {}, fresh = Object.keys(res).filter(k => !S.ra.res[k]).length, was = S.ra.pending;
      Object.assign(S.ra.res, res);
      // ще думає — перепитати за будь-якого стану: запит, уже відправлений у Claude, доходить і після «ліміту на сьогодні» (Помічник
      // тоді знімає з черги решту, і pending сам стає 0). Довга черга (інша вкладка поставила сотні записів) — після 5 хв рідше, до години
      S.ra.pending = j.pending || 0;
      if (S.ra.pending) {
        const n = S.ra.polls++;
        if (n < 60) S.ra.timer = setTimeout(recAiAsk, 5000);
        else if (n < 170) S.ra.timer = setTimeout(recAiAsk, 30000);
        else S.ra.pending = 0; // годину без відповіді — не чекаємо (і не пишемо «підбирає»); нові операції спитають знову
      }
      if (fresh || was !== S.ra.pending) render();
    }
    // після кожного показу: нові операції без статті (історія рахунку вже прочитана) — спитати Помічник один раз
    function recAiEnsure() {
      if (!opts.aiHints || S.ra.busy) return;
      const list = S.lastRecs.filter(p => raNeed(p) && S.hist.has(p.acc) && !S.rp.get(p.key).art);
      const sig = list.map(raKey).sort().join(',');
      if (!list.length || sig === S.ra.sig) return;
      S.ra.polls = 0;
      setTimeout(recAiAsk, 0);
    }
    function recAiHtml(p, can) {
      if (!opts.aiHints || !raNeed(p)) return '';
      const h = raHint(p);
      if (!h) return S.ra.pending && S.ra.sig.split(',').includes(raKey(p)) ? '<div class="muted xwhy">ШІ підбирає статтю…</div>' : '';
      const art = raArt(p, h), pr = raProj(h);
      if (!art) return ''; // ШІ теж не визначив — без зайвого напису в кожному такому рядку
      return `<div class="xwhy" style="margin-top:4px"><span class="muted">ШІ (${esc(h.c || 'низька')}):</span> «${esc(art.label.split(' / ').slice(1).join(' / ') || art.label)}»${pr ? ` · ${esc(pr[0])}` : ''}${h.w ? `<span class="muted"> — ${esc(h.w)}</span>` : ''}${can ? ` <button class="quiet" data-rai="1" title="Поставити цю статтю${pr ? ' і проєкт' : ''} в рядок" style="height:24px;padding:0 8px;margin:0;font-size:12px">Взяти</button>` : ''}</div>`;
    }
    /* Та сама стаття — таким самим операціям (16.11.2026): 18 покупок одного сервісу з однієї картки — не 18 виборів. Лише пропозиція:
       після вибору статті в рядку з'являється кнопка «І для ще N таких самих»; вона ставить статтю в рядки без статті з тим самим
       рахунком, типом і контрагентом (покупка карткою — з тим самим сервісом). Галочок не ставить; зарплатну статтю не розносить. */
    const simKey = p => (Rc.cardTail(p.row.purpose) ? merchantOf(p.row.purpose) : clean(p.row.cpty)).toLowerCase();
    function recSame(p) {
      const k = simKey(p);
      if (k.length < 2) return [];
      return S.lastRecs.filter(q => q !== p && !q.block && !q.payRow && !q.taxKey && q.acc === p.acc && q.op === p.op && simKey(q) === k && !S.rp.get(q.key).ta && !S.rp.get(q.key).art);
    }
    // вибір статті в рядку (людиною); art '' — стаття знята
    function recPickArt(key, art) {
      const st = S.rp.get(key);
      if (!st) return;
      st.art = art; st.ta = true; st.sim = false;
      if (!art) st.on = false;
      S.rsim = art && !salaryArt(art) ? { key, art } : null;
      render();
    }
    // кнопка «І для ще N таких самих» у рядку key
    function recSpreadArt(key) {
      const p = S.lastRecs.find(x => x.key === key), art = S.rsim && S.rsim.key === key ? S.rsim.art : '';
      S.rsim = null;
      if (p && art && S.rp.get(key).art === art) for (const q of recSame(p)) Object.assign(S.rp.get(q.key), { art, ta: true, sim: true });
      render();
    }
    // на рахунку (у періоді й за 120 днів до нього) є записи з проєктом — тоді проєкт нового запису береться з них
    const projSeen = acc => [...(S.items.get(acc) || []), ...(S.hist.get(acc) || [])].some(c => c.proj && (c.opc === 1 || c.opc === 2));
    function recHtml(all) {
      // проєкт, якого людина не міняла, іде за записами рахунку й тоді, коли їх історію прочитано вже після першого показу
      // (раніше лишався «останній вибраний» з будь-якого іншого рядка — 16.11.2026); до recProposals — щоб і коментар картки був з ним
      for (const p of S.lastRecs) { const st = S.rp.get(p.key); if (st && !st.tp && !st.pm && !p.rule.proj && projSeen(p.acc)) st.proj = recProject(p.acc); }
      const props = S.lastRecs = recProposals(all);
      // нічого створювати — так і сказати (з виписками, що покривають період); перекази між своїми — у своєму списку
      const each = S.kind === 'credit' ? 'кожного надходження' : S.kind === 'debit' ? 'кожного списання' : 'кожної операції';
      if (!props.length) return S.kind !== 'own' && all.some(r => r.R.covered && r.status !== 'ccy')
        ? `<div class="card" data-b="recs"><div class="sub-h" style="margin:0"><h3>Операції банку, яких немає в CRM</h3><span class="pill st-ok">немає</span></div><div class="muted small" style="margin-top:6px">Для ${each} банку за період у CRM є запис${S.kind === 'all' && S.lastProps.length ? ' (крім переказів між своїми — їх список вище в цьому розділі)' : ''}. Створювати нічого.</div></div>` : '';
      const can = !!opts.applyAllowed, live = props.filter(p => !p.block), off = props.filter(p => p.block), nPay = live.filter(p => p.payRow).length;
      const on = live.filter(p => ready(p) && S.rp.get(p.key).on), nBulk = live.filter(bulkOk).length;
      const projOpt = sel => projects.map(([n, v]) => `<option value="${v}"${Number(v) === Number(sel) ? ' selected' : ''}>${esc(n)}</option>`).join('');
      const artOpt = (op, sel) => {
        const list = ARTS.filter(a => a.type === op), groups = [...new Set(list.map(a => a.group))];
        return `<option value="">— стаття —</option>${!sel || list.some(a => a.key === sel) ? '' : `<option value="${esc(sel)}" selected>${esc(artLabel(sel))}</option>`}` +
          groups.map(g => `<optgroup label="${esc(g)}">${list.filter(a => a.group === g).map(a => `<option value="${a.key}"${a.key === sel ? ' selected' : ''}>${esc(a.label.split(' / ').slice(1).join(' / '))}</option>`).join('')}</optgroup>`).join('');
      };
      const bankTxt = p => `${p.bank.bank === 'mono' ? 'Моно' : 'Приват'} ${dmy(p.row.date)}${p.row.time ? ' ' + p.row.time : ''}: ${p.row.cpty || '—'} · ${p.row.purpose || ''}`;
      let h = `<div class="card" data-b="recs"><div class="sub-h"><h3>Операції банку, яких немає в CRM</h3><span class="muted small">у виписці є, у CRM немає${live.length - nPay ? ` · внести можна: ${live.length - nPay}` : ''}${nPay ? ` · ЗП через транзитний рахунок: ${nPay}` : ''}${off.length ? ` · лінтер не вносить: ${off.length}` : ''}</span></div>
<details class="hint" style="margin:0 0 10px"><summary>Що створюється і звідки стаття</summary><div>У виписці операція є, а в CRM запису з такою сумою за період немає. Можна створити витрату чи надходження на рахунку CRM — той самий запит, що й у вашому реєстрі погоджень. Стаття — за правилами rules.json, інакше як у попередніх записах рахунку з цим контрагентом; без статті запис не створюється. Покупка корп. карткою отримує коментар, як їх пишуть у CRM: «Facebook 30.10 17:33 Ларіоненко Тимур (тест США): 5000.00 UAH, корп. картка 7850» — сервіс, дата покупки, маркетолог, мета, картка; доки ви коментар не змінили, він іде за вибраними маркетологом, статтею й проєктом. Зарплатну статтю (комісії відділу продажів, ЗП тощо) теж можна вибрати — але CRM не дасть потім такий запис ні змінити, ні видалити, тож вікно створення окремо про це попередить. ЗП через транзитний рахунок («Ціл-ві зарах.») — окремими рядками з пакетом Привату: у CRM ЗП зазвичай вносять по людях, тож вносьте її, лише якщо цієї ЗП у CRM ще немає. Нічого не позначено заздалегідь. Операції згруповано за рахунком CRM — натисніть рядок рахунку, щоб розгорнути чи згорнути.</div></details>`;
      // реєстр погоджень налаштовано, але ще не прочитано чи він не відповів: які операції мають погодження — не видно (огляд 16.11.2026)
      if (live.length && regCfg() && (S.wd.busy || S.wd.error || !S.wd.rows)) h += S.wd.error
        ? `<div class="warn" style="margin:0 0 8px">Реєстр погоджень не відповів (${esc(S.wd.error)}) — не видно, які з цих операцій мають погодження. Те, що має погодження, вносьте у вкладці «Погодження», інакше буде дубль; спробувати ще раз — «Звірити».</div>`
        : '<div class="info" style="margin:0 0 8px">Читаю реєстр погоджень… Поки він не прочитаний, створення вимкнено: частину цих операцій реєстр вносить сам (був би дубль).</div>';
      if (!live.length) h += '<div class="info" style="margin:0 0 8px">Створювати нічого: кожна операція банку без запису в CRM — з тих, які лінтер не вносить (причина — нижче).</div>';
      if (live.length) {
        // групи за рахунком CRM (live уже впорядковано за рахунком): за замовчуванням розгорнуто, якщо операцій небагато або рахунок один
        const nGr = new Set(live.map(p => p.acc)).size, isOpen = acc => (S.rg.has(acc) ? S.rg.get(acc) : live.length <= 25 || nGr === 1);
        h += `<div class="tbl" style="max-height:64vh"><table class="xf"><tr><th></th><th>Дата</th><th class="n">Сума</th><th>Стаття</th><th>Проєкт</th><th>Коментар у CRM</th><th>Операція банку</th></tr>`;
        let cur = null;
        for (const p of live) {
          if (p.acc !== cur) {
            cur = p.acc;
            const gr = live.filter(q => q.acc === cur), nOn = gr.filter(q => ready(q) && S.rp.get(q.key).on).length, sumG = gr.reduce((s, q) => s + (q.op === 1 ? q.amount : -q.amount), 0);
            h += `<tr class="rg${isOpen(cur) ? ' open' : ''}" data-rg="${cur}"><td colspan="7"><span class="tw">▸</span>${esc(nameOf(cur))}<span class="gs">${gr.length} ${plural(gr.length, 'операція', 'операції', 'операцій')} · ${sumG < 0 ? '−' : '+'}${esc(fmt(Math.abs(sumG)))}${nOn ? ` · позначено ${nOn}` : ''}</span>${can && nGr > 1 && gr.some(bulkOk) ? `<button class="quiet rgall" data-rgall="${cur}" title="Позначити на цьому рахунку всі витрати зі статтею — як кнопка внизу, але лише тут">позначити всі тут (${gr.filter(bulkOk).length})</button>` : ''}${can && nGr > 1 ? `<button class="quiet rgall" data-rgnone="${cur}"${nOn ? '' : ' hidden'}>зняти</button>` : ''}</td></tr>`;
          }
          const st = S.rp.get(p.key), iss = artIssue(st.art), ok = ready(p);
          const sib = st.sib && !st.ta && p.taxPeers && p.taxPeers.length ? `<div class="muted xwhy">як інші податки з тієї самої ЗП (${esc([...new Set(p.taxPeers.map(q => q.taxName))].join(', '))})</div>` : '';
          const why = !st.art ? `<div class="bad" style="font-weight:400">виберіть статтю${(p.payRow || p.taxKey) && p.payArts && p.payArts.length ? `</div><div class="muted xwhy">ЗП${p.taxKey ? ' й податки з неї' : ''} на цьому рахунку записано як: ${esc(p.payArts.map(a => `«${artLabel(a.art).split(' / ').slice(1).join(' / ') || artLabel(a.art)}» (${a.n})`).join(', '))}` : ''}</div>${recAiHtml(p, can)}`
            : iss === 'salary' ? `<div class="warn" style="margin:4px 0 0;padding:4px 8px;font-weight:400">${esc(ISSUE.salary)}</div>${sib}`
            : sib ? sib
            : st.sim ? '<div class="muted xwhy">та сама стаття, що ви вибрали для такої самої операції</div>'
            : st.ta ? (raNeed(p) && raArt(p, raHint(p)) && raArt(p, raHint(p)).key === st.art ? '<div class="muted xwhy">за підказкою ШІ</div>' : '')
            : p.rule.art && st.art === p.rule.art.art ? `<div class="muted xwhy">${esc(p.rule.art.why)}${p.rule.art.sure ? '' : ' — перевірте'}</div>`
            : p.hist && st.art === p.hist.art ? `<div class="muted xwhy">як у попередніх записах рахунку (${p.hist.n}), напр. ID ${p.hist.ex.id}: «${esc(clean(p.hist.ex.comment).slice(0, 60))}»</div>` : '';
          const warns = p.rule.reasons.concat(p.sub && !p.sub.sure ? [`сума як у тарифі підписки юриста (${p.sub.plan}, ${p.sub.months} міс.), але призначення не про програмний продукт: якщо це підписка — виберіть статтю «Підписки юристів»; оплату клієнта вносять через замовлення (лід)`]
            : p.sub ? [`схоже на підписку юриста (${p.sub.plan}, ${p.sub.months} міс.): замовлення в CRM для неї не потрібне. Якщо на цю суму на рахунку є замовлення без оплати — це оплата замовлення, вносьте її через лід`]
            : p.op === 1 && !p.payRow ? ['оплату клієнта вносять через замовлення (лід) — тут створюйте лише інші надходження: повернення, відсотки тощо'] : [],
            p.ownCard ? [`${p.ownCard}: у CRM це витрата за тим, на що пішли гроші (комісії відділу продажів, ЗП тощо), — виберіть статтю`] : [],
            p.payroll ? [p.payroll] : [],
            p.aiNote ? [p.aiNote] : [],
            p.taxKey && p.taxPeers && p.taxPeers.length ? [`податок із ЗП: у CRM податки розносили по людях зі статтями відділів, тож статтю лінтер не вгадує; вибрана для одного податку цієї ЗП ставиться й іншим (${[...new Set(p.taxPeers.map(q => q.taxName))].join(', ')} того самого дня)`] : [],
            p.payRow ? [`ЗП одним переказом на «${clean(p.row.cpty) || 'транзитний рахунок'}»${p.packet && p.packet.cards ? ` (у пакеті ${p.packet.cards} ${plural(p.packet.cards, 'картка', 'картки', 'карток')})` : ''}. У CRM ЗП вносять по людях; записів ЗП без пари в банку на рахунку за період: ${p.payCtx.n ? `${p.payCtx.n} на ${fmt(p.payCtx.sum)}` : 'немає'}. Вносьте, лише якщо цієї ЗП у CRM ще немає; ім'я — на початку коментаря.`] : []);
          const nSame = can && S.rsim && S.rsim.key === p.key && S.rsim.art === st.art ? recSame(p).length : 0;
          const same = nSame ? `<div style="margin-top:4px"><button class="quiet" data-rsame="1" title="Поставити цю статтю ще в ${nSame} ${plural(nSame, 'рядок', 'рядки', 'рядків')} без статті на цьому рахунку з тим самим контрагентом («${esc(simKey(p))}»). Галочки не ставляться." style="height:24px;padding:0 8px;margin:0;font-size:12px">І для ще ${nSame} таких самих</button></div>` : '';
          const projWhy = !st.tp && !st.pm && !p.rule.proj && !projSeen(p.acc) && projects.length > 1 ? '<div class="muted xwhy">на рахунку ще немає записів з проєктом — перевірте проєкт</div>' : '';
          h += `<tr data-rk="${esc(p.key)}" data-rgrow="${p.acc}"${isOpen(p.acc) ? '' : ' class="shut"'}><td><input type="checkbox" data-ron${st.on && ok ? ' checked' : ''}${can && ok ? '' : ' disabled'}></td><td style="white-space:nowrap">${esc(dmy(p.date))}${p.buy ? `<div class="muted" style="font-size:12px" title="Банк провів покупку ${esc(dmy(p.date))}; у CRM покупки карткою — за датою покупки">у CRM — ${esc(dmy(p.buy))}</div>` : ''}</td>
<td class="n"><span class="${p.op === 1 ? 'ok' : 'bad'}">${p.op === 1 ? '+' : '−'}${esc(fmt(p.amount))}</span><div class="muted" style="font-weight:400;font-size:12px">${esc(SRC[p.src])}</div></td>
<td><select data-rart style="max-width:230px"${can ? '' : ' disabled'}>${artOpt(p.op, st.art)}</select>${why}${iss === 'marketer' ? mkHtml(p, st, can) : ''}${same}</td>
<td><select data-rproj${can ? '' : ' disabled'}>${projOpt(st.proj)}</select>${!st.tp && p.rule.proj && Number(st.proj) === Number(p.rule.proj.id) ? `<div class="muted xwhy">${esc(p.rule.proj.why)}</div>` : !st.tp && p.projMk && Number(st.proj) === Number(p.projMk.id) ? `<div class="muted xwhy">${esc(p.projMk.why)}</div>`
  : !st.tp && p.projHist && Number(st.proj) === Number(p.projHist.id) ? `<div class="muted xwhy">${esc(p.projHist.why)}</div>` : projWhy}</td>
<td><textarea class="xcom" data-rcom rows="${comRows(st.comment)}"${can ? '' : ' disabled'}>${esc(st.comment)}</textarea></td>
<td class="muted xwhy">${esc(bankTxt(p))}${p.acc !== p.bankAcc ? `<div>покупка карткою з рахунку «${esc(nameOf(p.bankAcc))}»</div>` : ''}${warns.length ? `<div class="warn" style="margin:4px 0 0;padding:4px 8px">${warns.map(esc).join('<br>')}</div>` : ''}</td></tr>`;
        }
        h += `</table></div><div class="row" style="margin-top:8px"><button class="primary" data-b="rcreate"${can && on.length && !S.busy ? '' : ' disabled'}>Створити позначені (${on.length})</button>
${can ? `${nBulk ? `<button class="quiet" data-b="rall">Позначити всі витрати зі статтею (${nBulk})</button>` : ''}<button class="quiet" data-b="rnone">Зняти позначки</button>` : ''}
<span class="muted small">${can ? 'Уперше створіть один запис і перевірте його в CRM — потім решту. Надходження позначайте по одному.' : 'Створювати записи можна в закладці «Лінтер кешфлоу (APPLY)»; тут — лише перегляд.'}</span></div>`;
      }
      if (off.length) h += `<details style="margin-top:10px"><summary>Ще ${off.length} ${plural(off.length, 'операція без запису в CRM, яку', 'операції без запису в CRM, які', 'операцій без запису в CRM, які')} лінтер не створює</summary><div style="margin-top:6px">${off.map(p => `<div class="pr">${esc(dmy(p.date))} <b>${p.op === 1 ? '+' : '−'}${esc(fmt(p.amount))}</b> · «${esc(nameOf(p.acc))}» · ${esc(p.row.cpty || '—')} · ${esc(p.row.purpose || '')}<div class="muted">${esc(p.block)}</div></div>`).join('')}</div></details>`;
      return h + '</div>';
    }
    // ---------- операції з виписок поза звіркою: службові й незіставлені рахунки, не проведені банком ----------
    /* Щоб нічого з виписки не губилось мовчки: операції періоду на рахунках банку без рахунку CRM (службові, технічні, ще один рахунок,
       «не звіряти», не зіставлені) і не проведені банком (Приват, PR_PR ≠ «r») — з причиною. Той самий рахунок з кількох файлів — один
       (файл, що покриває період, інакше найновіший). Лише довідка. → [{b, why, list: [{x, why}]}] */
    function outsideList() {
      const { from, to } = S, inP = x => !!x.date && x.date >= from && x.date <= to, keyOf = b => b.iban || `${b.fileName}|${b.owner}`;
      const out = [], seen = new Set();
      for (const b0 of S.banks) {
        const k = keyOf(b0);
        if (seen.has(k)) continue;
        seen.add(k);
        // як у bankFor: рівно — пізніше завантажений файл
        const b = S.banks.filter(x => keyOf(x) === k).reduce((cur, x) => (laterBank(x, cur, from, to) ? x : cur), null);
        const why = b.cfId ? '' : b.note || 'рахунок банку не зіставлено з рахунком CRM';
        // рахунок з CRM, але частину руху за правилом компанії в CRM не вносять (кошти броніків) — теж тут, з причиною
        const r = b.cfId ? (S.lastAll || []).find(r => r.b === b && (r.R.ruled || []).length) : null;
        const list = (b.cfId ? (r ? r.R.ruled.map(o => ({ x: o.row, why: o.why })) : []) : b.rows.filter(inP).map(x => ({ x, why }))).concat((b.skipped || []).filter(inP).map(x => ({ x, why: x.why })));
        if (list.length) out.push({ b, why: r ? 'кошти броніків (rules.json → bronik_accounts): у CRM не вносяться, дохід — «1.5% від бронювання»' : why, list: list.sort((p, q) => (p.x.date + (p.x.time || '') < q.x.date + (q.x.time || '') ? -1 : 1)) });
      }
      return out;
    }
    function outsideHtml() {
      const groups = outsideList();
      if (!groups.length) return '';
      const n = groups.reduce((s, g) => s + g.list.length, 0);
      let h = `<div class="card" data-b="outside"><details${S.outOpen ? ' open' : ''}><summary><b>Операції з виписок поза звіркою: ${n}</b> <span class="muted small" style="font-weight:400">— службові й незіставлені рахунки, не проведені банком, кошти броніків · лише довідка</span></summary>
<div class="muted small" style="margin:8px 0 4px">Ці операції є у виписках за період, але з CRM не звіряються. Службовий рахунок (масові виплати, РКО, ЗП, цільові зарахування) і технічний рахунок банку в CRM не потрібні — гроші з них ідуть на поточний рахунок чи виплати, які звіряються там. Рахунок, не зіставлений з CRM, звірятиметься, щойно ви виберете йому рахунок CRM у «Рахунки з виписок → рахунки CRM» вище. Операцію, яку банк не провів, звіряти нічим. Кошти броніків (їхні надходження, ЗП і податки за них) за правилом компанії в CRM не вносяться — дохід компанії записується окремо, «1.5% від бронювання».</div>`;
      for (const g of groups) {
        const sum = g.list.reduce((s, o) => s + o.x.amount, 0);
        h += `<div class="lbl" style="margin:12px 0 4px">${g.b.bank === 'mono' ? 'Моно' : 'Приват'} ${esc(tail(g.b.iban))} · ${esc(g.b.owner || g.b.client || '')} · ${g.list.length} ${plural(g.list.length, 'операція', 'операції', 'операцій')} · ${sum < 0 ? '−' : '+'}${esc(fmt(Math.abs(sum)))}${g.why ? `<div style="font-weight:400">${esc(g.why)}</div>` : ''}</div>
<table class="amts"><tr><th>Дата</th><th class="n">Сума</th><th>Контрагент · призначення</th>${g.list.some(o => o.why !== g.why) ? '<th>Чому поза звіркою</th>' : ''}</tr>${g.list.map(o => `<tr><td style="white-space:nowrap">${esc(dmy(o.x.date))}${o.x.time ? ' ' + esc(o.x.time) : ''}</td><td class="n">${esc(fmt(o.x.amount))}</td><td>${esc(o.x.cpty || '—')}${o.x.purpose ? ' · ' + esc(o.x.purpose) : ''}</td>${g.list.some(q => q.why !== g.why) ? `<td class="muted">${esc(o.why)}</td>` : ''}</tr>`).join('')}</table>`;
      }
      return h + '</details></div>';
    }
    // маркетолог для статті з рекламним бюджетом: список — з CRM, за замовчуванням — як у попередніх записах рахунку
    function mkHtml(p, st, can) {
      const bad = t => `<div class="bad" style="font-weight:400">${esc(t)}</div>`;
      if (p.op !== 2) return bad('стаття з маркетологом — лише для витрат');
      if (!S.mks) return '<div class="muted xwhy">читаю список маркетологів…</div>';
      const list = S.mks.slice();
      for (const id of [st.mk, p.mk && p.mk.id]) if (id && !list.some(m => m.id === id)) list.unshift({ id, name: mkName(id) }); // список не прочитано — з попередніх записів
      if (!list.length) return bad('не вдалося прочитати список маркетологів — внесіть запис через реєстр погоджень');
      return `<select data-rmk style="max-width:230px;margin-top:4px"${can ? '' : ' disabled'}><option value="">— маркетолог —</option>${list.map(m => `<option value="${m.id}"${m.id === st.mk ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` +
        (!st.mk ? bad('виберіть маркетолога: стаття з рекламним бюджетом') : !st.tm && p.mk && st.mk === p.mk.id ? `<div class="muted xwhy">${p.mk.cpty ? `маркетолог — за контрагентом «${esc(p.mk.cpty)}» (rules.json)` : p.mk.holder ? `маркетолог — хто тримає картку${p.mk.from ? ` з ${esc(dmy(p.mk.from))}` : ''} (довідник карток у rules.json)` : `маркетолог — як у найближчих схожих записах рахунку (${p.mk.n})`}</div>` : '');
    }
    function bindRecs() {
      const box = $('out'), keyOf = e => e.closest('[data-rk]').dataset.rk, q = k => box.querySelector(`[data-b="${k}"]`);
      // галочка — лише лічильники (кнопка й «позначено N» у рядку рахунку), без перемальовування
      const upd = () => {
        const live = S.lastRecs.filter(p => !p.block), on = p => ready(p) && S.rp.get(p.key).on, b = q('rcreate'), n = live.filter(on).length;
        if (b) { b.textContent = `Створити позначені (${n})`; b.disabled = !(opts.applyAllowed && n && !S.busy); }
        box.querySelectorAll('tr.rg[data-rg]').forEach(tr => {
          const acc = Number(tr.dataset.rg), k = live.filter(p => p.acc === acc && on(p)).length, gs = tr.querySelector('.gs');
          if (gs) gs.textContent = gs.textContent.replace(/ · позначено \d+$/, '') + (k ? ` · позначено ${k}` : '');
          const no = tr.querySelector('[data-rgnone]');
          if (no) no.hidden = !k;
        });
      };
      box.querySelectorAll('[data-ron]').forEach(e => e.onchange = () => { S.rp.get(keyOf(e)).on = e.checked; upd(); });
      box.querySelectorAll('[data-rart]').forEach(e => e.onchange = () => recPickArt(keyOf(e), e.value));
      box.querySelectorAll('[data-rsame]').forEach(e => e.onclick = () => recSpreadArt(keyOf(e)));
      // підказка ШІ: стаття (і проєкт, якщо ШІ його назвав) — як вибір людини
      box.querySelectorAll('[data-rai]').forEach(e => e.onclick = () => {
        const p = S.lastRecs.find(x => x.key === keyOf(e)), h = p && raHint(p), art = p && raArt(p, h), pr = raProj(h);
        if (!art) return;
        const st = S.rp.get(p.key);
        st.art = art.key; st.ta = true;
        if (pr) { st.proj = +pr[1]; st.tp = true; }
        render();
      });
      box.querySelectorAll('[data-rmk]').forEach(e => e.onchange = () => { const st = S.rp.get(keyOf(e)); st.mk = Number(e.value) || null; st.tm = true; if (!st.mk) st.on = false; render(); });
      box.querySelectorAll('[data-rproj]').forEach(e => e.onchange = () => { const st = S.rp.get(keyOf(e)); st.proj = +e.value; st.tp = true; LS.set('cfl_rec_proj', +e.value); });
      // коментар, змінений людиною, більше не підлаштовується (покупка карткою: за маркетологом, статтею й проєктом); порожній — знову автоматичний
      box.querySelectorAll('[data-rcom]').forEach(e => { comField(e); e.onchange = () => { const st = S.rp.get(keyOf(e)); st.comment = oneLine(e.value); st.tc = !!st.comment; if (!st.tc) render(); }; });
      // рядок рахунку — розгорнути / згорнути його операції (без перемальовування)
      box.querySelectorAll('tr.rg[data-rg]').forEach(e => e.onclick = () => {
        const acc = Number(e.dataset.rg), open = !e.classList.contains('open');
        S.rg.set(acc, open);
        e.classList.toggle('open', open);
        box.querySelectorAll(`tr[data-rgrow="${acc}"]`).forEach(t => t.classList.toggle('shut', !open));
      });
      // «позначити всі тут» у рядку рахунку — те саме, що кнопка внизу, але лише для цього рахунку (16.11.2026); рядок при цьому не згортається
      box.querySelectorAll('[data-rgall]').forEach(e => e.onclick = ev => { ev.stopPropagation(); const acc = Number(e.dataset.rgall); S.lastRecs.filter(p => p.acc === acc && bulkOk(p)).forEach(p => { S.rp.get(p.key).on = true; }); S.rg.set(acc, true); render(); });
      box.querySelectorAll('[data-rgnone]').forEach(e => e.onclick = ev => { ev.stopPropagation(); const acc = Number(e.dataset.rgnone); S.lastRecs.filter(p => p.acc === acc).forEach(p => { S.rp.get(p.key).on = false; }); render(); });
      if (q('rall')) q('rall').onclick = () => { S.lastRecs.filter(bulkOk).forEach(p => { S.rp.get(p.key).on = true; S.rg.set(p.acc, true); }); render(); };
      if (q('rnone')) q('rnone').onclick = () => { S.lastRecs.forEach(p => { S.rp.get(p.key).on = false; }); render(); };
      if (q('rcreate')) q('rcreate').onclick = () => (regCfg() && !S.wd.error && (S.wd.busy || !S.wd.rows)
        ? note('Реєстр погоджень ще читається — зачекайте кілька секунд і натисніть «Створити позначені» ще раз: поки його не прочитано, не видно, які операції мають погодження.', 'warn')
        : createMany(S.lastRecs.filter(p => ready(p) && S.rp.get(p.key).on), REC));
    }

