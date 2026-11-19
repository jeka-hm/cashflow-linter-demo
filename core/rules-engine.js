/* =====================================================================
   Рушій правил кешфлоу: компіляція rules.json і перевірка одного запису.
   Без залежностей: працює в браузері (букмарклет, «Помічник кешфлоу»),
   у Node (тести) і в Apps Script V8 (фаза 2 — реєстр погоджень).

   Запис на вході — нормалізований (див. crm-model.js → normalizeRecord):
     { id, date:'РРРР-ММ-ДД', period:'РРРР-ММ-01', text, type:'income'|'expense'|'transfer'|'exchange',
       category_id, operation_id, project_id, account_ids:[], account_names:[], amount, currency,
       is_lead, is_auto, is_salary }
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CFRules = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATUS = { OK: 'ok', FIX: 'fix', REVIEW: 'review', MANUAL: 'manual-422', LOCKED: 'locked-auto', OVERRIDDEN: 'overridden' };
  const SEVERITY = { ok: 0, fix: 1, review: 2, 'manual-422': 3, 'locked-auto': 4 };
  // review — «псевдополе»: правило лише позначає запис для ручної перевірки (напр. «інші країни»)
  const FIELDS = ['category', 'project', 'type', 'exclude_from_pnl', 'review'];
  // через API лінтер змінює лише статтю і проєкт; тип / виключення з P&L — завжди вручну (review)
  const API_FIELDS = new Set(['category', 'project']);
  const TYPES = new Set(['income', 'expense', 'transfer', 'exchange']);
  const COND_KEYS = new Set(['comment_regex', 'text_any', 'names', 'type', 'category_in', 'category_not_in',
    'project_in', 'project_not_in', 'account_regex', 'account_in', 'amount_min', 'amount_max',
    'is_manual', 'is_lead', 'date_from', 'date_to', 'all', 'any', 'not']);
  const RULE_KEYS = new Set(['id', 'title', 'source', 'effective_from', 'effective_to', 'date_field', 'priority',
    'match', 'unless', 'set', 'on_ambiguous', 'mode', 'note', 'group', 'disabled']);

  // ---------- текст ----------
  // апостроф: ' ʼ ’ ‘ ` ´ вважаються однаковими (ТЗ, розділ 4)
  const APOS_RE = /[ʼ’‘`´ʹ′']/g;
  const normApos = s => String(s == null ? '' : s).replace(APOS_RE, "'");
  const normText = s => normApos(s).toLowerCase().replace(/\s+/g, ' ').trim();
  // латинські двійники кириличних літер (у коментарях трапляється «i» замість «і») — лише для пошуку імен
  const LAT2CYR = { a: 'а', c: 'с', e: 'е', i: 'і', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в' };
  const fold = s => normText(s).replace(/[aceiopxykmthb]/g, ch => LAT2CYR[ch]).replace(/ё/g, 'е');
  // латинські двійники всередині кириличних слів («Комiсiя», «НIКІТЧЕНКО») → кирилиця, регістр зберігається
  const LAT_UP = { A: 'А', C: 'С', E: 'Е', I: 'І', O: 'О', P: 'Р', X: 'Х', Y: 'У', K: 'К', M: 'М', T: 'Т', H: 'Н', B: 'В' };
  const toCyr = s => normApos(s).replace(/[\p{L}]+/gu, w => /[а-яіїєґ]/i.test(w) ? w.replace(/[aceiopxykmthbACEIOPXYKMTHB]/g, ch => LAT2CYR[ch] || LAT_UP[ch]) : w);
  const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const W = '[\\p{L}\\p{N}_]';                 // «літера слова» з урахуванням кирилиці
  const NOT_W_BEFORE = '(?<![\\p{L}\\p{N}_])';
  const NOT_W_AFTER = '(?![\\p{L}\\p{N}_])';

  /* Регулярний вираз у стилі Python → RegExp JS з прапором u.
     - (?i)/(?s)/(?m) на початку → прапори; \w \W \b \B → з урахуванням кирилиці
       (у JS вони лише ASCII, тому «банківськ\w*» і «\bзп\b» без перекладу не працюють);
     - зайві екранування (\- поза [], \' тощо) прибираються — у режимі u це помилка. */
  function translateRegex(src) {
    if (typeof src !== 'string' || !src) throw new Error('порожній регулярний вираз');
    let flags = 'u', s = normApos(src), m;
    while ((m = /^\(\?([a-zA-Z]+)\)/.exec(s))) {
      for (const f of m[1]) {
        if (!'ims'.includes(f)) throw new Error(`прапор (?${f}) не підтримується`);
        if (!flags.includes(f)) flags += f;
      }
      s = s.slice(m[0].length);
    }
    if (/\(\?[imsx]+\)/.test(s)) throw new Error('прапори (?i) дозволені лише на початку виразу');
    const SYNTAX = '^$\\.*+?()[]{}|/';
    let out = '', inClass = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') {
        const n = s[i + 1];
        if (n === undefined) throw new Error('вираз закінчується на «\\»');
        i++;
        if (n === 'w') out += inClass ? '\\p{L}\\p{N}_' : W;
        else if (n === 'W') { if (inClass) throw new Error('\\W усередині [] не підтримується'); out += '[^\\p{L}\\p{N}_]'; }
        else if (n === 'b') { if (inClass) throw new Error('\\b усередині [] не підтримується'); out += `(?:(?<=${W})${NOT_W_AFTER}|${NOT_W_BEFORE}(?=${W}))`; }
        else if (n === 'B') out += `(?:(?<=${W})(?=${W})|${NOT_W_BEFORE}${NOT_W_AFTER})`;
        else if (/[a-zA-Z0-9]/.test(n) || SYNTAX.includes(n) || (inClass && n === '-')) out += '\\' + n;
        else out += n; // \' \- \" \№ … → сам символ
        continue;
      }
      if (c === '[' && !inClass) inClass = true;
      else if (c === ']' && inClass && out[out.length - 1] !== '[') inClass = false;
      out += c;
    }
    try { return new RegExp(out, flags); } catch (e) { throw new Error(`неправильний регулярний вираз «${src}»: ${e.message}`); }
  }

  /* Варіант імені → RegExp по «складеному» тексті (fold): регістр не важливий, апостроф однаковий,
     межі слова з урахуванням кирилиці. «Шелег*» — префікс (Шелега, Шелеги, Шелегу).
     Кілька слів — будь-які пробіли між ними. */
  function nameRegex(variant) {
    const v = fold(variant);
    if (!v) throw new Error('порожній варіант імені');
    const prefix = v.endsWith('*');
    const words = (prefix ? v.slice(0, -1) : v).split(' ').filter(Boolean).map(escRe);
    return new RegExp(NOT_W_BEFORE + words.join('\\s+') + (prefix ? '' : NOT_W_AFTER), 'u');
  }

  // ---------- дати ----------
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  function checkDate(v, what) {
    if (v == null) return null;
    if (typeof v !== 'string' || !ISO_DATE.test(v) || isNaN(Date.parse(v + 'T00:00:00Z'))) throw new Error(`${what}: очікується дата РРРР-ММ-ДД, отримано «${v}»`);
    return v;
  }

  // ---------- довідник (назви ↔ id) ----------
  /* ref = { articles: { 'Назва' | 'Група / Назва': {category_id, operation_id, label} },
             projects: { 'Україна': 1, … }, projectNames: {1:'Україна'} }
     Будується з rules.json (розділ reference) і перевіряється по живому CRM у linter.js. */
  function buildRef(doc) {
    const articles = {}, byId = {}, projects = {}, projectNames = {}, groups = {};
    const refDoc = (doc && doc.reference) || {};
    const list = (refDoc.articles || []).map(a => ({ a, art: { kind: 'article', category_id: a.category_id, operation_id: a.operation_id, label: articleLabelOf(a), group: a.group, name: a.name } }));
    const put = (k, art, weak) => {
      const key = normText(k);
      const cur = articles[key];
      if (cur === undefined) articles[key] = weak ? { weak: art } : art;
      else if (cur === 'AMBIGUOUS' || cur === art || (cur.weak === art)) return;
      else if (cur.weak && !weak) articles[key] = art;          // точна назва статті сильніша за назву категорії
      else if (!!cur.weak === !!weak) articles[key] = 'AMBIGUOUS';
    };
    for (const { a, art } of list) {
      groups[normText(a.group)] = a.group;
      byId[a.category_id + '/' + a.operation_id] = art;
      // однозначні ключі: повна назва, «Група / Стаття», «Категорія / Стаття»
      for (const k of [art.label, `${a.group} / ${a.name}`, `${a.category || a.name} / ${a.name}`]) articles[normText(k)] = art;
    }
    for (const { a, art } of list) put(a.name, art, false);              // коротка назва статті, якщо не повторюється
    for (const { a, art } of list) put(a.category || a.name, art, true);  // назва категорії — найслабший ключ
    for (const { a, art } of list) for (const al of a.aliases || []) articles[normText(al)] = art;
    for (const k of Object.keys(articles)) if (articles[k] && articles[k].weak) articles[k] = articles[k].weak;
    for (const [name, id] of Object.entries(refDoc.projects || {})) { projects[normText(name)] = id; projectNames[id] = name; }
    return { articles, articleById: byId, projects, projectNames, groups };
  }
  // «Група / Категорія / Стаття»; якщо назва категорії = назві статті — «Група / Стаття»
  function articleLabelOf(a) {
    const cat = a.category || a.name;
    return normText(cat) === normText(a.name) ? `${a.group} / ${a.name}` : `${a.group} / ${cat} / ${a.name}`;
  }
  function resolveArticle(ref, v, where) {
    if (v && typeof v === 'object') {
      const art = ref.articleById[v.category_id + '/' + v.operation_id];
      if (!art) throw new Error(`${where}: стаття ${v.category_id}/${v.operation_id} відсутня в довіднику`);
      return art;
    }
    const art = ref.articles[normText(v)];
    if (art === 'AMBIGUOUS') throw new Error(`${where}: назва «${v}» неоднозначна — вкажіть «Група / ${v}»`);
    if (!art) throw new Error(`${where}: стаття «${v}» відсутня в довіднику (reference.articles)`);
    return art;
  }
  function resolveProject(ref, v, where) {
    if (v === null) return null;
    if (typeof v === 'number') { if (!(v in ref.projectNames)) throw new Error(`${where}: проєкт id ${v} відсутній у довіднику`); return v; }
    const id = ref.projects[normText(v)];
    if (id === undefined) throw new Error(`${where}: проєкт «${v}» відсутній у довіднику (reference.projects)`);
    return id;
  }

  // ---------- компіляція ----------
  function compileCond(c, ref, where, nameLists) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`${where}: умова має бути об'єктом`);
    const out = {};
    for (const k of Object.keys(c)) {
      if (!COND_KEYS.has(k)) throw new Error(`${where}: невідоме поле умови «${k}»`);
      const v = c[k];
      switch (k) {
        case 'comment_regex': out.re = translateRegex(v); out.reSrc = v; break;
        case 'text_any': out.textAny = toArr(v, where + '.text_any').map(normText); break;
        case 'names': {
          const list = typeof v === 'string' && v.startsWith('@') ? nameLists[v.slice(1)] : v;
          if (!list) throw new Error(`${where}: список імен «${v}» не знайдено в people`);
          out.names = toArr(list, where + '.names').flat().map(x => ({ variant: x, re: nameRegex(x) }));
          break;
        }
        case 'type': out.type = toArr(v, where + '.type'); out.type.forEach(t => { if (!TYPES.has(t)) throw new Error(`${where}: невідомий тип «${t}»`); }); break;
        case 'category_in': case 'category_not_in':
          out[k] = new Set(toArr(v, where + '.' + k).map(x => { const a = resolveArticle(ref, x, where + '.' + k); return a.category_id + '/' + a.operation_id; }));
          break;
        case 'project_in': case 'project_not_in': out[k] = new Set(toArr(v, where + '.' + k).map(x => resolveProject(ref, x, where + '.' + k))); break;
        case 'account_regex': out.accRe = translateRegex(v); break;
        case 'account_in': out.accIn = new Set(toArr(v, where + '.account_in')); break;
        case 'amount_min': case 'amount_max': if (typeof v !== 'number') throw new Error(`${where}.${k}: очікується число`); out[k] = v; break;
        case 'is_manual': case 'is_lead': if (typeof v !== 'boolean') throw new Error(`${where}.${k}: очікується true/false`); out[k] = v; break;
        case 'date_from': case 'date_to': out[k] = checkDate(v, where + '.' + k); break;
        case 'all': case 'any': out[k] = toArr(v, where + '.' + k).map((x, i) => compileCond(x, ref, `${where}.${k}[${i}]`, nameLists)); break;
        case 'not': out.not = compileCond(v, ref, where + '.not', nameLists); break;
      }
    }
    return out;
  }
  function toArr(v, where) {
    const a = Array.isArray(v) ? v : [v];
    if (!a.length) throw new Error(`${where}: порожній список`);
    return a;
  }

  function compileRules(doc, opts) {
    opts = opts || {};
    const ref = opts.ref || buildRef(doc);
    const errors = [], warnings = [], rules = [], ids = new Set();
    const nameLists = {};
    for (const [k, v] of Object.entries((doc && doc.people) || {})) nameLists[k] = Array.isArray(v) ? v : v.names;
    (doc && doc.rules || []).forEach((r, idx) => {
      const where = `правило ${r && r.id ? r.id : '#' + (idx + 1)}`;
      try {
        if (!r || typeof r !== 'object') throw new Error('має бути об\'єктом');
        for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) throw new Error(`невідоме поле «${k}»`);
        if (typeof r.id !== 'string' || !/^R-[A-Z0-9-]+$/.test(r.id)) throw new Error('id має вигляд R-ЛІТЕРИ-ЦИФРИ');
        if (ids.has(r.id)) throw new Error('id повторюється');
        ids.add(r.id);
        if (!r.title) throw new Error('немає title');
        if (typeof r.priority !== 'number') throw new Error('priority має бути числом');
        if (!r.match) throw new Error('немає match');
        if (!r.set || !Object.keys(r.set).length) throw new Error('немає set');
        const from = checkDate(r.effective_from, where + '.effective_from'), to = checkDate(r.effective_to, where + '.effective_to');
        if (from && to && from > to) throw new Error('effective_from пізніше за effective_to');
        const dateField = r.date_field || 'date';
        if (!['date', 'period', 'created'].includes(dateField)) throw new Error('date_field: «date», «period» або «created»');
        const set = {}, setLabel = {};
        for (const [k, v] of Object.entries(r.set)) {
          if (k === 'category' || k === 'category_group' || k === 'category_not') {
            if (set.category) throw new Error('у set лише одне з category / category_group / category_not');
            if (k === 'category') { const a = resolveArticle(ref, v, where + '.set.category'); set.category = { kind: 'article', category_id: a.category_id, operation_id: a.operation_id, group: a.group }; setLabel.category = a.label; }
            else if (k === 'category_group') {
              const g = ref.groups[normText(v)];
              if (!g) throw new Error(`set.category_group: групи «${v}» немає в довіднику`);
              set.category = { kind: 'group', group: g }; setLabel.category = `будь-яка стаття групи «${g}» (стаття не визначена — вибрати вручну)`;
            } else {
              const arts = toArr(v, where + '.set.category_not').map(x => resolveArticle(ref, x, where + '.set.category_not'));
              set.category = { kind: 'not', keys: new Set(arts.map(a => a.category_id + '/' + a.operation_id)) };
              setLabel.category = 'не ' + arts.map(a => a.label).join(' / ') + ' (стаття не визначена — вибрати вручну)';
            }
          }
          else if (k === 'project') { set.project = resolveProject(ref, v, where + '.set.project'); setLabel.project = set.project == null ? '(без проєкту)' : ref.projectNames[set.project]; }
          else if (k === 'type') { if (v !== 'transfer') throw new Error('set.type: підтримується лише "transfer"'); set.type = 'transfer'; setLabel.type = 'переказ між рахунками'; }
          else if (k === 'exclude_from_pnl') { if (v !== true) throw new Error('set.exclude_from_pnl: лише true'); set.exclude_from_pnl = true; setLabel.exclude_from_pnl = 'не P&L / не показувати'; }
          else if (k === 'review') { if (typeof v !== 'string' || !v.trim()) throw new Error('set.review: текст причини'); set.review = v.trim(); setLabel.review = 'перевірити вручну: ' + v.trim(); }
          else throw new Error(`set: невідоме поле «${k}»`);
        }
        const mode = r.mode || 'fix';
        if (!['fix', 'review'].includes(mode)) throw new Error('mode: «fix» або «review»');
        const onAmb = r.on_ambiguous || 'review';
        if (!['review', 'skip'].includes(onAmb)) throw new Error('on_ambiguous: «review» або «skip»');
        rules.push({
          id: r.id, title: r.title, source: r.source || '', group: r.group || '', priority: r.priority,
          from, to, dateField, mode, onAmbiguous: onAmb, disabled: !!r.disabled, note: r.note || '',
          match: compileCond(r.match, ref, where + '.match', nameLists),
          unless: (r.unless || []).map((u, i) => compileCond(u, ref, `${where}.unless[${i}]`, nameLists)),
          set, setLabel, raw: r,
        });
      } catch (e) { errors.push(`${where}: ${e.message}`); }
    });
    if (!rules.length && !errors.length) warnings.push('у файлі немає жодного правила');
    // межа роботи лінтера: раніші записи — лише довідка (застосовує linter.js, рушій правил її не враховує)
    let fixFrom = null;
    try { fixFrom = checkDate(doc && doc.fix_from, 'fix_from'); } catch (e) { errors.push(e.message); }
    return { rules, errors, warnings, ref, version: doc && doc.version, fixFrom };
  }

  // ---------- перевірка ----------
  function condMatches(c, rec) {
    if (c.re && !c.re.test(rec.textApos != null ? rec.textApos : normApos(rec.text)) &&
      !c.re.test(rec.textCyr != null ? rec.textCyr : toCyr(rec.text))) return false;
    if (c.textAny) { const t = rec.textNorm != null ? rec.textNorm : normText(rec.text); if (!c.textAny.some(x => t.includes(x))) return false; }
    if (c.names) { const t = rec.textFold != null ? rec.textFold : fold(rec.text); if (!c.names.some(n => n.re.test(t))) return false; }
    if (c.type && !c.type.includes(rec.type)) return false;
    const art = rec.category_id != null ? rec.category_id + '/' + rec.operation_id : null;
    if (c.category_in && !(art && c.category_in.has(art))) return false;
    if (c.category_not_in && art && c.category_not_in.has(art)) return false;
    const proj = rec.project_id == null ? null : rec.project_id;
    if (c.project_in && !c.project_in.has(proj)) return false;
    if (c.project_not_in && c.project_not_in.has(proj)) return false;
    if (c.accRe && !(rec.account_names || []).some(n => c.accRe.test(n))) return false;
    if (c.accIn && !(rec.account_ids || []).some(id => c.accIn.has(id))) return false;
    const amt = Math.abs(Number(rec.amount) || 0);
    if (c.amount_min != null && amt < c.amount_min) return false;
    if (c.amount_max != null && amt > c.amount_max) return false;
    if (c.is_manual != null && (!rec.is_auto) !== c.is_manual) return false;
    if (c.is_lead != null && !!rec.is_lead !== c.is_lead) return false;
    if (c.date_from && rec.date < c.date_from) return false;
    if (c.date_to && rec.date > c.date_to) return false;
    if (c.all && !c.all.every(x => condMatches(x, rec))) return false;
    if (c.any && !c.any.some(x => condMatches(x, rec))) return false;
    if (c.not && condMatches(c.not, rec)) return false;
    return true;
  }
  function inEffect(rule, rec) {
    const d = rule.dateField === 'period' ? (rec.period || rec.date) : rule.dateField === 'created' ? (rec.created || rec.date) : rec.date;
    if (rule.from && (!d || d < rule.from)) return false;
    if (rule.to && (!d || d > rule.to)) return false;
    return true;
  }
  function currentValue(rec, f) {
    if (f === 'category') return rec.category_id == null ? null : { category_id: rec.category_id, operation_id: rec.operation_id };
    if (f === 'project') return rec.project_id == null ? null : rec.project_id;
    if (f === 'type') return rec.type === 'transfer' ? 'transfer' : rec.type;
    if (f === 'exclude_from_pnl') return rec.type === 'transfer' || rec.type === 'exchange';
    return undefined;
  }
  const artKey = v => v ? v.category_id + '/' + v.operation_id : 'null';
  const valKey = (f, v) => {
    if (f !== 'category') return String(v);
    if (v && v.kind === 'group') return 'group:' + v.group;
    if (v && v.kind === 'not') return 'not:' + [...v.keys].sort().join(',');
    return artKey(v);
  };
  // чи задовольняє стаття (поточна або очікувана) вимогу правила
  function satisfies(want, art, ref) {
    if (!want || want.kind === 'article' || want.kind === undefined) return artKey(want) === artKey(art);
    if (!art) return false;
    if (want.kind === 'not') return !want.keys.has(artKey(art));
    const a = ref && ref.articleById[artKey(art)];
    return !!a && a.group === want.group;
  }
  const sameVal = (f, a, b, ref) => f === 'category' ? satisfies(a, b, ref) : valKey(f, a) === valKey(f, b);
  const worse = (a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a);

  /* Перевірка одного запису. Повертає null, якщо жодне правило не застосовне.
     ctx.ruleIds — Set id вибраних правил (порожньо = усі). Пріоритети рахуються за ВСІМА правилами:
     вибір лише звужує, що показувати, тож невибране правило з вищим пріоритетом не обійдеться. */
  function evaluate(rec, compiled, ctx) {
    ctx = ctx || {};
    // запис не з normalizeRecord (рядки «Звірки з банком», погодження) — тексти один раз, а не в кожній умові кожного
    // правила; у результаті лишається сам запис (07.11.2026)
    const m = rec.textApos != null && rec.textCyr != null && rec.textNorm != null && rec.textFold != null ? rec : Object.assign(Object.create(rec), {
      textApos: rec.textApos != null ? rec.textApos : normApos(rec.text), textNorm: rec.textNorm != null ? rec.textNorm : normText(rec.text),
      textFold: rec.textFold != null ? rec.textFold : fold(rec.text), textCyr: rec.textCyr != null ? rec.textCyr : toCyr(rec.text) });
    const all = compiled.rules.filter(r => !r.disabled && inEffect(r, m) && condMatches(r.match, m) && !r.unless.some(u => condMatches(u, m)));
    const sel = ctx.ruleIds && ctx.ruleIds.size ? ctx.ruleIds : null;
    const applicable = sel ? all.filter(r => sel.has(r.id)) : all;
    if (!applicable.length) return null;
    // лід / автоматичний — важливіше за «зарплатний»: такі записи лінтер не чіпає взагалі (і вручну теж не пропонує)
    const lockReason = (rec.is_lead || rec.is_auto) ? STATUS.LOCKED : rec.is_salary ? STATUS.MANUAL : null;
    // кілька платежів у записі доходу / витрати — об'єднаний запис, лінтер такі не змінює (ТЗ, розділ 5 «Карти»)
    const multi = rec.n_payments > 1 && (rec.type === 'income' || rec.type === 'expense');
    const ref = compiled.ref;
    const fields = {}, reasons = [];
    for (const f of FIELDS) {
      const cands = all.filter(r => r.set[f] !== undefined);
      if (!cands.length || (sel && !cands.some(r => sel.has(r.id)))) continue;
      const top = Math.max(...cands.map(r => r.priority));
      const winners = cands.filter(r => r.priority === top), losers = cands.filter(r => r.priority < top);
      const cur = currentValue(rec, f);
      const fd = { field: f, winners, losers, current: cur, conflict: false, expected: null, expectedLabel: null, settable: true };
      if (f === 'review') {
        fd.equal = false;
        fd.expectedLabel = winners.map(r => r.setLabel.review).join('; ');
      } else if (f === 'category') {
        // точні статті + вимоги (група / «не ця стаття»): точна стаття має задовольняти всі вимоги
        const arts = winners.filter(r => r.set.category.kind === 'article'), cons = winners.filter(r => r.set.category.kind !== 'article');
        const keys = [...new Set(arts.map(r => artKey(r.set.category)))];
        if (keys.length > 1) fd.conflict = true;
        else if (keys.length === 1) {
          fd.expected = arts[0].set.category; fd.expectedLabel = arts[0].setLabel.category;
          if (cons.some(r => !satisfies(r.set.category, fd.expected, ref))) fd.conflict = true;
        } else {
          fd.expected = cons.length === 1 ? cons[0].set.category : { kind: 'multi', list: cons.map(r => r.set.category) };
          fd.expectedLabel = cons.map(r => r.setLabel.category).join('; ');
          fd.settable = false; // конкретної статті немає — лише перевірка
        }
        fd.equal = !fd.conflict && (fd.expected && fd.expected.kind === 'multi' ? fd.expected.list.every(w => satisfies(w, cur, ref)) : satisfies(fd.expected, cur, ref));
      } else {
        const keys = [...new Set(winners.map(r => valKey(f, r.set[f])))];
        fd.conflict = keys.length > 1;
        if (!fd.conflict) { fd.expected = winners[0].set[f]; fd.expectedLabel = winners[0].setLabel[f]; }
        fd.equal = !fd.conflict && sameVal(f, fd.expected, cur, ref);
      }
      const label = r => r.setLabel[f];
      const blocked = sel && !winners.some(r => sel.has(r.id)); // поле вирішує невибране правило з вищим пріоритетом
      if (fd.conflict) {
        const skip = winners.every(r => r.onAmbiguous === 'skip');
        fd.status = skip ? STATUS.OK : STATUS.REVIEW;
        if (!skip) reasons.push(`конфлікт правил з пріоритетом ${top}: ` + winners.map(r => `${r.id} → ${label(r)}`).join('; '));
      } else if (fd.equal) fd.status = STATUS.OK;
      else if (lockReason) fd.status = lockReason;
      else if (blocked) {
        fd.status = STATUS.REVIEW; fd.settable = false;
        reasons.push('вирішує невибране правило з вищим пріоритетом: ' + winners.map(r => `${r.id} → ${label(r)}`).join('; '));
      }
      else if (f === 'review') { fd.status = STATUS.REVIEW; reasons.push(fd.expectedLabel); }
      else if (!API_FIELDS.has(f)) { fd.status = STATUS.REVIEW; reasons.push(`${f === 'type' ? 'тип «переказ»' : 'виключення з P&L'} змінюється лише вручну`); }
      else if (multi) { fd.status = STATUS.REVIEW; fd.settable = false; reasons.push('запис з кількома платежами (об\'єднаний) — лінтер такі не змінює'); }
      else if (!fd.settable) { fd.status = STATUS.REVIEW; reasons.push('стаття має бути: ' + fd.expectedLabel); }
      else if (f === 'category' && ctx.marketerArts && ctx.marketerArts.has(artKey(fd.expected))) {
        fd.status = STATUS.REVIEW; fd.settable = false;
        reasons.push('для цільової статті CRM вимагає маркетолога (marketer_id) — змініть у CRM вручну, вибравши маркетолога');
      } else if (f === 'category' && ctx.marketerArts && cur && ctx.marketerArts.has(artKey(cur))) {
        // зараз стаття з маркетологом (рекламний бюджет): як CRM поведеться з бюджетом при зміні статті — невідомо
        fd.status = STATUS.REVIEW; fd.settable = false;
        reasons.push('запис зараз у статті з маркетологом (рекламний бюджет) — зміну статті зробіть у CRM вручну');
      } else if (winners.some(r => r.mode === 'review')) { fd.status = STATUS.REVIEW; reasons.push('правило вимагає ручного підтвердження (mode: review)'); }
      else if (f === 'category' && ctx.salaryOps && ctx.salaryOps.has(fd.expected.operation_id)) {
        fd.status = STATUS.REVIEW;
        reasons.push('цільова стаття належить до зарплатних — API може відмовити (422); підтвердіть рядок окремо');
      } else fd.status = STATUS.FIX;
      fields[f] = fd;
    }
    let status = STATUS.OK;
    for (const fd of Object.values(fields)) status = worse(status, fd.status);
    if (lockReason && status !== STATUS.OK) {
      status = lockReason;
      reasons.unshift(lockReason === STATUS.MANUAL ? 'зарплатна операція: API не змінює (HTTP 422) — змінити вручну'
        : rec.is_lead ? 'запис створено з ліда CRM — лінтер його не змінює' : 'запис створено автоматично — лінтер його не змінює');
    }
    // правило з нижчим пріоритетом, що хоче те саме конкретне значення, що й переможець, — не «перекрите»
    const agrees = (f, want, fd) => f !== 'review' && !fd.conflict && fd.expected != null &&
      (f === 'category' ? want.kind === 'article' && fd.expected.kind === 'article' && artKey(want) === artKey(fd.expected) : valKey(f, want) === valKey(f, fd.expected));
    const perRule = {};
    for (const r of applicable) {
      let st = null, lostDiff = false;
      for (const f of Object.keys(r.set)) {
        const fd = fields[f];
        if (fd.losers.includes(r) && !agrees(f, r.set[f], fd)) { if (f === 'review' || !sameVal(f, r.set[f], fd.current, ref)) lostDiff = true; continue; }
        const fst = fd.status === STATUS.OK ? STATUS.OK : (lockReason || fd.status);
        st = st == null ? fst : worse(st, fst);
      }
      perRule[r.id] = st != null ? st : (lostDiff ? STATUS.OVERRIDDEN : STATUS.OK);
    }
    const changes = [];
    if (status === STATUS.FIX || status === STATUS.REVIEW) {
      for (const f of Object.keys(fields)) {
        const fd = fields[f];
        if (API_FIELDS.has(f) && fd.settable && !fd.conflict && !fd.equal) changes.push({ field: f, from: fd.current, to: fd.expected, toLabel: fd.expectedLabel, auto: fd.status === STATUS.FIX });
      }
    }
    return { record: rec, applicable, fields, status, reasons: [...new Set(reasons)], perRule, changes };
  }

  return { STATUS, SEVERITY, FIELDS, API_FIELDS, normApos, normText, fold, toCyr, translateRegex, nameRegex, buildRef, articleLabelOf, resolveArticle, resolveProject, compileRules, condMatches, inEffect, evaluate, currentValue, satisfies };
}));
