#!/usr/bin/env python3
"""
Вивантаження виписок ПриватБанку (API «Автоклієнта») і monobank (особистий API)
у файли JSON для панелі звірки privat_recon.js (поле «Файли банку»).

Запуск:
    python privat_fetch.py                          — скрипт сам запитає період
    python privat_fetch.py 01.10.2026 13.10.2026    — період одразу в команді
    python privat_fetch.py 01.10.2026 13.10.2026 --mono-currency — і валютні рахунки Моно
Можна запускати подвійним клацанням: вікно запитає дати «з» і «по»
(Enter — дата в дужках) і не закриється, доки не натиснете Enter.

Токени — у файлі privat_tokens.json поруч зі скриптом. Один рядок — один
клієнт (ФОП або ТОВ). Лише Приват — просто токен; кілька банків — {"privat": …, "mono": …}.
Рядки через кому, після останнього коми немає; назви не повторюються:
    {
      "ПРИКЛАД":           "токен Привату",
      "ФОП Хоменко":  {"privat": "токен Привату", "mono": "токен Моно"},
      "ФОП Іваненко": {"mono": "токен Моно"}
    }
Порожній токен "" — банк (або клієнта) пропущено.

Приват: «Приват24 для бізнесу» → «Облік та звіти» → «Інтеграція (Автоклієнт)»
→ «Підключити додаток» → API. Для ТОВ API доступний у тарифах «Бізнес Комфорт»
і «Бізнес ПРО», для ФОП — у будь-якому тарифі.
Моно: токен для персонального використання з https://api.monobank.ua/
Береться ЛИШЕ рахунки ФОП (тип fop): власні рахунки ФОП власника токена і рахунки
ФОП, до яких надано доступ бухгалтеру (managedClients), — ті, в чиєму імені є
слово з назви клієнта (прізвище). Особисті картки і банки не вивантажуються.
Банк дозволяє функцію не частіше ніж 1 раз у 60 с і виписку не довше 31 доби + 1 година
за запит — скрипт сам чекає й ділить період, тому кожен наступний рахунок того самого
токена Моно — ще хвилина.
З 06.11.2026 з Моно беруться лише гривневі рахунки ФОП: на валютних (долар, євро…) руху
зазвичай немає, а кожен із них — ще хвилина очікування. Їхні залишки скрипт лише показує в журналі.
Валютні теж — ключ --mono-currency (його додає «Помічник кешфлоу», коли в «Налаштуваннях» →
«Виписки банку» стоїть галочка «валютні рахунки Моно»). Приват — усі рахунки, як і раніше.

Одночасно (з 06.11.2026): у кожного ФОП і ТОВ свій токен, тож клієнти й банки вивантажуються
паралельно — кожен токен у своєму потоці, з паузами, яких вимагають банки:
  • Приват — не частіше 1 запиту на секунду на токен («Рекомендовано відправляти запити не
    частіше 1 запиту в секунду», «Опис API … Автоклієнта», версія 3.0.0) і разом не більше
    PRIVAT_PARALLEL одночасних запитів з цього комп'ютера; під час регламентних робіт банку
    (work_balance = Y у statements/settings) скрипт чекає, а не сипле запитами;
  • Моно — кожна функція токена (дані клієнта, виписка) не частіше 1 разу на 60 с
    (документація monobank); той самий токен у кількох клієнтів — по черзі.
Запитів не більше, ніж раніше, — вони лише йдуть одночасно, тож усе вивантаження триває
приблизно стільки, скільки найдовший токен (Моно з кількома рахунками), а не суму всіх.

Результат: окремий файл на кожен банк кожного клієнта — виписка_Приват_<клієнт>_<з>_<по>.json,
виписка_Моно_<клієнт>_<з>_<по>.json (вхідний залишок на дату «з», вихідний на «по», операції)
і загальний файл виписка_ВСІ_<з>_<по>.json — рахунки всіх клієнтів
(у кожного рахунку поля "bank" і "client").
Потрібен пакет requests: на новому комп'ютері один раз запустіть встановити.bat
(він знайде Python і встановить requests), далі запускайте запустити.bat.
"""
import json
import re
import sys
import threading
import time
import traceback
from datetime import date, datetime, timedelta
from pathlib import Path

try:
    import requests
except ImportError:  # пакет ще не встановлено — повідомимо в main(), щоб вікно не закрилося мовчки
    requests = None

BASE = "https://acp.privatbank.ua/api/"
MONO = "https://api.monobank.ua"
MONO_MAX = 2682000  # с: виписка Моно — не довше 31 доби + 1 година за запит (документація monobank)
MONO_GAP = 61       # с: функція токена — не частіше 1 разу на 60 с (документація monobank) + 1 с запасу
PRIVAT_GAP = 1.0    # с між запитами одного токена Привату: «не частіше 1 запиту в секунду» (Опис API Автоклієнта 3.0.0)
PRIVAT_PARALLEL = 4  # одночасних запитів до Привату з цього комп'ютера (щоб не навантажувати банк з однієї адреси)
REGL_WAIT, REGL_TRIES = 20, 6  # регламентні роботи Привату: перепитати через 20 с, до 6 разів (2 хв)
CCY = {980: "UAH", 840: "USD", 978: "EUR", 985: "PLN", 826: "GBP"}
UAH = 980                        # код гривні (ISO 4217) у currencyCode Моно
MONO_CCY_FLAG = "--mono-currency"  # і валютні рахунки Моно (без ключа — лише гривневі)
BANK_KEYS = {"privat": "privat", "приват": "privat", "mono": "mono", "моно": "mono",
             "monobank": "mono", "монобанк": "mono"}
BANK_NAME = {"privat": "Приват", "mono": "Моно"}
HERE = Path(__file__).resolve().parent
TOKENS = HERE / "privat_tokens.json"
USAGE = ("Використання: python privat_fetch.py ДД.ММ.РРРР ДД.ММ.РРРР  (або без дат — скрипт запитає); "
         f"{MONO_CCY_FLAG} — і валютні рахунки Моно")


class Stop(Exception):
    """Помилка, після якої скрипт зупиняється (показується без трасування)."""


_out = threading.Lock()
CANCEL = threading.Event()  # Ctrl+C: потоки більше нічого не друкують і не запитують


def say(msg):
    """Рядок журналу з будь-якого потоку — цілим рядком (Помічник показує журнал наживо)."""
    if CANCEL.is_set():
        return
    with _out:
        print(msg, flush=True)


def pause(s):
    """Пауза, яку перериває Ctrl+C (CANCEL)."""
    if CANCEL.wait(s):
        raise Stop("скасовано")


_privat_last = {}  # токен Привату -> коли пішов останній запит (токен обслуговує один потік)
_privat_slots = threading.BoundedSemaphore(PRIVAT_PARALLEL)


def get(path, token, params):
    headers = {"token": token, "User-Agent": "privat_recon", "Content-Type": "application/json;charset=utf8"}
    for attempt in range(1, 6):
        wait = _privat_last.get(token, 0) + PRIVAT_GAP - time.time()
        pause(max(wait, 0))
        with _privat_slots:
            _privat_last[token] = time.time()
            r = requests.get(BASE + path, headers=headers, params=params, timeout=60)
        if r.status_code in (429, 503, 504):
            pause(2 * attempt)
            continue
        try:
            j = r.json()
        except ValueError:
            raise RuntimeError(f"{path}: HTTP {r.status_code}, відповідь не JSON")
        if r.status_code != 200 or j.get("status") == "ERROR":
            raise RuntimeError(f"{path}: HTTP {r.status_code} {j.get('message', '')}")
        return j
    raise RuntimeError(f"{path}: сервіс недоступний")


def paged(path, token, params, key):
    out, follow = [], None
    while True:
        p = dict(params, limit=100)
        if follow:
            p["followId"] = follow
        j = get(path, token, p)
        out.extend(j.get(key) or [])
        if not j.get("exist_next_page"):
            return out
        follow = j.get("next_page_id")  # пауза між сторінками — у get (не частіше 1 запиту на секунду на токен)


# ---------- період ----------
def parse_date(s):
    """'01.10.2026', '1.10.2026', '01-10-2026', '01/10/2026' -> date; інакше None."""
    m = re.fullmatch(r"\s*(\d{1,2})[./,-](\d{1,2})[./,-](\d{4})\s*", s or "")
    if not m:
        return None
    try:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:  # 31.09.2026 тощо
        return None


def period_error(d_from, d_to):
    today = date.today()
    if d_to > today:
        return f"дата «по» {d_to:%d.%m.%Y} пізніша за сьогодні ({today:%d.%m.%Y})"
    if d_from > d_to:
        return f"дата «з» {d_from:%d.%m.%Y} пізніша за дату «по» {d_to:%d.%m.%Y}"
    return None


def ask_date(label, default, check):
    while True:
        try:
            s = input(f"  {label} [{default:%d.%m.%Y}]: ")
        except EOFError:
            raise Stop("не вказано період. " + USAGE)
        d = default if not s.strip() else parse_date(s)
        if d is None:
            print("    Не розумію дату. Приклад: 01.10.2026")
            continue
        err = check(d)
        if err:
            print(f"    {err}")
            continue
        return d


def ask_period():
    """Запит періоду у вікні. За замовчуванням — з 1-го числа місяця по вчора;
    якщо «з» у минулому місяці — «по» пропонується останнім днем того місяця."""
    today = date.today()
    yesterday = today - timedelta(days=1)
    print("Період виписки (формат ДД.ММ.РРРР; Enter — дата в дужках):")
    d_from = ask_date("з ", yesterday.replace(day=1),
                      lambda d: f"дата пізніша за сьогодні ({today:%d.%m.%Y})" if d > today else None)
    month_end = (d_from.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    d_to = ask_date("по", max(d_from, min(month_end, yesterday)), lambda d: period_error(d_from, d))
    return d_from, d_to


def split_args(argv):
    """['01.10.2026', '13.10.2026', '--mono-currency'] -> (['01.10.2026', '13.10.2026'], True); невідомий ключ — зупинка."""
    flags = [a for a in argv if a.startswith("--")]
    bad = [a for a in flags if a != MONO_CCY_FLAG]
    if bad:
        raise Stop(f"невідомий ключ {bad[0]}. " + USAGE)
    return [a for a in argv if not a.startswith("--")], MONO_CCY_FLAG in flags


def period_from_args(args):
    if len(args) != 2:
        raise Stop(USAGE)
    d_from, d_to = parse_date(args[0]), parse_date(args[1])
    if d_from is None or d_to is None:
        raise Stop("не розумію дату. " + USAGE)
    err = period_error(d_from, d_to)
    if err:
        raise Stop(err)
    return d_from, d_to


# ---------- токени ----------
def load_tokens():
    if not TOKENS.exists():
        raise Stop(f"немає файлу {TOKENS.name} у папці {HERE}")

    def no_repeats(pairs):
        seen = {}
        for k, v in pairs:
            if k in seen:
                raise Stop(f"{TOKENS.name}: назва «{k}» записана двічі — назви мають різнитися")
            seen[k] = v
        return seen

    try:
        tokens = json.loads(TOKENS.read_text(encoding="utf-8-sig"), object_pairs_hook=no_repeats)
    except UnicodeDecodeError:
        raise Stop(f"{TOKENS.name}: файл не в кодуванні UTF-8 — збережіть його як UTF-8")
    except json.JSONDecodeError as e:
        raise Stop(f"{TOKENS.name}: помилка в рядку {e.lineno}, символ {e.colno} ({e.msg}). "
                   'Перевірте: назва і токен у прямих лапках "…", між рядками кома, після останнього — без коми.')
    if not isinstance(tokens, dict) or not tokens:
        raise Stop(f'{TOKENS.name}: очікується {{"Назва": "токен", "Назва 2": {{"privat": "токен", "mono": "токен"}}}}')
    return tokens


def client_banks(v):
    """"токен" -> {"privat": токен}; {"privat": …, "mono": …} -> як є (назви банків нормалізуються)."""
    if v is None or isinstance(v, str):
        return {"privat": (v or "").strip()}
    if isinstance(v, dict):
        out = {}
        for k, t in v.items():
            bank = BANK_KEYS.get(str(k).strip().lower())
            if not bank:
                raise RuntimeError(f'невідомий банк «{k}» — пишіть "privat" або "mono"')
            out[bank] = str(t or "").strip()
        return out
    raise RuntimeError('очікується "токен" або {"privat": "токен", "mono": "токен"}')


def check_token(token, where):
    if not re.fullmatch(r"[!-~]+", token):
        raise RuntimeError("це не схоже на токен (лише латиниця, цифри, знаки, без пробілів) — "
                           f"вставте токен з {where} без змін")


# ---------- Приват ----------
def privat_settings(token, log):
    """statements/settings; під час регламентних робіт банку (work_balance = Y: «запити не робити») — чекати, а не запитувати."""
    for attempt in range(REGL_TRIES):
        s = get("statements/settings", token, {}).get("settings", {})
        if str(s.get("work_balance") or "N").upper() != "Y":
            return s
        if attempt < REGL_TRIES - 1:
            log(f"Приват: у банку регламентні роботи — чекаю {REGL_WAIT} с…")
            pause(REGL_WAIT)
    raise RuntimeError("у банку регламентні роботи (work_balance = Y) — спробуйте за кілька хвилин")


DUP_WARN = "Банк віддав операцію двічі — дубль пропущено"


def privat_key(t):
    """Ключ операції для пошуку дублів: ID банку; без ID — REF+REFN+TRANTYPE+SUM+DAT_OD+TIM_P."""
    if t.get("ID"):
        return ("ID", str(t["ID"]))
    return tuple(str(t.get(k) or "") for k in ("REF", "REFN", "TRANTYPE", "SUM", "DAT_OD", "TIM_P"))


def privat_cents(v):
    """Сума Привату в копійках — як num() у core/recon.js (пробіли, кома); не число — 0."""
    m = re.search(r"-?\d+(?:\.\d+)?", re.sub(r"\s", "", str(v or "")).replace(",", ".", 1))
    return round(float(m.group(0)) * 100) if m else 0


def privat_gap(a, rows):
    """вхідний + рух − вихідний, у копійках; None — без обох залишків.
    Рух — як рахує панель (normPrivat): лише проведені (PR_PR порожній або «r»), D — мінус, решта — плюс."""
    if a.get("opening") is None or a.get("closing") is None:
        return None
    move = sum((-1 if t.get("TRANTYPE") == "D" else 1) * privat_cents(t.get("SUM"))
               for t in rows if not t.get("PR_PR") or t.get("PR_PR") == "r")
    return round(a["opening"] * 100) + move - round(a["closing"] * 100)


def privat_group(accs, trans, create=True):
    """Операції по рахунках без дублів: {рахунок: [операції, скільки дублів пропущено]}.
    07.11.2026: на межі сторінок (followId) банк у вересні віддав одну операцію двічі, а іншу пропустив."""
    out, seen = {}, {}
    for t in trans:
        acc = t.get("AUT_MY_ACC")
        key = acc if acc in accs else None
        if key is None:  # рахунок у транзакції може бути не в форматі IBAN — шукаємо за закінченням
            key = next((k for k in accs if acc and k.endswith(acc)), None)
        if key is None:
            if not create:
                continue
            accs[acc] = {"acc": acc, "ccy": t.get("CCY"), "name": "", "warnings": ["немає залишків по рахунку"]}
            key = acc
        g = out.setdefault(key, [[], 0])
        k = privat_key(t)
        if k in seen.setdefault(key, set()):
            g[1] += 1
            continue
        seen[key].add(k)
        g[0].append(t)
    return out


def privat_accounts(token, d_from, d_to, log=say):
    check_token(token, "Приват24 для бізнесу")
    F, T = d_from.strftime("%d-%m-%Y"), d_to.strftime("%d-%m-%Y")
    settings = privat_settings(token, log)
    b_open = paged("statements/balance", token, {"startDate": F, "endDate": F}, "balances")
    b_close = paged("statements/balance", token, {"startDate": T, "endDate": T}, "balances")
    t_params = {"startDate": F, "endDate": T}
    trans = paged("statements/transactions", token, t_params, "transactions")

    accs = {}
    for b in b_open:
        a = accs.setdefault(b["acc"], {"acc": b["acc"], "ccy": b.get("currency"), "name": b.get("nameACC"), "warnings": []})
        if "opening" in a:
            a["warnings"].append("API повернув кілька вхідних залишків — взято перший")
        else:
            a["opening"] = float(b["balanceIn"])
    for b in b_close:
        a = accs.setdefault(b["acc"], {"acc": b["acc"], "ccy": b.get("currency"), "name": b.get("nameACC"), "warnings": []})
        if "closing" in a:
            a["warnings"].append("API повернув кілька вихідних залишків — взято перший")
        else:
            a["closing"] = float(b["balanceOut"])
    groups = privat_group(accs, trans)
    # 07.11.2026: вхідний + рух має дорівнювати вихідному — інакше банк віддав неповну виписку
    # (у вересні на одному рахунку бракувало однієї операції). Перепитуємо операції клієнта один раз (паузи — у get).
    bad = {}
    for k, a in accs.items():  # і рахунки без жодної операції: банк міг загубити саме їх
        gap = privat_gap(a, groups.get(k, [[], 0])[0])
        if gap:
            bad[k] = gap
    if bad:
        log(f"Приват: вхідний + рух ≠ вихідний ({', '.join(str(k)[-4:] for k in bad)}) — перепитую операції ще раз…")
        again = privat_group(accs, paged("statements/transactions", token, t_params, "transactions"), create=False)
        for k, gap in bad.items():
            g2 = again.get(k, [[], 0])
            gap2 = privat_gap(accs[k], g2[0])
            if abs(gap2) < abs(gap):  # повторна відповідь ближча до залишків банку — беремо її
                groups[k], bad[k] = g2, gap2
    for k, (rows, dups) in groups.items():
        accs[k]["transactions"] = rows
        if dups:
            accs[k]["warnings"].append(DUP_WARN + (f" ({dups})" if dups > 1 else ""))
        if bad.get(k):  # текст починається з «Виписка неповна» — за ним панель показує попередження
            accs[k]["warnings"].append(f"Виписка неповна: вхідний + рух ≠ вихідний на {abs(bad[k]) / 100:.2f} грн — вивантажте заново")

    final = settings.get("date_final_statement", "")
    for a in accs.values():
        a.setdefault("opening", None)
        a.setdefault("closing", None)
        a.setdefault("transactions", [])
        if final:
            fd = datetime.strptime(final[:10], "%d.%m.%Y").date()
            if d_to > fd:
                a["warnings"].append(f"Підсумкова виписка банку є лише до {final[:10]}; дні після — проміжні дані")
    return list(accs.values())


# ---------- Моно ----------
_mono_last = {}  # (токен, функція) -> час останнього запиту: «Обмеження на використання функції не частіше ніж 1 раз у 60 секунд»
_mono_info = {}  # токен -> client-info (один і той самий токен може стояти в кількох клієнтів)


def mono_get(path, token, what, fn, log=say):
    """fn — функція API ('client-info' чи 'statement'): ліміт банку — на функцію; 429 — ще раз через 61 с (як і раніше)."""
    for attempt in range(3):
        wait = _mono_last.get((token, fn), 0) + MONO_GAP - time.time()
        if wait > 0:
            log(f"Моно: чекаю {int(wait + 0.999)} с (банк дозволяє 1 запит на 60 с)…")
        pause(max(wait, 0))
        r = requests.get(MONO + path, headers={"X-Token": token}, timeout=60)
        _mono_last[(token, fn)] = time.time()
        if r.status_code == 429:  # забагато запитів — наступна спроба через 61 с
            continue
        try:
            j = r.json()
        except ValueError:
            raise RuntimeError(f"{what}: HTTP {r.status_code}, відповідь не JSON")
        if r.status_code != 200:
            msg = j.get("errorDescription", "") if isinstance(j, dict) else ""
            raise RuntimeError(f"{what}: HTTP {r.status_code} {msg}".strip())
        return j
    raise RuntimeError(f"{what}: банк тричі відповів 429 (забагато запитів)")


def mono_statement(token, acc_id, t_from, t_to, log=say):
    """Операції рахунку за [t_from, t_to] від нових до старих: вікна ≤ 31 доби + 1 год;
    якщо у відповіді 500 операцій — дозапит із «to» = час найстарішої з них."""
    out, seen = [], set()
    hi = t_to
    while hi >= t_from:
        lo = max(t_from, hi - MONO_MAX + 1)
        to = hi
        while True:
            items = mono_get(f"/personal/statement/{acc_id}/{lo}/{to}", token, "виписка", "statement", log)
            new = [t for t in items if t["id"] not in seen]
            for t in new:
                seen.add(t["id"])
                out.append(t)
            if len(items) < 500:
                break
            if not new:
                raise RuntimeError("виписка: понад 500 операцій з однаковим часом — не можу вивантажити")
            to = min(t["time"] for t in items)
        hi = lo - 1
    return out


def mono_groups(info, client):
    """Рахунки ФОП із client-info, що належать клієнту: [(ім'я ФОП, [рахунки])]."""
    groups = []
    own = [a for a in info.get("accounts") or [] if a.get("type") == "fop"]
    if own:
        groups.append((info.get("name") or "", own))
    for m in info.get("managedClients") or []:
        accs = [a for a in m.get("accounts") or [] if a.get("type") == "fop"]
        if accs:
            groups.append((m.get("name") or "", accs))
    if not groups:
        raise RuntimeError("за цим токеном немає рахунків ФОП")
    kw = [w for w in re.findall(r"[a-zа-яіїєґ'ʼ’]+", client.lower()) if len(w) >= 3 and w not in ("фоп", "тов")]
    hit = [g for g in groups if any(w in g[0].lower() for w in kw)]
    if hit:
        return hit
    if len(groups) == 1:  # токен самого ФОП, а в назві клієнта немає прізвища
        return groups
    raise RuntimeError("за токеном кілька ФОП (" + "; ".join(g[0] for g in groups) +
                       f") — допишіть прізвище в назву «{client}»")


_mono_skipped = {}  # клієнт -> ["USD 0.00", …]: валютні рахунки, яких не вивантажено (без --mono-currency)


def is_uah(acc):
    """Гривневий рахунок Моно; без коду валюти — береться, як і раніше."""
    return acc.get("currencyCode") in (None, UAH)


def fx_label(acc):
    """Валютний рахунок Моно для журналу: «EUR 125.00» — валюта й поточний залишок з даних клієнта (без запиту виписки)."""
    ccy = CCY.get(acc.get("currencyCode"), str(acc.get("currencyCode")))
    return ccy if acc.get("balance") is None else f"{ccy} {acc['balance'] / 100:.2f}"


def mono_accounts(client, token, d_from, d_to, log=say, currency=False):
    check_token(token, "api.monobank.ua")
    if token not in _mono_info:
        _mono_info[token] = mono_get("/personal/client-info", token, "дані клієнта", "client-info", log)
    groups = mono_groups(_mono_info[token], client)
    if not currency:  # лише гривневі: на валютних руху зазвичай немає, а кожен рахунок — ще хвилина
        fx = [a for _, accs in groups for a in accs if not is_uah(a)]
        groups = [(owner, [a for a in accs if is_uah(a)]) for owner, accs in groups]
        if fx:
            _mono_skipped[client] = [fx_label(a) for a in fx]
            log(f"Моно: валютні рахунки не вивантажую ({', '.join(_mono_skipped[client])}) — лише гривневі")

    t_from = int(datetime(d_from.year, d_from.month, d_from.day).timestamp())
    t_to = int((datetime(d_to.year, d_to.month, d_to.day) + timedelta(days=1)).timestamp()) - 1
    now = int(time.time())
    # якщо від «з» до зараз ≤ 31 доби + 1 год — беремо одним запитом і дні після «по»:
    # тоді вихідний залишок на «по» точний, навіть коли за період операцій немає
    fetch_to = now if now - t_from <= MONO_MAX else min(t_to, now)

    result = []
    for owner, accs in groups:
        for acc in accs:
            ccy = CCY.get(acc.get("currencyCode"), str(acc.get("currencyCode")))
            log(f"Моно {acc.get('iban') or acc['id']} {ccy}: вивантажую…")
            items = mono_statement(token, acc["id"], t_from, fetch_to, log)
            chron = [t for _, t in sorted(enumerate(items), key=lambda p: (p[1]["time"], -p[0]))]
            inside = [t for t in chron if t_from <= t["time"] <= t_to]
            after = [t for t in chron if t["time"] > t_to]
            warnings = []
            if after:
                closing = after[0]["balance"] - after[0]["amount"]
            elif inside:
                closing = inside[-1]["balance"]
            elif fetch_to == now:
                closing = acc.get("balance")
            else:
                closing = None
                warnings.append("За період операцій немає, а від «по» до сьогодні понад 31 добу — залишки не знаю.")
            if fetch_to == now and not after and closing is not None and acc.get("balance") is not None \
                    and closing != acc["balance"]:
                warnings.append(f"Залишок за випискою {closing / 100:.2f} ≠ поточному балансу рахунку {acc['balance'] / 100:.2f}.")
            opening = inside[0]["balance"] - inside[0]["amount"] if inside else closing
            breaks = [t for p, t in zip(chron, chron[1:]) if p["balance"] + t["amount"] != t["balance"]]
            if breaks:
                first = datetime.fromtimestamp(breaks[0]["time"]).strftime("%d.%m.%Y %H:%M")
                warnings.append(f"Баланс після операції ≠ попередній баланс + сума: {len(breaks)} раз(и), перший {first}.")
            if acc.get("creditLimit"):
                warnings.append(f"Кредитний ліміт рахунку {acc['creditLimit'] / 100:.2f} — перевірте, чи входить він у залишки банку.")
            result.append({"acc": acc.get("iban") or acc["id"], "ccy": ccy, "name": f"{owner} ФОП".strip(),
                           "opening": None if opening is None else opening / 100,
                           "closing": None if closing is None else closing / 100,
                           "transactions": inside, "warnings": warnings})
    return result


# ---------- запуск ----------
def save(path, client, d_from, d_to, accounts, extra=None):
    out = {"source": "bank_api", "client": client, "from": d_from.isoformat(), "to": d_to.isoformat(),
           "fetched_at": datetime.now().strftime("%d.%m.%Y %H:%M")}
    out.update(extra or {})
    out["accounts"] = accounts
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")


def main(interactive):
    if requests is None:
        raise Stop("не встановлено пакет requests. Запустіть встановити.bat у цій папці "
                   "(або в командному рядку: py -m pip install requests)")
    dates, mono_ccy = split_args(sys.argv[1:])
    tokens = load_tokens()
    d_from, d_to = ask_period() if interactive else period_from_args(dates)
    print(f"\nПеріод {d_from:%d.%m.%Y} – {d_to:%d.%m.%Y}; клієнтів у {TOKENS.name}: {len(tokens)}\n")
    stamp = f"{d_from:%d.%m.%Y}_{d_to:%d.%m.%Y}"

    done, skipped, failed, all_accounts, clients = [], [], [], [], []
    jobs = []  # (клієнт, банк, токен) — у порядку файла токенів
    for client, raw in tokens.items():
        try:
            banks = {b: t for b, t in client_banks(raw).items() if t}
        except RuntimeError as e:
            print(f"== {client}\n  ПОМИЛКА: {e}")
            failed.append((client, e))
            continue
        if not banks:
            skipped.append(client)
            continue
        jobs += [(client, bank, token) for bank, token in banks.items()]

    # Одночасно: кожен токен — свій потік; той самий токен у кількох клієнтів — по черзі в одному потоці (ліміти банку — на токен)
    lanes = {}
    for job in jobs:
        lanes.setdefault((job[1], job[2]), []).append(job)
    results = {}

    def run_lane(lane):
        for client, bank, token in lane:
            label, log = BANK_NAME[bank], (lambda msg, c=client: say(f"  [{c}] {msg}"))
            t0 = time.time()
            try:  # помилка одного банку/клієнта не зупиняє інших
                log(f"{label}: вивантажую…")
                accs = (privat_accounts(token, d_from, d_to, log) if bank == "privat"
                        else mono_accounts(client, token, d_from, d_to, log, currency=mono_ccy))
                log(f"{label}: готово за {time.time() - t0:.0f} с — рахунків {len(accs)}")
                results[(client, bank)] = accs
            except Exception as e:  # noqa: BLE001
                log(f"{label}: ПОМИЛКА: {e}")
                results[(client, bank)] = e

    t_all = time.time()
    if lanes:
        say(f"Вивантажую одночасно: токенів {len(lanes)} (Приват — до {PRIVAT_PARALLEL} запитів разом, Моно — кожен токен окремо)…")
        if any(bank == "mono" for _, bank, _ in jobs):
            say("Моно: і валютні рахунки (ключ --mono-currency)." if mono_ccy else
                "Моно: лише гривневі рахунки ФОП (валютні — галочкою в «Налаштуваннях» Помічника або ключем --mono-currency).")
        # потоки-«демони» і очікування короткими кроками: Ctrl+C у вікні зупиняє все одразу (раніше чекав хвилинних пауз Моно в потоках)
        threads = [threading.Thread(target=run_lane, args=(lane,), daemon=True) for lane in lanes.values()]
        for t in threads:
            t.start()
        try:
            for t in threads:
                while t.is_alive():
                    t.join(0.2)
        except KeyboardInterrupt:
            CANCEL.set()  # решта потоків мовчить і не робить нових запитів
            raise
        say(f"Банки відповіли за {time.time() - t_all:.0f} с.\n")

    seen_client = set()
    for client, bank, token in jobs:  # файли й підсумок — у порядку файла токенів, як і раніше
        label, res = BANK_NAME[bank], results.get((client, bank))
        if client not in seen_client:
            seen_client.add(client)
            print(f"== {client}")
        safe = re.sub(r'[\\/:*?"<>|]+', "_", client).strip().replace(" ", "_")
        if isinstance(res, Exception) or res is None:
            print(f"  {label}: ПОМИЛКА: {res}")
            failed.append((f"{client} ({label})", res))
            continue
        accs = res
        for a in accs:
            a["bank"], a["client"] = bank, client
            print(f"  {label} {a['acc']} {a['ccy']}: вхідний {a['opening']}, вихідний {a['closing']}, "
                  f"транзакцій {len(a['transactions'])}")
            for w in a["warnings"]:  # 07.11.2026: і Приват (дублі, неповна виписка); «Підсумкова виписка…» — щодня в кожного рахунку, лише в панелі
                if bank == "mono" or not w.startswith("Підсумкова виписка"):
                    print(f"    ! {w}")
        if accs:  # окремий файл на кожен банк клієнта
            path = HERE / f"виписка_{label}_{safe}_{stamp}.json"
            save(path, client, d_from, d_to, accs, {"bank": bank})
            print(f"  → {path.name}")
            done.append(path.name)
            if client not in clients:
                clients.append(client)
            all_accounts += accs

    if all_accounts:  # загальний файл: усі рахунки всіх клієнтів і банків
        allf = HERE / f"виписка_ВСІ_{stamp}.json"
        save(allf, "ВСІ", d_from, d_to, all_accounts, {"clients": clients})
        print(f"\n== Загальний файл ({len(clients)} клієнт(ів), рахунків {len(all_accounts)})\n  → {allf.name}")

    print(f"\nГотово, окремих файлів: {len(done)}. У панелі звірки (поле «Файли банку») достатньо "
          "вибрати лише загальний файл виписка_ВСІ_….json.")
    if skipped:
        print("Пропущено (порожній токен): " + "; ".join(skipped))
    fx = [(c, _mono_skipped[c]) for c in tokens if c in _mono_skipped]
    if fx:
        print("Валютні рахунки Моно не вивантажено (лише гривневі; поточний залишок — з даних банку): "
              + "; ".join(f"{c} — {', '.join(v)}" for c, v in fx))
    if failed:
        print("НЕ вивантажено:")
        for client, e in failed:
            print(f"  {client}: {e}")
    return 1 if failed else 0


if __name__ == "__main__":
    interactive = not any(not a.startswith("--") for a in sys.argv[1:])  # без дат (ключі не рахуються) — запитати період
    code = 1
    try:
        code = main(interactive)
    except Stop as e:
        print(f"\nПОМИЛКА: {e}")
    except KeyboardInterrupt:
        print("\nСкасовано.")
    except Exception:
        traceback.print_exc()
    if interactive:
        try:
            input("\nНатисніть Enter, щоб закрити вікно…")
        except (EOFError, KeyboardInterrupt):
            pass
    sys.exit(code)
