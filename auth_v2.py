"""
DGA Capital — v2 auth subsystem
================================

Per-user authentication for the new portfolio.dgacapital.com login flow.

* GP (general partner) sees everything — the full Terminal Pro UI.
* LP (limited partner) sees only their own capital account in the
  fund(s) they participate in, plus their own managed account(s).

The v2 system runs *alongside* the existing single-password /api/auth
endpoint (which the current mobile app and web shell still use).
Backward compat is preserved until the new login is shipped to both
surfaces; then /api/auth can be deprecated.

Storage
-------
Initial credentials are baked into LP_CREDENTIALS_SEED below — already
hashed with PBKDF2-HMAC-SHA256, 200k iterations. The corresponding
plaintext passwords were generated once, shared with each LP out-of-
band, and never committed.

Password changes (planned next phase) will be persisted to a JSON file
at LP_CREDENTIALS_FILE_PATH so they survive across deploys.

Token format
------------
Simple signed JSON (HMAC-SHA256) — pragmatic JWT-equivalent without a
PyJWT dependency:

    base64url(claims_json).hex_hmac_signature

Claims contain: lp_id, email, name, role, fund_memberships (dict
{fund_name: lp_alias}), managed_account_ids (list), iat, exp.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_TOKEN_SECRET_ENV = "TOKEN_SECRET"
_DEFAULT_TOKEN_SECRET = "dga-capital-jwt-secret"  # only used if env var missing
_TOKEN_TTL_SECONDS = 12 * 3600                    # 12-hour session

_PBKDF2_ITERATIONS = 200_000
_PBKDF2_DIGEST     = "sha256"


def _token_secret() -> bytes:
    return os.environ.get(_TOKEN_SECRET_ENV, _DEFAULT_TOKEN_SECRET).encode()


# ---------------------------------------------------------------------------
# Seed credentials
# ---------------------------------------------------------------------------
# IMPORTANT: hashes were generated with `secrets.token_bytes(16)` salts and
# 200,000 PBKDF2 iterations. Plaintext passwords were communicated to each
# LP out-of-band. Do NOT log or expose these hashes outside the auth flow.
#
# Schema per record:
#   lp_id                  – stable internal id (used as JWT subject)
#   email                  – unique login identifier (lowercased for lookup)
#   name                   – display name
#   role                   – "gp" | "lp"
#   password_hash_hex      – PBKDF2-HMAC-SHA256, 200k iters
#   password_salt_hex      – random 16-byte salt
#   fund_memberships       – { "Fund Name": "LP alias in that fund" }
#                            empty {} for GP (sees everything) or LPs not in
#                            any funds yet.
#   managed_account_ids    – list of managed-account names this LP owns
#                            (matches the names used in the rebalance system).
#                            empty [] for GP or LPs without accounts.
#   must_change_password   – True until the LP changes their initial pw
#   created_at             – ISO date string
# ---------------------------------------------------------------------------
LP_CREDENTIALS_SEED: list[dict[str, Any]] = [
    {
        "lp_id":                "gp_alec",
        "email":                "alecmazo1@gmail.com",
        "name":                 "Alec Mazo",
        "role":                 "gp",
        # plaintext: "genesis"
        "password_hash_hex":    "7e6555659cc7d4fec744d55623610e31897ea254d217d90f29860c288a6e53fe",
        "password_salt_hex":    "55124b6cd276470f1f5b120dcb33e896",
        "fund_memberships":     {},   # GP sees everything — empty = no filter
        "managed_account_ids":  [],   # GP sees all managed accounts
        "must_change_password": False,
        "created_at":           "2026-05-10",
    },
    {
        "lp_id":                "lp_anatoly_mazo",
        "email":                "anatolymazo@gmail.com",
        "name":                 "Anatoly Mazo",
        "role":                 "lp",
        # plaintext shared with LP out-of-band
        "password_hash_hex":    "43849d0fd0354f3bba114c4a56a8bf4a02512c35f4c1965afe3cdf35cb3790ed",
        "password_salt_hex":    "46f1f0cd975fe9c3235e45380a49e857",
        "fund_memberships":     {},
        # Matches the funds.name in the production DB (uppercase, as
        # imported). Use case-insensitive comparison in the data layer
        # to tolerate any future capitalization changes.
        "managed_account_ids":  ["ANAT TOD"],
        "must_change_password": True,
        "created_at":           "2026-05-10",
    },
    {
        "lp_id":                "lp_eugene_mazo",
        "email":                "e.mazo@outlook.com",
        "name":                 "Eugene Mazo",
        "role":                 "lp",
        # plaintext shared with LP out-of-band
        "password_hash_hex":    "d372facf6ceb8f707d79ea7328642459bc984f59c011140120ae7635375c6c0a",
        "password_salt_hex":    "d3a911f82d0247020d4b613bd10f1748",
        "fund_memberships":     {
            "DGA Capital Fund I, LP":  "EM",
            "DGA Capital Fund II, LP": "EM",
        },
        "managed_account_ids":  ["EM DEFENSIVE"],
        "must_change_password": True,
        "created_at":           "2026-05-10",
    },
    {
        "lp_id":                "lp_edyta_sliwinska",
        "email":                "edytasliw@gmail.com",
        "name":                 "Edyta Sliwinska",
        "role":                 "lp",
        # plaintext shared with LP out-of-band — placeholder until fund/account assigned
        "password_hash_hex":    "cdc935a317c88ad92fc0021b4c3472b47a699c476566036a426ff1fbbc97288e",
        "password_salt_hex":    "91a772707a32617136cb1d8f6712fe8a",
        "fund_memberships":     {},
        "managed_account_ids":  [],
        "must_change_password": True,
        "created_at":           "2026-05-10",
    },
]


# ---------------------------------------------------------------------------
# Persistence — overlay file lets password changes survive across deploys.
# The seed above is the "factory default"; overlay overrides per lp_id.
# Stored in a directory the GP controls (configurable via env), not Dropbox.
# ---------------------------------------------------------------------------
_LP_CREDS_OVERLAY_ENV = "LP_CREDS_OVERLAY_PATH"
_DEFAULT_OVERLAY      = "/tmp/dga_lp_creds_overlay.json"   # Railway ephemeral


def _overlay_path() -> Path:
    return Path(os.environ.get(_LP_CREDS_OVERLAY_ENV, _DEFAULT_OVERLAY))


def _load_overlay() -> dict[str, dict]:
    p = _overlay_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def _save_overlay(overlay: dict[str, dict]) -> None:
    p = _overlay_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(overlay, indent=2, sort_keys=True))


def _all_credentials() -> dict[str, dict]:
    """Merge seed + overlay. Overlay wins per-lp_id."""
    out = {rec["lp_id"]: dict(rec) for rec in LP_CREDENTIALS_SEED}
    for lp_id, patch in _load_overlay().items():
        if lp_id in out:
            out[lp_id].update(patch)
        else:
            out[lp_id] = patch
    return out


# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------
def hash_password(password: str, salt_hex: Optional[str] = None) -> tuple[str, str]:
    """Hash a password with PBKDF2-HMAC-SHA256. Returns (hash_hex, salt_hex)."""
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac(_PBKDF2_DIGEST, password.encode(), salt, _PBKDF2_ITERATIONS)
    return h.hex(), salt.hex()


def verify_password(password: str, expected_hash_hex: str, salt_hex: str) -> bool:
    """Constant-time check of password against stored hash."""
    try:
        salt = bytes.fromhex(salt_hex)
        computed = hashlib.pbkdf2_hmac(
            _PBKDF2_DIGEST, password.encode(), salt, _PBKDF2_ITERATIONS
        )
        expected = bytes.fromhex(expected_hash_hex)
        return hmac.compare_digest(computed, expected)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Token (signed claims) — minimal JWT-style without PyJWT dependency.
# ---------------------------------------------------------------------------
def _b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def create_token(claims: dict[str, Any], ttl_seconds: int = _TOKEN_TTL_SECONDS) -> str:
    """Create a signed token. Claims should NOT contain `iat` or `exp` — we set them."""
    now      = int(time.time())
    payload  = {**claims, "iat": now, "exp": now + ttl_seconds}
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    payload_b64  = _b64url_encode(payload_json)
    sig = hmac.new(_token_secret(), payload_b64.encode(), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def verify_token(token: str) -> Optional[dict[str, Any]]:
    """Verify a token's signature and expiry. Returns claims dict or None."""
    if not token or "." not in token:
        return None
    try:
        payload_b64, sig = token.split(".", 1)
        expected_sig = hmac.new(
            _token_secret(), payload_b64.encode(), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            return None
        payload = json.loads(_b64url_decode(payload_b64))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except Exception:
        return None


# ---------------------------------------------------------------------------
# User lookup
# ---------------------------------------------------------------------------
def find_user_by_email(email: str) -> Optional[dict]:
    """Case-insensitive email lookup. Returns the full credential record or None."""
    target = (email or "").strip().lower()
    if not target:
        return None
    for rec in _all_credentials().values():
        if rec.get("email", "").strip().lower() == target:
            return rec
    return None


def find_user_by_lp_id(lp_id: str) -> Optional[dict]:
    return _all_credentials().get(lp_id)


# ---------------------------------------------------------------------------
# Login + me + change-password — high-level operations
# ---------------------------------------------------------------------------
def login(email: str, password: str) -> Optional[dict]:
    """Validate email + password. On success returns a dict with token + user info."""
    user = find_user_by_email(email)
    if not user:
        return None
    if not verify_password(
        password,
        user["password_hash_hex"],
        user["password_salt_hex"],
    ):
        return None

    claims = {
        "lp_id":               user["lp_id"],
        "email":               user["email"],
        "name":                user["name"],
        "role":                user["role"],
        "fund_memberships":    user.get("fund_memberships", {}),
        "managed_account_ids": user.get("managed_account_ids", []),
    }
    token = create_token(claims)
    return {
        "token":                token,
        "role":                 user["role"],
        "name":                 user["name"],
        "email":                user["email"],
        "lp_id":                user["lp_id"],
        "must_change_password": bool(user.get("must_change_password", False)),
        "fund_memberships":     user.get("fund_memberships", {}),
        "managed_account_ids": user.get("managed_account_ids", []),
    }


def whoami(token: str) -> Optional[dict]:
    """Return the user record for a valid token, or None if invalid/expired."""
    claims = verify_token(token)
    if not claims:
        return None
    user = find_user_by_lp_id(claims.get("lp_id", ""))
    if not user:
        return None
    # Return a sanitized view — never expose password hashes
    return {
        "lp_id":                user["lp_id"],
        "email":                user["email"],
        "name":                 user["name"],
        "role":                 user["role"],
        "fund_memberships":     user.get("fund_memberships", {}),
        "managed_account_ids":  user.get("managed_account_ids", []),
        "must_change_password": bool(user.get("must_change_password", False)),
    }


def change_password(lp_id: str, old_password: str, new_password: str) -> bool:
    """Change a user's password. Persists to the overlay file. Returns success."""
    user = find_user_by_lp_id(lp_id)
    if not user:
        return False
    if not verify_password(
        old_password,
        user["password_hash_hex"],
        user["password_salt_hex"],
    ):
        return False
    if len(new_password) < 8:
        return False
    new_hash, new_salt = hash_password(new_password)
    overlay = _load_overlay()
    overlay[lp_id] = {
        **overlay.get(lp_id, {}),
        "password_hash_hex":    new_hash,
        "password_salt_hex":    new_salt,
        "must_change_password": False,
    }
    _save_overlay(overlay)
    return True


# ---------------------------------------------------------------------------
# Scope checks — used by data endpoints to filter LP-visible records.
# ---------------------------------------------------------------------------
def claims_allow_fund(claims: dict, fund_name: str) -> bool:
    """True if the token's role is GP OR fund_name is in their memberships."""
    if not claims:
        return False
    if claims.get("role") == "gp":
        return True
    return fund_name in (claims.get("fund_memberships") or {})


def claims_allow_account(claims: dict, account_name: str) -> bool:
    """True if the token's role is GP OR account_name is in their managed accounts."""
    if not claims:
        return False
    if claims.get("role") == "gp":
        return True
    return account_name in (claims.get("managed_account_ids") or [])


def claims_lp_alias_in(claims: dict, fund_name: str) -> Optional[str]:
    """Return the LP's alias within a given fund, or None if not a member."""
    if not claims:
        return None
    if claims.get("role") == "gp":
        # GP doesn't have a per-fund LP alias — they see all rows.
        return None
    return (claims.get("fund_memberships") or {}).get(fund_name)
