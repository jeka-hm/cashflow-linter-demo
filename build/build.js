/* Збирання: core + ui + rules.json → dist/ (те саме, що build/build.py)
   - cashflow_linter.js — лінтер з підписом ключа розробника (останній рядок); годиться й для консолі браузера;
   - *.bookmarklet.txt  — вміст закладок: короткий завантажувач (bookmarklet/loader.js) з відкритим ключем;
   - встановлення.html  — сторінка з кнопками, які перетягують на панель закладок.
   Запуск: node build\build.js */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const readFile = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
// ui/bank-panel.js — з частин ui/bank-panel/NN-….part.js, склеєних за порядком назв (сам файл — лише завантажувач для Node)
const BANK_PARTS = 'ui/bank-panel';
const read = p => (p === 'ui/bank-panel.js'
  ? fs.readdirSync(path.join(ROOT, BANK_PARTS)).filter(f => /^\d+.*\.part\.js$/.test(f)).sort().map(f => readFile(`${BANK_PARTS}/${f}`)).join('')
  : readFile(p));

function bundle() {
  const rules = JSON.parse(read('rules/rules.json'));
  const parts = ['core/rules-engine.js', 'core/crm-model.js', 'core/linter.js', 'core/xlsx.js', 'core/recon.js', 'core/withdrawals.js', 'core/matching.js', 'core/drafts.js', 'ui/combo.js', 'ui/bank-panel.js', 'ui/approvals-tab.js', 'ui/linter-panel.js'].map(p => `/* ---- ${p} ---- */\n${read(p)}`);
  const now = new Date().toISOString();
  return `/* Лінтер кешфлоу crm.example.com — зібрано ${now.slice(0, 16).replace('T', ' ')}, rules.json ${rules.version}.
   Запуск: відкрити crm.example.com під своїм логіном → F12 → Console → вставити весь файл → Enter.
   За замовчуванням — лише перегляд (dry-run). Щоб дозволити зміни, ПЕРШИМ рядком у консолі виконайте:
     window.CF_LINTER_CONFIG = { APPLY: true };
*/
(function () {
var module, exports, define; // UMD-модулі нижче реєструються в globalThis (CFRules, CFModel, CFLinter, CFXlsx, CFRecon, CFBankPanel, CFApprovalsTab, CFPanel)
${parts.join('\n')}
var CF_RULES = ${JSON.stringify(rules)};
var CF_BUILD = '${now.slice(0, 19)}Z'; // мітка збірки: закладка бере найновішу, панель упізнає «ту саму» збірку
/* ---- bookmarklet/main.js ---- */
${read('bookmarklet/main.js')}
})();
`;
}

/* Підпис: останній рядок cashflow_linter.js — ECDSA P-256 / SHA-256 (base64, r‖s як у WebCrypto) усього, що вище.
   Публічна версія: ключ — демонстраційний, створюється під час першої збірки в dist/demo-signing-key.json (dist/ у git не йде);
   свій ключ можна задати змінною CFL_SIGNING_KEY. Той самий файл читає й build.py (build/sign.py). */
const SIG_MARK = '//# CFL-SIG ';
const signCode = (code, jwk) => code + SIG_MARK + crypto.sign('sha256', Buffer.from(code, 'utf8'),
  { key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }).toString('base64') + '\n';
function signingKey() {
  const file = process.env.CFL_SIGNING_KEY || path.join(DIST, 'demo-signing-key.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }, null, 1), 'utf8');
  console.log(`Створено демонстраційний ключ підпису: ${file}`);
  return jwk;
}

/* Закладка-завантажувач: код лінтера бере із запущеного Помічника або зі збереженої в браузері копії (найновішу),
   а без них — з файлу cashflow_linter.js, і виконує лише з дійсним підписом ключа key. Від збірки не залежить.
   Повний код у закладці Firefox не зберігає: його межа — 65 536 символів. */
function loaderSource(cfg, key) {
  const pub = { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
  return read('bookmarklet/loader.js').replace(/^\/\*[\s\S]*?\*\/\s*/, '')
    .replace('__CFG__', () => JSON.stringify(cfg)).replace('__KEY__', () => JSON.stringify(pub));
}
const toBookmarklet = src => 'javascript:' + encodeURIComponent(src).replace(/%20/g, ' ');
// повний шлях до cashflow_linter.js на сторінці встановлення (сторінку відкривають з диска)
const PATH_SCRIPT = String.raw`<script>try{if(location.protocol==='file:'){var p=decodeURIComponent(location.pathname).replace(/^\/(?=[A-Za-z]:)/,'').replace(/\//g,'\\');document.getElementById('f').textContent=p.replace(/[^\\]*$/,'')+'cashflow_linter.js'}}catch(e){}</script>`;

/* Закладка «Підключити до Помічника»: передає токен CRM у локальну програму (127.0.0.1).
   Якщо браузер не пускає запит до локальної програми — копіює токен у буфер обміну. */
function connectBookmarklet(port) {
  const code = `void (async()=>{const t=(localStorage.getItem('token')||'').replace(/^"|"$/g,'');if(!/crm\\.example\\.com$/.test(location.hostname)||!t){alert('Відкрийте crm.example.com під своїм логіном');return}try{const r=await fetch('http://127.0.0.1:${port}/api/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t,user_id:localStorage.getItem('user_id')})});const j=await r.json();alert(j.ok?'Помічник кешфлоу підключено до CRM'+(j.user?' ('+j.user+')':''):'Помічник: '+(j.error||r.status))}catch(e){try{await navigator.clipboard.writeText(t);alert('Помічник не відповідає або браузер не пускає до нього запит. Токен скопійовано в буфер обміну: у Помічнику відкрийте «Налаштування» → «Вхід у CRM», вставте його в поле «токен» і натисніть «Підключити».')}catch(e2){prompt('Скопіюйте токен (Ctrl+C) і вставте в Помічнику:',t)}}})()`;
  return 'javascript:' + encodeURIComponent(code).replace(/%20/g, ' ');
}

function main() {
  const key = signingKey();
  fs.mkdirSync(DIST, { recursive: true });
  const code = bundle();
  new Function(code.replace(/^\/\*[\s\S]*?\*\//, '')); // перевірка синтаксису
  fs.writeFileSync(path.join(DIST, 'cashflow_linter.js'), signCode(code, key), 'utf8');
  const stamp = new Date().toLocaleString('uk-UA');
  const view = toBookmarklet(loaderSource({ APPLY: false }, key));
  const apply = toBookmarklet(loaderSource({ APPLY: true }, key));
  const connect = connectBookmarklet(8765);
  fs.writeFileSync(path.join(DIST, 'Лінтер_кешфлоу_перегляд.bookmarklet.txt'), view, 'utf8');
  fs.writeFileSync(path.join(DIST, 'Лінтер_кешфлоу_APPLY.bookmarklet.txt'), apply, 'utf8');
  fs.writeFileSync(path.join(DIST, 'Підключити_Помічник.bookmarklet.txt'), connect, 'utf8');
  const attr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  fs.writeFileSync(path.join(DIST, 'встановлення.html'), `<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>Лінтер кешфлоу — закладки</title>
<style>body{font:15px/1.5 system-ui,Segoe UI,Arial;max-width:820px;margin:30px auto;padding:0 16px}a.bm{display:inline-block;padding:8px 14px;margin:6px 8px 6px 0;border-radius:8px;background:#0043ea;color:#fff;text-decoration:none;font-weight:600}a.bm.apply{background:#b00020}a.bm.conn{background:#0a7a2a}code{background:#f2f3f5;padding:1px 5px;border-radius:4px}</style></head><body>
<h1>Лінтер кешфлоу — встановлення закладок</h1>
<ol><li>Увімкніть панель закладок: <code>Ctrl+Shift+B</code>.</li>
<li>Перетягніть потрібні кнопки мишкою на панель закладок (не натискайте їх тут).</li>
<li>Відкрийте <b>crm.example.com</b> під своїм логіном і натисніть закладку.</li>
<li>Закладка сама бере найновішу версію лінтера із запущеного «Помічника кешфлоу». Якщо Помічник не запущений і лінтер ще не запускався в цьому браузері — один раз попросить вибрати файл <code id="f">cashflow_linter.js</code> з цієї самої папки.</li></ol>
<p>Після оновлень лінтера закладки перетягувати заново не треба: закладка запускає лише код, підписаний ключем розробника, і новішу версію бере сама.</p>
<p><a class="bm" href="${attr(view)}">Лінтер кешфлоу</a> — перевірка без змін (dry-run).</p>
<p><a class="bm apply" href="${attr(apply)}">Лінтер кешфлоу (APPLY)</a> — те саме, але з режимом редагування (зміни лише після резервної копії й підтвердження).</p>
<p><a class="bm conn" href="${attr(connect)}">Підключити Помічник</a> — передає ваш вхід у CRM програмі «Помічник кешфлоу» (вона має бути запущена).</p>
<p>Закладки працюють у Firefox, Chrome і Edge. Зібрано ${stamp}. Довжина закладок: перегляд ${view.length} символів, APPLY ${apply.length}.</p>
${PATH_SCRIPT}</body></html>`, 'utf8');
  console.log(`dist: cashflow_linter.js ${code.length} B; закладка ${view.length} символів; rules.json ${JSON.parse(read('rules/rules.json')).version}`);
}

if (require.main === module) main();
module.exports = { bundle, loaderSource, toBookmarklet, connectBookmarklet, signCode, SIG_MARK };
