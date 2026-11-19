"""
ШІ-підказки «Помічника кешфлоу» (Claude API, з 03.11.2026).

  • Щодня — Claude Sonnet 5.5 (з 05.11.2026; до того — Haiku 5.5, його підказки лишаються): для записів, яких не покриває
    жодне правило лінтера, підказує статтю й проєкт з коротким поясненням. Підказки видно в «Статтях і проєктах» (картка «Підказки ШІ»); змінює запис людина —
    «Взяти статтю» / «Взяти проєкт» і «Застосувати вибране», як у «Підказках з історії». Те саме — для операцій «Внести в CRM»
    у «Звірці з банком», яким лінтер не визначив статті ні за правилами, ні з історії рахунку («Взяти» в рядку). Відповідь
    пам'ятається (app/data/ai), тож кожен запис іде в Claude один раз — доки не змінять його коментар, суму чи рахунок.
  • Раз на тиждень — Claude Opus 5.5 (з 05.11.2026; до того — Sonnet 5.5): переглядає, де лінтер (правила) і щоденний ШІ не впоралися —
    ШІ запропонував іншу статтю, ніж поставила людина, чи вагався; запис без правил; операція банку без статті, — і складає чернетку
    нових правил чи змін чинних для rules.json (вкладка «Правила» Помічника). У чернетку правил правило потрапляє лише кнопкою,
    у файл — лише «Зберегти зміни».
  • «Зіставлення ШІ» у «Звірці з банком» (з 05.11.2026, на кнопку) — щоденна модель: операції банку, яких лінтер не зіставив
    з погодженнями реєстру сам, ↔ погодження, що лишились (match_request). Лише підказки з поясненням.

ШІ нічого не змінює в CRM. Назовні йдуть дата, тип, сума, рахунок, коментар, стаття й проєкт запису без правил; з коментаря
й назви рахунку перед відправкою прибрано IBAN, номери карток, довгі номери (ІПН, ЄДРПОУ, рахунки), телефони й e-mail.
Ключ API — лише тут, зашифрований Windows DPAPI (app/data/anthropic_key.dat): у закладку й на сторінку CRM він не потрапляє.
Місячний ліміт (за замовчуванням $100 — увесь місячний кредит API підписки; до 05.11.2026 — $10) витрачається рівномірно: на
сьогодні — частка ліміту за дні місяця, що минули, і 10 % запасу (pace_cap), тож у перший тиждень увесь кредит не піде. Досягнуто
частки — нові запити стоять до завтра, ліміту — до наступного місяця.
Пакет anthropic (офіційний SDK Claude) Помічник ставить сам, коли вперше зберігають ключ.
"""
import calendar
import hashlib
import importlib
import json
import os
import re
import site
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

# 05.11.2026, зміна: щодня — Sonnet (було Haiku), раз на тиждень — Opus (було Sonnet); гроші — рівномірно на місяць
HINTS_MODEL = 'claude-sonnet-5-5'     # щоденне: підказки статті й проєкту, «Зіставлення ШІ»
RULES_MODEL = 'claude-opus-5-5'       # тижневе: де лінтер і щоденний ШІ не впоралися → чернетка правил
MODEL_UA = {HINTS_MODEL: 'Claude Sonnet 5.5', RULES_MODEL: 'Claude Opus 5.5', 'claude-haiku-5-5': 'Claude Haiku 5.5'}
# $ за 1 млн токенів: вхід, вихід, запис у кеш (5 хв), читання з кешу (Haiku — для витрат і підказок до 05.11.2026: вони лишаються)
PRICES = {HINTS_MODEL: (2.0, 10.0, 2.5, 0.20), RULES_MODEL: (4.0, 20.0, 5.0, 0.20), 'claude-haiku-5-5': (0.10, 0.50, 0.125, 0.01)}
PROMPT_VERSION = 1                    # інша підказка моделі — і відповіді рахуються заново
BATCH = 40                            # записів в одному запиті до Claude
MAX_RECORDS = 1000                    # записів в одному запиті панелі
TEXT_MAX = 500                        # символів коментаря
DEFAULT_LIMIT = 100.0                 # $ на місяць: увесь місячний кредит API з підписки
OLD_LIMIT = 10.0                      # до 05.11.2026: збережене «10», якого людина сама не вписувала, — це старе значення за замовчуванням
PACE_SHARE = 0.10                     # рівномірно: на сьогодні — частка ліміту за дні місяця, що минули, і 10 % ліміту запасу
DRAFT_NEED = 3.0                      # $: тижневий перегляд (Opus) — лише якщо в межах ліміту на сьогодні лишилось стільки
RETRY_AFTER = 15 * 60                 # запис, на якому запит не вдався, — знову не раніше ніж за 15 хв (або кнопкою «Ще раз»)
ERROR_PAUSE = 2                       # с між невдалим запитом і наступним
DRAFT_EVERY = timedelta(days=7)
DRAFT_RETRY = 24 * 3600               # с: тижнева чернетка не вдалася (обрізано, відмова, мережа) — сама спробує знову не раніше ніж за добу
DRAFT_MIN_NEW = 10                    # тижнева чернетка — лише коли з минулої назбиралося стільки нових записів без правил
DRAFT_MAX_OBS = 300                   # записів у запиті чернетки (найновіші)
SEEN_KEEP = timedelta(days=180)
HINTS_KEEP = timedelta(days=400)      # відповіді, старші за це, забуваються (запис, якщо з'явиться знову, піде в Claude ще раз)
CONF = ('висока', 'середня', 'низька')
KEY_RE = re.compile(r'sk-ant-[A-Za-z0-9_\-]{20,300}')
STATE_UA = {'nokey': 'немає ключа Claude API', 'off': 'вимкнено в налаштуваннях', 'nosdk': 'не встановлено пакет anthropic',
            'badkey': 'Claude не прийняв ключ API', 'limit': 'досягнуто місячного ліміту',
            'pace': 'на сьогодні витрачено рівномірну частку місячного ліміту — завтра ШІ запрацює знову', 'ready': 'працює'}

# Помічник (helper.py) підставляє свої функції: setup(data=…, dpapi=…, log=…, load_config=…, save_config=…, rules_path=…, …)
HOST = {
    'data': lambda: Path('data'),
    'dpapi': None,
    'log': print,
    'load_config': lambda: {},
    'save_config': lambda cfg: None,
    'rules_path': lambda: Path('rules.json'),
    'format_path': lambda: Path('ФОРМАТ_ПРАВИЛ.md'),
    'can_edit_rules': lambda: False,
    # шукати «Кешфлоу ШІ» на Google Диску самому — лише справжній Помічник зі своєю папкою даних (тести й пісочниці — ні:
    # 07.11.2026 тести записали вигадані витрати й підказки в справжню спільну папку)
    'auto_shared': lambda: False,
    'config_lock': threading.RLock(),  # config.json читається-змінюється-пишеться по одному (Помічник дає свій замок)
}
CLIENT_FACTORY = [None]               # тести: lambda key: підробний клієнт; інакше — anthropic.Anthropic
LOCK = threading.RLock()
QUEUE = {}                            # ключ запису → запис, що чекає на Claude
INFLIGHT = set()
FAILED = {}                           # ключ → коли запит з ним не вдався
WORK = {'running': False, 'error': '', 'auth': False}
SDK_JOB = {'running': False, 'log': [], 'code': None}
DRAFT_JOB = {'running': False, 'error': '', 'started': None}
MEM = {'dir': None, 'hints': {}, 'seen': {}, 'key': None}


class AiError(Exception):
    pass


def setup(**kw):
    HOST.update(kw)


def log(msg):
    try:
        HOST['log'](msg)
    except Exception:  # noqa: BLE001 — журнал ніколи не ламає запит
        pass


def now_iso():
    return datetime.now().isoformat(timespec='seconds')


# ---------- файли app/data/ai ----------
def data_dir():
    return Path(HOST['data']())


def ai_dir():
    return data_dir() / 'ai'


def read_json(name, default):
    try:
        return json.loads((ai_dir() / name).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def replace_file(tmp, dst, tries=20):
    """os.replace з повтором: у Windows заміна не вдається (WinError 5), поки файл відкрито для читання іншим потоком,
    антивірусом чи Google Диском, — це частки секунди."""
    for i in range(tries):
        try:
            os.replace(tmp, dst)
            return
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(0.05)


def write_json(name, obj):
    d = ai_dir()
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / (name + '.new')
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    replace_file(tmp, d / name)
    if name in SHARED_FILES:
        share_out(name)


# ---------- спільна папка ШІ (з 05.11.2026): кілька Помічників — одна історія ----------
# Кешфлоу веде колега, а тижневий перегляд правил — на вашому комп'ютері: щоб він бачив роботу колеги, Помічники ділять історію
# через папку «Кешфлоу ШІ» на Google Диску (Google Диск для комп'ютера): кожен — своїм акаунтом, папку відкривають колезі на
# редагування, а він додає ярлик у «Мій диск». Кожен Помічник пише лише свою підпапку (<комп'ютер-користувач>/…, тож синхронізація не конфліктує) і читає чужі:
# підказки й відповіді «Зіставлення ШІ» (той самий запис не оплачується двічі), записи для тижневого перегляду й витрати місяця
# (ліміт — один на всіх). У папку йде те саме, що й у Claude (без IBAN, номерів карток, телефонів); ключ API — ні.
SHARED_NAME = 'Кешфлоу ШІ'
SHARED_FILES = ('hints.json', 'seen.json', 'match.json', 'usage.json')
SHARED = {'path': None, 'at': 0.0, 'files': {}, 'pushed': 0.0}  # знайдена папка (шукається раз на 10 хв), прочитані чужі файли


def machine_id():
    raw = f"{os.environ.get('COMPUTERNAME') or socket.gethostname()}-{os.environ.get('USERNAME') or ''}"
    return re.sub(r'[^\w\-]+', '_', raw).strip('_')[:60] or 'pc'


def shared_roots():
    """Де шукати «Кешфлоу ШІ»: лише Google Диск для комп'ютера («G:\\Мій диск», спільні диски) — уточнення 05.11.2026
    ; інша папка — лише вписана вручну в «Налаштуваннях»."""
    home = Path.home()
    roots = [home / 'Google Drive', home / 'Мій диск', home / 'My Drive']
    try:
        import ctypes
        mask = ctypes.windll.kernel32.GetLogicalDrives()
        letters = [chr(65 + i) for i in range(26) if mask >> i & 1 and i > 2]  # без A:, B:, C:
    except Exception:  # noqa: BLE001 — не Windows
        letters = []
    for x in letters:
        roots += [Path(f'{x}:\\Мій диск'), Path(f'{x}:\\My Drive')]
        for sd in (Path(f'{x}:\\Спільні диски'), Path(f'{x}:\\Shared drives')):
            try:
                roots += [p for p in sd.iterdir() if p.is_dir()] if sd.is_dir() else []
            except OSError:
                pass
    return roots


def find_shared():
    for r in shared_roots():
        try:
            if (r / SHARED_NAME).is_dir():
                return r / SHARED_NAME
        except OSError:
            continue
    return None


def shared_dir():
    """Спільна папка: вписана в «Налаштуваннях» (off — вимкнено) або знайдена сама за назвою; немає — None."""
    p = str(cfg().get('shared') or '').strip()
    if p == 'off':
        return None
    if p:
        d = Path(p)
        return d if d.is_dir() else None
    if not HOST['auto_shared']():
        return None
    now = time.time()
    if not SHARED['at'] or now - SHARED['at'] > 600:
        SHARED.update(path=find_shared(), at=now)
    return SHARED['path']


def share_out(name):
    """Свій файл — у свою підпапку спільної папки (кращим зусиллям: немає папки чи диска — лише локально)."""
    d = shared_dir()
    if not d:
        return
    try:
        mine = d / machine_id()
        mine.mkdir(exist_ok=True)
        src = ai_dir() / name
        tmp = mine / (name + '.new')
        tmp.write_bytes(src.read_bytes())
        replace_file(tmp, mine / name)
    except OSError as e:
        log(f'ШІ: спільна папка — {name} не записано ({e})')


def share_tick():
    """Раз на 10 хв: свої файли, новіші за копію в спільній папці (чи її ще немає), — туди (перший запуск, папку щойно знайдено)."""
    now = time.time()
    if now - SHARED['pushed'] < 600:
        return
    SHARED['pushed'] = now
    d = shared_dir()
    if not d:
        return
    for name in SHARED_FILES:
        src, dst = ai_dir() / name, d / machine_id() / name
        try:
            if src.is_file() and (not dst.is_file() or dst.stat().st_mtime < src.stat().st_mtime):
                share_out(name)
        except OSError:
            pass


def shared_json(f):
    """Файл зі спільної папки → (дані, час зміни); прочитане тримається, доки файл не змінився; немає файлу — (None, None)."""
    try:
        st = f.stat()
    except OSError:
        return None, None
    sig, hit = (st.st_mtime_ns, st.st_size), SHARED['files'].get(str(f))
    if not hit or hit[0] != sig:
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
        except (OSError, ValueError):  # файл ще синхронізується — лишається прочитане раніше
            data = hit[1] if hit else None
        SHARED['files'][str(f)] = hit = (sig, data, st.st_mtime)
    return hit[1], hit[2]


def others(name):
    """Той самий файл інших комп'ютерів зі спільної папки → [{підпапка, дані}]; прочитане тримається, доки файл не змінився."""
    d = shared_dir()
    if not d:
        return []
    me, out = machine_id(), []
    try:
        subs = [s for s in d.iterdir() if s.is_dir() and s.name != me]
    except OSError:
        return []
    for s in subs:
        data, at = shared_json(s / name)
        if isinstance(data, dict):
            out.append({'who': s.name, 'data': data, 'at': at})
    return out


def own_shared(name):
    """Копія свого файлу в спільній папці (її пише лише цей комп'ютер) — щоб нова чи втрачена папка даних не стерла історію."""
    d = shared_dir()
    data = shared_json(d / machine_id() / name)[0] if d else None
    return data if isinstance(data, dict) else {}


def other_hints():
    merged = {}
    for o in others('hints.json'):
        merged.update(o['data'])
    return merged


def mem():
    """Відповіді й записи — у пам'яті (файли пишемо, лише коли змінилися); інша папка даних (тести) — читаємо заново."""
    d = str(data_dir())
    if MEM['dir'] != d:
        MEM.update(dir=d, hints=read_json('hints.json', {}), seen=read_json('seen.json', {}), key=None)
    return MEM


# ---------- ключ API: Windows DPAPI, як токен CRM ----------
def key_file():
    return data_dir() / 'anthropic_key.dat'


def save_key(key):
    mem()['key'] = key
    try:
        data_dir().mkdir(parents=True, exist_ok=True)
        key_file().write_bytes(HOST['dpapi'](key.encode('utf-8'), True))
        return True
    except (OSError, TypeError) as e:
        log(f'Ключ Claude API не збережено на диск ({e}) — він діє до закриття програми')
        return False


def load_key():
    m = mem()
    if m['key']:
        return m['key']
    try:
        m['key'] = HOST['dpapi'](key_file().read_bytes(), False).decode('utf-8')
    except (OSError, ValueError, TypeError):
        return None
    return m['key']


def forget_key():
    mem()['key'] = None
    WORK['auth'] = False
    try:
        key_file().unlink()
    except OSError:
        pass


# ---------- налаштування (config.json → ai) і витрати ----------
def cfg():
    c = HOST['load_config']().get('ai')
    return c if isinstance(c, dict) else {}


def set_cfg(**kw):
    with HOST['config_lock']:  # інакше одночасне збереження іншої настройки (папка виписок, галочка Моно) могло б її стерти
        c = HOST['load_config']()
        a = c.get('ai') if isinstance(c.get('ai'), dict) else {}
        a.update(kw)
        c['ai'] = a
        HOST['save_config'](c)
        return a


def limit_usd():
    c = cfg()
    try:
        v = float(c['limit']) if c.get('limit') is not None else None
    except (TypeError, ValueError):
        v = None
    # «10», збережене до 05.11.2026 кнопкою «Зберегти» (поле показувало старе значення за замовчуванням), — не вибір людини
    if v is None or (v == OLD_LIMIT and not c.get('limit_own')):
        return DEFAULT_LIMIT
    return max(0.0, v)


def pace_cap(now=None):
    """Щоб місячного ліміту вистачило на весь місяць, а не на перший тиждень: на сьогодні можна витратити частку ліміту за дні
    місяця, що минули (разом із сьогоднішнім), і PACE_SHARE ліміту запасу. 7-го листопада з $100 — до $33,33, 30-го — усі $100."""
    now = now or datetime.now()
    lim = limit_usd()
    days = calendar.monthrange(now.year, now.month)[1]
    return round(min(lim, lim * now.day / days + lim * PACE_SHARE), 2)


def month():
    return datetime.now().strftime('%Y-%m')


def month_usd(u):
    """$ поточного місяця з usage.json (свого чи іншого комп'ютера)."""
    try:
        return float(((u or {}).get(month()) or {}).get('usd', 0.0) or 0.0)
    except (AttributeError, TypeError, ValueError):
        return 0.0


def own_usage():
    """Свої витрати: usage.json цього Помічника; якщо в копії цього комп'ютера в спільній папці за місяць більше (папку даних
    створено заново — перевстановлення, інша копія лінтера), береться вона: сума за місяць лише росте, і ліміт не «обнулиться»."""
    u = read_json('usage.json', {})
    sh = own_shared('usage.json')
    if month_usd(sh) > month_usd(u):
        u = {**u, month(): json.loads(json.dumps(sh[month()]))}
    return u


def sharing_on():
    """Спільну папку ввімкнено: вписано шлях або Помічник шукає «Кешфлоу ШІ» сам (не «off»)."""
    p = str(cfg().get('shared') or '').strip()
    return p != 'off' and bool(p or HOST['auto_shared']())


def foreign_usd():
    """Витрати інших комп'ютерів за місяць. Google Диск ще не підключився чи призупинений — береться останнє відоме значення
    (сума за місяць лише росте; app/data/ai/others_usage.json), щоб ліміт не став окремим для кожного комп'ютера.
    Спільну папку вимкнено («off») — чужих витрат не рахуємо."""
    if not sharing_on():
        return 0.0
    cur = sum(month_usd(o['data']) for o in others('usage.json'))
    last = read_json('others_usage.json', {})
    try:
        prev = float(last.get(month()) or 0.0) if isinstance(last, dict) else 0.0
    except (TypeError, ValueError):
        prev = 0.0
    if cur > prev + 1e-9:
        with LOCK:
            write_json('others_usage.json', {month(): round(cur, 6)})
        return cur
    return prev


def spent():
    """Витрати місяця — свої й інших комп'ютерів зі спільної папки: кредит один, тож і ліміт один."""
    return month_usd(own_usage()) + foreign_usd()


def add_usage(model, usage):
    """Оцінка вартості запиту за usage з відповіді → $ (і підсумок місяця в usage.json)."""
    p = PRICES.get(model) or PRICES[RULES_MODEL]
    g = lambda k: int(getattr(usage, k, 0) or 0)  # noqa: E731
    i, o, cw, cr = g('input_tokens'), g('output_tokens'), g('cache_creation_input_tokens'), g('cache_read_input_tokens')
    usd = (i * p[0] + o * p[1] + cw * p[2] + cr * p[3]) / 1e6
    with LOCK:
        u = own_usage()
        m = u.setdefault(month(), {'usd': 0.0, 'models': {}})
        m['usd'] = round(m.get('usd', 0.0) + usd, 6)
        x = m.setdefault('models', {}).setdefault(model, {'n': 0, 'in': 0, 'out': 0, 'cw': 0, 'cr': 0, 'usd': 0.0})
        for f, v in (('n', 1), ('in', i), ('out', o), ('cw', cw), ('cr', cr)):
            x[f] = x.get(f, 0) + v
        x['usd'] = round(x.get('usd', 0.0) + usd, 6)
        write_json('usage.json', u)
    return usd


# ---------- пакет anthropic ----------
def sdk():
    if SDK_JOB.get('pip'):  # pip ще пише файли пакета — напівготовий пакет не імпортувати
        return None
    try:
        return importlib.import_module('anthropic')
    except Exception:  # noqa: BLE001 — немає або зламаний пакет: те саме «не встановлено»
        importlib.invalidate_caches()
        try:
            return importlib.import_module('anthropic')
        except Exception:  # noqa: BLE001
            return None


def sdk_version():
    if CLIENT_FACTORY[0]:
        return 'тест'
    a = sdk()
    return getattr(a, '__version__', '?') if a else None


def start_sdk_install():
    with LOCK:
        if SDK_JOB['running']:
            return 409, {'error': 'пакет уже встановлюється'}
        SDK_JOB.update(running=True, log=[], code=None)
    threading.Thread(target=_install_sdk, daemon=True).start()
    return 200, {'ok': True}


def _install_sdk():
    """pip install anthropic — як «Встановити.bat» ставить requests: спершу для всіх, не вийшло — лише для себе (--user)."""
    try:
        SDK_JOB['pip'] = True
        for extra in ([], ['--user']):
            cmd = [sys.executable, '-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', 'anthropic', *extra]
            SDK_JOB['log'].append('> pip install anthropic' + (' --user' if extra else ''))
            try:
                p = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=900,
                                   stdin=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                SDK_JOB['log'] += [x for x in (p.stdout + p.stderr).splitlines() if x.strip()][-12:]
                if p.returncode == 0:
                    break
            except (OSError, subprocess.SubprocessError) as e:
                SDK_JOB['log'].append(f'ПОМИЛКА: {e}')
        SDK_JOB['pip'] = False
        if sdk() is None:  # --user: папки пакетів користувача могло не бути в sys.path під час запуску
            try:
                site.addsitedir(site.getusersitepackages())
            except Exception:  # noqa: BLE001
                pass
        SDK_JOB['code'] = 0 if sdk() else 1
        log('ШІ: пакет anthropic ' + (f'встановлено ({sdk_version()})' if sdk() else 'не встановлено — див. «Налаштування» Помічника'))
        if sdk() and load_key():
            verify()
    finally:
        SDK_JOB.update(running=False, pip=False)


def new_client(key):
    if CLIENT_FACTORY[0]:
        return CLIENT_FACTORY[0](key)
    a = sdk()
    if a is None:
        raise AiError('пакет anthropic ще не встановлено')
    return a.Anthropic(api_key=key, max_retries=3, timeout=300.0)


def explain(e):
    """Помилка Claude API → коротко українською (без ключа й без технічного сміття)."""
    if isinstance(e, AiError):
        return str(e)
    if isinstance(e, TypeError) and 'output_config' in str(e):
        return 'пакет anthropic застарий: закрийте Помічник, виконайте в командному рядку «py -m pip install --upgrade anthropic» і запустіть Помічник знову'
    code, msg = getattr(e, 'status_code', None), str(getattr(e, 'message', '') or e)
    if code == 401:
        return 'Claude не прийняв ключ API — перевірте його в «Налаштуваннях» Помічника'
    if code == 403:
        return 'ключ API не має доступу до цієї моделі чи організації'
    if code == 404:
        return 'модель недоступна для цього ключа'
    if code == 429:
        return 'забагато запитів до Claude — спробуйте за хвилину'
    if code == 400 and 'credit' in msg.lower():
        return 'на рахунку Claude API закінчилися кредити (Console → Billing)'
    if code:
        return f'помилка Claude API ({code}): {msg[:200]}'
    a = sdk()
    if a and isinstance(e, getattr(a, 'APIConnectionError', ())):
        return "немає зв'язку з Claude API — перевірте інтернет"
    return msg[:300] or type(e).__name__


def state():
    if not load_key():
        return 'nokey'
    if cfg().get('on') is False:
        return 'off'
    if not CLIENT_FACTORY[0] and sdk() is None:
        return 'nosdk'
    if WORK['auth']:
        return 'badkey'
    s = spent()
    if s >= limit_usd():
        return 'limit'
    if s >= pace_cap():
        return 'pace'
    return 'ready'


def verify():
    """Ключ і доступ до обох моделей — підрахунком токенів (безкоштовний запит). → (ok, помилка)"""
    try:
        client = new_client(load_key())
        for m in (HINTS_MODEL, RULES_MODEL):
            client.messages.count_tokens(model=m, messages=[{'role': 'user', 'content': 'перевірка'}])
        WORK.update(auth=False, error='')
        set_cfg(check={'ok': True, 'at': now_iso(), 'error': ''})
        return True, ''
    except Exception as e:  # noqa: BLE001
        msg = explain(e)
        if getattr(e, 'status_code', None) in (401, 403):
            WORK['auth'] = True
        set_cfg(check={'ok': False, 'at': now_iso(), 'error': msg})
        return False, msg


# ---------- що йде назовні: без номерів рахунків, карток, телефонів, e-mail ----------
EMAIL = re.compile(r'[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+')
IBAN = re.compile(r'\b([A-Z]{2})\d{2}(?: ?[A-Z0-9]){10,30}\b')
CARD = re.compile(r'(?<![\d*])\d(?:[ \-]?\d){12,18}(?![\d*])')
PHONE = re.compile(r'(?<![\w+])(?:\+?38[ \-]?)?\(?0\d{2}\)?[ \-]?\d{3}[ \-]?\d{2}[ \-]?\d{2}(?!\d)')
LONGNUM = re.compile(r'(?<!\d)\d{8,}(?!\d)')


def _iban(m):
    digits = re.sub(r'\D', '', m.group(0))
    return f'{m.group(1)}…{digits[-4:]}' if len(digits) >= 10 else m.group(0)


def clean_text(s, limit=TEXT_MAX):
    s = re.sub(r'\s+', ' ', str(s if s is not None else '')).strip()
    s = EMAIL.sub('[e-mail]', s)
    s = IBAN.sub(_iban, s)
    s = CARD.sub(lambda m: '**** ' + re.sub(r'\D', '', m.group(0))[-4:], s)
    s = PHONE.sub('[телефон]', s)
    s = LONGNUM.sub('[номер]', s)
    return s[:limit]


def clean_record(r):
    """Запис від панелі → лише потрібні поля, очищені; щось не так — None."""
    if not isinstance(r, dict):
        return None
    k, typ = r.get('k'), r.get('type')
    # запис CRM — його ID; операція банку без статті з «Внести в CRM» — 'b:' + хеш її ключа в панелі (з 05.11.2026)
    bank = isinstance(k, str) and re.fullmatch(r'b:[0-9a-f]{8,32}', k) is not None
    if not bank and (type(k) is not int or k <= 0) or typ not in ('income', 'expense'):
        return None
    try:
        amount = round(float(r.get('amount') or 0), 2)
    except (TypeError, ValueError):
        return None
    date = str(r.get('date') or '')
    art = str(r.get('art') or '')
    same = []
    for x in (r.get('same') if isinstance(r.get('same'), list) else [])[:3]:
        if isinstance(x, list) and len(x) == 2 and type(x[1]) is int:
            same.append([clean_text(x[0], 120), x[1]])
    return {'k': k, 'src': 'bank' if bank else 'crm', 'type': typ, 'amount': amount, 'date': date if re.fullmatch(r'\d{4}-\d{2}-\d{2}', date) else '',
            'ccy': clean_text(r.get('ccy'), 8), 'acc': clean_text(r.get('acc'), 160), 'cmt': clean_text(r.get('cmt')),
            'art': art if re.fullmatch(r'\d{1,6}:\d{0,6}', art) else '', 'art_label': clean_text(r.get('art_label'), 160),
            'prj': clean_text(r.get('prj'), 40), 'same': same}


def rec_key(r):
    raw = json.dumps([PROMPT_VERSION, r['k'], r['type'], r['amount'], r['ccy'], r['acc'], r['cmt'], r['date']], ensure_ascii=False)
    return hashlib.sha1(raw.encode('utf-8')).hexdigest()[:20]


# ---------- довідник для моделі: статті, проєкти, назви чинних правил (з rules.json Помічника) ----------
def load_rules():
    return json.loads(HOST['rules_path']().read_text(encoding='utf-8'))


def art_label(a):
    return f"{a['group']} / {a['name'] if a.get('category') == a['name'] else a['category'] + ' / ' + a['name']}"


def directory(doc):
    ref = doc.get('reference') or {}
    arts = [(f"{a['category_id']}:{a['operation_id']}", art_label(a), {1: 'дохід', 2: 'витрата'}.get(a.get('type'), 'будь-який'))
            for a in ref.get('articles') or []]
    projects = list((ref.get('projects') or {}).keys())
    policy = [r['title'] for r in doc.get('rules') or [] if r.get('title') and not r.get('disabled')]
    return arts, projects, policy


HINTS_SYSTEM = """Ти — помічник бухгалтера компанії Pryklad (example.com: маркетплейс юридичних послуг і підписки для юристів; проєкти — країни, де працює компанія). Записи кешфлоу ведуться в CRM.
Тобі дають записи, яких не покриває жодне правило лінтера кешфлоу. Для кожного запропонуй статтю P&L і проєкт (країну). Це лише підказка: вирішує людина.

Статті (код — група / категорія / стаття — тип):
{articles}

Проєкти: {projects}.

Як компанія класифікує типові випадки (чинні правила лінтера; записи, які вони покривають, сюди не потрапляють, але логіка та сама):
{policy}

Поля запису: n — номер у запиті; src — crm (запис кешфлоу) чи bank (операція з виписки банку, якої ще немає в CRM: стаття ще не вибрана, cmt — «Отримувач: призначення платежу»); date — дата; type — income (дохід) чи expense (витрата); amount і ccy — сума й валюта; acc — рахунок у CRM (банк, ФОП чи ТОВ, корп. картка); cmt — коментар (номери рахунків, карток і телефони приховано); art — поточна стаття (код, якщо вона є в довіднику, і назва в CRM); prj — поточний проєкт; same — статті інших записів того самого отримувача в цьому періоді: [стаття, кількість].

Як відповідати:
- article — код статті з довідника; тип статті має відповідати типу запису. Поточну статтю обрала людина: якщо вона правдоподібна, поверни її код. Якщо з запису статтю не визначити — "?".
- project — назва проєкту, лише коли його видно з коментаря чи рахунку (країна, місто, людина з правил вище, рахунок польської чи британської фірми тощо); інакше "?".
- confidence — «висока», коли запис однозначний; «середня» — ймовірно; «низька» — здогадка.
- why — одне коротке речення українською: чому саме так. Не вигадуй фактів, яких немає в записі.
- Поверни по одному елементу items для кожного n із запиту."""


def hints_schema(codes, projects):
    return {'type': 'object', 'additionalProperties': False, 'required': ['items'], 'properties': {'items': {'type': 'array', 'items': {
        'type': 'object', 'additionalProperties': False, 'required': ['n', 'article', 'project', 'confidence', 'why'], 'properties': {
            'n': {'type': 'integer'}, 'article': {'type': 'string', 'enum': codes + ['?']}, 'project': {'type': 'string', 'enum': projects + ['?']},
            'confidence': {'type': 'string', 'enum': list(CONF)}, 'why': {'type': 'string'}}}}}}


def call(model, system, user, schema, effort, max_tokens):
    """Один запит до Claude зі структурованою відповіддю (JSON за схемою) → повідомлення; витрати — в usage.json."""
    key = load_key()
    if not key:
        raise AiError('немає ключа Claude API')
    client = new_client(key)
    with client.messages.stream(model=model, max_tokens=max_tokens, system=system, messages=[{'role': 'user', 'content': user}],
                                output_config={'effort': effort, 'format': {'type': 'json_schema', 'schema': schema}}) as stream:
        msg = stream.get_final_message()
    try:  # відповідь уже оплачено: збій запису витрат (файл зайнятий) не має її викинути
        add_usage(model, getattr(msg, 'usage', None))
    except OSError as e:
        log(f'ШІ: витрати запиту не записано ({e})')
    if msg.stop_reason == 'refusal':
        raise AiError('Claude відмовився відповідати на цей запит')
    if msg.stop_reason == 'max_tokens':
        raise AiError('відповідь Claude обрізано — забагато записів в одному запиті')
    text = next((b.text for b in msg.content if getattr(b, 'type', '') == 'text'), '')
    try:
        data = json.loads(text)
    except ValueError:
        raise AiError('Claude повернув не JSON')
    if not isinstance(data, dict):
        raise AiError('Claude повернув не те, що просили')
    return data


def ask_hints(batch):
    """Підказки для записів batch (до BATCH) → {ключ запису: підказка}; записів без відповіді в результаті немає."""
    arts, projects, policy = directory(load_rules())
    codes, labels = [a[0] for a in arts], {a[0]: a[1] for a in arts}
    system = HINTS_SYSTEM.format(articles='\n'.join(f'{c} — {lab} — {kind}' for c, lab, kind in arts), projects=', '.join(projects),
                                 policy='\n'.join(f'- {t}' for t in policy))
    cur = lambda r: ' '.join(x for x in (r['art'] if r['art'] in labels else '', r['art_label']) if x) or '—'  # noqa: E731 — код і назва поточної статті
    recs = [{'n': i + 1, 'src': r.get('src') or 'crm', 'date': r['date'], 'type': r['type'], 'amount': r['amount'], 'ccy': r['ccy'], 'acc': r['acc'], 'cmt': r['cmt'],
             'art': cur(r), 'prj': r['prj'] or '—', **({'same': r['same']} if r['same'] else {})} for i, r in enumerate(batch)]
    # довідник і правила — однакові в усіх запитах: кешуються, наступні запити читають їх у 10 разів дешевше; запас max_tokens — на роздуми
    data = call(HINTS_MODEL, [{'type': 'text', 'text': system, 'cache_control': {'type': 'ephemeral'}}],
                json.dumps({'records': recs}, ensure_ascii=False), hints_schema(codes, projects), 'medium', 32000)
    out, t = {}, now_iso()
    for it in data.get('items') or []:
        n = it.get('n') if isinstance(it, dict) else None
        if type(n) is not int or not 1 <= n <= len(batch):
            continue
        a, p, c = it.get('article'), it.get('project'), it.get('confidence')
        out[batch[n - 1]['key']] = {'a': a if a in labels else '', 'al': labels.get(a, ''), 'p': p if p in projects else '',
                                    'c': c if c in CONF else 'низька', 'w': clean_text(it.get('why'), 300), 'm': HINTS_MODEL, 't': t}
    return out


# ---------- черга: панель питає «що знаєш про ці записи», решта йде в Claude у фоні ----------
def public(h):
    return {'a': h.get('a', ''), 'p': h.get('p', ''), 'c': h.get('c', ''), 'w': h.get('w', '')}


def note_seen(recs):
    """Записи без правил — для тижневої чернетки правил (лише в app/data/ai, назовні не йдуть, доки не складається чернетка)."""
    seen, t, changed = mem()['seen'], now_iso(), False
    old = (datetime.now() - SEEN_KEEP).strftime('%Y-%m-%d')
    for r in recs:
        if (r.get('date') or '9') < old:  # старші за SEEN_KEEP однаково б викинулись — і файл переписувався б на кожне опитування
            continue
        o = seen.get(r['key'])
        cur = {'k': r['k'], 'src': r.get('src') or 'crm', 'date': r['date'], 'type': r['type'], 'amount': r['amount'], 'ccy': r['ccy'], 'acc': r['acc'],
               'cmt': r['cmt'], 'art': r['art_label'], 'code': r['art'], 'prj': r['prj']}
        if o is None or any(o.get(f) != v for f, v in cur.items()):
            seen[r['key']] = {**cur, 'key': r['key'], 't': (o or {}).get('t') or t}
            changed = True
    if changed:
        for k in [k for k, o in seen.items() if (o.get('date') or '9') < old]:
            del seen[k]
        write_json('seen.json', seen)


def hints_request(body):
    """Запит панелі {records: [...], retry} → відомі підказки; невідомі записи стають у чергу до Claude (якщо ШІ працює)."""
    recs = body.get('records') if isinstance(body, dict) else None
    if not isinstance(recs, list):
        return 400, {'error': 'очікується {records: [...]}'}
    clean = [x for x in (clean_record(r) for r in recs[:MAX_RECORDS]) if x]
    share_tick()
    st, t, oh = state(), time.time(), other_hints()  # oh — відповіді інших Помічників зі спільної папки: удруге не платимо
    results, pending, failed = {}, 0, 0
    with LOCK:
        hints = mem()['hints']
        todo = []
        for r in clean:
            r['key'] = rec_key(r)
            h = hints.get(r['key']) or oh.get(r['key'])
            if h:
                results[r['k']] = public(h)
            else:
                todo.append(r)
        if st not in ('nokey', 'off'):
            note_seen(clean)
        if st == 'ready':
            for r in todo:
                k = r['key']
                if k in QUEUE or k in INFLIGHT:
                    continue
                if k in FAILED and not body.get('retry') and t - FAILED[k] < RETRY_AFTER:
                    continue
                FAILED.pop(k, None)
                QUEUE[k] = r
            start_worker()
        for r in todo:
            if r['key'] in QUEUE or r['key'] in INFLIGHT:
                pending += 1
            elif r['key'] in FAILED:
                failed += 1
    return 200, {'ok': True, 'state': st, 'state_ua': STATE_UA[st], 'results': results, 'pending': pending, 'failed': failed,
                 'running': WORK['running'], 'error': WORK['error'] if failed or st == 'badkey' else '', 'model': MODEL_UA[HINTS_MODEL],
                 'usage': {'usd': round(spent(), 4), 'limit': limit_usd()}}


def start_worker():
    with LOCK:
        if WORK['running'] or not QUEUE:
            return
        WORK['running'] = True
    threading.Thread(target=_work, daemon=True).start()


def _work():
    try:
        while True:
            with LOCK:
                if not QUEUE or state() != 'ready':  # ліміт, ключ: решту черги панель поставить знову, коли ШІ запрацює
                    QUEUE.clear()
                    WORK['running'] = False
                    return
                keys = list(QUEUE)[:BATCH]
                batch = [QUEUE.pop(k) for k in keys]
                INFLIGHT.update(keys)
            try:
                got = ask_hints(batch)
                with LOCK:
                    m = mem()
                    m['hints'].update(got)
                    old = (datetime.now() - HINTS_KEEP).isoformat(timespec='seconds')
                    for k in [k for k, h in m['hints'].items() if (h.get('t') or '') < old]:
                        del m['hints'][k]
                    write_json('hints.json', m['hints'])
                    for k in keys:
                        if k not in got:
                            FAILED[k] = time.time()
                    WORK['error'] = '' if len(got) == len(keys) else 'ШІ відповів не на всі записи — решта буде в наступному запиті'
            except Exception as e:  # noqa: BLE001 — помилка запиту: записи підуть ще раз пізніше або кнопкою «Ще раз»
                msg = explain(e)
                with LOCK:
                    for k in keys:
                        FAILED[k] = time.time()
                    WORK['error'] = msg
                    if getattr(e, 'status_code', None) in (401, 403):
                        WORK['auth'] = True
                        QUEUE.clear()
                log('ШІ-підказки: ' + msg)
                time.sleep(ERROR_PAUSE)
            finally:
                with LOCK:
                    INFLIGHT.difference_update(keys)
    except BaseException:
        WORK['running'] = False
        raise


# ---------- «Зіставлення ШІ» у «Звірці з банком» (з 05.11.2026): операції банку без пари ↔ погодження реєстру ----------
# Лінтер спершу зіставляє сам (сума, дата, рахунок; пакет ЗП — набір погоджень із кількістю карток), а сюди панель шле лише залишок.
# Щоденна модель (HINTS_MODEL) вибирає погодження, що пояснює операцію (лише з переданих — схема з переліком), з поясненням. Лише підказки:
# панель нічого не створює й не змінює. Ідентифікатори операцій і ключі погоджень у запиті замінено на b1…/a1… (назовні не йдуть),
# з тексту прибрано номери рахунків, карток, телефони й e-mail. Відповідь на той самий набір пам'ятається (match.json, 60 днів).
MATCH_VERSION = 2                     # 2 — пакет ЗП «по людях» в інструкції: збережені відповіді на стару не беруться
MATCH_MAX_BANK, MATCH_MAX_AP = 80, 200
MATCH_KEEP = timedelta(days=60)
MATCH_SYSTEM = """Ти — помічник бухгалтера компанії Pryklad (example.com). Компанія платить з рахунків ТОВ і ФОП; кожну виплату спершу погоджують у реєстрі погоджень (кому, за що, сума на руки), потім вносять у кешфлоу CRM.
Тобі дають операції банку (списання) за період, яких лінтер не зіставив з погодженнями сам (за сумою, датою й рахунком), і погодження, що лишились без пари.
Для кожної операції знайди погодження, яке її пояснює: та сама людина чи отримувач (ім'я в призначенні чи отримувачі), той самий зміст, а сума сходиться або пояснюється: кілька погоджень разом; пакет ЗП Привату (kind pay) — сума погоджень на руки стількох людей, скільки карток у пакеті (cards): одна людина може отримати кілька погоджень на одну картку (ЗП, премію, % РОП), погодження може бути з іншого рахунку тієї самої фірми (ТОВ), а тімлід — отримувачем погоджень за свою команду; суму пакета перевір додаванням до копійки; переказ ФОП на свою картку — виплати людям з неї; комісія банку чи курс.
Поля операції: id; date; amount — гривні; acc — рахунок; cpty — отримувач; text — призначення; kind — pay (ЗП одним переказом на транзитний рахунок) чи exp (інша витрата); cards — карток у пакеті.
Поля погодження: key; date — дата оплати; amount — сума на руки; acc — рахунок, з якого платять; recipient — кому; text — зміст; entered — чи вже внесено в кешфлоу.
Як відповідати: matches — лише операції, яким знайшлось пояснення (решту пропусти): bank — id операції; approvals — ключі погоджень; confidence — «висока» (люди й сума сходяться), «середня» (ймовірно), «низька» (здогадка); why — одне коротке речення українською: хто, за що і як сходиться сума. Одне погодження — не більше ніж до однієї операції. Не вигадуй того, чого немає в даних."""


def match_schema(bank_ids, ap_keys):
    return {'type': 'object', 'additionalProperties': False, 'required': ['matches'], 'properties': {'matches': {'type': 'array', 'items': {
        'type': 'object', 'additionalProperties': False, 'required': ['bank', 'approvals', 'confidence', 'why'], 'properties': {
            'bank': {'type': 'string', 'enum': bank_ids}, 'approvals': {'type': 'array', 'items': {'type': 'string', 'enum': ap_keys}},
            'confidence': {'type': 'string', 'enum': list(CONF)}, 'why': {'type': 'string'}}}}}}


def _amount(v):
    try:
        x = round(float(v), 2)
    except (TypeError, ValueError):
        return None
    return x if x == x and 0 < abs(x) < 1e12 else None  # NaN — ні


def clean_match(body):
    """Запит панелі {bank, approvals} → (bank, approvals) лише з потрібними, очищеними полями."""
    day = lambda v: str(v) if re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(v or '')) else ''  # noqa: E731
    bank, aps = [], []
    for b in (body.get('bank') if isinstance(body.get('bank'), list) else [])[:MATCH_MAX_BANK]:
        if not isinstance(b, dict) or _amount(b.get('amount')) is None or not str(b.get('id') or ''):
            continue
        cards = b.get('cards')
        bank.append({'id': str(b['id'])[:160], 'date': day(b.get('date')), 'amount': _amount(b['amount']), 'acc': clean_text(b.get('acc'), 160),
                     'cpty': clean_text(b.get('cpty'), 160), 'text': clean_text(b.get('text'), 300), 'kind': 'pay' if b.get('kind') == 'pay' else 'exp',
                     **({'cards': cards} if type(cards) is int and 0 < cards < 1000 else {})})
    for a in (body.get('approvals') if isinstance(body.get('approvals'), list) else [])[:MATCH_MAX_AP]:
        if not isinstance(a, dict) or _amount(a.get('amount')) is None or not str(a.get('key') or ''):
            continue
        aps.append({'key': str(a['key'])[:160], 'date': day(a.get('date')), 'amount': _amount(a['amount']), 'acc': clean_text(a.get('acc'), 160),
                    'recipient': clean_text(a.get('recipient'), 160), 'text': clean_text(a.get('text'), 300), 'entered': bool(a.get('entered'))})
    return bank, aps


def match_request(body):
    """Запит панелі {bank: [...], approvals: [...]} → {ok, state, matches: [{bank, approvals, confidence, why}], cached?, error?}."""
    if not isinstance(body, dict):
        return 400, {'error': 'очікується {bank: [...], approvals: [...]}'}
    bank, aps = clean_match(body)
    st = state()
    usage = lambda: {'usd': round(spent(), 4), 'limit': limit_usd()}  # noqa: E731
    base = {'ok': True, 'state': st, 'state_ua': STATE_UA[st], 'model': MODEL_UA[HINTS_MODEL], 'matches': []}
    if not bank or not aps:
        return 200, {**base, 'usage': usage()}
    key = hashlib.sha1(json.dumps([MATCH_VERSION, bank, aps], ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()[:24]
    share_tick()
    with LOCK:
        hit = read_json('match.json', {}).get(key)
    if hit is None:  # той самий залишок уже зіставляв інший Помічник (спільна папка) — його відповідь
        hit = next((o['data'][key] for o in others('match.json') if isinstance(o['data'].get(key), dict)), None)
    if hit is not None:
        return 200, {**base, 'matches': hit.get('m') or [], 'cached': True, 'usage': usage()}
    if st != 'ready':
        return 200, {**base, 'usage': usage()}
    bmap = {f'b{i + 1}': b for i, b in enumerate(bank)}
    amap = {f'a{i + 1}': a for i, a in enumerate(aps)}
    user = json.dumps({'bank': [{**b, 'id': k} for k, b in bmap.items()], 'approvals': [{**a, 'key': k} for k, a in amap.items()]}, ensure_ascii=False)
    try:
        # інструкція однакова в усіх запитах — кешується (наступні запити читають її дешевше)
        data = call(HINTS_MODEL, [{'type': 'text', 'text': MATCH_SYSTEM, 'cache_control': {'type': 'ephemeral'}}], user,
                    match_schema(list(bmap), list(amap)), 'medium', 32000)
    except AiError as e:
        return 200, {**base, 'ok': False, 'error': str(e), 'usage': usage()}
    except Exception as e:  # noqa: BLE001 — мережа, ключ, ліміти API
        if getattr(e, 'status_code', None) in (401, 403):
            WORK['auth'] = True
        return 200, {**base, 'ok': False, 'error': explain(e), 'usage': usage()}
    out, used = [], set()
    for m in data.get('matches') or []:
        if not isinstance(m, dict) or m.get('bank') not in bmap:
            continue
        ks = [k for k in dict.fromkeys(m.get('approvals') or []) if k in amap and k not in used]
        if not ks:
            continue
        used.update(ks)
        out.append({'bank': bmap[m['bank']]['id'], 'approvals': [amap[k]['key'] for k in ks],
                    'confidence': m.get('confidence') if m.get('confidence') in CONF else 'низька', 'why': clean_text(m.get('why'), 300)})
    with LOCK:
        old = (datetime.now() - MATCH_KEEP).isoformat(timespec='seconds')
        cache = {k: v for k, v in read_json('match.json', {}).items() if isinstance(v, dict) and str(v.get('t') or '') >= old}
        cache[key] = {'t': now_iso(), 'm': out}
        write_json('match.json', cache)
    return 200, {**base, 'matches': out, 'usage': usage()}


# ---------- тижневий перегляд правил (RULES_MODEL) ----------
DRAFT_SYSTEM = """Ти допомагаєш підтримувати правила лінтера кешфлоу компанії Pryklad (example.com). Нижче — формат правил і чинний rules.json. Раз на тиждень ти переглядаєш, де лінтер (правила) і щоденний ШІ (він підказує статтю записам без правил) не впоралися, і пропонуєш правила, щоб наступного разу лінтер визначав такі випадки сам.

У повідомленні — записи, яких не покриває жодне правило:
- src "crm" — запис кешфлоу: art і prj — стаття й проєкт у CRM (їх поставила людина чи реєстр погоджень); ai — підказка щоденного ШІ (art, prj, conf — впевненість, why);
- src "bank" — операція з виписки банку, якої ще немає в CRM і якій лінтер не визначив статті ні за правилами, ні з історії рахунку (art «—»: людина статтю ще не вибрала); cmt — коментар майбутнього запису «Отримувач: призначення платежу»; саме на ньому розділ «Внести в CRM» перевіряє правила;
- flags: "ai_miss" — ШІ запропонував іншу статтю, ніж стоїть у CRM; "ai_unsure" — ШІ статті не визначив чи не впевнений.

Що робити (до 8 правил), за пріоритетом:
1) ai_miss і ai_unsure — тут щоденний ШІ помиляється чи вагається. З коментаря, рахунку й чинних правил визнач, яка стаття правильна (людина теж могла помилитися — тоді правило mode "review" підсвітить такі записи), і запиши правило, що це вирішує.
2) повторювані випадки — щонайменше 3 записи зі спільною ознакою в коментарі чи рахунку і стабільно тією самою статтею (чи проєктом) — нове правило.
3) src "bank", що повторюються, — правило, щоб «Внести в CRM» сама ставила статтю: умова за отримувачем і призначенням; поки статтю не підтвердила людина (у CRM ще немає таких записів із цією статтею), лише mode "review".
4) чинне правило, яке не спрацювало, бо умова завузька (той самий випадок інакше написаний), — зміна цього правила: rule_json — правило з тим самим id і всіма полями, replaces — цей id, у why — що саме змінено.
Не пиши правил для податків із ЗП (ПДФО, військовий збір, ЄСВ), ЗП через транзитний рахунок («Ціл-ві зарах.») і зарплатних статей: їх розносять по людях і відділах, текстом платежу статтю не визначити.

Вимоги до правила:
- формат — як у чинному rules.json (поля id, group, title, priority, effective_from, match, unless, set, mode, note);
- нове правило: id — "R-AI-" + коротка латинська назва + "-01" (наприклад, R-AI-HETZNER-01), без повторів із чинними; replaces — "";
- умова вузька: comment_regex з (?i), text_any чи names; вона не має чіпляти записи з іншою статтею;
- set.category — точна назва статті з reference.articles (якщо коротка назва неоднозначна — «Група / Стаття»); set.project — лише коли проєкт справді стабільний;
- mode "review", якщо серед схожих записів є винятки або ти не впевнений; інакше "fix";
- effective_from — дата найранішого запису-прикладу, але не раніше fix_from ({fix_from}); у зміні чинного правила — як було;
- не дублюй чинні правила.
Людина перевірить кожне правило на записах CRM, перш ніж зберегти. Якщо пропонувати нічого, поверни порожній список rules і поясни це в summary.
rule_json — правило одним JSON-об'єктом у рядку; replaces — id чинного правила, яке змінюєш, або ""; title — назва правила; why — українською: що спільного в записах, хто помилявся (лінтер, ШІ чи людина) і чому саме ця стаття; examples — n записів-прикладів; covers — скільки записів із наданих покриває правило. summary — 1–3 речення українською про те, що знайдено.

Формат правил (rules/ФОРМАТ_ПРАВИЛ.md):
{format}

Чинний rules.json:
{rules}"""


def draft_schema():
    return {'type': 'object', 'additionalProperties': False, 'required': ['summary', 'rules'], 'properties': {
        'summary': {'type': 'string'},
        'rules': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'required': ['title', 'rule_json', 'replaces', 'why', 'examples', 'covers'],
                                             'properties': {'title': {'type': 'string'}, 'rule_json': {'type': 'string'}, 'replaces': {'type': 'string'},
                                                            'why': {'type': 'string'}, 'examples': {'type': 'array', 'items': {'type': 'integer'}}, 'covers': {'type': 'integer'}}}}}}


def flags(o, h):
    """Де щоденний ШІ не впорався: ai_miss — запропонував іншу статтю, ніж стоїть у CRM; ai_unsure — статті не визначив чи «низька»."""
    out = []
    code, a = o.get('code') or '', (h or {}).get('a') or ''
    if h and a and code and code != a and (o.get('src') or 'crm') == 'crm':
        out.append('ai_miss')
    if h and (not a or h.get('c') == 'низька'):
        out.append('ai_unsure')
    return out


def observations(limit=DRAFT_MAX_OBS):
    """Записи без правил і операції банку без статті для тижневого перегляду (Claude Opus) — свої й інших Помічників зі спільної
    папки: спершу там, де щоденний ШІ помилився чи вагався, далі — операції банку, яких лінтер не розпізнав, решта — найновіші.
    Один запис — один раз (після зміни коментаря чи на двох комп'ютерах він міг лишитися під кількома ключами — береться найновіший)."""
    m, oh = mem(), other_hints()
    with LOCK:
        latest = {}
        for o in all_seen():
            k = o.get('k')
            if k is not None and (k not in latest or (o.get('t') or '') >= (latest[k].get('t') or '')):
                latest[k] = o
        rows = [(o, m['hints'].get(o.get('key')) or oh.get(o.get('key')) or {}) for o in latest.values()]
    rank = lambda f, o: (0 if 'ai_miss' in f else 1 if 'ai_unsure' in f else 2 if o.get('src') == 'bank' else 3)  # noqa: E731
    rows = [(o, h, flags(o, h)) for o, h in rows]
    rows.sort(key=lambda x: (x[0].get('date') or '', str(x[0].get('k'))), reverse=True)
    rows.sort(key=lambda x: rank(x[2], x[0]))
    out = []
    for o, h, f in rows[:limit]:
        ai = {k: v for k, v in (('art', h.get('al')), ('prj', h.get('p')), ('conf', h.get('c')), ('why', h.get('w'))) if v}
        out.append({'k': o['k'], 'src': o.get('src') or 'crm', 'date': o.get('date'), 'type': o.get('type'), 'amount': o.get('amount'), 'ccy': o.get('ccy'),
                    'acc': o.get('acc'), 'cmt': o.get('cmt'), 'art': o.get('art') or '—', 'prj': o.get('prj') or '—', **({'ai': ai} if ai else {}),
                    **({'flags': f} if f else {})})
    return out


def rule_id(raw, taken):
    rid = re.sub(r'[^A-Z0-9\-]', '', str(raw or '').upper().replace('_', '-'))
    if not rid.startswith('R-AI-'):
        rid = 'R-AI-' + (rid[2:] if rid.startswith('R-') else rid or 'RULE-01')
    base, n = rid, 2
    while rid in taken:
        rid = f'{base}-{n}'
        n += 1
    taken.add(rid)
    return rid


def run_draft(auto=False):
    obs = observations()
    if not obs:
        raise AiError('ще немає записів без правил: спершу перевірте записи в «Статтях і проєктах» з увімкненими ШІ-підказками')
    doc = load_rules()
    try:
        fmt = HOST['format_path']().read_text(encoding='utf-8')
    except OSError:
        fmt = ''
    today = datetime.now().strftime('%d.%m.%Y')
    system = DRAFT_SYSTEM.format(fix_from=doc.get('fix_from') or '—', format=fmt, rules=json.dumps(doc, ensure_ascii=False, separators=(',', ':')))
    before = spent()
    sent = [{'n': i + 1, **{f: v for f, v in o.items() if f != 'k'}} for i, o in enumerate(obs)]  # ID записів CRM у Claude не йдуть
    # high: узагальнити випадки й написати умову правила; запас max_tokens — на роздуми (стрім, тож довга відповідь не обірветься)
    data = call(RULES_MODEL, system, json.dumps({'records': sent}, ensure_ascii=False), draft_schema(), 'high', 64000)
    k_of = lambda n: obs[n - 1]['k'] if type(n) is int and 1 <= n <= len(obs) else None  # noqa: E731
    current = {r.get('id'): r for r in doc.get('rules') or [] if r.get('id')}
    taken = set(current)
    rules = []
    for x in (data.get('rules') or [])[:12]:
        if not isinstance(x, dict):
            continue
        rule, err = None, ''
        old = current.get(str(x.get('replaces') or '').strip())  # зміна чинного правила (той самий id), а не нове
        try:
            rule = json.loads(x.get('rule_json') or '')
            if not isinstance(rule, dict) or not isinstance(rule.get('match'), dict) or not isinstance(rule.get('set'), dict):
                raise ValueError('немає умови match чи set')
        except ValueError as e:
            rule, err = None, f'правило не розібрано: {e}'
        if rule:
            rule['id'] = old['id'] if old else rule_id(rule.get('id'), taken)
            rule['title'] = str(rule.get('title') or x.get('title') or rule['id'])
            rule.setdefault('priority', 100)
            rule['source'] = f"ШІ ({MODEL_UA[RULES_MODEL]}), {today}: {'зміна правила' if old else 'чернетка'}"
        rules.append({'title': str(x.get('title') or '')[:200], 'rule': rule, 'raw': None if rule else str(x.get('rule_json') or '')[:4000], 'error': err,
                      'replaces': old['id'] if old else '', 'old': old if old and rule else None,
                      'why': str(x.get('why') or '')[:1500], 'examples': [k for k in (k_of(e) for e in (x.get('examples') or [])) if type(k) is int][:10],
                      'covers': x.get('covers') if type(x.get('covers')) is int else 0, 'status': 'new'})
    out = {'at': now_iso(), 'model': MODEL_UA[RULES_MODEL], 'auto': auto, 'n_obs': len(obs), 'summary': str(data.get('summary') or '')[:2000],
           'rules': rules, 'usd': round(spent() - before, 4)}
    write_json('drafts.json', out)
    log(f'ШІ: чернетка правил — {len(rules)} (записів без правил і операцій банку без статті: {len(obs)})')
    return out


def start_draft(auto=False):
    with LOCK:
        if DRAFT_JOB['running']:
            return 409, {'error': 'чернетка вже складається'}
        st = state()
        if st != 'ready':
            return 400, {'error': f'ШІ: {STATE_UA[st]}'}
        if not HOST['can_edit_rules']():
            return 403, {'error': "правила змінює власник лінтера — на цьому комп'ютері чернетка правил не потрібна"}
        if pace_cap() - spent() < DRAFT_NEED:
            return 400, {'error': f'для перегляду правил ({MODEL_UA[RULES_MODEL]}) у межах ліміту на сьогодні має лишатися ${DRAFT_NEED:.0f} — спробуйте завтра'}
        DRAFT_JOB.update(running=True, error='', started=now_iso())
    threading.Thread(target=_draft, args=(auto,), daemon=True).start()
    return 200, {'ok': True}


def _draft(auto):
    try:
        run_draft(auto)
    except Exception as e:  # noqa: BLE001
        DRAFT_JOB['error'] = explain(e)
        log('ШІ: чернетку правил не складено — ' + DRAFT_JOB['error'])
        if auto:  # обрізана чи відхилена відповідь уже оплачена — сама не повторюється кожні 6 год, а лише через добу
            try:
                write_json('draft_try.json', {'at': now_iso(), 'error': DRAFT_JOB['error']})
            except OSError:
                pass
    finally:
        DRAFT_JOB['running'] = False


def drafts():
    return {**read_json('drafts.json', {}), 'job': DRAFT_JOB}


def mark_draft(i, status, at=None, rid=None):
    """Позначка правила чернетки ШІ. at і rid — яку чернетку й яке правило бачила сторінка: тижнева чернетка могла за цей час
    скластися заново, і той самий номер i — уже інше правило (тоді 409, сторінка перечитує чернетку)."""
    if status not in ('new', 'added', 'rejected'):
        return 400, {'error': 'невідомий стан'}
    with LOCK:
        d = read_json('drafts.json', {})
        rules = d.get('rules') or []
        if type(i) is not int or not 0 <= i < len(rules):
            return 404, {'error': 'такого правила в чернетці немає'}
        if (at is not None and d.get('at') != at) or (rid is not None and ((rules[i].get('rule') or {}).get('id') or '') != rid):
            return 409, {'error': 'чернетка ШІ оновилася — ось нова, перегляньте її ще раз'}
        rules[i]['status'] = status
        write_json('drafts.json', d)
    return 200, {'ok': True}


def next_draft_at():
    try:
        at = read_json('drafts.json', {}).get('at')
        return datetime.fromisoformat(at) + DRAFT_EVERY if at else None
    except (TypeError, ValueError):
        return None


def all_seen():
    """Записи для тижневого перегляду — свої й інших Помічників зі спільної папки (кешфлоу може вести колега)."""
    return list(mem()['seen'].values()) + [o for x in others('seen.json') for o in x['data'].values() if isinstance(o, dict)]


def new_since_draft():
    at = read_json('drafts.json', {}).get('at') or ''
    with LOCK:
        return sum(1 for o in all_seen() if (o.get('t') or '') > at)


def maybe_draft():
    """Раз на тиждень: ШІ працює, тут можна змінювати правила й назбиралося DRAFT_MIN_NEW нових записів без правил."""
    if DRAFT_JOB['running'] or state() != 'ready' or not HOST['can_edit_rules']() or pace_cap() - spent() < DRAFT_NEED:
        return False
    try:  # остання автоматична спроба не вдалася менше ніж добу тому — чекаємо (кожна така спроба могла коштувати)
        tried = datetime.fromisoformat(read_json('draft_try.json', {}).get('at') or '')
        if (datetime.now() - tried).total_seconds() < DRAFT_RETRY:
            return False
    except (TypeError, ValueError):
        pass
    nxt = next_draft_at()
    if (nxt and datetime.now() < nxt) or new_since_draft() < DRAFT_MIN_NEW:
        return False
    return start_draft(auto=True)[0] == 200


def start_scheduler():
    def loop():
        time.sleep(90)
        while True:
            try:
                maybe_draft()
            except Exception as e:  # noqa: BLE001
                log(f'ШІ: планувальник чернетки — {e}')
            time.sleep(6 * 3600)
    threading.Thread(target=loop, daemon=True).start()


# ---------- налаштування з вікна Помічника ----------
def set_key(key):
    key = str(key or '').strip().strip('"')
    if not KEY_RE.fullmatch(key):
        return 400, {'error': 'це не схоже на ключ Claude API (він починається з sk-ant-)'}
    save_key(key)
    WORK.update(auth=False, error='')
    FAILED.clear()
    if cfg().get('on') is None:
        set_cfg(on=True)
    if not CLIENT_FACTORY[0] and sdk() is None:
        start_sdk_install()
        return 200, {'ok': True, 'installing': True}
    ok, err = verify()
    return 200, {'ok': ok, 'error': err}


def set_config(data):
    upd = {}
    if 'on' in data:
        upd['on'] = bool(data['on'])
    if 'limit' in data:
        try:
            v = float(data['limit'])
        except (TypeError, ValueError):
            return 400, {'error': 'ліміт — число доларів на місяць'}
        if not 0 <= v <= 1000:
            return 400, {'error': 'ліміт — від 0 до 1000 доларів на місяць'}
        upd['limit'], upd['limit_own'] = round(v, 2), True
    if 'shared' in data:  # спільна папка: '' — шукати «Кешфлоу ШІ» на Google Диску самому, 'off' — вимкнено, інакше — шлях
        v = str(data.get('shared') or '').strip().strip('"')
        if v and v != 'off' and not Path(v).is_dir():
            return 400, {'error': f'папки «{v}» немає — перевірте шлях (Google Диск для комп\'ютера має бути запущено)'}
        upd['shared'] = v
        SHARED.update(path=None, at=0.0, pushed=0.0)
    set_cfg(**upd)
    return 200, {'ok': True, 'status': status()}


def shared_info():
    """Для «Налаштувань»: спільна папка (вписана чи знайдена сама), цей комп'ютер і хто ще пише в неї, коли востаннє."""
    p = str(cfg().get('shared') or '').strip()
    d = shared_dir()
    who = {}
    for name in SHARED_FILES:
        for o in others(name):
            who[o['who']] = max(who.get(o['who'], 0), o['at'])
    return {'path': str(d) if d else '', 'set': p, 'off': p == 'off', 'missing': bool(p) and p != 'off' and not d, 'me': machine_id(),
            'name': SHARED_NAME, 'others': [{'who': k, 'at': datetime.fromtimestamp(v).isoformat(timespec='minutes')} for k, v in sorted(who.items())]}


def status():
    share_tick()
    st, u, d = state(), own_usage().get(month()) or {}, read_json('drafts.json', {})
    nxt = next_draft_at()
    with LOCK:
        queue = len(QUEUE) + len(INFLIGHT)
    return {'state': st, 'state_ua': STATE_UA[st], 'key': bool(load_key()), 'on': cfg().get('on') is not False, 'limit': limit_usd(), 'pace': pace_cap(),
            'sdk': sdk_version(), 'sdk_job': SDK_JOB, 'check': cfg().get('check'), 'models': MODEL_UA,
            'roles': {'daily': MODEL_UA[HINTS_MODEL], 'weekly': MODEL_UA[RULES_MODEL]}, 'shared': shared_info(),
            'others_usd': round(foreign_usd(), 4),
            'usage': {'month': month(), 'usd': round(float(u.get('usd', 0.0)), 4), 'models': u.get('models', {})},
            'hints': {'known': len(mem()['hints']), 'queue': queue, 'error': WORK['error']},
            'drafts': {'at': d.get('at'), 'n': len(d.get('rules') or []), 'new': sum(1 for r in d.get('rules') or [] if r.get('status') == 'new'),
                       'next': nxt.isoformat(timespec='minutes') if nxt else None, 'new_obs': new_since_draft(), 'min_new': DRAFT_MIN_NEW,
                       'job': DRAFT_JOB, 'can': bool(HOST['can_edit_rules']())}}
