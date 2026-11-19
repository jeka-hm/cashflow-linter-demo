"""Збирання dist/ без Node.js (те саме, що build/build.js): core + ui + rules.json →
   - cashflow_linter.js — лінтер, підписаний ключем розробника (build/sign.py); годиться й для консолі браузера;
   - *.bookmarklet.txt  — вміст закладок: короткий завантажувач (bookmarklet/loader.js) з відкритим ключем — від збірки не залежить;
   - встановлення.html  — сторінка з кнопками, які перетягують на панель закладок.
Запуск з папки проєкту: python build\\build.py   (--new-key — свідомо створити новий ключ підпису)"""
import argparse
import html
import json
import re
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sign  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'
PARTS = ['core/rules-engine.js', 'core/crm-model.js', 'core/linter.js', 'core/xlsx.js', 'core/recon.js', 'core/withdrawals.js', 'core/matching.js', 'core/drafts.js', 'ui/combo.js', 'ui/bank-panel.js', 'ui/approvals-tab.js', 'ui/linter-panel.js']
SIG_MARK = '//# CFL-SIG '  # останній рядок cashflow_linter.js: підпис усього, що вище


BANK_PARTS = 'ui/bank-panel'  # ui/bank-panel.js — з частин NN-….part.js, склеєних за порядком назв (сам файл — завантажувач для Node)


def read(p):  # без перетворення кінців рядків — як у build.js
    if p == 'ui/bank-panel.js':
        names = sorted(f.name for f in (ROOT / BANK_PARTS).iterdir() if re.match(r'^\d+.*\.part\.js$', f.name))
        return ''.join(read(f'{BANK_PARTS}/{n}') for n in names)
    with open(ROOT / p, encoding='utf-8', newline='') as f:
        return f.read()


def write(name, text):
    with open(DIST / name, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def enc_uri(s):  # encodeURIComponent
    return urllib.parse.quote(s, safe="-_.!~*'()")


def bundle():
    rules = json.loads(read('rules/rules.json'))
    now = datetime.now(timezone.utc)
    stamp = now.strftime('%Y-%m-%d %H:%M')
    parts = '\n'.join([f'/* ---- {p} ---- */\n{read(p)}' for p in PARTS])
    return f"""/* Лінтер кешфлоу crm.example.com — зібрано {stamp}, rules.json {rules['version']}.
   Запуск: відкрити crm.example.com під своїм логіном → F12 → Console → вставити весь файл → Enter.
   За замовчуванням — лише перегляд (dry-run). Щоб дозволити зміни, ПЕРШИМ рядком у консолі виконайте:
     window.CF_LINTER_CONFIG = {{ APPLY: true }};
*/
(function () {{
var module, exports, define; // UMD-модулі нижче реєструються в globalThis (CFRules, CFModel, CFLinter, CFXlsx, CFRecon, CFBankPanel, CFApprovalsTab, CFPanel)
{parts}
var CF_RULES = {json.dumps(rules, ensure_ascii=False, separators=(',', ':'))};
var CF_BUILD = '{now.strftime('%Y-%m-%dT%H:%M:%SZ')}'; // мітка збірки: закладка бере найновішу, панель упізнає «ту саму» збірку
/* ---- bookmarklet/main.js ---- */
{read('bookmarklet/main.js')}
}})();
"""


def signed(code, d):
    """cashflow_linter.js: код + останній рядок з підписом (ECDSA P-256, base64) — закладка виконує лише код з дійсним підписом."""
    return code + SIG_MARK + sign.sign_b64(d, code.encode('utf-8')) + '\n'


def loader_source(cfg, key):
    """Закладка-завантажувач (bookmarklet/loader.js): код лінтера бере із запущеного Помічника або зі збереженої в браузері
    копії (найновішу), а без них — з файлу cashflow_linter.js, і виконує лише з дійсним підписом відкритого ключа key.
    Від збірки не залежить — після оновлень закладку не перетягують. Повний код у закладці Firefox не зберігає: його межа —
    65 536 символів."""
    src = re.sub(r'^/\*[\s\S]*?\*/\s*', '', read('bookmarklet/loader.js'), count=1)
    key = {k: key[k] for k in ('kty', 'crv', 'x', 'y')}
    return src.replace('__CFG__', json.dumps(cfg, separators=(',', ':')), 1).replace('__KEY__', json.dumps(key, separators=(',', ':')), 1)


def to_bookmarklet(src):  # як encodeURIComponent(src).replace(/%20/g, ' ') у build.js
    return 'javascript:' + enc_uri(src).replace('%20', ' ')


# повний шлях до cashflow_linter.js на сторінці встановлення (сторінку відкривають з диска)
PATH_SCRIPT = r"""<script>try{if(location.protocol==='file:'){var p=decodeURIComponent(location.pathname).replace(/^\/(?=[A-Za-z]:)/,'').replace(/\//g,'\\');document.getElementById('f').textContent=p.replace(/[^\\]*$/,'')+'cashflow_linter.js'}}catch(e){}</script>"""


def connect_bookmarklet(port):
    """Закладка «Підключити Помічник»: передає токен CRM у локальну програму (127.0.0.1).
    Якщо браузер не пускає запит до локальної програми — копіює токен у буфер обміну."""
    code = ("void (async()=>{const t=(localStorage.getItem('token')||'').replace(/^\"|\"$/g,'');"
            "if(!/crm\\.example\\.com$/.test(location.hostname)||!t){alert('Відкрийте crm.example.com під своїм логіном');return}"
            f"try{{const r=await fetch('http://127.0.0.1:{port}/api/connect',{{method:'POST',headers:{{'Content-Type':'application/json'}},"
            "body:JSON.stringify({token:t,user_id:localStorage.getItem('user_id')})});const j=await r.json();"
            "alert(j.ok?'Помічник кешфлоу підключено до CRM'+(j.user?' ('+j.user+')':''):'Помічник: '+(j.error||r.status))}"
            "catch(e){try{await navigator.clipboard.writeText(t);alert('Помічник не відповідає або браузер не пускає до нього запит. "
            "Токен скопійовано в буфер обміну: у Помічнику відкрийте «Налаштування» → «Вхід у CRM», вставте його в поле «токен» і натисніть «Підключити».')}"
            "catch(e2){prompt('Скопіюйте токен (Ctrl+C) і вставте в Помічнику:',t)}}})()")
    return 'javascript:' + enc_uri(code).replace('%20', ' ')


def main(argv=None):
    ap = argparse.ArgumentParser(description='Збирання лінтера кешфлоу')
    ap.add_argument('--new-key', action='store_true', help='створити новий ключ підпису (після цього всім заново перетягнути закладки)')
    a = ap.parse_args(argv)
    d = sign.load_key(new=a.new_key)
    key = sign.public_jwk(d)
    DIST.mkdir(exist_ok=True)
    code = bundle()
    write('cashflow_linter.js', signed(code, d))
    built = datetime.now().strftime('%d.%m.%Y, %H:%M:%S')
    view = to_bookmarklet(loader_source({'APPLY': False}, key))
    apply = to_bookmarklet(loader_source({'APPLY': True}, key))
    connect = connect_bookmarklet(8765)
    write('Лінтер_кешфлоу_перегляд.bookmarklet.txt', view)
    write('Лінтер_кешфлоу_APPLY.bookmarklet.txt', apply)
    write('Підключити_Помічник.bookmarklet.txt', connect)
    attr = lambda s: html.escape(s, quote=True)
    write('встановлення.html', f"""<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>Лінтер кешфлоу — закладки</title>
<style>body{{font:15px/1.5 system-ui,Segoe UI,Arial;max-width:820px;margin:30px auto;padding:0 16px}}a.bm{{display:inline-block;padding:8px 14px;margin:6px 8px 6px 0;border-radius:8px;background:#0043ea;color:#fff;text-decoration:none;font-weight:600}}a.bm.apply{{background:#b00020}}a.bm.conn{{background:#0a7a2a}}code{{background:#f2f3f5;padding:1px 5px;border-radius:4px}}</style></head><body>
<h1>Лінтер кешфлоу — встановлення закладок</h1>
<ol><li>Увімкніть панель закладок: <code>Ctrl+Shift+B</code>.</li>
<li>Перетягніть потрібні кнопки мишкою на панель закладок (не натискайте їх тут).</li>
<li>Відкрийте <b>crm.example.com</b> під своїм логіном і натисніть закладку.</li>
<li>Закладка сама бере найновішу версію лінтера із запущеного «Помічника кешфлоу». Якщо Помічник не запущений і лінтер ще не запускався в цьому браузері — один раз попросить вибрати файл <code id="f">cashflow_linter.js</code> з цієї самої папки.</li></ol>
<p>Після оновлень лінтера закладки перетягувати заново не треба: закладка запускає лише код, підписаний ключем розробника, і новішу версію бере сама.</p>
<p><a class="bm" href="{attr(view)}">Лінтер кешфлоу</a> — перевірка без змін (dry-run).</p>
<p><a class="bm apply" href="{attr(apply)}">Лінтер кешфлоу (APPLY)</a> — те саме, але з режимом редагування (зміни лише після резервної копії й підтвердження).</p>
<p><a class="bm conn" href="{attr(connect)}">Підключити Помічник</a> — передає ваш вхід у CRM програмі «Помічник кешфлоу» (вона має бути запущена).</p>
<p>Закладки працюють у Firefox, Chrome і Edge. Зібрано {built}. Довжина закладок: перегляд {len(view)} символів, APPLY {len(apply)}.</p>
""" + PATH_SCRIPT + "</body></html>")
    print(f"dist: cashflow_linter.js {len(code.encode('utf-8'))} B, підписано; закладка {len(view)} символів; rules.json {json.loads(read('rules/rules.json'))['version']}")


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    main()
