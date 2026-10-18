#!/bin/sh
# Builds the knxd command line from environment variables (see deploy/appliance/compose.knx-usb.yaml).
set -eu

: "${KNXD_DRIVER:=usb:}"              # usb: (auto-detect one interface), usb:BUS:DEVICE, tpuart:/dev/ttyKNX1, ft12:/dev/ttyUSB0
: "${KNXD_ADDRESS:=0.0.1}"            # individual address of knxd itself: use a FREE address of your line, e.g. 1.1.250
: "${KNXD_CLIENT_ADDRESSES:=0.0.2:8}" # addresses for tunnelling clients (the SE7ENX hub uses one): free addresses too
: "${KNXD_NAME:=SE7ENX knxd}"         # shown by SE7ENX's KNX chain diagnostics
: "${KNXD_SINGLE:=true}"              # "single" filter in front of USB/IP interfaces (recommended by knxd's docs)
: "${KNXD_LOG_LEVEL:=4}"              # 0 (quiet) .. 9 (debug)

die() { echo "se7enx-knxd: $*" >&2; exit 2; }

case "$KNXD_DRIVER" in
  usb:*|tpuart:*|ft12:*|ipt:*) ;;
  *) die "unsupported KNXD_DRIVER '$KNXD_DRIVER' (use usb:, tpuart:<tty>, ft12:<tty> or ipt:<host>)" ;;
esac
echo "$KNXD_ADDRESS" | grep -Eq '^([0-9]|1[0-5])\.([0-9]|1[0-5])\.([0-9]{1,2}|1[0-9]{2}|2[0-4][0-9]|25[0-5])$' \
  || die "invalid KNXD_ADDRESS '$KNXD_ADDRESS' (expected area.line.device, e.g. 1.1.250)"
echo "$KNXD_CLIENT_ADDRESSES" | grep -Eq '^([0-9]|1[0-5])\.([0-9]|1[0-5])\.[0-9]{1,3}:[0-9]{1,3}$' \
  || die "invalid KNXD_CLIENT_ADDRESSES '$KNXD_CLIENT_ADDRESSES' (expected area.line.device:count, e.g. 1.1.240:4)"
case "$KNXD_LOG_LEVEL" in [0-9]) ;; *) die "KNXD_LOG_LEVEL must be 0-9" ;; esac

if [ "${KNXD_DRIVER#usb:}" != "$KNXD_DRIVER" ]; then
  echo "se7enx-knxd: KNX USB interfaces visible inside this container:"
  if ! findknxusb 2>&1; then
    echo "  none (or not accessible). Check: USB passthrough (/dev/bus/usb), the udev rule on the host" \
         "(deploy/knxd/70-se7enx-knx-usb.rules) and KNXD_GID in .env." >&2
  fi
fi

set -- --eibaddr="$KNXD_ADDRESS" --client-addrs="$KNXD_CLIENT_ADDRESSES" --Name="$KNXD_NAME" \
  --error="$KNXD_LOG_LEVEL" --no-timestamp -D -T --Server
if [ "$KNXD_SINGLE" = "true" ]; then
  set -- "$@" -B single
fi
exec knxd "$@" --layer2="$KNXD_DRIVER"
