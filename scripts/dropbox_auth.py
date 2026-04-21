#!/usr/bin/env python3
"""One-time Dropbox OAuth flow — run locally to get a permanent refresh token.

Usage:
    python3 scripts/dropbox_auth.py <APP_KEY> <APP_SECRET>

Then add the three printed env vars to Railway (Settings → Variables):
    DROPBOX_APP_KEY
    DROPBOX_APP_SECRET
    DROPBOX_REFRESH_TOKEN
"""
import sys
import urllib.parse
import urllib.request
import json


def main() -> None:
    app_key = sys.argv[1] if len(sys.argv) > 1 else input("App key:    ").strip()
    app_secret = sys.argv[2] if len(sys.argv) > 2 else input("App secret: ").strip()

    auth_url = (
        "https://www.dropbox.com/oauth2/authorize?"
        + urllib.parse.urlencode({
            "client_id": app_key,
            "response_type": "code",
            "token_access_type": "offline",
        })
    )
    print(f"\n1. Open this URL in your browser:\n\n   {auth_url}\n")
    print("   (Click 'Allow' to grant DGA Research access to your Dropbox.)")
    code = input("\n2. Paste the authorization code shown on the page: ").strip()

    data = urllib.parse.urlencode({
        "code": code,
        "grant_type": "authorization_code",
        "client_id": app_key,
        "client_secret": app_secret,
    }).encode()
    req = urllib.request.Request("https://api.dropboxapi.com/oauth2/token", data=data)
    try:
        resp = json.loads(urllib.request.urlopen(req).read())
    except Exception as exc:
        print(f"\n❌ Token exchange failed: {exc}")
        sys.exit(1)

    refresh_token = resp.get("refresh_token")
    if not refresh_token:
        print(f"\n❌ No refresh token in response: {resp}")
        sys.exit(1)

    print("\n" + "=" * 55)
    print("  Add these three vars to Railway → Settings → Variables")
    print("=" * 55)
    print(f"DROPBOX_APP_KEY={app_key}")
    print(f"DROPBOX_APP_SECRET={app_secret}")
    print(f"DROPBOX_REFRESH_TOKEN={refresh_token}")
    print("=" * 55)
    print(f"\nDropbox account: {resp.get('account_id', '(unknown)')}")
    print("Done. These tokens never expire — store them safely.")


if __name__ == "__main__":
    main()
