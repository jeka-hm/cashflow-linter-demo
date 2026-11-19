"""Підпис збірки лінтера: ECDSA P-256 + SHA-256 — той самий алгоритм, яким закладка перевіряє код через WebCrypto браузера;
k — за RFC 6979 (детермінований), без сторонніх пакетів.

Публічна версія: ключ — демонстраційний. Перша збірка створює пару ключів у dist/ (ця папка в git не йде):
dist/demo-signing-key.json і dist/demo-signing-public.json. Свій ключ можна задати змінними CFL_SIGNING_KEY і CFL_SIGNING_PUBLIC.
У робочій версії приватний ключ лежить лише на комп'ютері розробника, поза папкою проєкту."""
import base64
import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime
from pathlib import Path

# NIST P-256 (FIPS 186-4, D.1.2.3)
P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
G = (0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
     0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5)
DIST = Path(__file__).resolve().parent.parent / 'dist'
PUBLIC = Path(os.environ.get('CFL_SIGNING_PUBLIC') or DIST / 'demo-signing-public.json')


def _add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    (x1, y1), (x2, y2) = p1, p2
    if x1 == x2:
        if (y1 + y2) % P == 0:
            return None
        lam = (3 * x1 * x1 + A) * pow(2 * y1, -1, P) % P
    else:
        lam = (y2 - y1) * pow(x2 - x1, -1, P) % P
    x3 = (lam * lam - x1 - x2) % P
    return x3, (lam * (x1 - x3) - y1) % P


def _mul(k, pt):
    acc = None
    while k:
        if k & 1:
            acc = _add(acc, pt)
        pt = _add(pt, pt)
        k >>= 1
    return acc


def _on_curve(pt):
    x, y = pt
    return 0 <= x < P and 0 <= y < P and (y * y - (x * x * x + A * x + B)) % P == 0


def _int(b):
    return int.from_bytes(b, 'big')


def _k(d, h):
    """k за RFC 6979, розділ 3.2, для P-256 і SHA-256 (qlen = hlen = 256 біт)."""
    x, h1 = d.to_bytes(32, 'big'), (_int(h) % N).to_bytes(32, 'big')
    mac = lambda key, data: hmac.new(key, data, hashlib.sha256).digest()  # noqa: E731
    v, k = b'\x01' * 32, b'\x00' * 32
    k = mac(k, v + b'\x00' + x + h1)
    v = mac(k, v)
    k = mac(k, v + b'\x01' + x + h1)
    v = mac(k, v)
    while True:
        v = mac(k, v)
        t = _int(v)
        if 1 <= t < N:
            return t
        k = mac(k, v + b'\x00')
        v = mac(k, v)


def sign(d, msg):
    """Підпис msg (bytes) приватним ключем d → 64 байти r‖s (формат WebCrypto, IEEE P1363)."""
    h = hashlib.sha256(msg).digest()
    k = _k(d, h)
    r = _mul(k, G)[0] % N
    s = pow(k, -1, N) * (_int(h) + r * d) % N
    if not r or not s:  # імовірність ~2^-256
        raise ValueError('невдалий підпис — повторіть')
    return r.to_bytes(32, 'big') + s.to_bytes(32, 'big')


def verify(pub, msg, sig):
    """pub — точка (x, y) відкритого ключа; sig — 64 байти r‖s. → True / False."""
    if len(sig) != 64 or not _on_curve(pub):
        return False
    r, s = _int(sig[:32]), _int(sig[32:])
    if not (0 < r < N and 0 < s < N):
        return False
    w = pow(s, -1, N)
    pt = _add(_mul(_int(hashlib.sha256(msg).digest()) * w % N, G), _mul(r * w % N, pub))
    return pt is not None and pt[0] % N == r


# ---------- ключі (JWK — той самий формат, що й у WebCrypto) ----------
def _b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def _unb64u(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def public_jwk(d):
    x, y = _mul(d, G)
    return {'kty': 'EC', 'crv': 'P-256', 'x': _b64u(x.to_bytes(32, 'big')), 'y': _b64u(y.to_bytes(32, 'big'))}


def jwk_point(jwk):
    if jwk.get('kty') != 'EC' or jwk.get('crv') != 'P-256':
        raise ValueError('очікується ключ EC P-256')
    pt = _int(_unb64u(jwk['x'])), _int(_unb64u(jwk['y']))
    if not _on_curve(pt):
        raise ValueError('точка ключа не на кривій P-256')
    return pt


def load_public(path=None):
    return json.loads(Path(path or PUBLIC).read_text(encoding='utf-8'))


def key_path():
    if os.environ.get('CFL_SIGNING_KEY'):
        return Path(os.environ['CFL_SIGNING_KEY'])
    return DIST / 'demo-signing-key.json'


def _write_public(d, public):
    public.parent.mkdir(parents=True, exist_ok=True)
    public.write_text(json.dumps(public_jwk(d), indent=1) + '\n', encoding='utf-8')


def load_key(new=False, public=None):
    """Приватний ключ розробника (int). Перший запуск (ні ключа, ні build/signing-public.json) — створює пару ключів.
    Якщо відкритий ключ є, а приватного на цьому комп'ютері немає (або він інший) — зупиняється: новий ключ означав би,
    що всім треба заново перетягнути закладки й передати новий архів. new=True — свідомо створити нову пару."""
    public = Path(public or PUBLIC)
    kp = key_path()
    if kp.is_file() and not new:
        d = _int(_unb64u(json.loads(kp.read_text(encoding='utf-8'))['d']))
        if not public.is_file():
            _write_public(d, public)
        elif {k: load_public(public).get(k) for k in ('x', 'y')} != {k: public_jwk(d)[k] for k in ('x', 'y')}:
            raise SystemExit(f'Ключ підпису {kp} не відповідає {public} (закладкам, які вже роздано).\n'
                             'Якщо ключ свідомо замінено — запустіть збірку з --new-key.')
        return d
    if public.is_file() and not new:
        raise SystemExit(f'На цьому комп\'ютері немає ключа підпису ({kp}).\n'
                         'Ним підписано всі збірки й закладки лінтера; ключ лежить на комп\'ютері розробника. Перезбирати лінтер\n'
                         'тут не потрібно — оновлення приходять уже зібраними («Оновити.bat»). Якщо ключ втрачено — збірка з --new-key\n'
                         '(після цього всім треба заново перетягнути закладки й один раз отримати новий архів).')
    if kp.is_file():  # new=True: старий ключ — у резервну копію поруч
        kp.replace(kp.with_name(f'signing-key.{datetime.now():%Y%m%d-%H%M%S}.old.json'))
    d = 1 + secrets.randbelow(N - 1)
    kp.parent.mkdir(parents=True, exist_ok=True)
    kp.write_text(json.dumps(dict(public_jwk(d), d=_b64u(d.to_bytes(32, 'big'))), indent=1), encoding='utf-8')
    _write_public(d, public)
    print(f'Створено ключ підпису збірок: {kp}\n'
          '  Збережіть копію цього файлу в надійному місці: без нього нові збірки не запустяться в уже роздані закладки.')
    return d


def canonical(obj):
    """Однозначний JSON для підпису (manifest.json пакета оновлення)."""
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def sign_b64(d, data):
    return base64.b64encode(sign(d, data)).decode()


def verify_b64(jwk, data, sig_b64):
    try:
        return verify(jwk_point(jwk), data, base64.b64decode(sig_b64, validate=True))
    except (ValueError, KeyError, TypeError):
        return False
