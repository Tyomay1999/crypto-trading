#!/usr/bin/env bash
set -Eeuo pipefail

MODE="kill"
PORTS=()

usage() {
  cat <<'EOF'
DELTA DEV RUNTIME CLEANUP

Usage:
  delta-dev-runtime-cleanup.sh --ports 3003 3901 5434
  delta-dev-runtime-cleanup.sh --check-only --ports 3003 3901 5434
  delta-dev-runtime-cleanup.sh --kill --ports 3003 3901 5434

Behavior:
  - operates only on explicitly supplied TCP listening ports;
  - sends SIGTERM to listener PIDs in --kill mode;
  - waits briefly and verifies that the requested ports are free;
  - does not use broad pkill patterns;
  - does not touch Docker containers directly.

Exit:
  0 = requested ports are free after cleanup/check
  1 = one or more requested ports remain in use
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kill)
      MODE="kill"
      shift
      ;;
    --check-only)
      MODE="check"
      shift
      ;;
    --ports)
      shift
      while [[ $# -gt 0 && "$1" != --* ]]; do
        PORTS+=("$1")
        shift
      done
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ ${#PORTS[@]} -gt 0 ]] || fail "At least one port is required via --ports"

for port in "${PORTS[@]}"; do
  [[ "$port" =~ ^[0-9]+$ ]] || fail "Invalid port: $port"
  (( port >= 1 && port <= 65535 )) || fail "Port out of range: $port"
done

echo "DELTA_DEV_RUNTIME_CLEANUP=START"
echo "MODE=$MODE"
echo "PORTS=${PORTS[*]}"

remaining=0

for port in "${PORTS[@]}"; do
  mapfile -t pids < <(
    lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u || true
  )

  if [[ ${#pids[@]} -eq 0 ]]; then
    echo "PORT_${port}=FREE"
    continue
  fi

  echo "PORT_${port}=IN_USE"
  echo "PORT_${port}_PIDS=${pids[*]}"

  if [[ "$MODE" == "kill" ]]; then
    for pid in "${pids[@]}"; do
      cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
      echo "TERMINATE port=$port pid=$pid cmd=${cmd:-UNKNOWN}"
      kill "$pid" 2>/dev/null || true
    done
  fi
done

if [[ "$MODE" == "kill" ]]; then
  sleep 1
fi

echo "===== POST-CLEANUP CHECK ====="

for port in "${PORTS[@]}"; do
  if lsof -t -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "PORT_${port}=STILL_IN_USE"
    remaining=1
  else
    echo "PORT_${port}=FREE"
  fi
done

if [[ "$remaining" -ne 0 ]]; then
  echo "DELTA_DEV_RUNTIME_CLEANUP=FAIL"
  exit 1
fi

echo "DELTA_DEV_RUNTIME_CLEANUP=PASS"
