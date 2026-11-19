"""mcp-env-wrap.py — charge ~/.hephaistos/env.local puis exec le serveur MCP.

Usage: python mcp-env-wrap.py <commande> [args...]

Permet de garder les secrets hors des fichiers de config JSON (mcp-mux ne
fait pas d'interpolation ${env:VAR} et n'herite que les vars systeme).
Les enfants heritent stdio tel quel -> compatible MCP stdio.
"""

import os
import subprocess
import sys
from pathlib import Path


def _load_env_local() -> None:
    env_file = Path.home() / ".hephaistos" / "env.local"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: mcp-env-wrap.py <commande> [args...]", file=sys.stderr)
        return 2
    _load_env_local()
    proc = subprocess.run(sys.argv[1:], env=os.environ)
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
