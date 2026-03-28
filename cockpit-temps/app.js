/*
 * Cockpit Temperature Plugin — app.js
 *
 * Pure-JS Cockpit plugin that reads PCP lmsensors archive data via pmrep,
 * renders an interactive SVG line chart with threshold lines, and provides
 * sensor selection and date-range controls.
 *
 * No external libraries — uses Cockpit JS API + inline SVG rendering.
 */
(function () {
    "use strict";

    /* ======================================================================
       Constants
       ====================================================================== */

    var MAX_RANGE_MS = 365 * 24 * 3600 * 1000; // 365 days

    var SERIES_COLORS = [
        "#1976D2", "#388E3C", "#F57C00", "#7B1FA2",
        "#C62828", "#00838F", "#4E342E", "#283593",
        "#D81B60", "#00695C", "#BF360C", "#1565C0"
    ];

    /* Step rules: [max range in ms, step in seconds] */
    var STEP_RULES = [
        [      86400000,    60],  // <=24h  -> 1 min
        [     604800000,   300],  // <=7d   -> 5 min
        [    2592000000,   900],  // <=30d  -> 15 min
        [    7776000000,  3600],  // <=90d  -> 1 h
        [  MAX_RANGE_MS, 21600]   // <=365d -> 6 h
    ];

    /* SVG namespace */
    var SVG_NS = "http://www.w3.org/2000/svg";

    /* ======================================================================
       State
       ====================================================================== */

    var config = null;          // loaded from sensors.json
    var archiveDir = "";        // resolved PCP archive directory
    var selectedSensors = {};   // id -> true
    var colorMap = {};          // sensor id -> color string
    var startTime = null;       // Date
    var endTime = null;         // Date

    /* ======================================================================
       Initialization
       ====================================================================== */

    document.addEventListener("DOMContentLoaded", function () {
        cockpit.transport.wait(function () {
            init();
        });
    });

    function init() {
        loadConfig()
            .then(function () { return resolveArchiveDir(); })
            .then(function () {
                renderSensorPanel();
                initDateControls();
                wireEvents();
                setStatus("Redo. Välj sensorer och tidsintervall.");
            })
            .catch(function (err) {
                showMessage("Kunde inte initialisera plugin: " + err, "error");
            });
    }

    /* ======================================================================
       Config loading
       ====================================================================== */

    function loadConfig() {
        return new Promise(function (resolve, reject) {
            /* Fetch sensors.json relative to the plugin directory */
            var url = "config/sensors.json";
            fetch(url)
                .then(function (resp) {
                    if (!resp.ok) throw new Error("HTTP " + resp.status);
                    return resp.json();
                })
                .then(function (data) {
                    config = data;
                    /* Assign colors to all sensors */
                    var ci = 0;
                    config.groups.forEach(function (g) {
                        g.sensors.forEach(function (s) {
                            colorMap[s.id] = SERIES_COLORS[ci % SERIES_COLORS.length];
                            ci++;
                        });
                    });
                    resolve();
                })
                .catch(reject);
        });
    }

    /* ======================================================================
       PCP archive directory discovery
       ====================================================================== */

    function resolveArchiveDir() {
        return new Promise(function (resolve, reject) {
            var base = (config && config.archiveBase) || "/var/log/pcp/pmlogger";
            cockpit.spawn(["hostname"], { err: "message" })
                .then(function (hostname) {
                    archiveDir = base + "/" + hostname.trim();
                    /* Verify directory exists */
                    cockpit.spawn(["test", "-d", archiveDir], { err: "message" })
                        .then(function () { resolve(); })
                        .catch(function () {
                            /* Try listing first subdir under base */
                            cockpit.spawn(["bash", "-c",
                                "ls -1d " + base + "/*/ 2>/dev/null | head -1"],
                                { err: "message" })
                                .then(function (out) {
                                    var dir = out.trim();
                                    if (dir) {
                                        archiveDir = dir.replace(/\/+$/, "");
                                        resolve();
                                    } else {
                                        archiveDir = base;
                                        resolve(); // may fail later, but proceed
                                    }
                                })
                                .catch(function () { archiveDir = base; resolve(); });
                        });
                })
                .catch(function () { archiveDir = base; resolve(); });
        });
    }

    /* Verify that PCP archives exist in archiveDir and return the directory
       path. pmrep accepts a directory as the -a argument and automatically
       merges all archives it contains, respecting -S/-T time filters. This
       allows queries to span multiple archive files (e.g. across daily
       rotations or after a service restart). */
    function resolveLatestArchive() {
        return new Promise(function (resolve, reject) {
            cockpit.spawn(["bash", "-c",
                "ls -1t " + archiveDir + "/*.meta 2>/dev/null | head -1"],
                { err: "message" })
                .then(function (output) {
                    if (output.trim()) {
                        /* Return the latest uncompressed archive base path
                           (strip .meta) so pmrep targets only the current
                           archive and avoids broken rotated .meta.xz files. */
                        resolve(output.trim().replace(/\.meta$/, ""));
                    } else {
                        reject("Inga arkivfiler (.meta) hittades i " + archiveDir);
                    }
                })
                .catch(function (err) {
                    reject("Kunde inte söka arkivfiler: " + err);
                });
        });
    }

    /* ======================================================================
       Sensor panel rendering
       ====================================================================== */

    function renderSensorPanel() {
        var container = document.getElementById("sensor-groups");
        container.innerHTML = "";

        config.groups.forEach(function (group) {
            var div = document.createElement("div");
            div.className = "sensor-group";

            /* Group header with toggle-all checkbox */
            var header = document.createElement("div");
            header.className = "sensor-group-header";
            var groupCb = document.createElement("input");
            groupCb.type = "checkbox";
            groupCb.id = "grp-" + group.id;
            groupCb.addEventListener("change", function () {
                group.sensors.forEach(function (s) {
                    selectedSensors[s.id] = groupCb.checked;
                    var el = document.getElementById("cb-" + s.id);
                    if (el) el.checked = groupCb.checked;
                });
            });
            header.appendChild(groupCb);
            var headerLabel = document.createElement("label");
            headerLabel.setAttribute("for", "grp-" + group.id);
            headerLabel.textContent = group.label;
            header.appendChild(headerLabel);
            div.appendChild(header);

            /* Individual sensors */
            group.sensors.forEach(function (sensor) {
                var item = document.createElement("div");
                item.className = "sensor-item";

                var dot = document.createElement("span");
                dot.className = "sensor-color-dot";
                dot.style.background = colorMap[sensor.id];
                item.appendChild(dot);

                var cb = document.createElement("input");
                cb.type = "checkbox";
                cb.id = "cb-" + sensor.id;
                /* Pre-select sensors marked as default */
                if (sensor["default"]) {
                    cb.checked = true;
                    selectedSensors[sensor.id] = true;
                }
                cb.addEventListener("change", function () {
                    selectedSensors[sensor.id] = cb.checked;
                    /* Update group checkbox */
                    var allChecked = group.sensors.every(function (s) {
                        return selectedSensors[s.id];
                    });
                    groupCb.checked = allChecked;
                    groupCb.indeterminate = !allChecked && group.sensors.some(function (s) {
                        return selectedSensors[s.id];
                    });
                });
                item.appendChild(cb);

                var lbl = document.createElement("label");
                lbl.setAttribute("for", "cb-" + sensor.id);
                lbl.textContent = sensor.label;
                item.appendChild(lbl);

                div.appendChild(item);
            });

            /* Sync group checkbox with default selections */
            var allChecked = group.sensors.every(function (s) {
                return selectedSensors[s.id];
            });
            var someChecked = group.sensors.some(function (s) {
                return selectedSensors[s.id];
            });
            groupCb.checked = allChecked;
            groupCb.indeterminate = !allChecked && someChecked;

            container.appendChild(div);
        });
    }

    /* ======================================================================
       Date range controls
       ====================================================================== */

    function initDateControls() {
        /* Default: last 7 days */
        endTime = new Date();
        startTime = new Date(endTime.getTime() - 7 * 24 * 3600 * 1000);
        syncDateInputs();
    }

    function syncDateInputs() {
        document.getElementById("input-start").value = toLocalISO(startTime);
        document.getElementById("input-end").value = toLocalISO(endTime);
    }

    function readDateInputs() {
        var s = document.getElementById("input-start").value;
        var e = document.getElementById("input-end").value;
        if (s) startTime = new Date(s);
        if (e) endTime = new Date(e);
    }

    function applyPreset(durationMs) {
        endTime = new Date();
        startTime = new Date(endTime.getTime() - durationMs);
        clampRange();
        syncDateInputs();
        /* Update active button */
        document.querySelectorAll(".btn-preset").forEach(function (btn) {
            btn.classList.toggle("active",
                parseInt(btn.getAttribute("data-duration"), 10) === durationMs);
        });
    }

    function clampRange() {
        var rangeMs = endTime.getTime() - startTime.getTime();
        var warning = document.getElementById("range-warning");
        if (rangeMs > MAX_RANGE_MS) {
            startTime = new Date(endTime.getTime() - MAX_RANGE_MS);
            warning.textContent = "Maximalt intervall är 365 dagar. Startdatum justerades automatiskt.";
            warning.classList.remove("hidden");
        } else if (rangeMs <= 0) {
            endTime = new Date();
            startTime = new Date(endTime.getTime() - 86400000);
            warning.textContent = "Ogiltigt intervall. Återställt till senaste 24 timmar.";
            warning.classList.remove("hidden");
        } else {
            warning.classList.add("hidden");
        }
    }

    /* ======================================================================
       Event wiring
       ====================================================================== */

    function wireEvents() {
        /* Preset buttons */
        document.querySelectorAll(".btn-preset").forEach(function (btn) {
            btn.addEventListener("click", function () {
                applyPreset(parseInt(btn.getAttribute("data-duration"), 10));
            });
        });

        /* Fetch button */
        document.getElementById("btn-fetch").addEventListener("click", function () {
            readDateInputs();
            clampRange();
            syncDateInputs();
            fetchAndRender();
        });

        /* Date input changes — clear preset highlight */
        ["input-start", "input-end"].forEach(function (id) {
            document.getElementById(id).addEventListener("change", function () {
                document.querySelectorAll(".btn-preset").forEach(function (b) {
                    b.classList.remove("active");
                });
            });
        });

        /* Discover button */
        document.getElementById("btn-discover").addEventListener("click", discoverMetrics);

        /* Resize handler for chart */
        window.addEventListener("resize", debounce(function () {
            if (window._lastChartData) {
                renderChart(window._lastChartData.series, window._lastChartData.thresholds);
            }
        }, 300));
    }

    /* ======================================================================
       Data fetching via pmrep
       ====================================================================== */

    function fetchAndRender() {
        /* Collect selected sensor metrics */
        var sensors = getSelectedSensors();
        if (sensors.length === 0) {
            showMessage("Välj minst en sensor i panelen till vänster.", "info");
            return;
        }

        var rangeMs = endTime.getTime() - startTime.getTime();
        var stepSec = getStepForRange(rangeMs);
        var metrics = sensors.map(function (s) { return s.metric; });

        showMessage('<span class="spinner"></span> Hämtar data (' +
            sensors.length + " sensorer, steg " + humanStep(stepSec) + ")&hellip;", "loading");

        setStatus("Hämtar data\u2026");
        document.getElementById("btn-fetch").disabled = true;

        /* Verify archives exist, then query the whole archive directory with
           pmrep so data from all archive files (daily rotations, restarts)
           is included in the result. */
        resolveLatestArchive()
            .then(function (archivePath) {
                var args = [
                    "pmrep",
                    "-a", archivePath,
                    "-o", "csv",
                    "-r",
                    "-t", stepSec + "sec",
                    "-S", "@" + formatPcpTime(startTime),
                    "-T", "@" + formatPcpTime(endTime)
                ].concat(metrics);

                return cockpit.spawn(args, { err: "message", superuser: "try" });
            })
            .then(function (output) {
                document.getElementById("btn-fetch").disabled = false;
                var parsed = parsePmrepCSV(output, sensors);
                if (parsed.series.length === 0 || parsed.totalPoints === 0) {
                    showMessage("Inga datapunkter hittades för valt intervall. " +
                        "Kontrollera att PCP-arkiv finns och att pmdalmsensors är aktiverad.", "info");
                    setStatus("Inga data.");
                    return;
                }
                hideMessage();
                var thresholds = gatherThresholds(sensors);
                window._lastChartData = { series: parsed.series, thresholds: thresholds };
                renderChart(parsed.series, thresholds);
                setStatus(parsed.totalPoints + " datapunkter laddade.");
            })
            .catch(function (err) {
                document.getElementById("btn-fetch").disabled = false;
                var detail = (err && err.message) ? err.message : String(err);
                showMessage("Fel vid datahämtning: " + escapeHtml(detail) +
                    "<br><br>Tips: Kontrollera att PCP är igång (<code>systemctl status pmcd pmlogger</code>) " +
                    "och att arkiv finns i <code>" + escapeHtml(archiveDir) + "</code>.", "error");
                setStatus("Fel vid datahämtning.");
            });
    }

    function getSelectedSensors() {
        var result = [];
        config.groups.forEach(function (g) {
            g.sensors.forEach(function (s) {
                if (selectedSensors[s.id]) result.push(s);
            });
        });
        return result;
    }

    function getStepForRange(rangeMs) {
        for (var i = 0; i < STEP_RULES.length; i++) {
            if (rangeMs <= STEP_RULES[i][0]) return STEP_RULES[i][1];
        }
        return STEP_RULES[STEP_RULES.length - 1][1];
    }

    function parsePmrepCSV(csv, sensors) {
        var lines = csv.trim().split("\n");
        if (lines.length < 2) return { series: [], totalPoints: 0 };

        /* First line: header with metric names */
        var headerLine = lines[0];
        var headers = parseCSVLine(headerLine);

        /* Detect and skip optional unit row (second line starting with a non-digit after Time) */
        var dataStartIdx = 1;
        if (lines.length > 2) {
            var secondFields = parseCSVLine(lines[1]);
            /* If second row's first field doesn't look like a timestamp, skip it */
            if (secondFields[0] && !/^\d{4}/.test(secondFields[0].trim())) {
                dataStartIdx = 2;
            }
        }

        /* Build metric-name to sensor index mapping */
        var colToSensor = {};
        for (var col = 1; col < headers.length; col++) {
            var hdr = headers[col].replace(/^"|"$/g, "").trim();
            for (var si = 0; si < sensors.length; si++) {
                if (hdr === sensors[si].metric || hdr.indexOf(sensors[si].metric) !== -1) {
                    colToSensor[col] = si;
                    break;
                }
            }
        }

        /* Initialize series */
        var seriesMap = {};
        sensors.forEach(function (s) {
            seriesMap[s.id] = {
                id: s.id,
                label: s.label,
                color: colorMap[s.id],
                points: []
            };
        });

        /* Parse data rows */
        var totalPoints = 0;
        for (var r = dataStartIdx; r < lines.length; r++) {
            var fields = parseCSVLine(lines[r]);
            if (fields.length < 2) continue;
            var ts = parseTimestamp(fields[0]);
            if (!ts) continue;

            for (var c = 1; c < fields.length; c++) {
                var sIdx = colToSensor[c];
                if (sIdx === undefined) continue;
                var val = parseFloat(fields[c]);
                if (isNaN(val) || fields[c].trim() === "?" || fields[c].trim() === "") {
                    /* Gap — push null marker so the chart breaks the line */
                    seriesMap[sensors[sIdx].id].points.push({ time: ts, value: null });
                } else {
                    /* PCP lmsensors may report in millidegrees; normalise */
                    if (val > 1000) val = val / 1000;
                    seriesMap[sensors[sIdx].id].points.push({ time: ts, value: val });
                    totalPoints++;
                }
            }
        }

        var series = sensors.map(function (s) { return seriesMap[s.id]; })
            .filter(function (s) { return s.points.length > 0; });

        return { series: series, totalPoints: totalPoints };
    }

    /* Minimal CSV line parser (handles quoted fields) */
    function parseCSVLine(line) {
        var result = [];
        var current = "";
        var inQuotes = false;
        for (var i = 0; i < line.length; i++) {
            var ch = line[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (i + 1 < line.length && line[i + 1] === '"') {
                        current += '"';
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    current += ch;
                }
            } else {
                if (ch === '"') {
                    inQuotes = true;
                } else if (ch === ",") {
                    result.push(current);
                    current = "";
                } else {
                    current += ch;
                }
            }
        }
        result.push(current);
        return result;
    }

    function parseTimestamp(str) {
        var s = str.replace(/^"|"$/g, "").trim();
        /* Expected format: "YYYY-MM-DD HH:MM:SS" */
        var d = new Date(s.replace(" ", "T"));
        return isNaN(d.getTime()) ? null : d;
    }

    /* ======================================================================
       Threshold collection
       ====================================================================== */

    function gatherThresholds(sensors) {
        var thresholds = [];
        /* Global thresholds */
        if (config.thresholds && config.thresholds.global) {
            config.thresholds.global.forEach(function (t) {
                thresholds.push({
                    value: t.value,
                    label: t.label,
                    color: t.color,
                    style: t.style || "dashed"
                });
            });
        }
        /* Per-sensor thresholds */
        sensors.forEach(function (s) {
            if (s.thresholds && s.thresholds.length) {
                s.thresholds.forEach(function (t) {
                    /* Avoid duplicates by value+label */
                    var exists = thresholds.some(function (et) {
                        return et.value === t.value && et.label === t.label;
                    });
                    if (!exists) {
                        thresholds.push({
                            value: t.value,
                            label: t.label,
                            color: t.color || "#FF7043",
                            style: t.style || "dashed"
                        });
                    }
                });
            }
        });
        return thresholds;
    }

    /* ======================================================================
       SVG Chart Rendering
       ====================================================================== */

    function renderChart(series, thresholds) {
        var container = document.getElementById("chart-area");
        var placeholder = document.getElementById("chart-placeholder");
        placeholder.classList.add("hidden");
        container.classList.remove("hidden");
        container.innerHTML = "";

        /* Hide tooltip */
        document.getElementById("chart-tooltip").classList.add("hidden");

        /* Estimate legend height: one row per ~3 series, 20px per row + padding */
        var legendRows = Math.ceil(series.length / 3);
        var legendHeight = legendRows * 22 + 12;

        /* Dimensions — legend below chart, minimal right margin */
        var totalWidth = container.clientWidth - 16;
        var totalHeight = Math.max(400, Math.min(550, container.clientHeight - 16));
        var margin = { top: 24, right: 20, bottom: 55 + legendHeight, left: 62 };
        var plotW = totalWidth - margin.left - margin.right;
        var plotH = totalHeight - margin.top - margin.bottom;

        if (plotW < 100 || plotH < 80) return;

        /* Calculate data extents (thresholds do NOT affect y-scale) */
        var xMin = Infinity, xMax = -Infinity;
        var dataYMin = Infinity, dataYMax = -Infinity;

        series.forEach(function (s) {
            s.points.forEach(function (p) {
                if (p.value === null) return;
                var t = p.time.getTime();
                if (t < xMin) xMin = t;
                if (t > xMax) xMax = t;
                if (p.value < dataYMin) dataYMin = p.value;
                if (p.value > dataYMax) dataYMax = p.value;
            });
        });

        /* Y-scale: 5°C padding, rounded to nearest 5°C step */
        var yMin = Math.floor(dataYMin / 5) * 5 - 5;
        var yMax = Math.ceil(dataYMax / 5) * 5 + 5;
        if (yMin < 0) yMin = 0;

        if (xMin >= xMax) { xMin = startTime.getTime(); xMax = endTime.getTime(); }

        /* Scale functions */
        function xScale(t) { return margin.left + (t - xMin) / (xMax - xMin) * plotW; }
        function yScale(v) { return margin.top + plotH - (v - yMin) / (yMax - yMin) * plotH; }

        /* Create SVG */
        var svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("width", totalWidth);
        svg.setAttribute("height", totalHeight);
        svg.setAttribute("viewBox", "0 0 " + totalWidth + " " + totalHeight);

        /* Clip path for plot area */
        var defs = svgEl("defs");
        var clipPath = svgEl("clipPath", { id: "plot-clip" });
        clipPath.appendChild(svgEl("rect", {
            x: margin.left, y: margin.top,
            width: plotW, height: plotH
        }));
        defs.appendChild(clipPath);
        svg.appendChild(defs);

        /* Grid */
        var gridGroup = svgEl("g", { "class": "chart-grid" });
        /* Horizontal grid lines (y ticks) — fixed 5°C steps */
        var yTicks = [];
        for (var yt = yMin; yt <= yMax; yt += 5) {
            yTicks.push(yt);
        }
        yTicks.forEach(function (v) {
            gridGroup.appendChild(svgEl("line", {
                x1: margin.left, x2: margin.left + plotW,
                y1: yScale(v), y2: yScale(v)
            }));
        });
        /* Vertical grid lines (x ticks) */
        var xTicks = niceTicksTime(xMin, xMax, Math.min(10, Math.floor(plotW / 80)));
        xTicks.forEach(function (t) {
            gridGroup.appendChild(svgEl("line", {
                x1: xScale(t), x2: xScale(t),
                y1: margin.top, y2: margin.top + plotH
            }));
        });
        svg.appendChild(gridGroup);

        /* Threshold lines — draw lines first, then place labels with
           collision avoidance so overlapping temperatures don't produce
           unreadable stacked text. */
        var threshGroup = svgEl("g");
        var threshLabelPositions = [];
        var MIN_LABEL_GAP = 14; /* minimum px between label baselines */

        /* Sort thresholds by value descending so highest label is placed first */
        var sortedThresh = thresholds.slice().sort(function (a, b) { return b.value - a.value; });

        sortedThresh.forEach(function (th) {
            if (th.value < yMin || th.value > yMax) return;
            var y = yScale(th.value);
            var dasharray = th.style === "dashed" ? "6,4" : th.style === "dotted" ? "2,3" : "none";
            threshGroup.appendChild(svgEl("line", {
                x1: margin.left, x2: margin.left + plotW,
                y1: y, y2: y,
                stroke: th.color, "stroke-width": 1.5,
                "stroke-dasharray": dasharray,
                "class": "chart-threshold"
            }));

            /* Choose label y: nudge down if too close to an already-placed label */
            var labelY = y - 4;
            for (var li = 0; li < threshLabelPositions.length; li++) {
                if (Math.abs(labelY - threshLabelPositions[li]) < MIN_LABEL_GAP) {
                    labelY = threshLabelPositions[li] + MIN_LABEL_GAP;
                }
            }
            threshLabelPositions.push(labelY);

            var label = svgEl("text", {
                x: margin.left + 6,
                y: labelY,
                fill: th.color,
                "text-anchor": "start",
                "class": "chart-threshold-label"
            });
            label.textContent = th.label;
            threshGroup.appendChild(label);
        });
        svg.appendChild(threshGroup);

        /* Data lines (clipped) */
        var dataGroup = svgEl("g", { "clip-path": "url(#plot-clip)" });
        series.forEach(function (s) {
            var pathD = buildLinePath(s.points, xScale, yScale);
            if (pathD) {
                dataGroup.appendChild(svgEl("path", {
                    d: pathD, stroke: s.color,
                    "class": "chart-line"
                }));
            }
        });
        svg.appendChild(dataGroup);

        /* Y axis */
        var yAxisGroup = svgEl("g", { "class": "chart-axis" });
        yAxisGroup.appendChild(svgEl("line", {
            x1: margin.left, x2: margin.left,
            y1: margin.top, y2: margin.top + plotH
        }));
        yTicks.forEach(function (v) {
            var y = yScale(v);
            yAxisGroup.appendChild(svgEl("line", {
                x1: margin.left - 4, x2: margin.left,
                y1: y, y2: y
            }));
            var txt = svgEl("text", {
                x: margin.left - 8, y: y + 4,
                "text-anchor": "end", "class": "chart-axis"
            });
            txt.textContent = v + "\u00b0";
            yAxisGroup.appendChild(txt);
        });
        /* Y axis label */
        var yLabel = svgEl("text", {
            x: 14, y: margin.top + plotH / 2,
            "class": "chart-axis-label",
            "text-anchor": "middle",
            transform: "rotate(-90, 14, " + (margin.top + plotH / 2) + ")"
        });
        yLabel.textContent = "Temperatur (\u00b0C)";
        yAxisGroup.appendChild(yLabel);
        svg.appendChild(yAxisGroup);

        /* X axis */
        var xAxisGroup = svgEl("g", { "class": "chart-axis" });
        xAxisGroup.appendChild(svgEl("line", {
            x1: margin.left, x2: margin.left + plotW,
            y1: margin.top + plotH, y2: margin.top + plotH
        }));
        xTicks.forEach(function (t) {
            var x = xScale(t);
            xAxisGroup.appendChild(svgEl("line", {
                x1: x, x2: x,
                y1: margin.top + plotH, y2: margin.top + plotH + 4
            }));
            var txt = svgEl("text", {
                x: x, y: margin.top + plotH + 18,
                "text-anchor": "middle", "class": "chart-axis"
            });
            txt.textContent = formatXTick(t, xMax - xMin);
            xAxisGroup.appendChild(txt);
            /* Second line for date if range > 24h */
            if ((xMax - xMin) > 86400000) {
                var txt2 = svgEl("text", {
                    x: x, y: margin.top + plotH + 30,
                    "text-anchor": "middle", "class": "chart-axis"
                });
                txt2.textContent = formatXTickDate(t);
                xAxisGroup.appendChild(txt2);
            }
        });
        svg.appendChild(xAxisGroup);

        /* Legend (below chart, horizontal wrap) */
        var legendGroup = svgEl("g");
        var legendBaseY = margin.top + plotH + 42;
        var legendX = margin.left;
        var legendItemX = legendX;
        var legendItemY = legendBaseY;
        var legendColWidth = Math.max(180, Math.floor(plotW / 3));

        series.forEach(function (s, i) {
            /* Wrap to next row if we'd exceed plot width */
            if (i > 0 && legendItemX + legendColWidth > margin.left + plotW + 10) {
                legendItemX = legendX;
                legendItemY += 22;
            }
            legendGroup.appendChild(svgEl("rect", {
                x: legendItemX, y: legendItemY - 6,
                width: 12, height: 12, rx: 2,
                fill: s.color
            }));
            var ltxt = svgEl("text", {
                x: legendItemX + 18, y: legendItemY + 4,
                "class": "chart-legend-item"
            });
            ltxt.textContent = s.label;
            legendGroup.appendChild(ltxt);
            legendItemX += legendColWidth;
        });
        svg.appendChild(legendGroup);

        /* Hover dots (one per series, initially hidden) */
        var hoverDots = [];
        series.forEach(function (s) {
            var dot = svgEl("circle", {
                r: 4, fill: s.color,
                "class": "chart-hover-dot",
                display: "none"
            });
            svg.appendChild(dot);
            hoverDots.push(dot);
        });

        /* Crosshair */
        var crosshair = svgEl("line", {
            y1: margin.top, y2: margin.top + plotH,
            "class": "chart-crosshair", display: "none"
        });
        svg.appendChild(crosshair);

        /* Transparent overlay for mouse events */
        var overlay = svgEl("rect", {
            x: margin.left, y: margin.top,
            width: plotW, height: plotH,
            "class": "chart-overlay"
        });

        var tooltipEl = document.getElementById("chart-tooltip");

        overlay.addEventListener("mousemove", function (e) {
            var rect = svg.getBoundingClientRect();
            var mouseX = e.clientX - rect.left;
            var mouseY = e.clientY - rect.top;
            var timeAtMouse = xMin + (mouseX - margin.left) / plotW * (xMax - xMin);

            crosshair.setAttribute("x1", mouseX);
            crosshair.setAttribute("x2", mouseX);
            crosshair.setAttribute("display", "");

            /* Build tooltip content */
            var html = '<div class="tt-time">' + formatTooltipTime(new Date(timeAtMouse)) + "</div>";
            var anyVisible = false;

            series.forEach(function (s, idx) {
                var nearest = findNearest(s.points, timeAtMouse);
                if (nearest && nearest.value !== null) {
                    anyVisible = true;
                    var px = xScale(nearest.time.getTime());
                    var py = yScale(nearest.value);
                    hoverDots[idx].setAttribute("cx", px);
                    hoverDots[idx].setAttribute("cy", py);
                    hoverDots[idx].setAttribute("display", "");
                    html += '<div class="tt-row">' +
                        '<span class="tt-dot" style="background:' + s.color + '"></span>' +
                        '<span>' + escapeHtml(s.label) + '</span>' +
                        '<span class="tt-val">' + nearest.value.toFixed(1) + "\u00b0C</span></div>";
                } else {
                    hoverDots[idx].setAttribute("display", "none");
                }
            });

            if (anyVisible) {
                tooltipEl.innerHTML = html;
                tooltipEl.classList.remove("hidden");
                /* Position tooltip */
                var cRect = document.getElementById("chart-container").getBoundingClientRect();
                var ttLeft = e.clientX - cRect.left + 16;
                var ttTop = e.clientY - cRect.top - 10;
                /* Avoid overflow right */
                if (ttLeft + tooltipEl.offsetWidth > cRect.width - 10) {
                    ttLeft = e.clientX - cRect.left - tooltipEl.offsetWidth - 16;
                }
                tooltipEl.style.left = ttLeft + "px";
                tooltipEl.style.top = ttTop + "px";
            } else {
                tooltipEl.classList.add("hidden");
            }
        });

        overlay.addEventListener("mouseout", function () {
            crosshair.setAttribute("display", "none");
            hoverDots.forEach(function (d) { d.setAttribute("display", "none"); });
            tooltipEl.classList.add("hidden");
        });

        svg.appendChild(overlay);
        container.appendChild(svg);
    }

    /* Build SVG path string, breaking at null values (gaps) */
    function buildLinePath(points, xScale, yScale) {
        var parts = [];
        var segment = [];
        points.forEach(function (p) {
            if (p.value === null) {
                if (segment.length > 0) { parts.push(segment); segment = []; }
            } else {
                segment.push(xScale(p.time.getTime()) + "," + yScale(p.value));
            }
        });
        if (segment.length > 0) parts.push(segment);

        return parts.map(function (seg) {
            return "M" + seg[0] + " L" + seg.slice(1).join(" L");
        }).join(" ");
    }

    /* Find the data point nearest to a given timestamp */
    function findNearest(points, timeMs) {
        var best = null, bestDist = Infinity;
        for (var i = 0; i < points.length; i++) {
            var d = Math.abs(points[i].time.getTime() - timeMs);
            if (d < bestDist) { bestDist = d; best = points[i]; }
        }
        /* Only return if within reasonable distance (5% of range) */
        var range = endTime.getTime() - startTime.getTime();
        if (bestDist > range * 0.05) return null;
        return best;
    }

    /* ======================================================================
       SVG helpers
       ====================================================================== */

    function svgEl(tag, attrs) {
        var el = document.createElementNS(SVG_NS, tag);
        if (attrs) {
            Object.keys(attrs).forEach(function (k) {
                el.setAttribute(k, attrs[k]);
            });
        }
        return el;
    }

    /* Nice tick values for a linear scale */
    function niceTicksLinear(min, max, count) {
        var range = max - min;
        if (range <= 0) return [min];
        var rough = range / count;
        var mag = Math.pow(10, Math.floor(Math.log10(rough)));
        var residual = rough / mag;
        var step;
        if (residual <= 1.5) step = 1 * mag;
        else if (residual <= 3) step = 2 * mag;
        else if (residual <= 7) step = 5 * mag;
        else step = 10 * mag;

        var ticks = [];
        var v = Math.ceil(min / step) * step;
        while (v <= max) {
            ticks.push(Math.round(v * 100) / 100);
            v += step;
        }
        return ticks;
    }

    /* Nice tick positions for a time scale */
    function niceTicksTime(minMs, maxMs, count) {
        var range = maxMs - minMs;
        var steps = [
            60000, 300000, 600000, 1800000, 3600000,        // min, 5min, 10min, 30min, 1h
            7200000, 21600000, 43200000, 86400000,           // 2h, 6h, 12h, 1d
            172800000, 604800000, 2592000000, 7776000000     // 2d, 7d, 30d, 90d
        ];
        var step = steps[steps.length - 1];
        for (var i = 0; i < steps.length; i++) {
            if (range / steps[i] <= count * 1.5) { step = steps[i]; break; }
        }
        var ticks = [];
        var v = Math.ceil(minMs / step) * step;
        while (v <= maxMs) {
            ticks.push(v);
            v += step;
        }
        return ticks;
    }

    /* ======================================================================
       Metric discovery
       ====================================================================== */

    function discoverMetrics() {
        var resultsDiv = document.getElementById("discovery-results");
        resultsDiv.classList.remove("hidden");
        resultsDiv.innerHTML = '<span class="spinner"></span> Söker efter lmsensors-mått\u2026';

        cockpit.spawn(["pminfo", "-t", "lmsensors"], { err: "message", superuser: "try" })
            .then(function (output) {
                var lines = output.trim().split("\n");
                if (lines.length === 0 || (lines.length === 1 && !lines[0].trim())) {
                    resultsDiv.innerHTML = "<em>Inga lmsensors-mått hittades. " +
                        "Kör <code>scripts/setup_pcp_temps.sh</code> för att installera och aktivera pmdalmsensors.</em>";
                    return;
                }
                var html = "<strong>Tillgängliga mått (" + lines.length + "):</strong><pre>";
                lines.forEach(function (l) {
                    html += escapeHtml(l) + "\n";
                });
                html += "</pre><p style='margin-top:8px;font-style:italic'>" +
                    "Redigera <code>config/sensors.json</code> och uppdatera <code>metric</code>-fälten " +
                    "med rätt mått-namn ovan.</p>";
                resultsDiv.innerHTML = html;
            })
            .catch(function (err) {
                resultsDiv.innerHTML = "<em>Kunde inte köra pminfo: " + escapeHtml(String(err)) + "</em>" +
                    "<br>Kontrollera att PCP är installerat och pmcd är igång.";
            });
    }

    /* ======================================================================
       Formatting helpers
       ====================================================================== */

    function toLocalISO(d) {
        /* Return "YYYY-MM-DDTHH:MM" for datetime-local input */
        var pad = function (n) { return n < 10 ? "0" + n : String(n); };
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
            "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    function formatPcpTime(d) {
        var pad = function (n) { return n < 10 ? "0" + n : String(n); };
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
            " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    }

    function formatXTick(timeMs, rangeMs) {
        var d = new Date(timeMs);
        var pad = function (n) { return n < 10 ? "0" + n : String(n); };
        return pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    function formatXTickDate(timeMs) {
        var d = new Date(timeMs);
        var months = ["jan", "feb", "mar", "apr", "maj", "jun",
            "jul", "aug", "sep", "okt", "nov", "dec"];
        return d.getDate() + " " + months[d.getMonth()];
    }

    function formatTooltipTime(d) {
        var pad = function (n) { return n < 10 ? "0" + n : String(n); };
        var months = ["jan", "feb", "mar", "apr", "maj", "jun",
            "jul", "aug", "sep", "okt", "nov", "dec"];
        return d.getDate() + " " + months[d.getMonth()] + " " + d.getFullYear() +
            " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    }

    function humanStep(sec) {
        if (sec < 60) return sec + "s";
        if (sec < 3600) return (sec / 60) + " min";
        return (sec / 3600) + " tim";
    }

    function truncate(str, len) {
        return str.length > len ? str.substring(0, len - 1) + "\u2026" : str;
    }

    function escapeHtml(s) {
        var div = document.createElement("div");
        div.appendChild(document.createTextNode(s));
        return div.innerHTML;
    }

    function debounce(fn, ms) {
        var timer;
        return function () {
            clearTimeout(timer);
            timer = setTimeout(fn, ms);
        };
    }

    /* ======================================================================
       UI messaging
       ====================================================================== */

    function showMessage(html, type) {
        var el = document.getElementById("messages");
        el.innerHTML = html;
        el.className = "msg-" + type;
        el.classList.remove("hidden");
    }

    function hideMessage() {
        document.getElementById("messages").classList.add("hidden");
    }

    function setStatus(text) {
        document.getElementById("status-bar").textContent = text;
    }
})();
