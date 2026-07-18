#!/usr/bin/env bash
# =============================================================================
# setup_pcp_temps.sh — Install & configure PCP + lmsensors PMDA on Ubuntu
#
# Installs required packages, enables the lmsensors PMDA, configures pmlogger
# to archive lmsensors metrics with daily rotation and retention pruning.
#
# Usage:  sudo bash scripts/setup_pcp_temps.sh
# =============================================================================
set -euo pipefail

# ── Configurable variables ───────────────────────────────────────────────────
RETENTION_DAYS="${RETENTION_DAYS:-120}"        # Keep archives this many days
MAX_SIZE_GB="${MAX_SIZE_GB:-10}"               # Max total archive size in GB
PMLOGGER_INTERVAL="${PMLOGGER_INTERVAL:-60}"   # Logging interval in seconds
# ─────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ── Pre-flight checks ───────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    err "Detta skript måste köras som root.  Kör: sudo bash $0"
    exit 1
fi

if ! command -v apt-get &>/dev/null; then
    err "Endast Ubuntu/Debian stöds (apt-get saknas)."
    exit 1
fi

info "Ubuntu-version: $(lsb_release -ds 2>/dev/null || cat /etc/os-release | head -1)"
info "Retentionstid: ${RETENTION_DAYS} dagar, max arkivstorlek: ${MAX_SIZE_GB} GB"
echo ""

# ── Step 1: Install packages ────────────────────────────────────────────────
info "Steg 1/7 — Installerar paket..."

apt-get update -qq

# Core packages always available
PKGS="lm-sensors pcp cockpit cockpit-pcp"

# pcp-pmda-lmsensors may or may not exist as a separate package
if apt-cache show pcp-pmda-lmsensors &>/dev/null 2>&1; then
    PKGS="$PKGS pcp-pmda-lmsensors"
    info "Paketet pcp-pmda-lmsensors finns — installerar det."
else
    info "Paketet pcp-pmda-lmsensors saknas; PMDA installeras manuellt i steg 3."
fi

# pcp-gui / pcp-system-tools provide pmrep
if apt-cache show pcp-system-tools &>/dev/null 2>&1; then
    PKGS="$PKGS pcp-system-tools"
elif apt-cache show pcp-gui &>/dev/null 2>&1; then
    PKGS="$PKGS pcp-gui"
fi

apt-get install -y $PKGS
ok "Paket installerade."

# ── Step 2: Detect sensors ──────────────────────────────────────────────────
info "Steg 2/7 — Kör sensors-detect..."

# Non-interactive sensors-detect (answer YES to all)
if ! command -v sensors &>/dev/null; then
    err "'sensors' kommando saknas trots att lm-sensors installerats."
    exit 1
fi

# Only run sensors-detect if no sensors found yet
if sensors 2>/dev/null | grep -qi "adapter"; then
    ok "Sensorer redan detekterade:"
    sensors | head -30
else
    info "Kör sensors-detect (icke-interaktivt)..."
    yes "" | sensors-detect --auto 2>/dev/null || sensors-detect 2>/dev/null || true
    # Load detected kernel modules
    if [[ -f /etc/modules-load.d/lm-sensors.conf ]]; then
        while IFS= read -r mod; do
            [[ -z "$mod" || "$mod" == \#* ]] && continue
            modprobe "$mod" 2>/dev/null || true
        done < /etc/modules-load.d/lm-sensors.conf
    fi
    sensors || warn "sensors returnerade inga data."
fi
echo ""

# ── Step 3: Install lmsensors PMDA ──────────────────────────────────────────
info "Steg 3/7 — Aktiverar lmsensors PMDA..."

PMDA_DIR="/var/lib/pcp/pmdas/lmsensors"

if [[ ! -d "$PMDA_DIR" ]]; then
    # On some systems the PMDA may be at a different path
    PMDA_DIR=$(find /var/lib/pcp/pmdas /usr/share/pcp/pmdas -maxdepth 1 -name "lmsensors" -type d 2>/dev/null | head -1 || true)
fi

if [[ -z "$PMDA_DIR" || ! -d "$PMDA_DIR" ]]; then
    err "Kunde inte hitta lmsensors PMDA-katalog."
    err "Kontrollera att PCP-versionen stöder lmsensors PMDA."
    err "Sökta platser: /var/lib/pcp/pmdas/lmsensors, /usr/share/pcp/pmdas/lmsensors"
    exit 1
fi

info "PMDA-katalog: $PMDA_DIR"

# Ensure pmcd is running before installing PMDA
systemctl enable --now pmcd 2>/dev/null || true
sleep 1

# Check if already installed
if pminfo lmsensors 2>/dev/null | head -1 | grep -q "lmsensors"; then
    ok "lmsensors PMDA redan installerad."
else
    info "Installerar PMDA från $PMDA_DIR ..."
    pushd "$PMDA_DIR" > /dev/null
    # Pipe newline to accept defaults
    echo | ./Install 2>&1 | tail -5
    popd > /dev/null

    sleep 2
    if pminfo lmsensors 2>/dev/null | head -1 | grep -q "lmsensors"; then
        ok "lmsensors PMDA installerad och aktiv."
    else
        warn "PMDA kan ha installerats men pminfo visar inga mått ännu."
        warn "Kontrollera med: pminfo -f lmsensors"
    fi
fi
echo ""

# ── Step 4: Configure pmlogger for lmsensors metrics ────────────────────────
info "Steg 4/7 — Konfigurerar pmlogger att logga lmsensors-mått..."

PMLOGGER_CONF_DIR="/etc/pcp/pmlogger"
PMLOGGER_CONF_DEFAULT="$PMLOGGER_CONF_DIR/config.default"
LMSENSORS_CONF_SNIPPET="$PMLOGGER_CONF_DIR/config.d/lmsensors.config"

# Try config.d directory first (modern PCP), fall back to appending
if [[ -d "$PMLOGGER_CONF_DIR/config.d" ]]; then
    info "Skriver konfiguration till $LMSENSORS_CONF_SNIPPET"
    cat > "$LMSENSORS_CONF_SNIPPET" <<CONFEOF
# Cockpit-temps: Log all lm-sensors metrics
log mandatory on ${PMLOGGER_INTERVAL}sec {
    lmsensors
}
CONFEOF
    ok "Konfigurationsfragment skapat."
elif [[ -f "$PMLOGGER_CONF_DEFAULT" ]]; then
    # Append if not already present
    if grep -q "lmsensors" "$PMLOGGER_CONF_DEFAULT"; then
        ok "lmsensors redan konfigurerat i $PMLOGGER_CONF_DEFAULT"
    else
        info "Lägger till lmsensors i $PMLOGGER_CONF_DEFAULT"
        cat >> "$PMLOGGER_CONF_DEFAULT" <<CONFEOF

# Cockpit-temps: Log all lm-sensors metrics
log mandatory on ${PMLOGGER_INTERVAL}sec {
    lmsensors
}
CONFEOF
        ok "lmsensors tillagd i pmlogger-konfiguration."
    fi
else
    warn "Kunde inte hitta pmlogger-konfiguration. Skapar minimal config..."
    mkdir -p "$PMLOGGER_CONF_DIR"
    cat > "$PMLOGGER_CONF_DEFAULT" <<CONFEOF
log mandatory on ${PMLOGGER_INTERVAL}sec {
    lmsensors
    kernel.all.load
    hinv.ncpu
}
CONFEOF
    ok "Minimal pmlogger-konfiguration skapad."
fi
echo ""

# ── Step 5: Configure archive rotation & retention ──────────────────────────
info "Steg 5/7 — Konfigurerar arkivrotation och retention..."

# Configure pmlogger_daily retention. The systemd unit reads
# EnvironmentFile=/etc/{sysconfig,default}/pmlogger_timers — NOT the
# pmlogger file, where settings are silently ignored.
PMLOGGER_SYSCONFIG=""
if [[ -d /etc/sysconfig ]]; then
    PMLOGGER_SYSCONFIG="/etc/sysconfig/pmlogger_timers"
elif [[ -d /etc/default ]]; then
    PMLOGGER_SYSCONFIG="/etc/default/pmlogger_timers"
fi

if [[ -n "$PMLOGGER_SYSCONFIG" ]]; then
    info "Skriver retentionskonfiguration till $PMLOGGER_SYSCONFIG"
    # -k N: cull archives older than N days. No compression flag: pmrep
    # cannot read .xz archives via directory argument, so compressed
    # archives break the plugin.
    sed -i '/^PMLOGGER_DAILY_PARAMS=/d' "$PMLOGGER_SYSCONFIG" 2>/dev/null || true
    cat >> "$PMLOGGER_SYSCONFIG" <<SYSEOF
# Cockpit-temps PCP archive retention settings
# Generated by setup_pcp_temps.sh
PMLOGGER_DAILY_PARAMS="-k ${RETENTION_DAYS}"
SYSEOF
    ok "pmlogger_daily retention: ${RETENTION_DAYS} dagar."
else
    warn "Kunde inte hitta /etc/sysconfig eller /etc/default — ställer in retention via kontroll-fil."
fi

# Remove retention config written to the wrong file by earlier versions
# of this script (the systemd unit never reads it)
for LEGACY in /etc/sysconfig/pmlogger /etc/default/pmlogger; do
    if [[ -f "$LEGACY" ]] && grep -q "setup_pcp_temps.sh" "$LEGACY"; then
        info "Tar bort inaktuell retentionskonfiguration: $LEGACY"
        rm -f "$LEGACY"
    fi
done

# Disable archive compression permanently. pmlogger_daily compresses
# rotated archives (.0 -> .0.xz) but pmrep cannot read them via a
# directory argument -> "PM_ERR_NAME Unknown metric name" in the plugin.
PMLOGGER_CONTROL_LOCAL="/etc/pcp/pmlogger/control.d/local"
if [[ -f "$PMLOGGER_CONTROL_LOCAL" ]]; then
    if grep -q '^\$PCP_COMPRESSAFTER=never' "$PMLOGGER_CONTROL_LOCAL"; then
        ok "Arkivkomprimering redan avstängd i $PMLOGGER_CONTROL_LOCAL"
    else
        sed -i '/^\$PCP_COMPRESSAFTER=/d' "$PMLOGGER_CONTROL_LOCAL"
        sed -i '/^\$version=/a $PCP_COMPRESSAFTER=never' "$PMLOGGER_CONTROL_LOCAL"
        ok "Arkivkomprimering avstängd (\$PCP_COMPRESSAFTER=never)."
    fi
else
    warn "$PMLOGGER_CONTROL_LOCAL saknas — kunde inte stänga av arkivkomprimering."
    warn "Om arkiv komprimeras (.xz) slutar pluginet läsa dem."
fi

# Ensure pmlogger_daily systemd timer is enabled (runs daily)
if systemctl list-unit-files | grep -q pmlogger_daily; then
    systemctl enable pmlogger_daily.timer 2>/dev/null || true
    ok "pmlogger_daily.timer aktiverad."
elif systemctl list-unit-files | grep -q pmlogger-daily; then
    systemctl enable pmlogger-daily.timer 2>/dev/null || true
    ok "pmlogger-daily.timer aktiverad."
else
    # Fall back to ensuring cron-based rotation
    if [[ -f /etc/cron.daily/pmlogger_daily ]] || [[ -f /usr/libexec/pcp/bin/pmlogger_daily ]]; then
        ok "pmlogger_daily körs via cron."
    else
        warn "Hittade varken systemd-timer eller cron för pmlogger_daily."
        warn "Arkivrotation kan behöva konfigureras manuellt."
    fi
fi

# Create disk-budget enforcement script. Installed in /usr/local/bin and
# scheduled via /etc/cron.d at 08:10 — /etc/cron.daily runs 06:25 and is
# skipped entirely on machines that are powered off then (anacron is not
# installed by default on Ubuntu Server).
BUDGET_SCRIPT="/usr/local/bin/pcp-archive-budget"
BUDGET_CRON="/etc/cron.d/pcp-archive-budget"
info "Skapar disk-budget-skript: $BUDGET_SCRIPT"
cat > "$BUDGET_SCRIPT" <<'BUDGETEOF'
#!/bin/bash
# pcp-archive-budget — Enforce max disk usage for PCP archives
# Generated by cockpit-temps setup_pcp_temps.sh

MAX_SIZE_GB="${PCP_MAX_SIZE_GB:-5}"
MAX_SIZE_KB=$((MAX_SIZE_GB * 1024 * 1024))
ARCHIVE_BASE="/var/log/pcp/pmlogger"

for HOST_DIR in "$ARCHIVE_BASE"/*/; do
    [[ -d "$HOST_DIR" ]] || continue

    # Calculate current size
    CURRENT_KB=$(du -sk "$HOST_DIR" 2>/dev/null | cut -f1)
    if [[ "$CURRENT_KB" -le "$MAX_SIZE_KB" ]]; then
        continue
    fi

    echo "PCP archive budget: ${HOST_DIR} is ${CURRENT_KB}KB (limit ${MAX_SIZE_KB}KB). Pruning oldest..."

    # Find and remove oldest archive sets until under budget
    # Archives are named YYYYMMDD.HH.MM* (meta, index, volumes)
    find "$HOST_DIR" -maxdepth 1 -name "*.meta" -o -name "*.meta.xz" | sort | while read META; do
        CURRENT_KB=$(du -sk "$HOST_DIR" 2>/dev/null | cut -f1)
        [[ "$CURRENT_KB" -le "$MAX_SIZE_KB" ]] && break

        BASE="${META%.meta}"
        BASE="${BASE%.meta.xz}"
        echo "  Removing archive set: $(basename "$BASE")"
        rm -f "${BASE}".*
    done
done
BUDGETEOF
chmod +x "$BUDGET_SCRIPT"

cat > "$BUDGET_CRON" <<CRONEOF
# Cockpit-temps: enforce PCP archive disk budget
# Generated by setup_pcp_temps.sh
10 8 * * * root PCP_MAX_SIZE_GB=${MAX_SIZE_GB} $BUDGET_SCRIPT
CRONEOF

# Remove budget script installed in cron.daily by earlier versions of
# this script (cron.daily never runs on hosts powered off at 06:25)
rm -f /etc/cron.daily/pcp-archive-budget

ok "Disk-budget-skript installerat (max ${MAX_SIZE_GB} GB, körs 08:10 via cron.d)."
echo ""

# ── Step 6: Enable and start services ───────────────────────────────────────
info "Steg 6/7 — Aktiverar och startar tjänster..."

systemctl enable --now pmcd 2>/dev/null     && ok "pmcd aktiv."     || warn "Kunde inte starta pmcd."
systemctl enable --now pmlogger 2>/dev/null  && ok "pmlogger aktiv." || warn "Kunde inte starta pmlogger."
systemctl enable --now cockpit.socket 2>/dev/null && ok "cockpit aktiv." || warn "Kunde inte starta cockpit."

# Restart pmlogger to pick up new config
systemctl restart pmlogger 2>/dev/null || true
ok "pmlogger omstartad med ny konfiguration."
echo ""

# ── Step 7: Verify ──────────────────────────────────────────────────────────
info "Steg 7/7 — Verifiering..."
echo ""

# Check lmsensors metrics
info "Kontrollerar lmsensors-mått via pminfo:"
if pminfo lmsensors 2>/dev/null | head -20; then
    ok "lmsensors-mått tillgängliga."
else
    warn "Inga lmsensors-mått hittades. PMDA kan behöva ominstalleras."
fi
echo ""

# Show sample value
info "Exempelvärde (pmval):"
SAMPLE_METRIC=$(pminfo lmsensors 2>/dev/null | grep "temp.*input" | head -1)
if [[ -n "$SAMPLE_METRIC" ]]; then
    pmval -s 1 "$SAMPLE_METRIC" 2>/dev/null || true
fi
echo ""

# Show archive directory
HOSTNAME_REAL=$(hostname)
ARCHIVE_PATH="/var/log/pcp/pmlogger/$HOSTNAME_REAL"
info "Arkivkatalog: $ARCHIVE_PATH"
if [[ -d "$ARCHIVE_PATH" ]]; then
    ls -lh "$ARCHIVE_PATH" | tail -10
    echo ""
    ARCHIVE_SIZE=$(du -sh "$ARCHIVE_PATH" 2>/dev/null | cut -f1)
    info "Total arkivstorlek: $ARCHIVE_SIZE"
else
    warn "Arkivkatalog skapad men kan vara tom (pmlogger behöver tid för att skriva data)."
fi
echo ""

# ── Summary ─────────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════"
echo -e "${GREEN}Setup klar!${NC}"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Nästa steg:"
echo "  1. Installera Cockpit-plugin:  sudo bash scripts/install_plugin.sh"
echo "  2. Öppna Cockpit:              https://$(hostname -I | awk '{print $1}'):9090"
echo "  3. Navigera till 'Temperaturer' i menyn"
echo ""
echo "Verifieringskommandon:"
echo "  sensors                                # Visa aktuella sensorvärden"
echo "  pminfo lmsensors | head -20            # Lista PCP lmsensors-mått"
echo "  pminfo -f lmsensors | head -40         # Visa mått med värden"
echo "  pmval -s 3 -t 2sec $SAMPLE_METRIC      # Visa 3 sampel"
echo "  du -sh $ARCHIVE_PATH                   # Arkivstorlek"
echo "  systemctl status pmcd pmlogger         # Tjänststatus"
echo ""
echo "Rotations- och budget-kontroll:"
echo "  systemctl list-timers | grep pmlog     # Visa aktiva timers"
echo "  cat $BUDGET_SCRIPT                     # Visa budget-skript"
echo "  bash -x $BUDGET_SCRIPT                 # Kör budget-prune manuellt (dry-run)"
echo "  du -sh $ARCHIVE_PATH                   # Kontrollera storlek"
echo ""
echo "Retentionsinställningar (redigera vid behov):"
if [[ -n "$PMLOGGER_SYSCONFIG" ]]; then
    echo "  $PMLOGGER_SYSCONFIG"
fi
echo "  Retention: ${RETENTION_DAYS} dagar"
echo "  Max storlek: ${MAX_SIZE_GB} GB"
echo ""
