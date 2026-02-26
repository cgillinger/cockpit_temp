#!/usr/bin/env bash
# =============================================================================
# uninstall_plugin.sh — Remove cockpit-temps plugin from the system
#
# Usage:  sudo bash scripts/uninstall_plugin.sh [--purge]
#
# Options:
#   --purge   Also remove PCP lmsensors config and budget cron script
# =============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

PURGE=false
[[ "${1:-}" == "--purge" ]] && PURGE=true

if [[ $EUID -ne 0 ]]; then
    err "Kör som root:  sudo bash $0"
    exit 1
fi

# ── Remove plugin ────────────────────────────────────────────────────────────
TARGETS=(
    "/usr/share/cockpit/cockpit-temps"
    "/usr/local/share/cockpit/cockpit-temps"
)

REMOVED=false
for DIR in "${TARGETS[@]}"; do
    if [[ -d "$DIR" ]]; then
        info "Tar bort: $DIR"
        rm -rf "$DIR"
        ok "Borttagen: $DIR"
        REMOVED=true
    fi
done

# Also remove any backups
for BAK in /usr/share/cockpit/cockpit-temps.bak.* /usr/local/share/cockpit/cockpit-temps.bak.*; do
    if [[ -d "$BAK" ]]; then
        info "Tar bort backup: $BAK"
        rm -rf "$BAK"
    fi
done

if ! $REMOVED; then
    warn "Ingen installation hittades att ta bort."
fi

# ── Purge PCP configuration ─────────────────────────────────────────────────
if $PURGE; then
    info "Rensar PCP-konfiguration (--purge)..."

    # Remove pmlogger lmsensors config snippet
    CONF="/etc/pcp/pmlogger/config.d/lmsensors.config"
    if [[ -f "$CONF" ]]; then
        rm -f "$CONF"
        ok "Borttagen: $CONF"
    fi

    # Remove budget cron script
    BUDGET="/etc/cron.daily/pcp-archive-budget"
    if [[ -f "$BUDGET" ]]; then
        rm -f "$BUDGET"
        ok "Borttagen: $BUDGET"
    fi

    warn "PCP-arkivdata (loggar) bevaras. Ta bort manuellt vid behov:"
    warn "  rm -rf /var/log/pcp/pmlogger/\$(hostname)/"
    warn ""
    warn "lmsensors PMDA avinstalleras inte. Gör manuellt vid behov:"
    warn "  cd /var/lib/pcp/pmdas/lmsensors && sudo ./Remove"
fi

# ── Restart Cockpit ──────────────────────────────────────────────────────────
info "Startar om Cockpit..."
systemctl restart cockpit.socket 2>/dev/null || systemctl restart cockpit 2>/dev/null || true
ok "Cockpit omstartad."

echo ""
echo -e "${GREEN}Avinstallation klar.${NC}"
echo ""
