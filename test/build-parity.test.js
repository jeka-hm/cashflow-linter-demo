'use strict';
/* build/build.js і build/build.py мають давати той самий cashflow_linter.js (до підпису) — різниться лише час збирання.
   Без Python тест пропускається. Нічого не пише в dist/ і не чіпає ключ підпису. */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const build = require('../build/build.js');

// bundle() з build.py — у stdout, байтами UTF-8 (без перетворення кінців рядків і без кодування консолі Windows)
const PY_CODE = [
  'import sys',
  'sys.dont_write_bytecode = True',
  `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'build'))})`,
  'import build',
  "sys.stdout.buffer.write(build.bundle().encode('utf-8'))",
].join('\n');

function pyBundle() {
  for (const [exe, pre] of [['python', []], ['py', ['-3']], ['python3', []]]) {
    const r = spawnSync(exe, [...pre, '-c', PY_CODE], { cwd: ROOT, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    if (r.error || r.status === 9009 || (r.status !== 0 && !r.stdout.length && /not found|не знайдено|Microsoft Store/i.test(String(r.stderr)))) continue; // немає такого Python
    return { exe, status: r.status, out: r.stdout.toString('utf8'), err: r.stderr.toString('utf8') };
  }
  return null;
}

// час збирання: «зібрано РРРР-ММ-ДД ГГ:ХХ» у заголовку і CF_BUILD = 'РРРР-ММ-ДДTГГ:ХХ:ССZ'
const STAMPS = [
  [/^(\/\* Лінтер кешфлоу crm\.example\.com — зібрано )\d{4}-\d{2}-\d{2} \d{2}:\d{2}(, rules\.json )/, '$1<час>$2'],
  [/(\nvar CF_BUILD = ')\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z(';)/, '$1<час>$2'],
];
function noStamp(code, who) {
  for (const [re, to] of STAMPS) {
    assert.ok(re.test(code), `${who}: не знайдено мітку часу збирання (${re})`);
    code = code.replace(re, to);
  }
  return code;
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const cut = s => JSON.stringify(s.slice(Math.max(0, i - 120), i + 200));
  return `перша різниця — символ ${i} (рядок ${a.slice(0, i).split('\n').length}):\n  build.js: ${cut(a)}\n  build.py: ${cut(b)}`;
}

test('build.js і build.py збирають однаковий лінтер (крім часу збирання)', t => {
  const py = pyBundle();
  if (!py) return t.skip('Python не знайдено — порівняти збірки нічим');
  assert.strictEqual(py.status, 0, 'build.py bundle() не виконався:\n' + py.err);
  const js = noStamp(build.bundle(), 'build.js');
  const pyCode = noStamp(py.out, 'build.py');
  assert.ok(js.length > 100000, 'збірка підозріло мала');
  if (js !== pyCode) assert.fail(`збірки build.js (${js.length} символів) і build.py (${pyCode.length}) різні; ${firstDiff(js, pyCode)}`);
});

test('обидва збирачі збирають ті самі частини; закладки реєстру погоджень (стороннього коду) у публічній збірці немає', () => {
  const fs = require('fs');
  const jsSrc = fs.readFileSync(path.join(ROOT, 'build/build.js'), 'utf8');
  const pySrc = fs.readFileSync(path.join(ROOT, 'build/build.py'), 'utf8');
  const list = src => [...new Set([...src.matchAll(/'((?:core|ui)\/[a-z-]+\.js)'/g)].map(m => m[1]))].sort();
  assert.ok(list(jsSrc).length >= 12, 'у build.js не знайдено список частин');
  assert.deepStrictEqual(list(jsSrc), list(pySrc), 'список частин у build.js і build.py різний');
  const code = build.bundle();
  assert.ok(code.includes('/* ---- core/drafts.js ---- */'), 'у збірці немає core/drafts.js');
  assert.ok(!code.includes('CF_REGISTRY_RUN = function'), 'у публічній збірці не має бути коду реєстру погоджень');
});
