"""
secure_store.py — application-layer encryption for sensitive values at rest.

Used to encrypt Plaid access_tokens (and any other secret-grade string we
persist) BEFORE they touch the database, so a database dump alone never exposes
them. Uses Fernet (AES-128-CBC + HMAC-SHA256, authenticated) with a key supplied
via the DATA_ENCRYPTION_KEY env var, held SEPARATELY from the database.

FAIL CLOSED: refuses to encrypt/decrypt without a valid key.

Generate a key once and set it as the DATA_ENCRYPTION_KEY env var:
    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

Key rotation: keep the old key in DATA_ENCRYPTION_KEYS (comma-separated, newest
first); decrypt() tries each so you can re-encrypt rows lazily after rotating.
"""
from __future__ import annotations

import os
from functools import lru_cache

_KEY_ENV  = "DATA_ENCRYPTION_KEY"     # primary key (Fernet, base64 32 bytes)
_KEYS_ENV = "DATA_ENCRYPTION_KEYS"    # optional: comma-separated for rotation


def _keys() -> list:
    raw = []
    primary = os.environ.get(_KEY_ENV, "").strip()
    if primary:
        raw.append(primary)
    extra = os.environ.get(_KEYS_ENV, "").strip()
    if extra:
        raw.extend(k.strip() for k in extra.split(",") if k.strip())
    return list(dict.fromkeys(raw))   # dedupe, preserve order


@lru_cache(maxsize=1)
def _fernet():
    """MultiFernet over all configured keys (first = the one used to encrypt)."""
    from cryptography.fernet import Fernet, MultiFernet
    keys = _keys()
    if not keys:
        raise RuntimeError(
            f"{_KEY_ENV} is not set. Generate one with Fernet.generate_key() and "
            "set it as an env var before storing encrypted data — refusing to "
            "handle secrets without a key.")
    try:
        return MultiFernet([Fernet(k.encode()) for k in keys])
    except Exception as e:
        raise RuntimeError(f"{_KEY_ENV}/{_KEYS_ENV} contains an invalid Fernet key: {e}")


def is_configured() -> bool:
    """True if a usable encryption key is present (for startup self-checks)."""
    try:
        _fernet()
        return True
    except Exception:
        return False


def encrypt(plaintext):
    """Encrypt a string → URL-safe base64 token (str). Passes None through."""
    if plaintext is None:
        return None
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(token):
    """Decrypt a token produced by encrypt(). Passes None through."""
    if token is None:
        return None
    return _fernet().decrypt(token.encode()).decode()
