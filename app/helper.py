#!/usr/bin/env python3
"""
Помічник кешфлоу — локальна програма для crm.example.com.

Що вміє:
  • лінтер кешфлоу за rules.json (перегляд за замовчуванням; режим редагування — з резервною
    копією, підтвердженням, журналом і відкатом);
  • сам тягне виписки Приват/Моно вашим скриптом privat_fetch.py і звіряє їх з кешфлоу;
  • ШІ-підказки (Claude API, з вашим ключем): стаття й проєкт для записів без правил і тижнева чернетка правил — app/helper_ai.py;
  • зберігає звіти, резервні копії й журнали в app/data.

Запуск: «Помічник кешфлоу.bat» (або python app/helper.py). Вікно браузера само не відкривається:
Enter у консолі відкриває http://127.0.0.1:8765 (або ключ --open — одразу). Сервер слухає лише 127.0.0.1 — ззовні недоступний.

Вхід у CRM: на сторінці crm.example.com натисніть закладку «Підключити Помічник»
(або вставте токен у «Налаштуваннях»). Токен зберігається зашифрованим (Windows DPAPI —
розшифрувати може лише ваш обліковий запис Windows) у app/data/crm_token.dat.
"""
import argparse
import base64
import ctypes
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import helper_ai as ai

VERSION = '1.0.0'
HERE = Path(__file__).resolve().parent          # app/
ROOT = HERE.parent                               # корінь проєкту: core/, ui/, rules/
STATIC = HERE / 'static'
DATA = HERE / 'data'
CRM_ORIGIN = 'https://crm.example.com'
DEFAULT_PORT = 8765
DEFAULT_BANK_DIR = Path.home() / 'Documents' / 'Звірка Приват'
MIN_INTERVAL = 0.3                               # ТЗ: не частіше 1 запиту на 300 мс
# Через проксі дозволено читати лише ці шляхи API, а змінювати — лише запис кешфлоу
GET_ALLOW = re.compile(r'^(invoice-payment(/\d+)?|invoice-payment-types|invoice|currency|pnl/(category(/\d+)?|operation/?|operation-config|operation-salary|group))$')
USER_PATH = re.compile(r'^user/(\d+)$')  # лише свій профіль і лише права на кешфлоу (user_rights_only)
PUT_ALLOW = re.compile(r'^invoice-payment/(\d+)$')
PUT_FIELDS = {'pnl_category_id', 'pnl_operation_id', 'project_id'}  # ТЗ, розділ 6
SAVE_KINDS = {'backups', 'journals', 'reports', 'bank'}
SAVE_EXT = {'.json', '.xlsx', '.csv'}
BANK_FILE = re.compile(r'^виписка_[^\\/:*?"<>|]+\.json$')
PANEL_PREFIX = '/api/panel/'                     # запити панелі лінтера зі сторінки CRM (лише Origin crm.example.com)
AI_BODY_MAX = 4 * 1024 * 1024                    # записи без правил для «Підказок ШІ» (до 1000)
DIST_LINTER = '/dist/cashflow_linter.js'         # підписаний лінтер: закладка на сторінці CRM бере його звідси (CORS лише для CRM)

KEY = secrets.token_urlsafe(24)                  # ключ сесії: лише сторінка, віддана цим сервером, знає його
QUIT_KEY = secrets.token_urlsafe(24)             # лише для зупинки (Оновити.bat читає його з data/run.json)
SERVER = [None]
STATE = {'token': None, 'user': None, 'port': DEFAULT_PORT, 'crm_base': CRM_ORIGIN}
LOCK = threading.Lock()
JOB_LOCK = threading.Lock()                      # один запуск privat_fetch.py за раз
_last_crm = [0.0]
JOB = {'running': False, 'log': [], 'code': None, 'file': None, 'started': None, 'args': None}
AI_MATCH = [0]                                   # скільки запитів «Зіставлення ШІ» зараз чекають на Claude (для /api/quit)
AI_MATCH_LOCK = threading.Lock()


def ai_busy():
    """ШІ зараз працює (07.11.2026): Claude уже рахує гроші за запит — зупинка Помічника перервала б його, витрата не врахувалася б,
    а після перезапуску ті самі записи пішли б і оплатились удруге."""
    with AI_MATCH_LOCK:
        matching = AI_MATCH[0] > 0
    return bool(ai.WORK['running'] or ai.INFLIGHT or ai.DRAFT_JOB['running'] or matching)


for _s in (sys.stdout, sys.stderr):  # консоль cp1251: невідомі символи → «?», а не виняток
    try:
        _s.reconfigure(errors='replace')
    except (AttributeError, ValueError):
        pass


def log(msg):
    try:
        print(f'[{datetime.now():%H:%M:%S}] {msg}', flush=True)
    except Exception:  # noqa: BLE001 — журнал у консолі ніколи не ламає запит
        pass


# ---------- налаштування ----------
def config_path():
    return DATA / 'config.json'


# config.json пишуть кілька потоків (вікно Помічника, ШІ у фоні): читати-змінити-записати — під замком, запис — цілим файлом
# (новий файл і заміна), інакше читання посеред запису давало {} і наступне збереження стирало решту налаштувань.
CONFIG_LOCK = threading.RLock()
REAL_HELPER = [False]                            # main() без --data: справжній Помічник (не тести й не пісочниці)


def load_config():
    for i in range(5):
        try:
            return json.loads(config_path().read_text(encoding='utf-8'))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):  # файл саме замінюють (Windows не дає відкрити його на мить) — ще раз
            if i < 4:
                time.sleep(0.03)
    return {}


def save_config(cfg):
    with CONFIG_LOCK:
        DATA.mkdir(parents=True, exist_ok=True)
        tmp = config_path().with_name('config.json.new')
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding='utf-8')
        ai.replace_file(tmp, config_path())


def bank_dir():
    return Path(load_config().get('bank_dir') or DEFAULT_BANK_DIR)


# ---------- токен: Windows DPAPI ----------
class _Blob(ctypes.Structure):
    _fields_ = [('cbData', ctypes.c_uint32), ('pbData', ctypes.POINTER(ctypes.c_char))]


def _dpapi(data, protect):
    if os.name != 'nt':
        raise OSError('DPAPI є лише у Windows')
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = _Blob()
    crypt32 = ctypes.windll.crypt32
    ok = (crypt32.CryptProtectData(ctypes.byref(blob_in), ctypes.c_wchar_p('cashflow-helper'), None, None, None, 1, ctypes.byref(blob_out))
          if protect else crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None, 1, ctypes.byref(blob_out)))
    if not ok:
        raise OSError('DPAPI: помилка ' + str(ctypes.GetLastError()))
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def token_file():
    return DATA / 'crm_token.dat'


def save_token(token):
    DATA.mkdir(parents=True, exist_ok=True)
    try:
        token_file().write_bytes(_dpapi(token.encode('utf-8'), True))
    except OSError as e:
        log(f'Токен не збережено на диск ({e}) — він діє до закриття програми')


def load_token():
    try:
        return _dpapi(token_file().read_bytes(), False).decode('utf-8')
    except (OSError, ValueError):
        return None


def forget_token():
    STATE['token'] = None
    STATE['user'] = None
    try:
        token_file().unlink()
    except OSError:
        pass


# ---------- CRM ----------
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Не йти за переадресацією: urllib передав би заголовок Authorization (токен) на іншу адресу."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def crm_request(method, path, body=None, token=None):
    """Запит до API CRM з токеном; не частіше 1 на 300 мс; 429 — пауза й повтор."""
    token = token or STATE['token']
    if not token:
        return 401, {'error': 'Помічник не підключено до CRM'}, ''
    url = STATE['crm_base'].rstrip('/') + '/api/' + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    for attempt in range(1, 8):
        with LOCK:
            wait = _last_crm[0] + MIN_INTERVAL - time.time()
            if wait > 0:
                time.sleep(wait)
            _last_crm[0] = time.time()
        req = urllib.request.Request(url, data=data, method=method, headers={
            'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'User-Agent': 'cashflow-helper/' + VERSION,
            **({'Content-Type': 'application/json'} if data is not None else {})})
        try:
            with _OPENER.open(req, timeout=90) as r:
                raw = r.read()
                status = r.status
        except urllib.error.HTTPError as e:
            with e:  # закрити відповідь (сервер працює довго — сокети не мають висіти до збирання сміття)
                raw, status = e.read(), e.code
            if status == 429 and attempt < 7:
                ra = e.headers.get('Retry-After')
                time.sleep(float(ra) if ra and ra.replace('.', '', 1).isdigit() else 2 * attempt)
                continue
        except urllib.error.URLError as e:
            return 502, {'error': f'CRM недоступний: {e.reason}'}, ''
        text = raw.decode('utf-8', 'replace')
        try:
            return status, json.loads(text), ''
        except ValueError:
            return status, None, text[:500]
    return 429, {'error': 'CRM: забагато запитів (429)'}, ''


def user_rights_only(j):
    """З профілю користувача CRM — лише роль і права на кешфлоу: токени й контакти з відповіді CRM далі не йдуть."""
    u = j.get('data') if isinstance(j, dict) and isinstance(j.get('data'), dict) else j
    if not isinstance(u, dict):
        return {}
    perms, role = u.get('permissions'), u.get('role')
    inv = perms.get('invoice') if isinstance(perms, dict) else None
    return {'id': u.get('id'), 'role': {'name': role.get('name')} if isinstance(role, dict) else None,
            'permissions': {'invoice': inv if isinstance(inv, dict) else {}}}


def check_token(token):
    """Чи приймає CRM токен (легкий запит — довідник валют)."""
    status, _, _ = crm_request('GET', 'currency', token=token)
    return status == 200


def set_token(token, user_id=None):
    token = (token or '').strip().strip('"')
    if not re.fullmatch(r'[!-~]{20,}', token):
        return False, 'це не схоже на токен CRM'
    if not check_token(token):
        return False, 'CRM не прийняв токен — увійдіть у CRM ще раз і повторіть'
    user = f'користувач {user_id}' if user_id and str(user_id).isdigit() else 'підключено'
    STATE['token'], STATE['user'] = token, user
    save_token(token)
    with CONFIG_LOCK:
        cfg = load_config()
        cfg['crm_user'] = user
        save_config(cfg)
    log(f'Підключено до CRM ({user})')
    return True, user


# ---------- виписки банку (privat_fetch.py) ----------
MONO_CCY_FLAG = '--mono-currency'  # privat_fetch.py з 06.11.2026: без ключа Моно — лише гривневі рахунки ФОП


def mono_currency():
    """Галочка «валютні рахунки Моно» в «Налаштуваннях» (за замовчуванням — ні: лише гривневі)."""
    return load_config().get('mono_currency') is True


def fetch_knows_flag(script):
    """Чи знає privat_fetch.py ключ --mono-currency (старіший вивантажує всі валюти й ключа не прийме)."""
    try:
        return MONO_CCY_FLAG in script.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return False


def bank_status():
    d = bank_dir()
    script = d / 'privat_fetch.py'
    clients = []
    try:
        clients = list(json.loads((d / 'privat_tokens.json').read_text(encoding='utf-8-sig')).keys())
    except (OSError, ValueError):
        pass
    return {'dir': str(d), 'script': script.exists(), 'tokens': (d / 'privat_tokens.json').exists(), 'clients': clients,
            'mono_currency': mono_currency(), 'mono_flag': script.exists() and fetch_knows_flag(script)}


def dmy(iso):
    y, m, d = iso.split('-')
    return f'{d}.{m}.{y}'


def run_bank_fetch(d_from, d_to):
    d = bank_dir()
    JOB.update(running=True, log=[], code=None, file=None, started=datetime.now().isoformat(timespec='seconds'), args=[d_from, d_to])
    try:
        env = dict(os.environ, PYTHONUTF8='1', PYTHONIOENCODING='utf-8', PYTHONUNBUFFERED='1')  # журнал наживо, а не наприкінці
        script = d / 'privat_fetch.py'
        # валютні рахунки Моно — лише з галочкою; старіший скрипт ключа не знає (і так вивантажує всі валюти)
        fx = [MONO_CCY_FLAG] if mono_currency() and fetch_knows_flag(script) else []
        p = subprocess.Popen([sys.executable, str(script), dmy(d_from), dmy(d_to), *fx], cwd=str(d), env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        for line in iter(p.stdout.readline, b''):
            JOB['log'].append(line.decode('utf-8', 'replace').rstrip())
            JOB['log'] = JOB['log'][-400:]
        JOB['code'] = p.wait()
        f = d / f'виписка_ВСІ_{dmy(d_from)}_{dmy(d_to)}.json'
        JOB['file'] = f.name if f.exists() and f.stat().st_mtime >= time.time() - 24 * 3600 else None
    except Exception as e:  # noqa: BLE001 — показати будь-яку помилку в журналі вкладки
        JOB['log'].append(f'ПОМИЛКА: {e}')
        JOB['code'] = -1
    finally:
        JOB['running'] = False


def start_bank_fetch(data):
    """Запустити privat_fetch.py за період {from, to} (РРРР-ММ-ДД) у фоні. → (HTTP-статус, відповідь)."""
    with JOB_LOCK:
        if JOB['running']:
            return 409, {'error': 'вивантаження вже триває'}
        d_from, d_to = data.get('from'), data.get('to')
        if not all(isinstance(x, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', x) for x in (d_from, d_to)) or d_from > d_to:
            return 400, {'error': 'перевірте період'}
        if not (bank_dir() / 'privat_fetch.py').exists():
            return 400, {'error': f'немає privat_fetch.py у папці {bank_dir()} — вкажіть папку в Налаштуваннях Помічника'}
        JOB.update(running=True, log=[], code=None, file=None)  # одразу «триває», щоб не стартувати двічі
        threading.Thread(target=run_bank_fetch, args=(d_from, d_to), daemon=True).start()
        return 200, {'ok': True}


def dist_build():
    """Мітка CF_BUILD лінтера в dist/ — панель на сторінці CRM підкаже, якщо тут новіша збірка, ніж відкрита в неї."""
    try:
        m = re.search(r"\nvar CF_BUILD = '([^']*)';", (ROOT / 'dist' / 'cashflow_linter.js').read_text(encoding='utf-8'))
        return m.group(1) if m else None
    except OSError:
        return None


def bank_files():
    d = bank_dir()
    out = []
    for f in sorted(d.glob('виписка_*.json'), key=lambda x: x.stat().st_mtime, reverse=True):
        m = re.search(r'(\d{2}\.\d{2}\.\d{4})_(\d{2}\.\d{2}\.\d{4})', f.name)
        out.append({'name': f.name, 'size': f.stat().st_size, 'mtime': datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec='minutes'),
                    'from': m.group(1) if m else None, 'to': m.group(2) if m else None, 'all': f.name.startswith('виписка_ВСІ_')})
    return out


# ---------- правила «Статей і проєктів»: зміна rules.json у вкладці «Правила» ----------
# Змінювати можна лише на комп'ютері з ключем підпису збірок (у розробника): після збереження лінтер перезбирається й
# підписується, закладка бере нову збірку з Помічника, колега отримує її через «Опублікувати оновлення» → «Оновити».
SEMVER = re.compile(r'^\s*(\d+)\.(\d+)\.(\d+)')
RULES_LOCK = threading.Lock()


def rules_path():
    return ROOT / 'rules' / 'rules.json'


def rules_archive():
    return ROOT / 'rules' / 'архів'


def _build_module(name):
    if str(ROOT / 'build') not in sys.path:
        sys.path.insert(0, str(ROOT / 'build'))
    return __import__(name)


def can_edit_rules():
    try:
        return _build_module('sign').key_path().is_file()
    except Exception:
        return False


def rules_versions():
    out = []
    files = sorted(rules_archive().glob('rules_*.json'), key=lambda x: x.stat().st_mtime, reverse=True) if rules_archive().is_dir() else []
    for f in files[:40]:
        try:
            v = json.loads(f.read_text(encoding='utf-8')).get('version', '')
        except (OSError, ValueError):
            v = '?'
        out.append({'name': f.name, 'version': v, 'mtime': datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec='minutes')})
    return out


def bump_version(old, note):
    m = SEMVER.match(str(old or ''))
    a, b, c = (int(x) for x in m.groups()) if m else (1, 0, 0)
    note = re.sub(r'\s+', ' ', str(note or '')).strip()[:120] or 'зміни у вкладці «Правила» Помічника'
    return f'{a}.{b}.{c + 1} ({datetime.now():%d.%m.%Y}, {note})'


def rebuild_linter():
    """Перезібрати dist/: підписаний лінтер з новими правилами (закладка візьме його з Помічника).
    Окремим процесом (07.11.2026): build.py, імпортований сюди, лишався б тим, що був при першому збереженні, — Помічник працює
    днями, а перелік частин і латок реєстру в build.py змінюється; стара копія підписала б збірку без нових частин."""
    r = subprocess.run([sys.executable, str(ROOT / 'build' / 'build.py')], cwd=str(ROOT), capture_output=True, text=True,
                       encoding='utf-8', errors='replace', env=dict(os.environ, PYTHONIOENCODING='utf-8'),
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if r.returncode != 0:
        out = ((r.stderr or '').strip() or (r.stdout or '').strip())[-800:]
        raise RuntimeError(out or f'збірка завершилась з кодом {r.returncode}')


def save_rules(doc, note):
    """Записати rules.json новою версією: попередня — в rules/архів, лінтер перезбирається. Не вдалося зібрати — файл повертається."""
    if not can_edit_rules():
        return 403, {'error': "на цьому комп'ютері немає ключа підпису збірок — правила змінює власник лінтера, а сюди вони приходять оновленням"}
    if not isinstance(doc, dict) or not isinstance(doc.get('rules'), list) or not all(isinstance(r, dict) and isinstance(r.get('id'), str) for r in doc['rules']):
        return 400, {'error': 'очікується rules.json з полем rules — списком правил з id'}
    cards = (doc.get('reference') or {}).get('cards', []) if isinstance(doc.get('reference') or {}, dict) else None
    if not isinstance(cards, list) or not all(isinstance(c, dict) and re.fullmatch(r'\d{4}', str(c.get('last4', ''))) and type(c.get('account_id')) is int
                                              and c['account_id'] > 0 and not c.get('local') for c in cards):
        return 400, {'error': 'reference.cards: у кожної картки — last4 (4 останні цифри) і account_id (ID рахунку CRM)'}
    if len({str(c['last4']) for c in cards}) != len(cards):
        return 400, {'error': 'reference.cards: та сама картка двічі'}
    with RULES_LOCK:
        p = rules_path()
        old_text = p.read_text(encoding='utf-8')
        old = json.loads(old_text)
        doc = dict(doc, version=bump_version(old.get('version'), note), updated=datetime.now().strftime('%Y-%m-%d'))
        m = SEMVER.match(str(old.get('version') or ''))
        name = f"rules_{'.'.join(m.groups()) if m else 'old'}_{datetime.now():%Y%m%d-%H%M%S}.json"
        rules_archive().mkdir(parents=True, exist_ok=True)
        (rules_archive() / name).write_text(old_text, encoding='utf-8')
        tmp = p.with_name('rules.json.new')
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')  # той самий вигляд, що й у генератора правил
        os.replace(tmp, p)
        try:
            rebuild_linter()
        except BaseException as e:  # зокрема SystemExit зі збірки
            p.write_text(old_text, encoding='utf-8')
            return 500, {'error': f'лінтер не перезібрано ({e}) — rules.json повернуто до попередньої версії'}
        log(f'Правила: збережено {doc["version"]}; попередня версія — rules/архів/{name}')
        return 200, {'ok': True, 'version': doc['version'], 'archived': name}


def restore_rules(name):
    if not isinstance(name, str) or not re.fullmatch(r'rules_[\w.\-]+\.json', name):
        return 400, {'error': 'неприпустима назва файлу'}
    f = rules_archive() / name
    if not f.is_file():
        return 404, {'error': 'такої версії в архіві немає'}
    doc = json.loads(f.read_text(encoding='utf-8'))
    m = SEMVER.match(str(doc.get('version') or ''))
    return save_rules(doc, f"відновлено версію {'.'.join(m.groups()) if m else name}")


# ШІ-підказки: ключ API шифрується тим самим DPAPI, що й токен CRM; правила для довідника моделі — rules/rules.json
ai.setup(data=lambda: DATA, dpapi=_dpapi, log=log, load_config=load_config, save_config=save_config, rules_path=rules_path,
         format_path=lambda: ROOT / 'rules' / 'ФОРМАТ_ПРАВИЛ.md', can_edit_rules=can_edit_rules, config_lock=CONFIG_LOCK,
         # «Кешфлоу ШІ» на Google Диску шукає сам лише запущений Помічник зі своєю папкою даних: main() без --data. Тести лише
         # імпортують helper.py — 07.11.2026 через це вони писали вигадані витрати в справжню спільну папку.
         auto_shared=lambda: REAL_HELPER[0])


def start_publish():
    bat = ROOT / 'Опублікувати оновлення.bat'
    if os.name != 'nt' or not bat.is_file():
        return 400, {'error': "немає «Опублікувати оновлення.bat» — публікують з комп'ютера власника лінтера"}
    subprocess.Popen(['cmd.exe', '/c', str(bat)], cwd=str(ROOT), creationflags=subprocess.CREATE_NEW_CONSOLE)
    return 200, {'ok': True}


# ---------- файли програми ----------
def safe_name(name):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', '_', str(name)).strip(' .')
    return name[:150] or 'file'


def kind_for(name):
    n = name.lower()
    if 'резервна' in n or 'backup' in n:
        return 'backups'
    if 'журнал' in n or 'journal' in n:
        return 'journals'
    return 'reports'


# панель лінтера на сторінці CRM зберігає сюди резервні копії й журнали (без вікна «Зберегти як» у браузері)
PANEL_SAVE_KINDS = {'backups', 'journals'}
PANEL_SAVE_NAME = re.compile(r'^кешфлоу_[^\\/:*?"<>|\x00-\x1f]{1,140}\.(json|xlsx)$')
PANEL_SAVE_MAX = 25 * 1024 * 1024


def save_file(name, kind, b64, kinds=SAVE_KINDS):
    """Файл у папку даних Помічника: DATA/<kind>/<name>; така сама назва вже є — з часом у назві."""
    name = safe_name(name)
    kind = kind or kind_for(name)
    if kind not in kinds:
        return 400, {'error': 'невідомий тип файлу'}
    if Path(name).suffix.lower() not in SAVE_EXT:
        return 400, {'error': 'зберігаються лише .json, .xlsx і .csv'}
    try:
        raw = base64.b64decode(b64 or '', validate=True)
    except ValueError:
        return 400, {'error': 'файл пошкоджено (base64)'}
    target = DATA / kind / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target = target.with_name(f'{target.stem}_{datetime.now():%H%M%S}{target.suffix}')
    target.write_bytes(raw)
    log(f'Збережено {kind}/{target.name} ({len(raw)} байт)')
    return 200, {'ok': True, 'path': str(target), 'dir': str(target.parent), 'name': target.name, 'kind': kind}


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    server_version = 'CashflowHelper/' + VERSION

    def log_message(self, fmt, *args):
        if not self.path.startswith(('/api/bank/job', '/static', '/core', '/ui', '/api/panel/ai/', '/api/ai/status', '/api/ai/hints')):
            log('%s %s' % (self.command, self.path.split('?')[0][:80]))

    # --- відповіді ---
    def end_headers(self):
        # сторінку Помічника не можна вбудувати в чужий сайт (клікджекінг кнопок «Застосувати» / «Відкат»)
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "frame-ancestors 'none'")
        super().end_headers()

    def send_json(self, status, obj, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype, extra=None):
        data = path.read_bytes()
        if path.name == 'index.html':
            data = data.replace(b'__HELPER_KEY__', KEY.encode()).replace(b'__HELPER_VERSION__', VERSION.encode())
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def read_body(self, limit=60 * 1024 * 1024):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            raise ValueError('неправильна довжина запиту')
        if n < 0 or n > limit:  # від'ємна довжина — rfile.read(-1) чекав би, доки клієнт закриє з'єднання
            raise ValueError('неправильна довжина запиту' if n < 0 else 'завеликий запит')
        return self.rfile.read(n) if n else b''

    # --- захист ---
    def host_ok(self):
        host = (self.headers.get('Host') or '').lower()
        return host in (f'127.0.0.1:{STATE["port"]}', f'localhost:{STATE["port"]}')

    def local_origin_ok(self):
        o = self.headers.get('Origin')
        return o is None or o in (f'http://127.0.0.1:{STATE["port"]}', f'http://localhost:{STATE["port"]}')

    def key_ok(self):
        return secrets.compare_digest(self.headers.get('X-Helper-Key') or '', KEY) and self.local_origin_ok()

    def cors_crm(self, methods='POST, OPTIONS'):
        return {'Access-Control-Allow-Origin': CRM_ORIGIN, 'Access-Control-Allow-Private-Network': 'true',
                'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': methods, 'Vary': 'Origin'}

    def panel_ok(self):
        # панель лінтера на сторінці CRM (закладка): лише з crm.example.com — браузер не дасть іншому сайту підставити Origin
        return self.headers.get('Origin') == CRM_ORIGIN

    # --- маршрути ---
    def do_OPTIONS(self):
        panel = self.path.split('?')[0].startswith(PANEL_PREFIX)
        dist = self.path.split('?')[0] == DIST_LINTER
        if (self.path == '/api/connect' or panel or dist) and self.headers.get('Origin') == CRM_ORIGIN:
            self.send_response(204)
            for k, v in self.cors_crm('GET, POST, OPTIONS' if panel else 'GET, OPTIONS' if dist else 'POST, OPTIONS').items():
                self.send_header(k, v)
            self.end_headers()
        else:
            self.send_response(403)
            self.end_headers()

    def panel_get(self, p, q):
        """Виписки для вкладки «Звірка з банком» панелі лінтера на сторінці CRM: стан, файли, хід вивантаження, файл."""
        if not self.panel_ok():
            return self.send_json(403, {'error': 'дозволено лише зі сторінки crm.example.com'})
        cors = self.cors_crm('GET, POST, OPTIONS')
        if p == '/api/panel/bank/status':
            return self.send_json(200, {'ok': True, 'app': 'cashflow-helper', 'version': VERSION, 'linter': dist_build(), 'bank': bank_status(), 'job': JOB}, cors)
        if p == '/api/panel/bank/files':
            return self.send_json(200, {'files': bank_files()}, cors)
        if p == '/api/panel/bank/job':
            return self.send_json(200, JOB, cors)
        if p == '/api/panel/bank/file':
            name = (q.get('name') or [''])[0]
            if not BANK_FILE.match(name):
                return self.send_json(400, {'error': 'неприпустима назва файлу'}, cors)
            f = bank_dir() / name
            if not f.is_file():
                return self.send_json(404, {'error': 'файл не знайдено'}, cors)
            return self.send_file(f, 'application/json; charset=utf-8', cors)
        return self.send_json(404, {'error': 'невідомий запит'}, cors)

    def do_GET(self):
        if not self.host_ok():
            return self.send_json(403, {'error': 'host'})
        url = urllib.parse.urlsplit(self.path)
        p, q = url.path, urllib.parse.parse_qs(url.query)
        if p in ('/', '/index.html'):
            return self.send_file(STATIC / 'index.html', 'text/html; charset=utf-8')
        if p == '/api/ping':
            return self.send_json(200, {'ok': True, 'app': 'cashflow-helper', 'version': VERSION})
        for prefix, base in (('/static/', STATIC), ('/core/', ROOT / 'core'), ('/ui/', ROOT / 'ui'), ('/rules/', ROOT / 'rules'), ('/dist/', ROOT / 'dist')):
            if p.startswith(prefix):
                f = (base / urllib.parse.unquote(p[len(prefix):])).resolve()
                if base.resolve() in f.parents and f.is_file():
                    ctype = {'.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
                             '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png'}.get(f.suffix, 'application/octet-stream')
                    # лінтер для закладки на сторінці CRM: читати відповідь дозволено лише їй (код підписаний — закладка перевіряє підпис)
                    crm = p == DIST_LINTER and self.headers.get('Origin') == CRM_ORIGIN
                    return self.send_file(f, ctype, self.cors_crm('GET, OPTIONS') if crm else None)
                return self.send_json(404, {'error': 'немає файлу'})
        if not p.startswith('/api/'):
            return self.send_json(404, {'error': 'не знайдено'})
        if p.startswith(PANEL_PREFIX):
            return self.panel_get(p, q)
        if not self.key_ok():
            return self.send_json(403, {'error': 'немає ключа сесії — відкрийте Помічник з його вікна'})
        if p == '/api/rules/meta':
            return self.send_json(200, {'canEdit': can_edit_rules(), 'versions': rules_versions(), 'publish': (ROOT / 'Опублікувати оновлення.bat').is_file()})
        if p == '/api/ai/status':
            return self.send_json(200, ai.status())
        if p == '/api/ai/drafts':
            return self.send_json(200, ai.drafts())
        if p == '/api/status':
            return self.send_json(200, {'version': VERSION, 'crm': {'connected': bool(STATE['token']), 'user': STATE['user'], 'saved': token_file().exists()},
                                        'bank': bank_status(), 'data_dir': str(DATA), 'config': load_config()})
        if p.startswith('/api/crm/'):
            path = p[len('/api/crm/'):]
            own = USER_PATH.match(path)
            if own and own.group(1) != (re.findall(r'\d+', STATE['user'] or '') or [''])[0]:
                return self.send_json(403, {'error': 'можна читати лише права підключеного користувача'})
            if not own and not GET_ALLOW.match(path):
                return self.send_json(403, {'error': f'шлях {path} не дозволено'})
            full = path + ('?' + url.query if url.query else '')
            status, j, text = crm_request('GET', full)
            if status == 401:
                STATE['user'] = None
            if own and j is not None:
                j = user_rights_only(j)
            return self.send_json(status, j if j is not None else {'error': text})
        if p == '/api/bank/job':
            return self.send_json(200, JOB)
        if p == '/api/bank/files':
            return self.send_json(200, {'dir': str(bank_dir()), 'files': bank_files()})
        if p == '/api/bank/file':
            name = (q.get('name') or [''])[0]
            if not BANK_FILE.match(name):
                return self.send_json(400, {'error': 'неприпустима назва файлу'})
            f = bank_dir() / name
            if not f.is_file():
                return self.send_json(404, {'error': 'файл не знайдено'})
            return self.send_file(f, 'application/json; charset=utf-8')
        if p == '/api/files/list':
            out = []
            for kind in sorted(SAVE_KINDS):
                for f in sorted((DATA / kind).glob('*'), key=lambda x: x.stat().st_mtime, reverse=True)[:200]:
                    out.append({'kind': kind, 'name': f.name, 'size': f.stat().st_size, 'mtime': datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec='minutes')})
            return self.send_json(200, {'dir': str(DATA), 'files': out})
        if p == '/api/files/get':
            kind, name = (q.get('kind') or [''])[0], safe_name((q.get('name') or [''])[0])
            f = DATA / kind / name
            if kind not in SAVE_KINDS or not f.is_file():
                return self.send_json(404, {'error': 'файл не знайдено'})
            return self.send_file(f, 'application/octet-stream')
        return self.send_json(404, {'error': 'невідомий запит'})

    def do_POST(self):
        if not self.host_ok():
            return self.send_json(403, {'error': 'host'})
        p = urllib.parse.urlsplit(self.path).path
        try:
            body = self.read_body()
        except ValueError as e:
            return self.send_json(413, {'error': str(e)})
        if p == '/api/quit':
            # «Оновити.bat»: зупинити Помічник перед заміною файлів (ключ — у data/run.json; браузерні сторінки його не знають)
            if self.headers.get('Origin') is not None or not secrets.compare_digest(self.headers.get('X-Quit-Key') or '', QUIT_KEY):
                return self.send_json(403, {'error': 'немає ключа'})
            if JOB['running']:
                return self.send_json(409, {'error': 'Помічник вивантажує виписки — дочекайтеся завершення'})
            if ai.SDK_JOB['running']:
                return self.send_json(409, {'error': 'Помічник встановлює пакет anthropic для ШІ-підказок — дочекайтеся завершення'})
            if ai_busy():
                return self.send_json(409, {'error': 'Помічник чекає відповіді ШІ (Claude) — дочекайтеся завершення'})
            threading.Thread(target=SERVER[0].shutdown, daemon=True).start()
            return self.send_json(200, {'ok': True})
        if p == '/api/connect':
            # закладка «Підключити Помічник» з crm.example.com
            if self.headers.get('Origin') != CRM_ORIGIN:
                return self.send_json(403, {'error': 'дозволено лише з crm.example.com'})
            try:
                msg = json.loads(body or b'{}')
            except ValueError:
                msg = {}
            ok, info = set_token(msg.get('token'), msg.get('user_id'))
            return self.send_json(200 if ok else 400, {'ok': ok, 'user': info if ok else None, 'error': None if ok else info}, self.cors_crm())
        if p == '/api/panel/bank/fetch':
            # панель лінтера на сторінці CRM просить вивантажити виписки за період
            if not self.panel_ok():
                return self.send_json(403, {'error': 'дозволено лише зі сторінки crm.example.com'})
            try:
                msg = json.loads(body or b'{}')
            except ValueError:
                msg = {}
            status, obj = start_bank_fetch(msg if isinstance(msg, dict) else {})
            return self.send_json(status, obj, self.cors_crm('GET, POST, OPTIONS'))
        if p == '/api/panel/files/save':
            # панель лінтера: резервна копія чи журнал — у папку даних Помічника, а не завантаженням браузера (без вікна «Зберегти як»)
            cors = self.cors_crm('GET, POST, OPTIONS')
            if not self.panel_ok():
                return self.send_json(403, {'error': 'дозволено лише зі сторінки crm.example.com'})
            if len(body) > PANEL_SAVE_MAX:
                return self.send_json(413, {'error': 'завеликий файл'}, cors)
            try:
                msg = json.loads(body or b'{}')
            except ValueError:
                msg = {}
            msg = msg if isinstance(msg, dict) else {}
            if not PANEL_SAVE_NAME.match(str(msg.get('name') or '')):
                return self.send_json(400, {'error': 'неприпустима назва файлу'}, cors)
            status, obj = save_file(msg.get('name'), msg.get('kind'), msg.get('base64'), PANEL_SAVE_KINDS)
            return self.send_json(status, obj, cors)
        if p in ('/api/panel/ai/hints', '/api/panel/ai/match'):
            # «Підказки ШІ» («Статті й проєкти»: відомі відповіді — одразу, решта йде в Claude у фоні) і «Зіставлення ШІ» («Звірка з
            # банком»: на кнопку, панель чекає відповіді) — зі сторінки CRM; ключ API — лише тут
            cors = self.cors_crm('GET, POST, OPTIONS')
            if not self.panel_ok():
                return self.send_json(403, {'error': 'дозволено лише зі сторінки crm.example.com'})
            if len(body) > AI_BODY_MAX:
                return self.send_json(413, {'error': 'завеликий запит'}, cors)
            try:
                msg = json.loads(body or b'{}')
            except ValueError:
                msg = {}
            msg = msg if isinstance(msg, dict) else {}
            if p == '/api/panel/ai/hints':
                status, obj = ai.hints_request(msg)
            else:
                with AI_MATCH_LOCK:
                    AI_MATCH[0] += 1
                try:
                    status, obj = ai.match_request(msg)
                finally:
                    with AI_MATCH_LOCK:
                        AI_MATCH[0] -= 1
            return self.send_json(status, obj, cors)
        if not self.key_ok():
            return self.send_json(403, {'error': 'немає ключа сесії'})
        try:
            data = json.loads(body or b'{}')
        except ValueError:
            return self.send_json(400, {'error': 'очікується JSON'})
        if p == '/api/rules/save':
            return self.send_json(*save_rules(data.get('doc'), data.get('note')))
        if p == '/api/rules/restore':
            return self.send_json(*restore_rules(data.get('name')))
        if p == '/api/rules/publish':
            return self.send_json(*start_publish())
        # ШІ-підказки: ключ і налаштування — лише з вікна Помічника (ключ назад не віддається)
        if p == '/api/ai/key':
            return self.send_json(*ai.set_key(data.get('key')))
        if p == '/api/ai/forget':
            ai.forget_key()
            return self.send_json(200, {'ok': True})
        if p == '/api/ai/config':
            return self.send_json(*ai.set_config(data))
        if p == '/api/ai/hints':
            return self.send_json(*ai.hints_request(data))
        if p == '/api/ai/sdk':
            return self.send_json(*ai.start_sdk_install())
        if p == '/api/ai/draft':
            return self.send_json(*ai.start_draft())
        if p == '/api/ai/drafts/mark':
            return self.send_json(*ai.mark_draft(data.get('i'), data.get('status'), data.get('at'), data.get('id')))
        if p == '/api/token':
            ok, info = set_token(data.get('token'))
            return self.send_json(200 if ok else 400, {'ok': ok, 'user': info if ok else None, 'error': None if ok else info})
        if p == '/api/logout':
            forget_token()
            return self.send_json(200, {'ok': True})
        if p == '/api/config':
            with CONFIG_LOCK:
                cfg = load_config()
                if 'bank_dir' in data:
                    bd = str(data['bank_dir'] or '').strip()
                    # папка виписок — не всередині даних Помічника (туди пише /api/files/save)
                    if bd and (Path(bd).resolve() == DATA.resolve() or DATA.resolve() in Path(bd).resolve().parents):
                        return self.send_json(400, {'error': 'папка виписок не може бути всередині папки даних Помічника'})
                    cfg['bank_dir'] = bd
                if 'account_map' in data:
                    am = data['account_map']
                    if not isinstance(am, dict) or not all(isinstance(k, str) and isinstance(v, int) for k, v in am.items()):
                        return self.send_json(400, {'error': 'account_map: очікується {IBAN: id рахунку}'})
                    cfg['account_map'] = am
                if 'mono_currency' in data:
                    if not isinstance(data['mono_currency'], bool):
                        return self.send_json(400, {'error': 'mono_currency: очікується так/ні'})
                    cfg['mono_currency'] = data['mono_currency']
                save_config(cfg)
            return self.send_json(200, {'ok': True, 'config': cfg})
        if p == '/api/bank/fetch':
            return self.send_json(*start_bank_fetch(data))
        if p == '/api/files/save':
            return self.send_json(*save_file(data.get('name'), data.get('kind'), data.get('base64')))
        if p == '/api/files/open':
            kind = data.get('kind')
            folder = DATA / kind if kind in SAVE_KINDS else (bank_dir() if kind == 'bankdir' else DATA)
            folder.mkdir(parents=True, exist_ok=True)
            if os.name == 'nt':
                os.startfile(str(folder))  # noqa: S606 — відкрити папку у Провіднику
            return self.send_json(200, {'ok': True, 'path': str(folder)})
        return self.send_json(404, {'error': 'невідомий запит'})

    def do_PUT(self):
        if not self.host_ok() or not self.key_ok():
            return self.send_json(403, {'error': 'немає ключа сесії'})
        p = urllib.parse.urlsplit(self.path).path
        if self.headers.get('X-Helper-Edit') != '1':
            return self.send_json(403, {'error': 'зміни дозволені лише в режимі редагування'})
        path = p[len('/api/crm/'):] if p.startswith('/api/crm/') else ''
        if not PUT_ALLOW.match(path):
            return self.send_json(403, {'error': f'змінювати {path} не дозволено'})
        try:
            data = json.loads(self.read_body() or b'{}')
        except ValueError:
            return self.send_json(400, {'error': 'очікується JSON'})
        if not isinstance(data, dict) or not data:
            return self.send_json(400, {'error': 'очікується JSON-об\'єкт зі зміненими полями'})
        bad = set(data) - PUT_FIELDS
        if bad:
            return self.send_json(400, {'error': 'лінтер змінює лише статтю і проєкт; заборонені поля: ' + ', '.join(sorted(map(str, bad)))})
        if not all(re.fullmatch(r'\d{1,9}', str(v)) and not isinstance(v, bool) for v in data.values()):
            return self.send_json(400, {'error': 'значення полів — лише id (цілі числа)'})
        if ('pnl_category_id' in data) != ('pnl_operation_id' in data):
            return self.send_json(400, {'error': 'стаття змінюється парою pnl_category_id + pnl_operation_id'})
        status, j, text = crm_request('PUT', path, data)
        log(f'PUT {path} {json.dumps(data, ensure_ascii=False)} → {status}')
        return self.send_json(status, j if j is not None else {'error': text})


def find_app_browser():
    cands = [os.path.expandvars(p) for p in (
        r'%ProgramFiles%\Google\Chrome\Application\chrome.exe', r'%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe',
        r'%LocalAppData%\Google\Chrome\Application\chrome.exe', r'%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe',
        r'%ProgramFiles%\Microsoft\Edge\Application\msedge.exe')]
    return next((c for c in cands if os.path.isfile(c)), None)


def open_window(url):
    exe = find_app_browser()
    try:
        if exe:
            subprocess.Popen([exe, f'--app={url}', '--window-size=1400,900'])
            return
    except OSError:
        pass
    webbrowser.open(url)


def already_running(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/ping', timeout=2) as r:
            return json.loads(r.read()).get('app') == 'cashflow-helper'
    except (OSError, ValueError):
        return False


def open_on_enter(url):
    """Вікно Помічника — лише на вимогу: Enter у консолі відкриває його (за замовчуванням нічого не відкривається)."""
    if not sys.stdin or not sys.stdin.isatty():
        return
    def loop():
        try:
            for _ in sys.stdin:
                open_window(url)
        except (OSError, ValueError):
            pass
    threading.Thread(target=loop, daemon=True).start()


def main(argv=None):
    ap = argparse.ArgumentParser(description='Помічник кешфлоу')
    ap.add_argument('--port', type=int, default=int(load_config().get('port') or DEFAULT_PORT))
    ap.add_argument('--open', action='store_true', help='одразу відкрити вікно Помічника в браузері')
    ap.add_argument('--no-browser', action='store_true', help='(за замовчуванням і так не відкривається; лишено для сумісності)')
    ap.add_argument('--crm-base', default=CRM_ORIGIN, help='лише для тестів (мок CRM)')
    ap.add_argument('--data', help='інша папка даних (для тестів)')
    ap.add_argument('--ai-fake', action='store_true', help='лише для тестів: ШІ-підказки від test/fake_anthropic.py замість Claude API')
    a = ap.parse_args(argv)
    global DATA
    if a.data:
        DATA = Path(a.data).resolve()
    REAL_HELPER[0] = not a.data and not a.ai_fake
    if a.ai_fake:
        sys.path.insert(0, str(ROOT / 'test'))
        ai.CLIENT_FACTORY[0] = __import__('fake_anthropic').make_client
    STATE['port'], STATE['crm_base'] = a.port, a.crm_base
    url = f'http://127.0.0.1:{a.port}/'
    if already_running(a.port):
        print(f'Помічник уже запущено: {url}')
        if a.open:
            open_window(url)
        elif sys.stdin and sys.stdin.isatty() and not a.no_browser:
            try:
                input('Щоб відкрити його вікно, натисніть Enter (або просто закрийте це вікно). ')
                open_window(url)
            except (EOFError, KeyboardInterrupt):
                pass
        return 0
    DATA.mkdir(parents=True, exist_ok=True)
    tok = load_token()
    if tok:
        if check_token(tok):
            STATE['token'], STATE['user'] = tok, load_config().get('crm_user') or 'підключено'
            log('Вхід у CRM відновлено')
        else:
            log('Збережений токен CRM більше не діє — підключіться знову')
    srv = SERVER[0] = ThreadingHTTPServer(('127.0.0.1', a.port), Handler)
    run = DATA / 'run.json'  # для «Оновити.bat»: як зупинити саме цей Помічник
    run.write_text(json.dumps({'pid': os.getpid(), 'port': a.port, 'quit_key': QUIT_KEY}), encoding='utf-8')
    print(f'Помічник кешфлоу {VERSION}: {url}  (закрийте це вікно, щоб зупинити)', flush=True)
    ai.start_scheduler()  # тижнева чернетка правил від ШІ (лише якщо ШІ налаштовано й тут можна змінювати правила)
    if a.open:
        threading.Timer(0.6, open_window, args=(url,)).start()
    elif sys.stdin and sys.stdin.isatty():  # --no-browser тут нічого не вимикає (07.11.2026): і після «Оновити.bat» Enter відкриває вікно
        print('Вікно Помічника не відкривається само: щоб відкрити його, натисніть тут Enter.', flush=True)
        open_on_enter(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        try:
            if json.loads(run.read_text(encoding='utf-8')).get('pid') == os.getpid():
                run.unlink()
        except (OSError, ValueError):
            pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
