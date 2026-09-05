// Elephant Intrusion Detection System - Frontend Client Logic
// Triangular TDOA Mapping + Live Triaxial Geophone Waveform

let ws;
let canvas, ctx;
let stftCanvas, stftCtx;

const WAVEFORM_RATE_HZ = 200;
const WAVEFORM_HISTORY_SECONDS = 60;
const maxHistoryPoints = WAVEFORM_RATE_HZ * WAVEFORM_HISTORY_SECONDS;
const WAVEFORM_DISPLAY_SECONDS = 10;
const WAVEFORM_DISPLAY_POINTS = WAVEFORM_RATE_HZ * WAVEFORM_DISPLAY_SECONDS;

let currentStftNode = "NODE_01";
let currentStftIntrusion = false;
let waveformNode = "NODE_01";

let axisVisibility = {
    X: true,
    Y: true,
    Z: true
};

let triaxialHistory = {
    "NODE_01": { x: [], y: [], z: [] },
    "NODE_02": { x: [], y: [], z: [] },
    "NODE_03": { x: [], y: [], z: [] }
};

function createInitialHistory() {
    for (const nodeId of Object.keys(triaxialHistory)) {
        triaxialHistory[nodeId].x = new Array(maxHistoryPoints).fill(0);
        triaxialHistory[nodeId].y = new Array(maxHistoryPoints).fill(0);
        triaxialHistory[nodeId].z = new Array(maxHistoryPoints).fill(0);
    }
}

createInitialHistory();

document.addEventListener("DOMContentLoaded", () => {
    initCanvas();
    initWaveformNodeSelector();
    initWebSocket();
});

function initWaveformNodeSelector() {
    ["NODE_01", "NODE_02", "NODE_03"].forEach(nodeId => {
        const card = document.getElementById(`card_${nodeId}`);
        if (!card) return;

        card.style.cursor = "pointer";
        card.addEventListener("click", (event) => {
            if (event.target.closest("button")) return;
            selectWaveformNode(nodeId);
        });
    });
}

function selectWaveformNode(nodeId) {
    if (!triaxialHistory[nodeId]) return;

    waveformNode = nodeId;

    ["NODE_01", "NODE_02", "NODE_03"].forEach(id => {
        const card = document.getElementById(`card_${id}`);
        if (!card) return;
        card.classList.toggle("waveform-node-selected", id === nodeId);
    });
}

function toggleAxisButton(axis) {
    if (!Object.prototype.hasOwnProperty.call(axisVisibility, axis)) return;

    axisVisibility[axis] = !axisVisibility[axis];

    const button = document.getElementById(`axisBtn_${axis}`);
    if (button) {
        button.classList.toggle("active", axisVisibility[axis]);
    }

    if (!axisVisibility.X && !axisVisibility.Y && !axisVisibility.Z) {
        axisVisibility[axis] = true;
        if (button) button.classList.add("active");
    }
}

function initCanvas() {
    canvas = document.getElementById("vibrationCanvas");
    if (!canvas) return;

    ctx = canvas.getContext("2d");

    stftCanvas = document.getElementById("stftCanvas");
    if (stftCanvas) {
        stftCtx = stftCanvas.getContext("2d");
    }

    resizeWaveformCanvas();
    window.addEventListener("resize", resizeWaveformCanvas);
    requestAnimationFrame(renderWaveform);
}

function resizeWaveformCanvas() {
    if (!canvas || !ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const targetWidth = Math.floor(width * dpr);
    const targetHeight = Math.floor(height * dpr);

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function getVisibleData(data) {
    if (!Array.isArray(data)) return [];
    return data.length <= WAVEFORM_DISPLAY_POINTS
        ? data.slice()
        : data.slice(data.length - WAVEFORM_DISPLAY_POINTS);
}

function removeDisplayBaseline(data) {
    if (!Array.isArray(data) || data.length === 0) return [];

    let sum = 0;
    let count = 0;

    for (const value of data) {
        const n = Number(value);
        if (Number.isFinite(n)) {
            sum += n;
            count++;
        }
    }

    if (count === 0) return [];

    const mean = sum / count;

    return data.map(value => {
        const n = Number(value);
        return Number.isFinite(n) ? n - mean : 0;
    });
}

function getDisplayScale(seriesList) {
    let maxAbs = 0;

    for (const series of seriesList) {
        for (const value of series) {
            const n = Math.abs(Number(value));
            if (Number.isFinite(n)) maxAbs = Math.max(maxAbs, n);
        }
    }

    if (maxAbs < 1) return 1;
    if (maxAbs < 2) return 2;
    if (maxAbs < 5) return 5;
    if (maxAbs < 10) return 10;
    if (maxAbs < 20) return 20;
    return Math.ceil(maxAbs / 10) * 10;
}

function renderWaveform() {
    if (!canvas || !ctx) {
        requestAnimationFrame(renderWaveform);
        return;
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        requestAnimationFrame(renderWaveform);
        return;
    }

    resizeWaveformCanvas();

    const width = rect.width;
    const height = rect.height;
    const marginLeft = 58;
    const marginRight = 18;
    const marginTop = 18;
    const marginBottom = 38;

    const graphLeft = marginLeft;
    const graphRight = width - marginRight;
    const graphTop = marginTop;
    const graphBottom = height - marginBottom;
    const graphWidth = graphRight - graphLeft;
    const graphHeight = graphBottom - graphTop;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#10171B";
    ctx.fillRect(graphLeft, graphTop, graphWidth, graphHeight);

    const history = triaxialHistory[waveformNode];
    if (!history) {
        requestAnimationFrame(renderWaveform);
        return;
    }

    const xData = removeDisplayBaseline(getVisibleData(history.x));
    const yData = removeDisplayBaseline(getVisibleData(history.y));
    const zData = removeDisplayBaseline(getVisibleData(history.z));

    const visibleSeries = [];
    if (axisVisibility.X) visibleSeries.push(xData);
    if (axisVisibility.Y) visibleSeries.push(yData);
    if (axisVisibility.Z) visibleSeries.push(zData);

    const scale = getDisplayScale(visibleSeries);
    const yMin = -scale;
    const yMax = scale;

    // Grid
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";

    const horizontalTicks = 4;
    for (let i = 0; i <= horizontalTicks; i++) {
        const y = graphTop + (i / horizontalTicks) * graphHeight;
        ctx.beginPath();
        ctx.moveTo(graphLeft, y);
        ctx.lineTo(graphRight, y);
        ctx.stroke();
    }

    const verticalTicks = 5;
    for (let i = 0; i <= verticalTicks; i++) {
        const x = graphLeft + (i / verticalTicks) * graphWidth;
        ctx.beginPath();
        ctx.moveTo(x, graphTop);
        ctx.lineTo(x, graphBottom);
        ctx.stroke();
    }

    // Zero reference line
    const zeroY = graphBottom - ((0 - yMin) / (yMax - yMin)) * graphHeight;
    ctx.strokeStyle = "rgba(255,255,255,0.30)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(graphLeft, zeroY);
    ctx.lineTo(graphRight, zeroY);
    ctx.stroke();

    // Y-axis labels
    ctx.font = "12px Inter, Arial, sans-serif";
    ctx.fillStyle = "rgba(220,230,235,0.72)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let i = 0; i <= horizontalTicks; i++) {
        const value = yMax - (i / horizontalTicks) * (yMax - yMin);
        const y = graphTop + (i / horizontalTicks) * graphHeight;
        ctx.fillText(`${Number(value.toFixed(1))}`, graphLeft - 8, y);
    }

    // Unit label
    ctx.save();
    ctx.translate(15, graphTop + graphHeight / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "11px Inter, Arial, sans-serif";
    ctx.fillStyle = "rgba(220,230,235,0.60)";
    ctx.fillText("mm/s", 0, 0);
    ctx.restore();

    // Time labels
    ctx.font = "11px Inter, Arial, sans-serif";
    ctx.fillStyle = "rgba(220,230,235,0.60)";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const timeLabels = ["-10 s", "-7.5 s", "-5 s", "-2.5 s", "0 s"];
    for (let i = 0; i < timeLabels.length; i++) {
        const x = graphLeft + (i / (timeLabels.length - 1)) * graphWidth;
        ctx.fillText(timeLabels[i], x, graphBottom + 10);
    }

    function drawTrace(data, lineColor) {
        if (!Array.isArray(data) || data.length < 2) return;

        const displayCount = Math.min(
            data.length,
            Math.max(300, Math.floor(graphWidth * 1.5))
        );
        const stride = Math.max(1, Math.floor(data.length / displayCount));

        ctx.beginPath();
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 1.35;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";

        let started = false;

        for (let index = 0; index < data.length; index += stride) {
            let value = Number(data[index]);
            if (!Number.isFinite(value)) continue;

            value = Math.max(yMin, Math.min(yMax, value));

            const x = graphLeft + (index / (data.length - 1)) * graphWidth;
            const y = graphBottom - ((value - yMin) / (yMax - yMin)) * graphHeight;

            if (!started) {
                ctx.moveTo(x, y);
                started = true;
            } else {
                ctx.lineTo(x, y);
            }
        }

        const lastIndex = data.length - 1;
        if (lastIndex >= 0) {
            const lastValue = Number(data[lastIndex]);
            if (Number.isFinite(lastValue)) {
                const value = Math.max(yMin, Math.min(yMax, lastValue));
                const x = graphRight;
                const y = graphBottom - ((value - yMin) / (yMax - yMin)) * graphHeight;
                if (!started) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
        }

        if (started) ctx.stroke();
    }

    if (axisVisibility.X) drawTrace(xData, "#2F80ED");
    if (axisVisibility.Y) drawTrace(yData, "#F2994A");
    if (axisVisibility.Z) drawTrace(zData, "#10B981");

    // Top labels
    ctx.font = "11px Inter, Arial, sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(220,230,235,0.60)";
    ctx.fillText(
        `${waveformNode.replace("NODE_", "G")} • ${WAVEFORM_DISPLAY_SECONDS}s VIEW`,
        graphLeft + 8,
        graphTop + 5
    );

    ctx.textAlign = "right";
    ctx.fillStyle = "#10B981";
    ctx.fillText("● LIVE • 200 Hz", graphRight - 6, graphTop + 5);

    requestAnimationFrame(renderWaveform);
}

function initWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const wsBadge = document.getElementById("wsStatus");
    if (wsBadge) wsBadge.textContent = "Connecting...";

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        if (wsBadge) {
            wsBadge.textContent = "CONNECTED";
            wsBadge.style.color = "var(--color-emerald)";
        }
    };

    ws.onmessage = (event) => {
        try {
            handleServerMessage(JSON.parse(event.data));
        } catch (e) {
            console.error("Error parsing WebSocket packet:", e);
        }
    };

    ws.onclose = () => {
        if (wsBadge) {
            wsBadge.textContent = "DISCONNECTED";
            wsBadge.style.color = "var(--color-crimson)";
        }
        setTimeout(initWebSocket, 3000);
    };

    ws.onerror = (err) => {
        console.error("WebSocket error:", err);
    };
}

function handleServerMessage(msg) {
    if (msg.type === "INITIAL_STATE") {
        if (msg.nodes) msg.nodes.forEach(updateNodeUI);
        if (msg.recent_alerts) updateAlertsTable(msg.recent_alerts);
        return;
    }

    if (msg.type === "TELEMETRY_UPDATE") {
        const d = msg.data || {};
        updateNodeUI(d);

        const nodeId = d.node_id;
        if (triaxialHistory[nodeId]) {
            const history = triaxialHistory[nodeId];

            if (
                Array.isArray(d.wave_x) &&
                Array.isArray(d.wave_y) &&
                Array.isArray(d.wave_z) &&
                d.wave_x.length > 0
            ) {
                history.x.push(...d.wave_x.map(Number));
                history.y.push(...d.wave_y.map(Number));
                history.z.push(...d.wave_z.map(Number));

                if (history.x.length > maxHistoryPoints) history.x.splice(0, history.x.length - maxHistoryPoints);
                if (history.y.length > maxHistoryPoints) history.y.splice(0, history.y.length - maxHistoryPoints);
                if (history.z.length > maxHistoryPoints) history.z.splice(0, history.z.length - maxHistoryPoints);
            } else {
                history.x.push(safeNum(d.vib_x, safeNum(d.vibration_val, 0)));
                history.y.push(safeNum(d.vib_y, safeNum(d.vibration_val, 0)));
                history.z.push(safeNum(d.vib_z, safeNum(d.vibration_val, 0)));

                if (history.x.length > maxHistoryPoints) history.x.shift();
                if (history.y.length > maxHistoryPoints) history.y.shift();
                if (history.z.length > maxHistoryPoints) history.z.shift();
            }
        }

        if (msg.alert) triggerAlertUI(msg.alert);
    }
}

function safeNum(val, fallback = 0.0) {
    const n = parseFloat(val);
    return Number.isFinite(n) ? n : fallback;
}

function updateNodeUI(node) {
    const nodeId = node.node_id;
    if (!nodeId) return;

    const vx = safeNum(node.vib_x, safeNum(node.vibration_val, 0.3) * 0.58);
    const vy = safeNum(node.vib_y, safeNum(node.vibration_val, 0.3) * 0.52);
    const vz = safeNum(node.vib_z, safeNum(node.vibration_val, 0.3) * 0.63);
    const vmag = safeNum(node.vibration_val, Math.sqrt(vx * vx + vy * vy + vz * vz));

    const vxEl = document.getElementById(`vx_${nodeId}`);
    if (vxEl) vxEl.textContent = `Vx: ${vx.toFixed(2)}`;

    const vyEl = document.getElementById(`vy_${nodeId}`);
    if (vyEl) vyEl.textContent = `Vy: ${vy.toFixed(2)}`;

    const vzEl = document.getElementById(`vz_${nodeId}`);
    if (vzEl) vzEl.textContent = `Vz: ${vz.toFixed(2)}`;

    const vmagEl = document.getElementById(`vmag_${nodeId}`);
    if (vmagEl) vmagEl.textContent = `|V|: ${vmag.toFixed(2)}`;

    const fdomEl = document.getElementById(`fdom_${nodeId}`);
    if (fdomEl) fdomEl.innerHTML = `${safeNum(node.f_dom, 18.5).toFixed(1)} <span style="font-size:0.75rem;">Hz</span>`;

    const batText = document.getElementById(`bat_text_${nodeId}`);
    if (batText) batText.textContent = `${Math.round(safeNum(node.battery, 90))}%`;

    const batBar = document.getElementById(`bat_bar_${nodeId}`);
    if (batBar) batBar.style.width = `${Math.max(5, Math.min(100, safeNum(node.battery, 90)))}%`;

    const sigEl = document.getElementById(`signal_${nodeId}`);
    if (sigEl) sigEl.textContent = `${node.rssi || -65} dBm / ${node.snr || 9.8}`;

    const pill = document.getElementById(`pill_${nodeId}`);
    if (pill) {
        if (node.is_hardware) {
            pill.innerHTML = `⚡ ESP32 HARDWARE <br/><span style='font-size:0.65rem; opacity:0.9;'>REAL-TIME | Rate: ${node.sample_rate_hz || 200} Hz | Block: ${node.block_id || 0} Chunk: ${(node.chunk_id || 0) + 1}/4</span>`;
            pill.className = vmag >= 4.0 ? "node-pill alert" : "node-pill online";
            pill.style.background = "rgba(6, 182, 212, 0.25)";
            pill.style.borderColor = "var(--color-cyan)";
            pill.style.color = "var(--color-cyan)";
        } else if (node.status === "ALERT" || vmag >= 4.0) {
            pill.textContent = "ALERT";
            pill.className = "node-pill alert";
            pill.style = "";
        } else {
            pill.textContent = "ONLINE (SIM)";
            pill.className = "node-pill online";
            pill.style = "";
        }
    }

    const micBadge = document.getElementById(`mic_badge_${nodeId}`);
    if (micBadge) {
        if (node.mic_verified) {
            micBadge.textContent = "MIC: VERIFIED ✓";
            micBadge.className = "badge-tag verified";
        } else {
            micBadge.textContent = "MIC: OFF";
            micBadge.className = "badge-tag unverified";
        }
    }

    const pirBadge = document.getElementById(`pir_badge_${nodeId}`);
    if (pirBadge) {
        if (node.pir_active) {
            pirBadge.textContent = "PIR: ACTIVE ✓";
            pirBadge.className = "badge-tag verified";
        } else {
            pirBadge.textContent = "PIR: OFF";
            pirBadge.className = "badge-tag unverified";
        }
    }
}

function triggerAlertUI(alert) {
    const banner = document.getElementById("alertBanner");
    const icon = document.getElementById("alertIcon");
    const title = document.getElementById("alertTitle");
    const desc = document.getElementById("alertDesc");
    const score = document.getElementById("threatScore");
    const stftBtn = document.getElementById("bannerStftBtn");
    const sirenText = document.getElementById("sirenStatusText");

    if (banner) {
        banner.className = `alert-banner critical`;
        if (icon) icon.textContent = "🐘🚨";
        if (title) title.textContent = `INTRUSION ALERT: ${alert.direction}`;
        if (desc) desc.textContent = alert.details;
        if (score) {
            score.textContent = `${alert.confidence}% (${alert.threat_level})`;
            score.style.color = "var(--color-crimson)";
        }
        if (stftBtn) {
            stftBtn.style.display = "inline-flex";
            stftBtn.onclick = () => openSTFTModal(alert.latest_node || "NODE_01", true);
        }
    }

    if (sirenText && alert.threat_level === "CRITICAL") {
        sirenText.textContent = "ACTIVATED (SIREN + LIGHT)";
        sirenText.style.color = "var(--color-crimson)";
    }

    const tdoaVec = document.getElementById("tdoaVectorText");
    if (tdoaVec) tdoaVec.textContent = alert.direction;

    const nearestEl = document.getElementById("nearestNodeText");
    if (nearestEl && alert.nearest_label) nearestEl.textContent = `${alert.nearest_label}`;

    if (alert.tdoa_delays) {
        Object.keys(alert.tdoa_delays).forEach(nid => {
            const tEl = document.getElementById(`tdoa_${nid}`);
            if (tEl) {
                const val = alert.tdoa_delays[nid];
                tEl.innerHTML = `${val < 900 ? val.toFixed(1) : '--'} <span style="font-size:0.75rem;">ms</span>`;
            }
        });
    }

    if (alert.latest_node) {
        const trailNode = document.getElementById(`trail_${alert.latest_node}`);
        if (trailNode) trailNode.classList.add("active");
    }

    playAlertSound();
    fetchAlerts();
}

function updateAlertsTable(alerts) {
    const tbody = document.getElementById("alertsTableBody");
    if (!tbody) return;

    if (!alerts || alerts.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No intrusion alerts recorded.</td></tr>`;
        return;
    }

    tbody.innerHTML = alerts.map(a => {
        const dateStr = new Date(a.timestamp * 1000).toLocaleTimeString();
        const mainNode = a.nearest_node || (a.trigger_nodes ? a.trigger_nodes.split(" -> ")[0] : "NODE_01");
        return `
            <tr class="clickable-row" onclick="openSTFTModal('${mainNode}', true)" title="Click to view STFT Spectrogram for this event">
                <td>${dateStr}</td>
                <td><strong>${a.trigger_nodes}</strong></td>
                <td>${a.direction}</td>
                <td><span class="threat-badge ${a.threat_level}">${a.threat_level}</span></td>
                <td><strong>${a.confidence}%</strong></td>
                <td>
                    ${a.mic_verified ? '<span style="color:var(--color-cyan);">Mic ✓ </span>' : ''}
                    ${a.pir_verified ? '<span style="color:var(--color-emerald);">PIR ✓</span>' : ''}
                </td>
                <td style="font-size:0.8rem; color:var(--text-muted);">${a.details || ''}</td>
            </tr>
        `;
    }).join("");
}

async function fetchAlerts() {
    try {
        const res = await fetch("/api/alerts?limit=20");
        const data = await res.json();
        updateAlertsTable(data);
    } catch (e) {
        console.error("Failed to fetch alerts:", e);
    }
}

async function openSTFTModal(nodeId = "NODE_01", isIntrusion = false) {
    currentStftNode = nodeId;
    currentStftIntrusion = isIntrusion;

    const modal = document.getElementById("stftModal");
    const pill = document.getElementById("stftNodePill");
    if (pill) pill.textContent = nodeId;
    if (modal) modal.classList.add("active");

    await fetchAndRenderSTFT();
}

function closeSTFTModal() {
    const modal = document.getElementById("stftModal");
    if (modal) modal.classList.remove("active");
}

async function refreshSTFTData() {
    await fetchAndRenderSTFT();
}

async function fetchAndRenderSTFT() {
    try {
        const url = `/api/stft/${currentStftNode}?is_intrusion=${currentStftIntrusion ? 'true' : 'false'}`;
        const res = await fetch(url);
        const data = await res.json();

        document.getElementById("stftPeakFreq").textContent = `${data.peak_frequency_hz} Hz`;
        document.getElementById("stftPeakEnergy").textContent = `${data.peak_energy_db} dB`;
        document.getElementById("stftBandwidth").textContent = `${data.bandwidth_hz} Hz`;

        const classEl = document.getElementById("stftClass");
        if (classEl) {
            classEl.textContent = data.signal_class;
            classEl.style.color = data.is_intrusion ? "var(--color-crimson)" : "var(--color-emerald)";
        }

        renderSTFTHeatmap(data.stft_matrix, data.freq_axis, data.time_axis);
    } catch (e) {
        console.error("Error fetching STFT data:", e);
    }
}

function renderSTFTHeatmap(matrix, freqAxis, timeAxis) {
    if (!stftCanvas || !Array.isArray(matrix) || matrix.length === 0) return;

    stftCtx = stftCanvas.getContext("2d");
    const rect = stftCanvas.parentElement.getBoundingClientRect();
    stftCanvas.width = Math.max(1, rect.width - 60);
    stftCanvas.height = 280;

    const w = stftCanvas.width;
    const h = stftCanvas.height;
    stftCtx.clearRect(0, 0, w, h);

    const numTimeSteps = matrix.length;
    const numFreqBins = matrix[0].length;
    const cellWidth = w / numTimeSteps;
    const cellHeight = h / numFreqBins;

    for (let t = 0; t < numTimeSteps; t++) {
        for (let f = 0; f < numFreqBins; f++) {
            const intensity = matrix[t][f];
            const x = t * cellWidth;
            const y = h - (f + 1) * cellHeight;
            stftCtx.fillStyle = intensityToSpectrogramColor(intensity);
            stftCtx.fillRect(x, y, cellWidth + 0.5, cellHeight + 0.5);
        }
    }

    stftCtx.strokeStyle = "rgba(255,255,255,0.15)";
    stftCtx.lineWidth = 1;

    for (let f = 10; f < 50; f += 10) {
        const y = h - (f / 50.0) * h;
        stftCtx.beginPath();
        stftCtx.moveTo(0, y);
        stftCtx.lineTo(w, y);
        stftCtx.stroke();
        stftCtx.fillStyle = "rgba(255,255,255,0.7)";
        stftCtx.font = "10px Inter";
        stftCtx.fillText(`${f} Hz`, 6, y - 3);
    }
}

function intensityToSpectrogramColor(val) {
    if (val < 0.15) return `#050811`;
    if (val < 0.35) {
        const r = Math.floor((val - 0.15) / 0.2 * 139);
        const g = Math.floor((val - 0.15) / 0.2 * 92 + 92);
        return `rgb(${r}, ${g}, 246)`;
    }
    if (val < 0.6) {
        const g = Math.floor((1 - (val - 0.35) / 0.25) * 100);
        return `rgb(239, ${g}, 68)`;
    }
    if (val < 0.85) {
        const g = Math.floor((val - 0.6) / 0.25 * 158 + 50);
        return `rgb(245, ${g}, 11)`;
    }
    return `#FFFFFF`;
}

async function triggerSimulation(type = "INBOUND_NW") {
    try {
        await fetch("/api/simulate/intrusion", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type })
        });
    } catch (e) {
        console.error("Error triggering simulation:", e);
    }
}

async function clearSimulation() {
    try {
        await fetch("/api/simulate/clear", { method: "POST" });

        const banner = document.getElementById("alertBanner");
        const icon = document.getElementById("alertIcon");
        const title = document.getElementById("alertTitle");
        const desc = document.getElementById("alertDesc");
        const score = document.getElementById("threatScore");
        const stftBtn = document.getElementById("bannerStftBtn");
        const sirenText = document.getElementById("sirenStatusText");

        if (banner) {
            banner.className = "alert-banner normal";
            if (icon) icon.textContent = "🛡️";
            if (title) title.textContent = "ALL FIELD NODES SECURE";
            if (desc) desc.textContent = "Continuous low-power TDOA monitoring active across 3 geophone sensing nodes.";
            if (score) {
                score.textContent = "SAFE";
                score.style.color = "var(--color-emerald)";
            }
            if (stftBtn) stftBtn.style.display = "none";
        }

        if (sirenText) {
            sirenText.textContent = "STANDBY";
            sirenText.style.color = "var(--text-muted)";
        }

        ["NODE_01", "NODE_02", "NODE_03"].forEach(id => {
            const trailNode = document.getElementById(`trail_${id}`);
            if (trailNode) trailNode.classList.remove("active");
        });
    } catch (e) {
        console.error("Error clearing simulation:", e);
    }
}

function playAlertSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.3);

        gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);

        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
    } catch (e) {}
}
