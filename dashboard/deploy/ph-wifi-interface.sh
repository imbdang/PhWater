#!/usr/bin/env bash
set -euo pipefail
# wlan0 remains the AP. brcmfmac creates a distinct MAC for this managed VIF.
if ! test -d /sys/class/net/wlan1; then
    wifi_phy="$(basename "$(readlink -f /sys/class/net/wlan0/phy80211)")"
    /usr/sbin/iw phy "$wifi_phy" interface add wlan1 type managed
fi
/usr/sbin/ip link set wlan1 up
