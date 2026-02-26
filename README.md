# cockpit-temps — Cockpit Temperature Monitoring Plugin

A Cockpit plugin for Ubuntu Server that visualises hardware temperature data
(CPU, NVMe, etc.) as interactive line charts with configurable thresholds.
Data is collected and archived by **PCP** (Performance Co-Pilot) via the
`pmdalmsensors` PMDA, giving you up to 365 days of history with automatic
archive rotation and disk-budget enforcement.

---

## Features

- **Historical charts** — query PCP archives up to 1 year back
- **Sensor grouping** — CPU / NVMe groups with Swedish-friendly labels
- **Threshold lines** — global defaults (70 / 75 / 80 °C) plus per-sensor overrides
- **Date range controls** — quick presets (1h, 24h, 7d, 30d, 90d, 1y) and custom range
- **Auto downsampling** — step size scales with time range (1 min → 6 h)
- **Metric discovery** — UI button lists available PCP lmsensors metrics
- **Archive rotation** — pmlogger_daily + cron-based disk budget
- **Zero external deps** — plain JS, inline SVG chart, no build step

---

## File Tree

```
cockpit-temps/
├── manifest.json              # Cockpit plugin manifest
├── index.html                 # Main HTML page
├── app.js                     # Application logic + SVG chart
├── style.css                  # Styles
└── config/
    └── sensors.json           # Sensor mapping, thresholds, retention config

scripts/
├── setup_pcp_temps.sh         # Install PCP + lmsensors PMDA + rotation
├── install_plugin.sh          # Deploy plugin into Cockpit
└── uninstall_plugin.sh        # Remove plugin (optional --purge)
```

---

## Quick Start

### 1. Clone the repo

```bash
git clone <this-repo> cockpit-temps-repo
cd cockpit-temps-repo
```

### 2. Run the PCP setup script (as root)

```bash
sudo bash scripts/setup_pcp_temps.sh
```

This will:
- Install `lm-sensors`, `pcp`, `cockpit`, `cockpit-pcp`
- Run `sensors-detect`
- Install the lmsensors PMDA
- Configure `pmlogger` to archive lmsensors metrics every 60 s
- Set up archive rotation (365 days retention, 5 GB max)
- Enable and start all services

**Configurable variables** (set before running or edit the script):

| Variable             | Default | Description                     |
|---------------------|---------|---------------------------------|
| `RETENTION_DAYS`    | 365     | Keep archives this many days    |
| `MAX_SIZE_GB`       | 5       | Max total archive disk usage    |
| `PMLOGGER_INTERVAL` | 60      | Logging interval in seconds     |

Example:

```bash
sudo RETENTION_DAYS=180 MAX_SIZE_GB=2 bash scripts/setup_pcp_temps.sh
```

### 3. Install the Cockpit plugin

```bash
sudo bash scripts/install_plugin.sh
```

### 4. Open Cockpit

Navigate to `https://<server-ip>:9090` and click **Temperaturer** in the menu.

---

## Sensor Configuration

Edit `cockpit-temps/config/sensors.json` to customise sensor labels, PCP metric
names, and thresholds.

### Discovering your metric names

**Option A — Use the UI:** Click the "Upptäck sensorer" button in the plugin
sidebar. It runs `pminfo -t lmsensors` and lists all available metrics.

**Option B — Command line:**

```bash
# List all lmsensors metric names
pminfo lmsensors

# List metrics with descriptions
pminfo -t lmsensors

# Show current values
pminfo -f lmsensors
```

### Example `pminfo -t lmsensors` output

```
lmsensors.coretemp_isa_0000.temp1_input [coretemp-isa-0000 temperature input temp1]
lmsensors.coretemp_isa_0000.temp2_input [coretemp-isa-0000 temperature input temp2]
lmsensors.coretemp_isa_0000.temp3_input [coretemp-isa-0000 temperature input temp3]
lmsensors.coretemp_isa_0000.temp4_input [coretemp-isa-0000 temperature input temp4]
lmsensors.coretemp_isa_0000.temp5_input [coretemp-isa-0000 temperature input temp5]
lmsensors.nvme_pci_0100.temp1_input     [nvme-pci-0100 temperature input temp1]
lmsensors.nvme_pci_0100.temp2_input     [nvme-pci-0100 temperature input temp2]
lmsensors.nvme_pci_0100.temp3_input     [nvme-pci-0100 temperature input temp3]
```

### Mapping lm-sensors output to PCP metrics

| `sensors` label          | PCP metric name                              | Config label                      |
|--------------------------|----------------------------------------------|-----------------------------------|
| Package id 0 (coretemp)  | `lmsensors.coretemp_isa_0000.temp1_input`    | Processortemperatur (Package)     |
| Core 0 (coretemp)        | `lmsensors.coretemp_isa_0000.temp2_input`    | CPU Core 0                        |
| Core 1 (coretemp)        | `lmsensors.coretemp_isa_0000.temp3_input`    | CPU Core 1                        |
| Core 2 (coretemp)        | `lmsensors.coretemp_isa_0000.temp4_input`    | CPU Core 2                        |
| Core 3 (coretemp)        | `lmsensors.coretemp_isa_0000.temp5_input`    | CPU Core 3                        |
| Composite (nvme)         | `lmsensors.nvme_pci_0100.temp1_input`        | NVMe temperatur (Composite)      |
| Sensor 1 (nvme)          | `lmsensors.nvme_pci_0100.temp2_input`        | NVMe temperatur (Sensor 1)       |
| Sensor 2 (nvme)          | `lmsensors.nvme_pci_0100.temp3_input`        | NVMe temperatur (Sensor 2)       |

The naming convention: `lmsensors.<chip>.<feature>` where:
- Chip: adapter name with dashes → underscores (e.g., `coretemp-isa-0000` → `coretemp_isa_0000`)
- Feature: sensor label from libsensors (e.g., `temp1_input`, `temp2_input`, ...)

### Per-sensor thresholds

In `sensors.json`, each sensor can override the global thresholds:

```json
{
    "id": "nvme_composite",
    "label": "NVMe temperatur (Composite)",
    "metric": "lmsensors.nvme_pci_0100.temp1_input",
    "thresholds": [
        { "value": 65, "label": "NVMe Varning", "color": "#FFA726" },
        { "value": 75, "label": "NVMe Kritiskt", "color": "#E53935" }
    ]
}
```

---

## Archive Rotation & Disk Budget

### How it works

1. **pmlogger_daily** runs via systemd timer (or cron) once per day:
   - Creates a new daily archive
   - Compresses old archives (`-x 0`)
   - Removes archives older than `RETENTION_DAYS` (`-k N`)

2. **pcp-archive-budget** cron script (`/etc/cron.daily/pcp-archive-budget`):
   - Checks total archive size per host
   - If over `MAX_SIZE_GB`, removes oldest archive sets until under budget

### Verification commands

```bash
# Check archive size
du -sh /var/log/pcp/pmlogger/$(hostname)/

# List archive files
ls -lhS /var/log/pcp/pmlogger/$(hostname)/ | head -20

# Check pmlogger_daily timer
systemctl list-timers | grep pmlog

# Check retention config
cat /etc/default/pmlogger    # or /etc/sysconfig/pmlogger

# Manually trigger budget enforcement (safe to run)
sudo bash /etc/cron.daily/pcp-archive-budget

# Check pmlogger_daily status
systemctl status pmlogger_daily.timer
journalctl -u pmlogger_daily --since today
```

### Adjusting retention after install

Edit `/etc/default/pmlogger` (or `/etc/sysconfig/pmlogger`):

```bash
PMLOGGER_DAILY_PARAMS="-E -k 180 -x 0"   # 180 days
PCP_MAX_SIZE_GB=3                          # 3 GB budget
```

Then restart: `sudo systemctl restart pmlogger`

---

## Acceptance Tests

### 1. Sensors detected

```bash
sensors
# Expected: output showing coretemp-isa-0000 and/or nvme-pci-0100 adapters
```

### 2. PCP lmsensors metrics available

```bash
pminfo | grep -i lmsensors
# Expected: multiple lmsensors.* metric names

pminfo -f lmsensors | head -20
# Expected: metric names with numeric temperature values
```

### 3. Live data via pmval

```bash
pmval -s 3 -t 2sec lmsensors.coretemp_isa_0000.temp1_input
# Expected: 3 temperature samples, e.g. 55.000, 56.000, 55.000
```

### 4. Archive data exists

```bash
# Wait a few minutes after setup, then:
pmrep -a /var/log/pcp/pmlogger/$(hostname)/ -o csv -H -t 60sec \
  -S "-10minutes" lmsensors.coretemp_isa_0000.temp1_input
# Expected: CSV rows with timestamps and temperature values
```

### 5. UI tests (manual)

1. Open Cockpit → Temperaturer
2. Select "NVMe temperatur (Sensor 1)" checkbox
3. Choose "24 tim" preset → click **Hämta data**
4. **Expected:** Line chart with data points rendered
5. Choose "1 år" preset → click **Hämta data**
6. **Expected:** Chart renders with downsampled data (6h steps); range clamped at 365 days
7. Hover over chart → tooltip shows timestamp + temperature
8. Three threshold lines visible: "Varning 70°C", "Smartd 75°C", "Kritiskt 80°C"
9. Click "Upptäck sensorer" → list of PCP metric names appears

### 6. Rotation & budget

```bash
# Check archive size stays within budget after several days/weeks
du -sh /var/log/pcp/pmlogger/$(hostname)/

# Simulate budget enforcement
sudo bash /etc/cron.daily/pcp-archive-budget
```

### 7. Survives reboot

```bash
sudo reboot
# After reboot:
systemctl is-active pmcd pmlogger cockpit.socket
# Expected: all "active"
```

---

## Troubleshooting

### Plugin doesn't appear in Cockpit menu

```bash
ls -la /usr/share/cockpit/cockpit-temps/
# Verify manifest.json exists and is readable
cat /usr/share/cockpit/cockpit-temps/manifest.json
# Restart cockpit
sudo systemctl restart cockpit.socket
```

### "Inga datapunkter hittades" in the UI

1. Check PCP is running: `systemctl status pmcd pmlogger`
2. Check archives exist: `ls /var/log/pcp/pmlogger/$(hostname)/`
3. Check metrics: `pminfo -f lmsensors | head -20`
4. Try fetching manually:
   ```bash
   pmrep -a /var/log/pcp/pmlogger/$(hostname)/ -o csv -H -t 60sec \
     -S "-1hour" lmsensors.coretemp_isa_0000.temp1_input
   ```
5. If no output, wait a few minutes for pmlogger to accumulate data

### pminfo shows no lmsensors metrics

```bash
# Reinstall the PMDA
cd /var/lib/pcp/pmdas/lmsensors
sudo ./Remove
sudo ./Install
sudo systemctl restart pmcd
pminfo lmsensors
```

### Metric names don't match config

Use the "Upptäck sensorer" button or run:
```bash
pminfo -t lmsensors
```
Then update `cockpit-temps/config/sensors.json` with the correct metric names
and re-run `sudo bash scripts/install_plugin.sh`.

### Archive disk usage growing too large

```bash
# Check current size
du -sh /var/log/pcp/pmlogger/$(hostname)/

# Run budget script manually
sudo bash /etc/cron.daily/pcp-archive-budget

# Reduce retention
sudo sed -i 's/-k [0-9]*/-k 90/' /etc/default/pmlogger
sudo systemctl restart pmlogger
```

---

## Uninstall

```bash
# Remove plugin only
sudo bash scripts/uninstall_plugin.sh

# Remove plugin + PCP config (archives preserved)
sudo bash scripts/uninstall_plugin.sh --purge
```

---

## License

MIT
