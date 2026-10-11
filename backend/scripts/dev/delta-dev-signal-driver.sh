#!/usr/bin/env bash
set -Eeuo pipefail

CONTROL_URL="${DELTA_DEV_SIGNAL_CONTROL_URL:-http://127.0.0.1:3900}"
INTERVAL=20
MODE=""
SIGNAL_ID=""
SCENARIO="random"
SYMBOL=""
DIRECTION=""

usage() {
  cat <<'EOF'
DELTA DEV SIGNAL DRIVER

Usage:
  delta_dev_signal_driver.sh --next <signalId>
  delta_dev_signal_driver.sh --create [--symbol BTCUSDT] [--direction LONG]
  delta_dev_signal_driver.sh --random-run [--interval 20] [--scenario random|tp3|stop-after-entry|stop-after-tp1|stop-after-tp2]
  delta_dev_signal_driver.sh --status
  delta_dev_signal_driver.sh --help

Options:
  --next <signalId>       Advance one lifecycle step for an existing signal.
  --create                Create one random DEV signal and leave it at PUBLISHED.
  --random-run            Create a random DEV signal and advance it automatically.
  --interval <seconds>    Delay between lifecycle transitions. Default: 20.
  --scenario <name>       random (default), tp3, stop-after-entry,
                          stop-after-tp1, stop-after-tp2.
  --symbol <symbol>       Override random symbol for --create/--random-run.
  --direction <LONG|SHORT>
                          Override random direction.
  --status                Show DEV simulator status.
  --url <control-url>     Override control URL.
                          Default: http://127.0.0.1:3900
  --help                  Show this help.

Examples:
  ./delta_dev_signal_driver.sh --next p13h-iphone-20261011t134928z

  ./delta_dev_signal_driver.sh --random-run

  ./delta_dev_signal_driver.sh --random-run --interval 5

  ./delta_dev_signal_driver.sh --random-run \
    --scenario stop-after-tp1 \
    --interval 10

Environment:
  DELTA_DEV_SIGNAL_CONTROL_URL
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

need_value() {
  [[ $# -ge 2 && -n "${2:-}" ]] || fail "Missing value for $1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --next)
      need_value "$@"
      MODE="next"
      SIGNAL_ID="$2"
      shift 2
      ;;
    --create)
      MODE="create"
      shift
      ;;
    --random-run)
      MODE="random-run"
      shift
      ;;
    --status)
      MODE="status"
      shift
      ;;
    --interval)
      need_value "$@"
      INTERVAL="$2"
      shift 2
      ;;
    --scenario)
      need_value "$@"
      SCENARIO="$2"
      shift 2
      ;;
    --symbol)
      need_value "$@"
      SYMBOL="$2"
      shift 2
      ;;
    --direction)
      need_value "$@"
      DIRECTION="$2"
      shift 2
      ;;
    --url)
      need_value "$@"
      CONTROL_URL="${2%/}"
      shift 2
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

[[ -n "$MODE" ]] || {
  usage
  exit 1
}

[[ "$INTERVAL" =~ ^[0-9]+$ ]] || fail "--interval must be a non-negative integer"

case "$SCENARIO" in
  random|tp3|stop-after-entry|stop-after-tp1|stop-after-tp2) ;;
  *) fail "Invalid --scenario: $SCENARIO" ;;
esac

if [[ -n "$DIRECTION" ]]; then
  case "$DIRECTION" in
    LONG|SHORT) ;;
    *) fail "--direction must be LONG or SHORT" ;;
  esac
fi

command -v curl >/dev/null 2>&1 || fail "curl is required"

http_get() {
  local path="$1"
  curl -fsS "${CONTROL_URL}${path}"
}

http_post() {
  local path="$1"
  local body="${2-}"
  if [[ -z "$body" ]]; then
    body='{}'
  fi
  curl -fsS \
    -X POST \
    -H 'content-type: application/json' \
    --data "$body" \
    "${CONTROL_URL}${path}"
}

pick_random() {
  local -n arr_ref="$1"
  local idx=$(( RANDOM % ${#arr_ref[@]} ))
  printf '%s\n' "${arr_ref[$idx]}"
}

make_signal_id() {
  printf 'dev-%s-%04d\n' "$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')" "$(( RANDOM % 10000 ))"
}

create_random_signal() {
  local symbols=(BTCUSDT ETHUSDT SOLUSDT BNBUSDT XRPUSDT)
  local directions=(LONG SHORT)

  local chosen_symbol="${SYMBOL:-$(pick_random symbols)}"
  local chosen_direction="${DIRECTION:-$(pick_random directions)}"
  local id
  id="$(make_signal_id)"

  echo "CREATE_SIGNAL_ID=$id"
  echo "CREATE_SYMBOL=$chosen_symbol"
  echo "CREATE_DIRECTION=$chosen_direction"

  http_post \
    "/signals" \
    "{\"signalId\":\"${id}\",\"symbol\":\"${chosen_symbol}\",\"direction\":\"${chosen_direction}\"}"
  echo
  printf '%s\n' "$id"
}

advance() {
  local id="$1"
  http_post "/signals/${id}/next" '{}'
  echo
}

stop_signal() {
  local id="$1"
  http_post "/signals/${id}/stop" '{}'
  echo
}

sleep_step() {
  if [[ "$INTERVAL" -gt 0 ]]; then
    echo "WAIT_SECONDS=$INTERVAL"
    sleep "$INTERVAL"
  fi
}

resolve_scenario() {
  if [[ "$SCENARIO" != "random" ]]; then
    printf '%s\n' "$SCENARIO"
    return
  fi

  local scenarios=(
    tp3
    stop-after-entry
    stop-after-tp1
    stop-after-tp2
  )
  pick_random scenarios
}

run_scenario() {
  local id="$1"
  local scenario="$2"

  echo "RUN_SIGNAL_ID=$id"
  echo "RUN_SCENARIO=$scenario"
  echo "RUN_INTERVAL_SECONDS=$INTERVAL"

  # PUBLISHED -> WAITING_FOR_ENTRY
  sleep_step
  echo "STEP=WAITING_FOR_ENTRY"
  advance "$id"

  # WAITING_FOR_ENTRY -> ENTRY_REACHED
  sleep_step
  echo "STEP=ENTRY_REACHED"
  advance "$id"

  case "$scenario" in
    stop-after-entry)
      sleep_step
      echo "STEP=STOP_REACHED"
      stop_signal "$id"
      ;;

    stop-after-tp1)
      sleep_step
      echo "STEP=TP1_REACHED"
      advance "$id"

      sleep_step
      echo "STEP=STOP_REACHED"
      stop_signal "$id"
      ;;

    stop-after-tp2)
      sleep_step
      echo "STEP=TP1_REACHED"
      advance "$id"

      sleep_step
      echo "STEP=TP2_REACHED"
      advance "$id"

      sleep_step
      echo "STEP=STOP_REACHED"
      stop_signal "$id"
      ;;

    tp3)
      sleep_step
      echo "STEP=TP1_REACHED"
      advance "$id"

      sleep_step
      echo "STEP=TP2_REACHED"
      advance "$id"

      sleep_step
      echo "STEP=TP3_REACHED"
      advance "$id"
      ;;
  esac

  echo "RUN_COMPLETE=YES"
  echo "FINAL_SCENARIO=$scenario"
}

case "$MODE" in
  status)
    http_get "/status"
    echo
    ;;

  next)
    [[ -n "$SIGNAL_ID" ]] || fail "--next requires a signalId"
    echo "NEXT_SIGNAL_ID=$SIGNAL_ID"
    advance "$SIGNAL_ID"
    ;;

  create)
    create_random_signal >/tmp/delta-dev-signal-create.$$.out
    cat /tmp/delta-dev-signal-create.$$.out
    rm -f /tmp/delta-dev-signal-create.$$.out
    ;;

  random-run)
    tmp="$(mktemp)"
    create_random_signal | tee "$tmp"
    SIGNAL_ID="$(grep '^CREATE_SIGNAL_ID=' "$tmp" | tail -1 | cut -d= -f2-)"
    rm -f "$tmp"

    [[ -n "$SIGNAL_ID" ]] || fail "Could not resolve created signalId"

    CHOSEN_SCENARIO="$(resolve_scenario)"
    run_scenario "$SIGNAL_ID" "$CHOSEN_SCENARIO"
    ;;
esac
