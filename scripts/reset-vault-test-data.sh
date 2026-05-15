#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

# Usage:
#   ./scripts/reset-vault-test-data.sh --mode clear-vault --force
#   ./scripts/reset-vault-test-data.sh --mode restore-pre-vault --force
#   ./scripts/reset-vault-test-data.sh --mode hard-auth-reset --force
#   ./scripts/reset-vault-test-data.sh --data-dir /path/to/zync/data --mode hard-auth-reset --force
#
# Modes:
#   clear-vault        Remove vault/sync files only. Safe default for vault-only cleanup.
#   restore-pre-vault  Remove vault files and restore connections.json from the pre-secure backup.
#   hard-auth-reset    Remove vault files and strip authRef/privateKeyPath/password from live connections.json.
#
# Notes:
#   - This script does not remove Google refresh tokens from the OS keychain.
#   - Use hard-auth-reset when you want a true "nothing can still connect" local test state.

DATA_DIR=""
MODE="clear-vault"
DELETE_CONNECTIONS_BACKUP=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir)
      DATA_DIR="${2:?missing value for --data-dir}"
      shift 2
      ;;
    --mode)
      MODE="${2:?missing value for --mode}"
      if [[ "$MODE" != "clear-vault" && "$MODE" != "restore-pre-vault" && "$MODE" != "hard-auth-reset" ]]; then
        echo "Invalid mode: $MODE" >&2
        echo "Expected one of: clear-vault, restore-pre-vault, hard-auth-reset" >&2
        exit 1
      fi
      shift 2
      ;;
    --delete-connections-backup)
      DELETE_CONNECTIONS_BACKUP=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

resolve_data_dir() {
  local requested="${1:-}"
  if [[ -n "$requested" ]]; then
    cd "$requested" >/dev/null 2>&1 && pwd -P
    return
  fi

  local candidates=(
    "$HOME/.config/Zync/User"
    "$HOME/.config/zync"
    "$HOME/.local/share/com.zync.desktop"
    "$HOME/.local/share/zync"
    "$HOME/Library/Application Support/com.zync.desktop"
    "$HOME/Library/Application Support/zync"
  )

  local native_settings_path="$HOME/.config/Zync/User/settings.json"
  local data_path=""
  if [[ -f "$native_settings_path" ]]; then
    data_path="$(python3 - <<'PY' "$native_settings_path"
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
try:
    data = json.loads(path.read_text(encoding='utf-8'))
except Exception:
    print("")
    raise SystemExit(0)
value = data.get("dataPath") or ""
print(value)
PY
)"
    if [[ -n "$data_path" && -d "$data_path" ]]; then
      cd "$data_path" >/dev/null 2>&1 && pwd -P
      return
    fi
  fi

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -d "$candidate" ]]; then
      cd "$candidate" >/dev/null 2>&1 && pwd -P
      return
    fi
  done

  echo "Could not auto-detect the Zync data directory." >&2
  echo "Re-run with --data-dir /path/to/your/zync/data" >&2
  exit 1
}

remove_if_exists() {
  local path="$1"
  if [[ -e "$path" ]]; then
    rm -f "$path"
    echo "Removed: $path"
  else
    echo "Missing:  $path"
  fi
}

RESOLVED_DATA_DIR="$(resolve_data_dir "$DATA_DIR")"
CONNECTIONS_BACKUP="$RESOLVED_DATA_DIR/connections.json.pre-secure-to-vault"
LEGACY_CONNECTIONS_BACKUP="$RESOLVED_DATA_DIR/connections.json.pre-vault-migration"
CONNECTIONS_PATH="$RESOLVED_DATA_DIR/connections.json"

TARGETS=(
  "$RESOLVED_DATA_DIR/vault.redb"
  "$RESOLVED_DATA_DIR/vault.redb.pre-import"
  "$RESOLVED_DATA_DIR/vault.redb.tmp-pre-import"
  "$RESOLVED_DATA_DIR/vault.redb.sync-tmp"
  "$RESOLVED_DATA_DIR/vault.redb.download-tmp"
  "$RESOLVED_DATA_DIR/sync-google.json"
  "$RESOLVED_DATA_DIR/sync-google-tokens.json"
  "$RESOLVED_DATA_DIR/sync-profiles.json"
)

TARGET_PATTERNS=(
  "$RESOLVED_DATA_DIR"/sync-collection-*.json
)

echo "Target data dir: $RESOLVED_DATA_DIR"
echo
echo "Reset mode: $MODE"
echo
echo "This script will remove vault-related local test data:"
for target in "${TARGETS[@]}"; do
  echo " - $target"
done
for pattern in "${TARGET_PATTERNS[@]}"; do
  mapfile -t files < <(compgen -G "$pattern")
  if [[ ${#files[@]} -eq 0 ]]; then
    echo " - $pattern (no matches)"
    continue
  fi
  for file in "${files[@]}"; do
    echo " - $file"
  done
done
if [[ "$DELETE_CONNECTIONS_BACKUP" -eq 1 ]]; then
  echo " - $CONNECTIONS_BACKUP"
  echo " - $LEGACY_CONNECTIONS_BACKUP"
fi
if [[ "$MODE" == "restore-pre-vault" ]]; then
  echo " - restore $CONNECTIONS_BACKUP (or legacy backup) -> $CONNECTIONS_PATH"
fi
if [[ "$MODE" == "hard-auth-reset" ]]; then
  echo " - clear authRef/privateKeyPath/password inside $CONNECTIONS_PATH"
fi
echo
echo "Note: This does NOT remove Google refresh tokens from the OS keychain."
echo "Use the app Disconnect action or remove the keyring entry manually if needed."
echo "Modes:"
echo " - clear-vault: remove vault/sync files only (default; does not change live connection auth fields)"
echo " - restore-pre-vault: remove vault files and restore connections.json from pre-secure backup"
echo " - hard-auth-reset: remove vault files and strip authRef/privateKeyPath/password from live connections.json"
echo

if [[ "$FORCE" -ne 1 ]]; then
  read -r -p "Proceed? [y/N] " reply
  if [[ ! "$reply" =~ ^([yY][eE][sS]?|[yY])$ ]]; then
    echo "Aborted."
    exit 1
  fi
fi

for target in "${TARGETS[@]}"; do
  remove_if_exists "$target"
done

for pattern in "${TARGET_PATTERNS[@]}"; do
  mapfile -t matches < <(compgen -G "$pattern")
  for target in "${matches[@]}"; do
    [[ -e "$target" ]] || continue
    remove_if_exists "$target"
  done
done

if [[ "$MODE" == "restore-pre-vault" ]]; then
  if [[ -f "$CONNECTIONS_BACKUP" ]]; then
    cp "$CONNECTIONS_BACKUP" "$CONNECTIONS_PATH"
    echo "Restored connections backup: $CONNECTIONS_BACKUP -> $CONNECTIONS_PATH"
  elif [[ -f "$LEGACY_CONNECTIONS_BACKUP" ]]; then
    cp "$LEGACY_CONNECTIONS_BACKUP" "$CONNECTIONS_PATH"
    echo "Restored legacy connections backup: $LEGACY_CONNECTIONS_BACKUP -> $CONNECTIONS_PATH"
  else
    echo "Cannot restore connections: no pre-secure backup found at $CONNECTIONS_BACKUP or $LEGACY_CONNECTIONS_BACKUP" >&2
  fi
fi

if [[ "$MODE" == "hard-auth-reset" ]]; then
  if [[ -f "$CONNECTIONS_PATH" ]]; then
    # Intentionally clears both vault refs and direct auth fields so hosts
    # cannot silently keep connecting through an old PEM path or password.
    python3 - <<'PY' "$CONNECTIONS_PATH"
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
for conn in data.get("connections", []):
    conn["authRef"] = None
    conn["privateKeyPath"] = None
    conn["password"] = None
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
    echo "Stripped authRef/privateKeyPath/password from live connections.json."
  else
    echo "Connections file not found: $CONNECTIONS_PATH" >&2
  fi
fi

if [[ "$DELETE_CONNECTIONS_BACKUP" -eq 1 ]]; then
  remove_if_exists "$CONNECTIONS_BACKUP"
  remove_if_exists "$LEGACY_CONNECTIONS_BACKUP"
fi

echo
echo "Vault test reset complete."
