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
    """Token-signing secret. FAIL CLOSED: refuse to operate with the public
    default (it's in the git history, so it would let anyone forge admin tokens).
    The app must be started with a strong random TOKEN_SECRET env var."""
    sec = os.environ.get(_TOKEN_SECRET_ENV, "").strip()
    if not sec or sec == _DEFAULT_TOKEN_SECRET:
        raise RuntimeError(
            "TOKEN_SECRET is missing or set to the public default. Set a strong "
            "random TOKEN_SECRET environment variable — refusing to sign/verify "
            "session tokens with a guessable secret.")
    return sec.encode()


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
        # plaintext: "dgacapital"
        "password_hash_hex":    "4b279b1481df1e23375775d57e2bb7258150a9b586ebcac314a0cf16b90b1184",
        "password_salt_hex":    "1d9bfbcbf9013f444b60365aeb7c15e0",
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
        # plaintext: "dgacapital"
        "password_hash_hex":    "2de3b5c19e7845b00f3512c0a9758a837312c6ec53d9cff74377d673acad0670",
        "password_salt_hex":    "4a4795b89b150e2dab18a0292442fb2c",
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
        # plaintext: "dgacapital"
        "password_hash_hex":    "a7cb3b575fb764c2d8f265a9c427f1a97002f10a45411dddadb3ea7be7548af6",
        "password_salt_hex":    "708474ec6382c4f01b6dcf89b8e4f775",
        "fund_memberships":     {},
        "managed_account_ids":  [],
        "must_change_password": True,
        "created_at":           "2026-05-10",
    },
]


# ---------------------------------------------------------------------------
# Persistence — overlay file lets password changes survive across deploys.
# The seed above is the "factory default"; overlay overrides per lp_id.
#
# Default path resolves to $STOCKS_FOLDER/_lp_creds_overlay.json, which
# lives on the same Railway persistent volume as watchlists, reports, etc.
# Override with LP_CREDS_OVERLAY_PATH env var if needed.
# ---------------------------------------------------------------------------
_LP_CREDS_OVERLAY_ENV = "LP_CREDS_OVERLAY_PATH"


def _default_overlay_path() -> Path:
    """Resolve the overlay path from env or fall back to the stocks folder."""
    # Prefer STOCKS_FOLDER (Railway persistent volume) over /tmp
    stocks = os.environ.get("STOCKS_FOLDER", "")
    if stocks:
        return Path(stocks) / "_lp_creds_overlay.json"
    # Local dev fallback — project root
    return Path(__file__).parent / "_lp_creds_overlay.json"


def _overlay_path() -> Path:
    override = os.environ.get(_LP_CREDS_OVERLAY_ENV, "")
    return Path(override) if override else _default_overlay_path()


# ---------------------------------------------------------------------------
# Pluggable DB backend — registered by server.py at startup so LP
# assignments persist in PostgreSQL even if the overlay file path is
# ephemeral (e.g. non-volume Railway containers).
# ---------------------------------------------------------------------------
_OVERLAY_DB_LOAD: Optional[Any] = None   # () -> dict[str, dict]
_OVERLAY_DB_SAVE: Optional[Any] = None   # (dict) -> None


def register_db_backend(load_fn, save_fn) -> None:
    """Register DB load/save functions. Called once by server.py at startup."""
    global _OVERLAY_DB_LOAD, _OVERLAY_DB_SAVE
    _OVERLAY_DB_LOAD = load_fn
    _OVERLAY_DB_SAVE = save_fn


def _load_overlay_from_file() -> dict[str, dict]:
    p = _overlay_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def _save_overlay_to_file(overlay: dict[str, dict]) -> None:
    p = _overlay_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(overlay, indent=2, sort_keys=True))


def _load_overlay() -> dict[str, dict]:
    file_data = _load_overlay_from_file()
    if _OVERLAY_DB_LOAD is not None:
        try:
            db_data = _OVERLAY_DB_LOAD()
            # DB wins — merge file first, then DB on top
            return {**file_data, **db_data}
        except Exception:
            pass
    return file_data


def _save_overlay(overlay: dict[str, dict]) -> None:
    try:
        _save_overlay_to_file(overlay)
    except Exception:
        pass
    if _OVERLAY_DB_SAVE is not None:
        try:
            _OVERLAY_DB_SAVE(overlay)
        except Exception:
            pass


def _all_credentials() -> dict[str, dict]:
    """Merge seed + overlay. Overlay wins per-lp_id. Soft-deleted users are excluded."""
    out = {rec["lp_id"]: dict(rec) for rec in LP_CREDENTIALS_SEED}
    for lp_id, patch in _load_overlay().items():
        if lp_id in out:
            out[lp_id].update(patch)
        else:
            out[lp_id] = patch
    # Filter out soft-deleted entries
    return {k: v for k, v in out.items() if not v.get("deleted")}


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
    """Validate email + password. On success returns a dict with token + user info.

    Authentication is strictly per-user: each account logs in with its OWN
    password only. The former master-password ("god-mode") impersonation path —
    which let the FUND_PASSWORD holder log in as any LP — has been removed.
    """
    user = find_user_by_email(email)
    if not user:
        return None

    if not verify_password(password, user["password_hash_hex"], user["password_salt_hex"]):
        return None

    claims = {
        "lp_id":               user["lp_id"],
        "email":               user["email"],
        "name":                user["name"],
        "role":                user["role"],
        "fund_memberships":    user.get("fund_memberships", {}),
        "managed_account_ids": user.get("managed_account_ids", []),
    }
    if user.get("demo_mode"):
        claims["demo_mode"] = True

    token = create_token(claims)
    return {
        "token":                token,
        "role":                 user["role"],
        "name":                 user["name"],
        "email":                user["email"],
        "lp_id":                user["lp_id"],
        "must_change_password": bool(user.get("must_change_password", False)),
        "fund_memberships":     user.get("fund_memberships", {}),
        "managed_account_ids":  user.get("managed_account_ids", []),
        "demo_mode":            bool(user.get("demo_mode", False)),
        "impersonated":         False,
    }


def whoami(token: str) -> Optional[dict]:
    """Return the user record for a valid token, or None if invalid/expired."""
    claims = verify_token(token)
    if not claims:
        return None
    user = find_user_by_lp_id(claims.get("lp_id", ""))
    if not user:
        return None
    # Check if this is an admin impersonation session (flag lives in the token)
    impersonated_by = claims.get("impersonated_by")
    # Return a sanitized view — never expose password hashes
    out = {
        "lp_id":                user["lp_id"],
        "email":                user["email"],
        "name":                 user["name"],
        "role":                 user["role"],
        "fund_memberships":     user.get("fund_memberships", {}),
        "managed_account_ids":  user.get("managed_account_ids", []),
        "must_change_password": False if impersonated_by else bool(user.get("must_change_password", False)),
    }
    if impersonated_by:
        out["impersonated_by"] = impersonated_by
        out["impersonated"]    = True
    # Pass through demo_mode flag (stamped in token at login time)
    if claims.get("demo_mode") or user.get("demo_mode"):
        out["demo_mode"] = True
    return out


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


def gp_set_password(lp_id: str, new_password: str, must_change: bool = True) -> bool:
    """GP-only admin reset. Sets a new password without requiring the old one.

    Persists to the overlay so it survives deploys. Sets must_change_password=True
    by default so the LP is prompted to choose their own password on next login.
    Returns False if the lp_id doesn't exist or the password is too short.
    """
    user = find_user_by_lp_id(lp_id)
    if not user:
        return False
    if len(new_password) < 6:
        return False
    new_hash, new_salt = hash_password(new_password)
    overlay = _load_overlay()
    overlay[lp_id] = {
        **overlay.get(lp_id, {}),
        "password_hash_hex":    new_hash,
        "password_salt_hex":    new_salt,
        "must_change_password": must_change,
    }
    _save_overlay(overlay)
    return True


def list_users() -> list[dict]:
    """Return a sanitized list of all users (no password hashes)."""
    return [
        {
            "lp_id":                u["lp_id"],
            "email":                u["email"],
            "name":                 u["name"],
            "role":                 u["role"],
            "must_change_password": bool(u.get("must_change_password", False)),
            "fund_memberships":     u.get("fund_memberships", {}),
            "managed_account_ids":  u.get("managed_account_ids", []),
            "created_at":           u.get("created_at", ""),
        }
        for u in _all_credentials().values()
    ]


def create_user(
    email: str,
    name: str,
    password: str,
    role: str = "lp",
    fund_memberships: Optional[dict] = None,
    managed_account_ids: Optional[list] = None,
    must_change_password: bool = True,
    demo_mode: bool = False,
) -> str:
    """Create a new user. Returns the new user_id. Raises ValueError on conflict.

    role: "lp" | "gp" | "admin"  (default "lp")
    Admin users have full GP access to both the GP and LP dashboards.
    """
    import datetime as _dt
    role = (role or "lp").strip().lower()
    if role not in ("lp", "gp", "admin"):
        raise ValueError("Role must be 'lp', 'gp', or 'admin'")
    email = (email or "").strip().lower()
    if not email:
        raise ValueError("Email is required")
    if find_user_by_email(email):
        raise ValueError("Email already exists")
    if len(password) < 6:
        raise ValueError("Password must be at least 6 characters")
    prefix = {"gp": "gp_", "admin": "admin_", "lp": "lp_"}.get(role, "lp_")
    user_id = prefix + secrets.token_hex(8)
    new_hash, new_salt = hash_password(password)
    overlay = _load_overlay()
    overlay[user_id] = {
        "lp_id":                user_id,
        "email":                email,
        "name":                 (name or "").strip(),
        "role":                 role,
        "password_hash_hex":    new_hash,
        "password_salt_hex":    new_salt,
        "fund_memberships":     fund_memberships or {},
        "managed_account_ids":  managed_account_ids or [],
        "must_change_password": must_change_password,
        "demo_mode":            demo_mode,
        "created_at":           _dt.date.today().isoformat(),
    }
    _save_overlay(overlay)
    return user_id


def delete_user(lp_id: str) -> bool:
    """Delete a user account. Returns False if the user doesn't exist.

    Seed users (baked into LP_CREDENTIALS_SEED) are soft-deleted via a
    'deleted: True' flag in the overlay so they survive code deploys.
    Overlay-only users (created at runtime) are removed from the overlay
    entirely.
    """
    if not find_user_by_lp_id(lp_id):
        return False
    seed_ids = {rec["lp_id"] for rec in LP_CREDENTIALS_SEED}
    overlay  = _load_overlay()
    if lp_id in seed_ids:
        # Soft-delete: mark as deleted in overlay; _all_credentials() will skip it
        overlay[lp_id] = {**overlay.get(lp_id, {}), "deleted": True}
    else:
        # Hard-delete: remove from overlay entirely
        overlay.pop(lp_id, None)
    _save_overlay(overlay)
    return True


def update_assignments(
    lp_id: str,
    fund_memberships: dict,
    managed_account_ids: list,
) -> bool:
    """Update fund/account assignments for an existing LP. Persists to overlay."""
    if not find_user_by_lp_id(lp_id):
        return False
    overlay = _load_overlay()
    overlay[lp_id] = {
        **overlay.get(lp_id, {}),
        "fund_memberships":    fund_memberships,
        "managed_account_ids": managed_account_ids,
    }
    _save_overlay(overlay)
    return True


def update_email(lp_id: str, new_email: str) -> bool:
    """Update the login email for an existing user.

    Validates that:
    - The user exists
    - new_email is non-empty and valid-ish (contains @)
    - new_email is not already taken by another account

    Returns False if validation fails. Persists to overlay.
    """
    new_email = (new_email or "").strip().lower()
    if not new_email or "@" not in new_email:
        return False
    user = find_user_by_lp_id(lp_id)
    if not user:
        return False
    # Check for duplicate (allow same email = no-op update)
    existing = find_user_by_email(new_email)
    if existing and existing["lp_id"] != lp_id:
        raise ValueError("Email already in use by another account")
    overlay = _load_overlay()
    overlay[lp_id] = {
        **overlay.get(lp_id, {}),
        "email": new_email,
    }
    _save_overlay(overlay)
    return True


# ---------------------------------------------------------------------------
# Scope checks — used by data endpoints to filter LP-visible records.
# ---------------------------------------------------------------------------
def _is_privileged(claims: dict) -> bool:
    """Return True if the user has full GP-level access (role is gp or admin)."""
    return claims.get("role") in ("gp", "admin")


def claims_allow_fund(claims: dict, fund_name: str) -> bool:
    """True if the token's role is GP/admin OR fund_name is in their memberships."""
    if not claims:
        return False
    if _is_privileged(claims):
        return True
    return fund_name in (claims.get("fund_memberships") or {})


def claims_allow_account(claims: dict, account_name: str) -> bool:
    """True if the token's role is GP/admin OR account_name is in their managed accounts."""
    if not claims:
        return False
    if _is_privileged(claims):
        return True
    return account_name in (claims.get("managed_account_ids") or [])


def claims_lp_alias_in(claims: dict, fund_name: str) -> Optional[str]:
    """Return the LP's alias within a given fund, or None if not a member."""
    if not claims:
        return None
    if _is_privileged(claims):
        # GP/admin don't have a per-fund LP alias — they see all rows.
        return None
    return (claims.get("fund_memberships") or {}).get(fund_name)
