/* =====================================================================
   Лінтер кешфлоу: читання записів, перевірка правилами, звіт,
   застосування змін (резервна копія → підтвердження → по одному запису
   з перечитуванням → журнал) і відкат з резервної копії.
   Доступ до сайту — через адаптер api, тому той самий код працює
   у букмарклеті (fetch з токеном), у «Помічнику кешфлоу» (через локальний
   сервер) і в тестах (мок API).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules-engine.js'), require('./crm-model.js'));
  else root.CFLinter = factory(root.CFRules, root.CFModel);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (R, M) {
  'use strict';
  const S = R.STATUS;
  const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

  /* rawFetch(method, path, body) → {status, json, text, retryAfter}
     Не частіше 1 запиту на minInterval мс; HTTP 429 — пауза й повтор (ТЗ, розділ 3). */
  function makeApi(rawFetch, o) {
    o = o || {};
    const minInterval = o.minInterval == null ? 300 : o.minInterval, maxRetries = o.maxRetries == null ? 6 : o.maxRetries;
    const sleep = o.sleep || defaultSleep, now = o.now || (() => Date.now());
    let last = -Infinity, calls = 0, retries429 = 0;
    async function call(method, path, body) {
      for (let attempt = 1, blips = 0; ; attempt++) {
        // місце в черзі бронюється до паузи: кілька одночасних викликів не стартують разом
        const at = Math.max(now(), last + minInterval);
        last = at;
        if (at > now()) await sleep(at - now());
        calls++;
        let r;
        try { r = await rawFetch(method, path, body); }
        catch (e) {
          // збій мережі: читання повторюємо (1, 3, 8 с), запис — ні (повтор POST міг би створити дубль)
          if (method === 'GET' && blips < 3) { await sleep([1000, 3000, 8000][blips++]); continue; }
          throw e;
        }
        if (method === 'GET' && [500, 502, 503, 504].includes(r.status) && blips < 3) { await sleep([1000, 3000, 8000][blips++]); continue; }
        if (r.status === 429 && attempt <= maxRetries) {
          retries429++;
          if (o.log) o.log(`HTTP 429 на ${method} ${path} — пауза й повтор (${attempt}/${maxRetries})`);
          await sleep(r.retryAfter ? Math.min(Number(r.retryAfter), 30) * 1000 : 2000 * attempt);
          continue;
        }
        return r;
      }
    }
    async function get(path) {
      const r = await call('GET', path);
      if (r.status !== 200) { const e = new Error(`GET ${path}: HTTP ${r.status}`); e.status = r.status; throw e; }
      return r.json;
    }
    return { call, get, put: (path, body) => call('PUT', path, body), post: (path, body) => call('POST', path, body), stats: () => ({ calls, retries429 }) };
  }

  const pad = n => String(n).padStart(2, '0');
  const iso2dash = iso => iso.split('-').reverse().join('-'); // РРРР-ММ-ДД → ДД-ММ-РРРР (формат фільтра сайту)
  const listOf = j => Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);

  function createLinter(opts) {
    const api = opts.api, rulesDoc = opts.rulesDoc;
    const log = opts.log || (() => {}), progress = opts.onProgress || (() => {});
    const compiled = R.compileRules(rulesDoc);
    // межа роботи (rules.json → fix_from): раніші записи лише показуються, змін для них немає.
    // opts.ignoreFixFrom — лише для аналізу (регресія): впливає на звіт, але не на planChanges / apply.
    const fixFrom = compiled.fixFrom;
    // До межі — і запис з датою в межах роботи, але з періодом старого місяця (01–05.09.2026 з періодом 08.2026 — за правилом
    // «з 1 по 5 число — попередній місяць», що діяло до 07.11.2026): його зміна рухала б P&L місяця, який не виправляємо (16.11.2026)
    const oldPeriod = rec => !!(fixFrom && rec && rec.period && String(rec.period).slice(0, 7) < fixFrom.slice(0, 7));
    const beforeFloor = rec => !!(fixFrom && rec && ((rec.date && rec.date < fixFrom) || oldPeriod(rec)));
    const floorWhy = rec => (rec.date && rec.date < fixFrom ? `запис до ${dmy(fixFrom)}` : `період ${M.monthUa(rec.period)} — до ${dmy(fixFrom)}`);
    // закриті місяці CRM (P&L → «Закриття періоду», змінює лише Адмін): opts.closedThrough() → «РРРР-ММ» включно або null.
    // Запис закритого місяця (за періодом, як перевіряє CRM) — лише довідка; opts.onClosed(«РРРР-ММ») — CRM відмовив через закритий місяць
    const closedTo = () => (typeof opts.closedThrough === 'function' ? opts.closedThrough() : null);
    const inClosed = rec => !!(rec && rec.period && M.isClosedMonth(rec.period, closedTo()));
    let live = null;

    async function loadReference() {
      const cats = listOf(await api.get('pnl/category?include_archived=1'));
      const ops = listOf(await api.get('pnl/operation/'));
      const accounts = listOf(await api.get('invoice?get_all=1'));
      const currencies = listOf(await api.get('currency'));
      let config = null, salaryOps = null;
      try { config = await api.get('pnl/operation-config'); } catch (e) { log('pnl/operation-config недоступний: ' + e.message); }
      const salCat = config && config.salary && config.salary.category_id;
      if (salCat) {
        try {
          const j = await api.get(`pnl/category/${salCat}`);
          salaryOps = (((j && j.data) || j || {}).operations || []).map(o => o.id);
        } catch (e) { log('зарплатні статті не завантажено, беру знімок 24.10.2026: ' + e.message); }
      }
      live = M.buildLiveRef({ cats, ops, accounts, currencies, config, salaryOps });
      live.accounts = accounts;
      const problems = M.checkArticles(rulesDoc, live);
      return { live, problems };
    }

    /* Записи за період [from, to] (РРРР-ММ-ДД, включно), опційно лише рахунки accountIds. */
    async function fetchRecords(from, to, accountIds) {
      const base = `invoice-payment?date_from=${iso2dash(from)}&date_to=${iso2dash(to)}&per_page=${opts.perPage || 500}` +
        (accountIds && accountIds.length ? accountIds.map(id => `&invoice_ids[]=${id}`).join('') : '');
      const out = [], seen = new Set();
      let total = null;
      for (let p = 1; p <= 1000; p++) {
        const j = await api.get(`${base}&page=${p}`);
        total = j.total != null ? j.total : total;
        for (const r of j.data || []) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
        progress({ stage: 'read', got: out.length, total, page: p, lastPage: j.last_page });
        if (!j.last_page || p >= j.last_page) break;
      }
      return out;
    }

    function evaluateAll(raws, ruleIds) {
      const ctx = { ruleIds: ruleIds && ruleIds.length ? new Set(ruleIds) : null, salaryOps: live && live.salaryOps, marketerArts: live && live.marketerArts };
      const results = [], rest = [];
      let inPeriod = 0;
      for (const raw of raws) {
        if (raw.deleted_at) continue;
        inPeriod++;
        const rec = M.normalizeRecord(raw, live);
        const res = R.evaluate(rec, compiled, ctx);
        if (res) {
          if (!opts.ignoreFixFrom && beforeFloor(rec)) freeze(res, `${floorWhy(rec)} — межа роботи лінтера: лише довідка, не змінюється`);
          else if (!opts.ignoreFixFrom && inClosed(rec)) freeze(res, `місяць ${M.monthUa(rec.period)} закрито в CRM — лише довідка, не змінюється`);
          res.raw = raw; results.push(res);
        // жодне правило не спрацювало — для «Підказок з історії»: витрата чи дохід зі статтею, не лід / авто / ЗП, одна оплата, у межах роботи
        } else if ((rec.type === 'income' || rec.type === 'expense') && rec.category_id && !rec.is_lead && !rec.is_auto && !rec.is_salary &&
          rec.n_payments === 1 && !beforeFloor(rec) && !inClosed(rec)) rest.push(rec);
      }
      return { results, checked: inPeriod, rest };
    }

    async function run(params) {
      if (compiled.errors.length) throw new Error('Помилки у rules.json:\n' + compiled.errors.join('\n'));
      if (!live) {
        const { problems } = await loadReference();
        if (problems.length) throw new Error('Довідник статей у CRM не збігається з rules.json:\n' + problems.join('\n'));
      }
      const raws = await fetchRecords(params.from, params.to, params.accountIds);
      const { results, checked, rest } = evaluateAll(raws, params.ruleIds);
      return { params, results, checked, rest, fetched: raws.length, rulesVersion: compiled.version, at: new Date().toISOString() };
    }

    /* Що змінювати: id → зміни (лише стаття/проєкт). selection — Set id записів;
       review-рядки — лише ті, що позначені окремо (ТЗ, розділ 6). manual — ручні правки користувача.
       fieldsById (необов'язково) — Map id → Set полів: з запису беруться лише вибрані зміни (напр. лише проєкт). */
    function planChanges(results, selection, manual, fieldsById) {
      const plan = [];
      for (const res of results) {
        const id = res.record.id;
        if (beforeFloor(res.record) || inClosed(res.record)) continue; // до межі fix_from і закриті місяці — нічого, навіть ручні правки
        const own = manual && manual[id];
        if (own) {
          const rc = res.record;
          if (rc.is_lead || rc.is_auto || rc.is_salary || (rc.type !== 'income' && rc.type !== 'expense') || rc.n_payments > 1) continue;
          // узята «Підказка ШІ» — так і в журналі (людина вибрала її сама, як ручну правку)
          plan.push({ id, changes: own, ruleIds: [own.some(c => c.via === 'ai') ? 'ПІДКАЗКА ШІ' : 'РУЧНА ПРАВКА'], status: 'manual-edit', record: res.record });
          continue;
        }
        if (!selection || !selection.has(id)) continue;
        if (res.status !== S.FIX && res.status !== S.REVIEW) continue;
        const want = fieldsById && fieldsById.get(id);
        const ch = res.changes.filter(c => (res.status === S.REVIEW || c.auto) && (!want || want.has(c.field)));
        if (!ch.length) continue;
        // правила, що задають вибрані зміни (без перекритих і тих, що вже «ok»)
        const drivers = res.applicable.filter(r => (res.perRule[r.id] === S.FIX || res.perRule[r.id] === S.REVIEW) && ch.some(c => r.set[c.field] !== undefined)).map(r => r.id);
        plan.push({ id, changes: ch, ruleIds: drivers.length ? drivers : res.applicable.map(r => r.id), status: res.status, record: res.record });
      }
      return plan.map(p => ({ ...p, body: M.buildUpdate(p.changes) }));
    }

    function describePlan(plan) {
      const byRule = {};
      for (const p of plan) for (const r of p.ruleIds) byRule[r] = (byRule[r] || 0) + 1;
      const first = plan[0];
      return {
        count: plan.length, byRule,
        sample: first ? { method: 'PUT', url: `/api/invoice-payment/${first.id}`, body: first.body } : null,
      };
    }

    // чи дає правило ту саму зміну на свіжих даних (ручні правки не перевіряються — їх задала людина)
    const changeKey = c => c.field === 'category' ? c.to.category_id + '/' + c.to.operation_id : String(c.to);
    function stillPlanned(p, nb) {
      if (p.status === 'manual-edit') return true;
      const res = R.evaluate(nb, compiled, { salaryOps: live && live.salaryOps, marketerArts: live && live.marketerArts });
      return !!res && p.changes.every(c => res.changes.some(x => x.field === c.field && changeKey(x) === changeKey(c)));
    }

    /* Застосування. hooks: confirm(info) → bool; saveBackup(obj) — після підтвердження, до першої зміни
       (скасування не лишає резервної копії); onApplied(id, backup) — запис справді змінено (backup.applied);
       onItem(entry, i, n); saveJournal(entries). */
    async function apply(plan, hooks) {
      hooks = hooks || {};
      if (!plan.length) return { journal: [], cancelled: false };
      // 1) свіжий повний вміст кожного запису для резервної копії; запис, який не вдалося прочитати, не змінюється
      const fresh = {}, unread = {};
      for (let i = 0; i < plan.length; i++) {
        try { fresh[plan[i].id] = await api.get(`invoice-payment/${plan[i].id}`).then(j => j.data || j); }
        catch (e) { unread[plan[i].id] = e.message; }
        progress({ stage: 'backup', done: i + 1, total: plan.length });
      }
      const todo = plan.filter(p => fresh[p.id]);
      // 2) підтвердження
      const info = describePlan(todo);
      info.unread = plan.length - todo.length;
      if (hooks.confirm && !(await hooks.confirm(info))) return { journal: [], cancelled: true };
      // 3) резервна копія — до першої зміни
      const backup = {
        kind: 'cashflow-linter-backup', created_at: new Date().toISOString(), rules_version: compiled.version,
        records: todo.map(p => fresh[p.id]),
        changes: Object.fromEntries(todo.map(p => [p.id, { fields: p.changes.map(c => c.field), body: p.body, rules: p.ruleIds }])),
      };
      if (todo.length && hooks.saveBackup) await hooks.saveBackup(backup);
      backup.applied = []; // які записи лінтер справді змінив (у файлі копії цього поля немає: файл пишеться до змін)
      // 4) по одному запису: перечитати → перевірити → PUT → перечитати
      const journal = plan.filter(p => unread[p.id]).map(p => ({ time: new Date().toISOString(), id: p.id, rules: p.ruleIds.join(', '), body: p.body, before: null, after: null,
        result: 'error', http: null, problems: ['не вдалося прочитати запис для резервної копії — не змінювався: ' + unread[p.id]] }));
      let noRights = false; // CRM відмовив у правах (403) — решта запитів відмовила б так само, їх не надсилаємо
      for (let i = 0; i < todo.length; i++) {
        const p = todo[i];
        const entry = { time: new Date().toISOString(), id: p.id, rules: p.ruleIds.join(', '), body: p.body, before: snapshot(fresh[p.id]), after: null, result: '', http: null, problems: [] };
        try {
          if (noRights) { entry.result = 'skipped-rights'; entry.problems.push('не надсилалось: CRM відмовив у правах на попередньому записі'); continue; }
          // безпосередньо перед зміною: поки було відкрите вікно підтвердження, запис могли змінити
          const before = await api.get(`invoice-payment/${p.id}`).then(j => j.data || j);
          entry.before = snapshot(before);
          const nb = M.normalizeRecord(before, live);
          const drift = p.changes.filter(c => !sameCurrent(c, p.record, nb));
          if (drift.length) { entry.result = 'skipped-changed'; entry.problems.push('запис змінився після звіту — пропущено'); }
          else if (beforeFloor(nb)) { entry.result = 'skipped-locked'; entry.problems.push(`${floorWhy(nb)} — межа роботи лінтера, не змінюється`); }
          else if (inClosed(nb)) { entry.result = 'skipped-closed'; entry.problems.push(`місяць ${M.monthUa(nb.period)} закрито в CRM — запит не надсилався`); }
          else if (nb.is_lead || nb.is_auto) { entry.result = 'skipped-locked'; entry.problems.push('запис з ліда / автоматичний'); }
          else if (nb.is_salary) { entry.result = 'manual-422'; entry.problems.push('зарплатна операція — API не змінює, змінити вручну (запит не надсилався)'); }
          else if (!stillPlanned(p, nb)) { entry.result = 'skipped-changed'; entry.problems.push('за свіжими даними правило вже не дає цієї зміни — пропущено'); }
          else {
            const r = await api.put(`invoice-payment/${p.id}`, p.body);
            entry.http = r.status;
            if (r.status < 200 || r.status >= 300) noRights = refused(entry, r, nb) === 'rights';
            else {
              backup.applied.push(p.id);
              if (hooks.onApplied) await hooks.onApplied(p.id, backup);
              const after = await api.get(`invoice-payment/${p.id}`).then(j => j.data || j);
              entry.after = snapshot(after);
              const v = M.verifyUpdate(before, after, p.body);
              entry.result = v.ok ? 'ok' : 'verify-failed';
              entry.problems.push(...v.problems);
            }
          }
        } catch (e) { entry.result = 'error'; entry.problems.push(e.message); }
        finally {
          journal.push(entry);
          if (hooks.onItem) hooks.onItem(entry, i + 1, todo.length);
          progress({ stage: 'apply', done: i + 1, total: todo.length });
        }
      }
      if (hooks.saveJournal) await hooks.saveJournal(journal);
      return { journal, cancelled: false, backup };
    }
    /* CRM не прийняв PUT: результат і причина — у журнал (текст відповіді сервера, а не лише код). → kind з M.crmFailure.
       Закритий місяць — ще й opts.onClosed(період запису rec): далі цей і раніші місяці не перевіряються й запити не надсилаються. */
    function refused(entry, r, rec) {
      const f = M.crmFailure(r);
      if (f.kind === 'closed' && opts.onClosed && rec && M.monthOf(rec.period)) opts.onClosed(M.monthOf(rec.period));
      if (f.kind === 'closed') entry.result = 'closed-period';
      else if (f.kind === 'rights') entry.result = 'no-rights';
      else entry.result = r.status === 422 ? 'manual-422' : 'error';
      entry.problems.push(f.kind === 'closed' || f.kind === 'rights' ? M.crmError(r, 'put').message
        : r.status === 422 ? 'API відмовив (422) — змінити вручну' + (f.message ? ': ' + f.message : '') : `HTTP ${r.status}` + (f.message ? ': ' + f.message : ''));
      return f.kind;
    }

    /* Відкат: повернути статтю/проєкт із резервної копії для записів, які змінював лінтер.
       backup.applied (копія з браузера) — точний список змінених; у файлі його немає, тоді пропускаються
       записи, де в копії вже ті самі значення, що й після лінтера (лінтер їх не змінював). */
    async function rollback(backup, hooks) {
      hooks = hooks || {};
      if (!backup || backup.kind !== 'cashflow-linter-backup') throw new Error('це не резервна копія лінтера');
      // ID з файлу йде в адресу запиту: лише додатні цілі числа (файл могли підмінити)
      if (!Array.isArray(backup.records) || !backup.changes || backup.records.some(r => !r || !/^\d{1,9}$/.test(String(r.id)))) throw new Error('пошкоджена резервна копія');
      const applied = Array.isArray(backup.applied) ? new Set(backup.applied.map(Number)) : null;
      const items = backup.records.map(raw => ({ raw, ch: backup.changes[raw.id] })).filter(x => x.ch && (!applied || applied.has(Number(x.raw.id))));
      const plan = items.map(x => {
        const r = M.buildRestore(x.raw, x.ch.fields);
        return { id: x.raw.id, body: r.body, manual: r.manual, expectNow: x.ch.body, raw: x.raw, same: sameAsTarget(x.raw, x.ch.body) };
      });
      const act = plan.filter(p => !p.same);
      const firstPut = act.find(p => Object.keys(p.body).length);
      const info = { count: act.length, total: backup.records.length, nochange: plan.length - act.length, appliedKnown: !!applied, manual: act.filter(p => p.manual.length).length,
        sample: firstPut ? { method: 'PUT', url: `/api/invoice-payment/${firstPut.id}`, body: firstPut.body } : null, created_at: backup.created_at };
      if (hooks.confirm && !(await hooks.confirm(info))) return { journal: [], cancelled: true };
      const journal = plan.filter(p => p.same).map(p => ({ time: new Date().toISOString(), id: p.id, rules: 'ВІДКАТ', body: {}, before: null, after: null, result: 'skipped-nochange', http: null,
        problems: ['у резервній копії вже ті самі значення, що й після лінтера — лінтер цей запис не змінював'] }));
      let noRights = false;
      for (let i = 0; i < act.length; i++) {
        const p = act[i];
        const entry = { time: new Date().toISOString(), id: p.id, rules: 'ВІДКАТ', body: p.body, before: null, after: null, result: '', http: null, problems: [] };
        try {
          if (noRights) { entry.result = 'skipped-rights'; entry.problems.push('не надсилалось: CRM відмовив у правах на попередньому записі'); continue; }
          const cur = await api.get(`invoice-payment/${p.id}`).then(j => j.data || j);
          entry.before = snapshot(cur);
          const n = M.normalizeRecord(cur, live);
          const changedSince = (p.expectNow.pnl_operation_id != null && (String(n.operation_id) !== String(p.expectNow.pnl_operation_id) || String(n.category_id) !== String(p.expectNow.pnl_category_id))) ||
            (p.expectNow.project_id != null && String(n.project_id) !== String(p.expectNow.project_id));
          if (changedSince && !hooks.force) { entry.result = 'skipped-changed'; entry.problems.push('після лінтера запис змінювали — відкат пропущено'); }
          else if (inClosed(n)) { entry.result = 'skipped-closed'; entry.problems.push(`місяць ${M.monthUa(n.period)} закрито в CRM — повернути може лише Адмін (запит не надсилався)`); }
          else if (!Object.keys(p.body).length) { entry.result = 'manual'; entry.problems.push(...p.manual); }
          else {
            const r = await api.put(`invoice-payment/${p.id}`, p.body);
            entry.http = r.status;
            if (r.status < 200 || r.status >= 300) noRights = refused(entry, r, n) === 'rights';
            else {
              const after = await api.get(`invoice-payment/${p.id}`).then(j => j.data || j);
              entry.after = snapshot(after);
              const v = M.verifyUpdate(cur, after, p.body);
              entry.result = !v.ok ? 'verify-failed' : p.manual.length ? 'partial' : 'ok';
              entry.problems.push(...v.problems, ...p.manual);
            }
          }
        } catch (e) { entry.result = 'error'; entry.problems.push(e.message); }
        finally {
          journal.push(entry);
          if (hooks.onItem) hooks.onItem(entry, i + 1, act.length);
        }
      }
      if (hooks.saveJournal) await hooks.saveJournal(journal);
      return { journal, cancelled: false };
    }

    return { compiled, fixFrom, loadReference, fetchRecords, evaluateAll, run, planChanges, describePlan, apply, rollback, get live() { return live; }, set live(v) { live = v; } };
  }

  const LOCKED_DATE = 'locked-date';
  const dmy = iso => iso.split('-').reverse().join('.');
  // Запис до межі fix_from чи закритого місяця: видно, що кажуть правила, але змін не пропонується. why — причина для звіту.
  function freeze(res, why) {
    if (res.status === S.OK) return res;
    res.status = LOCKED_DATE;
    res.changes = [];
    res.reasons.unshift(why);
    for (const id of Object.keys(res.perRule)) if (res.perRule[id] !== S.OK && res.perRule[id] !== S.OVERRIDDEN) res.perRule[id] = LOCKED_DATE;
    return res;
  }

  function sameCurrent(change, recAtReport, recNow) {
    if (change.field === 'category') return recAtReport.category_id === recNow.category_id && recAtReport.operation_id === recNow.operation_id;
    if (change.field === 'project') return recAtReport.project_id === recNow.project_id;
    return true;
  }
  // у резервній копії вже цільові значення → лінтер цей запис не змінював (нічого повертати)
  function sameAsTarget(rawBefore, body) {
    const n = M.normalizeRecord(rawBefore, null);
    if (body.pnl_operation_id != null && (String(n.category_id) !== String(body.pnl_category_id) || String(n.operation_id) !== String(body.pnl_operation_id))) return false;
    if (body.project_id != null && String(n.project_id) !== String(body.project_id)) return false;
    return true;
  }
  function snapshot(raw) {
    const n = M.normalizeRecord(raw, null);
    return { category_id: n.category_id, operation_id: n.operation_id, project_id: n.project_id };
  }

  // ---------- звіт ----------
  const STATUS_ORDER = [S.FIX, S.REVIEW, S.MANUAL, S.LOCKED, LOCKED_DATE, S.OVERRIDDEN, S.OK];
  const STATUS_UA = { fix: 'виправити', review: 'перевірити', 'manual-422': 'лише вручну в CRM', 'locked-auto': 'лід / авто — не змінюється',
    'locked-date': 'до межі — лише довідка', overridden: 'перекрито іншим правилом', ok: 'збігається' };
  // результати журналу застосування й відкату — для показу людині (у журналах і логіці лишаються коди)
  const RESULT_UA = { ok: 'змінено й перевірено', 'skipped-changed': 'пропущено: запис змінили після перевірки', 'skipped-locked': 'пропущено: лід / авто чи до межі',
    'skipped-closed': 'пропущено: місяць закрито', 'closed-period': 'місяць закрито в CRM', 'no-rights': 'немає права змінювати', 'skipped-rights': 'не надсилалось: немає права',
    'verify-failed': 'перевірка після зміни не збіглась — перевірте в CRM', 'manual-422': 'лише вручну в CRM', manual: 'повернути вручну', partial: 'змінено частково',
    'skipped-nochange': 'лінтер не змінював — пропущено', error: 'помилка' };
  const r2 = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

  /* Рядки детального звіту: один рядок на пару «запис × правило» (колонки — ТЗ, розділ 7.4). */
  function reportRows(run, live) {
    const head = ['ID запису', 'Дата', 'Рахунок', 'Сума', 'Валюта', 'Тип', 'Коментар', 'Поточна стаття', 'Поточний проєкт',
      'Правило', 'Очікувана стаття', 'Очікуваний проєкт', 'Статус', 'Статус запису', 'Причина', 'Джерело запису'];
    const rows = [head];
    for (const res of run.results) {
      const rec = res.record;
      for (const r of res.applicable) {
        rows.push([rec.id, rec.date, rec.account_names.join(' → '), r2(rec.amount), rec.currency, M.TYPE_UA[rec.type] || rec.type, rec.comment,
          rec.category_label, rec.project_label, `${r.id} — ${r.title}`,
          r.setLabel.category || r.setLabel.type || r.setLabel.exclude_from_pnl || r.setLabel.review || '', r.setLabel.project || '',
          res.perRule[r.id], res.status, res.reasons.join('; '), rec.is_lead ? 'лід CRM' : rec.is_auto ? 'автоматичний' : 'ручний']);
      }
    }
    return rows;
  }

  /* Підсумок по правилах: скільки записів і на яку суму в кожному статусі (довгий формат). */
  function summaryRows(run, compiled) {
    const head = ['Правило', 'Назва', 'Статус', 'Записів', 'Сума, UAH', 'Інші валюти'];
    const acc = {};
    for (const res of run.results) {
      for (const r of res.applicable) {
        const st = res.perRule[r.id];
        const k = r.id + '|' + st;
        const a = acc[k] || (acc[k] = { n: 0, uah: 0, other: {} });
        a.n++;
        if (res.record.currency === 'UAH') a.uah += Math.abs(res.record.amount);
        else a.other[res.record.currency] = (a.other[res.record.currency] || 0) + Math.abs(res.record.amount);
      }
    }
    const rows = [head];
    for (const rule of compiled.rules) {
      for (const st of STATUS_ORDER) {
        const a = acc[rule.id + '|' + st];
        if (!a) continue;
        rows.push([rule.id, rule.title, st, a.n, r2(a.uah), Object.entries(a.other).map(([c, v]) => `${r2(v)} ${c}`).join('; ')]);
      }
      if (!STATUS_ORDER.some(st => acc[rule.id + '|' + st])) rows.push([rule.id, rule.title, '—', 0, 0, '']);
    }
    return rows;
  }

  /* «Підказки з історії» для записів, яких не покриває жодне правило (01.11.2026). Отримувач — початок коментаря до «:» (або перші
     слова), тип той самий. Якщо щонайменше minN інших записів цього отримувача (rest і past — нормалізовані записи, past — період і
     120 днів до нього) і ≥ minShare з них мають одну статтю, а цей запис — іншу, — підказка. Лише довідка: нічого не змінює.
     → [{rec, art: 'категорія:операція', label, n, k, key, ex: [id…]}], за датою */
  const hintKey = c => {
    const s = String(c || '').toLowerCase().replace(/[’ʼ'`]/g, ''), i = s.indexOf(':');
    return (i > 2 && i < 80 ? s.slice(0, i) : s).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !/^\d+$/.test(w)).slice(0, 3).join(' ');
  };
  function historyHints(rest, past, minN, minShare) {
    minN = minN || 4; minShare = minShare || 0.75;
    const artOf = x => `${x.category_id}:${x.operation_id || ''}`, groups = new Map();
    for (const x of past || []) {
      const k = hintKey(x.comment);
      if (!k || !x.category_id || (x.type !== 'income' && x.type !== 'expense')) continue;
      const g = `${x.type}|${k}`;
      if (!groups.has(g)) groups.set(g, new Map());
      groups.get(g).set(x.id, x); // той самий запис у періоді й в історії — один
    }
    // на групу — один раз: скільки записів і які з кожною статтею; на запис — лише відняти його самого (раніше на кожен запис група
    // копіювалась і списки статей будувались через concat — квадратично: 3000 записів групи × 300 без правил — 15 с на сторінці CRM)
    const stats = new Map();
    const statOf = gk => {
      let s = stats.get(gk);
      if (!s) {
        const m = groups.get(gk), by = new Map();
        if (m) for (const x of m.values()) { const a = artOf(x); let v = by.get(a); if (!v) by.set(a, v = []); v.push(x); }
        stats.set(gk, s = { m, n: m ? m.size : 0, by });
      }
      return s;
    };
    const out = [];
    for (const r of rest || []) {
      const key = hintKey(r.comment);
      if (!key) continue;
      const s = statOf(`${r.type}|${key}`), self = s.m && s.m.get(r.id), n = s.n - (self ? 1 : 0);
      if (n < minN) continue;
      let art = null, k = 0;
      for (const [a, xs] of s.by) { const c = xs.length - (self && artOf(self) === a ? 1 : 0); if (c > k) { art = a; k = c; } }
      if (!art || k / n < minShare || art === artOf(r)) continue;
      const xs = s.by.get(art).filter(x => x.id !== r.id);
      out.push({ rec: r, art, label: xs[0].category_label || art, n, k, key, ex: xs.slice(0, 3).map(x => x.id) });
    }
    return out.sort((a, b) => (a.rec.date < b.rec.date ? -1 : a.rec.date > b.rec.date ? 1 : 0));
  }

  /* «Підказки ШІ» (03.11.2026): записи без правил (rest) так, як їх отримає «Помічник кешфлоу» для Claude; з тексту він ще прибере
     номери рахунків, карток, телефони й e-mail. others — інші записи періоду (нормалізовані). same — статті інших записів того
     самого отримувача (як у historyHints) у періоді: [стаття, скільки], до трьох — модель бачить, як їх зазвичай класифікують. */
  function aiRecords(rest, others) {
    const groups = new Map();
    for (const x of (rest || []).concat(others || [])) {
      const k = hintKey(x.comment);
      if (!k || !x.category_id || (x.type !== 'income' && x.type !== 'expense')) continue;
      const g = `${x.type}|${k}`;
      if (!groups.has(g)) groups.set(g, new Map());
      groups.get(g).set(x.id, x);
    }
    return (rest || []).map(r => {
      const key = hintKey(r.comment), by = new Map();
      for (const x of key ? (groups.get(`${r.type}|${key}`) || new Map()).values() : []) {
        if (x.id !== r.id) by.set(x.category_label || '?', (by.get(x.category_label || '?') || 0) + 1);
      }
      return { k: r.id, date: r.date, type: r.type, amount: r.amount, ccy: r.currency, acc: (r.account_names || []).join(' → '), cmt: r.text || r.comment || '',
        art: `${r.category_id}:${r.operation_id == null ? '' : r.operation_id}`, art_label: r.category_label || '', prj: r.project_label || '',
        same: [...by].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 3) };
    });
  }

  function statusCounts(run) {
    const c = {};
    for (const res of run.results) c[res.status] = (c[res.status] || 0) + 1;
    return c;
  }

  function journalRows(journal) {
    const rows = [['Час', 'ID запису', 'Правило', 'Було (кат/ст/проєкт)', 'Стало (кат/ст/проєкт)', 'Запит PUT', 'HTTP', 'Результат', 'Примітки']];
    const f = s => s ? `${s.category_id}/${s.operation_id}/${s.project_id == null ? '—' : s.project_id}` : '';
    for (const e of journal) rows.push([e.time, e.id, e.rules, f(e.before), f(e.after), JSON.stringify(e.body), e.http == null ? '' : e.http, e.result, e.problems.join('; ')]);
    return rows;
  }

  return { makeApi, createLinter, reportRows, summaryRows, statusCounts, journalRows, STATUS_ORDER, STATUS_UA, RESULT_UA, LOCKED_DATE, historyHints, aiRecords };
}));
