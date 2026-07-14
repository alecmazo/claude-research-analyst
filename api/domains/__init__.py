"""Domain modules extracted from api/server.py for maintainability.

Each module exposes register(app, g) or is imported by server after core
helpers exist. Prefer adding new endpoints here instead of growing server.py.
"""
