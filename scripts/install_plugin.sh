#!/usr/bin/env bash
# =============================================================================
# install_plugin.sh — Deploy cockpit-temps plugin to the system
#
# Copies the plugin directory into Cockpit's plugin path and restarts Cockpit.
#
# Usage:  sudo bash scripts/install_plugin.sh
# =============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ── Pre-flight ───────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    err "Kör som root:  sudo bash $0"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$(dirname "$SCRIPT_DIR")/cockpit-temps"

if [[ ! -d "$PLUGIN_SRC" ]]; then
    err "Kunde inte hitta plugin-katalog: $PLUGIN_SRC"
    exit 1
fi

if [[ ! -f "$PLUGIN_SRC/manifest.json" ]]; then
    err "manifest.json saknas i $PLUGIN_SRC"
    exit 1
fi

# ── Choose install target ────────────────────────────────────────────────────
# Prefer /usr/share/cockpit (system-wide), fall back to /usr/local/share/cockpit
if [[ -d /usr/share/cockpit ]]; then
    TARGET="/usr/share/cockpit/cockpit-temps"
elif [[ -d /usr/local/share/cockpit ]]; then
    TARGET="/usr/local/share/cockpit/cockpit-temps"
else
    mkdir -p /usr/share/cockpit
    TARGET="/usr/share/cockpit/cockpit-temps"
fi

info "Källa:  $PLUGIN_SRC"
info "Mål:    $TARGET"

# ── Disable PCP archive compression ─────────────────────────────────────────
# pmrep cannot read .xz-compressed archives when given a directory argument.
# pmlogger_daily compresses rotated archives by default, which breaks this
# plugin's data retrieval.  Setting $PCP_COMPRESSAFTER=never prevents that.
PMLOGGER_CONTROL="/etc/pcp/pmlogger/control.d/local"
if [[ -f "$PMLOGGER_CONTROL" ]]; then
    if grep -q '^#\$PCP_COMPRESSAFTER=never' "$PMLOGGER_CONTROL" 2>/dev/null; then
        sed -i 's/^#\$PCP_COMPRESSAFTER=never/$PCP_COMPRESSAFTER=never/' "$PMLOGGER_CONTROL"
        ok "Uncommented PCP_COMPRESSAFTER=never in $PMLOGGER_CONTROL"
    elif ! grep -q '^\$PCP_COMPRESSAFTER=never' "$PMLOGGER_CONTROL" 2>/dev/null; then
        echo '$PCP_COMPRESSAFTER=never' >> "$PMLOGGER_CONTROL"
        ok "Added PCP_COMPRESSAFTER=never to $PMLOGGER_CONTROL"
    else
        ok "PCP_COMPRESSAFTER=never already set in $PMLOGGER_CONTROL"
    fi
else
    info "$PMLOGGER_CONTROL not found — skipping compression config"
    info "If pmlogger_daily compresses archives, create the file manually:"
    info '  echo "\$PCP_COMPRESSAFTER=never" | sudo tee -a '"$PMLOGGER_CONTROL"
fi

# ── Remove previous install ──────────────────────────────────────────────────
if [[ -d "$TARGET" ]]; then
    info "Tar bort befintlig installation: $TARGET"
    rm -rf "$TARGET"
fi

# ── Copy files ───────────────────────────────────────────────────────────────
info "Kopierar plugin-filer..."
cp -r "$PLUGIN_SRC" "$TARGET"

# Set ownership and permissions
chown -R root:root "$TARGET"
chmod -R 644 "$TARGET"
find "$TARGET" -type d -exec chmod 755 {} +

ok "Plugin kopierad till $TARGET"

# ── Restart Cockpit ──────────────────────────────────────────────────────────
info "Startar om Cockpit..."
if systemctl is-active --quiet cockpit.socket 2>/dev/null || \
   systemctl is-active --quiet cockpit.service 2>/dev/null; then
    systemctl restart cockpit.socket 2>/dev/null || systemctl restart cockpit 2>/dev/null || true
    ok "Cockpit omstartad."
else
    info "Cockpit verkar inte vara igång. Startar..."
    systemctl enable --now cockpit.socket 2>/dev/null || true
    ok "Cockpit startad."
fi

echo ""
echo -e "${GREEN}Installation klar!${NC}"
echo ""
echo "Öppna Cockpit i webbläsaren:"
echo "  https://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'SERVER-IP'):9090"
echo ""
echo "Navigera till 'Temperaturer' i sidomenyn."
echo ""
echo "Felsökning:"
echo "  ls -la $TARGET/"
echo "  journalctl -u cockpit -n 20"
echo "  cockpit-bridge --version"
echo ""
