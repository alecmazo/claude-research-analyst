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

    # Dropbox's built-in redirect receiver just displays the code on screen.
    # It must also be added to the app's Redirect URIs in the App Console.
    REDIRECT_URI = "https://www.dropbox.com/1/oauth2/redirect_receiver"

    auth_url = (
        "https://www.dropbox.com/oauth2/authorize?"
        + urllib.parse.urlencode({
            "client_id": app_key,
            "response_type": "code",
            "token_access_type": "offline",
            "redirect_uri": REDIRECT_URI,
        })
    )
    print("\nBefore opening the URL, do this ONE-TIME step in the App Console:")
    print(f"  1. Go to https://www.dropbox.com/developers/apps")
    print(f"  2. Open your DGA Research app → Settings tab")
    print(f"  3. Under 'Redirect URIs' add exactly:")
    print(f"       {REDIRECT_URI}")
    print(f"  4. Click Add\n")
    print(f"Then open this URL in your browser:\n\n   {auth_url}\n")
    print("   (Click 'Allow' — you'll be redirected to a page showing a code.)")
    raw = input("\nPaste the code OR the full redirect URL: ").strip()
    # Accept either the bare code or the full redirect URL containing ?code=...
    if "code=" in raw:
        code = urllib.parse.parse_qs(urllib.parse.urlparse(raw).query).get("code", [raw])[0]
    else:
        code = raw

    data = urllib.parse.urlencode({
        "code": code,
        "grant_type": "authorization_code",
        "client_id": app_key,
        "client_secret": app_secret,
        "redirect_uri": REDIRECT_URI,
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
