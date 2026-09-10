// Elephant Intrusion Detection System - Dashboard Client
// The frontend displays received telemetry and upstream decisions. It does not
// infer elephant presence, confidence, TDOA, or direction on its own.

let ws;
let canvas;
let ctx;
let stftCanvas;
let stftCtx;

const NODE_IDS = ["NODE_01", "NODE_02"];
const NODE_LABELS = {
    NODE_01: "G1",
    NODE_02: "G2"
};

const WAVEFORM_RATE_HZ = 200;
const WAVEFORM_HISTORY_SECONDS = 60;
const MAX_HISTORY_POINTS = WAVEFORM_RATE_HZ * WAVEFORM_HISTORY_SECONDS;
const WAVEFORM_DISPLAY_SECONDS = 10;
const WAVEFORM_DISPLAY_POINTS = WAVEFORM_RATE_HZ * WAVEFORM_DISPLAY_SECONDS;
const NODE_OFFLINE_TIMEOUT_SECONDS = 10;

let waveformNode = "NODE_01";
let currentStftNode = "NODE_01";
let axisVisibility = { X: true, Y: true, Z: true };

const triaxialHistory = {
    NODE_01: { x: [], y: [], z: [], sampleRate: 200 },
    NODE_02: { x: [], y: [], z: [], sampleRate: 200 }
};

const nodeLastPacket = {
    NODE_01: 0,
    NODE_02: 0
};

const nodeEventState = {
    NODE_01: null,
    NODE_02: null
};

function labelForNode(nodeId) {
    return NODE_LABELS[nodeId] || nodeId || "—";
}

function safeNum(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function hasValue(value) {
    return value !== undefined && value !== null && value !== "";
}

function formatNumber(value, digits = 2, suffix = "") {
    const number = safeNum(value);
    return number === null ? "—" : `${number.toFixed(digits)}${suffix}`;
}

function formatTimestamp(value) {
    if (!hasValue(value)) return "—";
    const numeric = Number(value);
    const date = Number.isFinite(numeric)
        ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
        : new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function formatTimeOnly(value) {
    if (!hasValue(value)) return "—";
    const numeric = Number(value);
    const date = Number.isFinite(numeric)
        ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
        : new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString();
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

document.addEventListener("DOMContentLoaded", () => {
    initCanvas();
    initWaveformNodeSelector();
    initWebSocket();
    fetchAlerts();
    updateNodeOfflineStates();
    setInterval(updateNodeOfflineStates, 2000);
});

function initWaveformNodeSelector() {
    NODE_IDS.forEach(nodeId => {
        const card = document.getElementById(`card_${nodeId}`);
        if (!card) return;

        card.addEventListener("click", event => {
            if (event.target.closest("button")) return;
            selectWaveformNode(nodeId);
        });
    });
    selectWaveformNode(waveformNode);
}

function selectWaveformNode(nodeId) {
    if (!triaxialHistory[nodeId]) return;

    waveformNode = nodeId;

    NODE_IDS.forEach(id => {
        const card = document.getElementById(`card_${id}`);
        if (card) card.classList.toggle("waveform-node-selected", id === nodeId);
    });

    const subtitle = document.getElementById("waveformSubtitle");
    if (subtitle) {
        subtitle.textContent = `Selected node: ${labelForNode(nodeId)} • 10-second display • signed, zero-centered`;
    }

    updateWaveformSourceNote();
}

function toggleAxisButton(axis) {
    if (!Object.prototype.hasOwnProperty.call(axisVisibility, axis)) return;

    axisVisibility[axis] = !axisVisibility[axis];
    const button = document.getElementById(`axisBtn_${axis}`);
    if (button) button.classList.toggle("active", axisVisibility[axis]);

    if (!axisVisibility.X && !axisVisibility.Y && !axisVisibility.Z) {
        axisVisibility[axis] = true;
        if (button) button.classList.add("active");
    }
}

function initCanvas() {
    canvas = document.getElementById("vibrationCanvas");
    if (canvas) {
        ctx = canvas.getContext("2d");
        resizeWaveformCanvas();
        window.addEventListener("resize", resizeWaveformCanvas);
        requestAnimationFrame(renderWaveform);
    }

    stftCanvas = document.getElementById("stftCanvas");
    if (stftCanvas) stftCtx = stftCanvas.getContext("2d");
}

function resizeWaveformCanvas() {
    if (!canvas || !ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function getVisibleData(data) {
    if (!Array.isArray(data)) return [];
    return data.length > WAVEFORM_DISPLAY_POINTS
        ? data.slice(data.length - WAVEFORM_DISPLAY_POINTS)
        : data.slice();
}

function removeDisplayBaseline(data) {
    if (!data.length) return [];
    const valid = data.filter(value => Number.isFinite(Number(value))).map(Number);
    if (!valid.length) return [];
    const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
    return data.map(value => {
        const number = Number(value);
        return Number.isFinite(number) ? number - mean : 0;
    });
}

function getDisplayScale(seriesList) {
    let maxAbs = 0;
    seriesList.forEach(series => {
        series.forEach(value => {
            const number = Math.abs(Number(value));
            if (Number.isFinite(number)) maxAbs = Math.max(maxAbs, number);
        });
    });

    if (maxAbs <= 0.5) return 0.5;
    if (maxAbs <= 1) return 1;
    if (maxAbs <= 2) return 2;
    if (maxAbs <= 5) return 5;
    if (maxAbs <= 10) return 10;
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

    const width = rect.width;
    const height = rect.height;
    const left = 58;
    const right = 18;
    const top = 18;
    const bottom = 38;
    const graphLeft = left;
    const graphRight = width - right;
    const graphTop = top;
    const graphBottom = height - bottom;
    const graphWidth = graphRight - graphLeft;
    const graphHeight = graphBottom - graphTop;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#10171B";
    ctx.fillRect(graphLeft, graphTop, graphWidth, graphHeight);

    const history = triaxialHistory[waveformNode];
    const xData = removeDisplayBaseline(getVisibleData(history.x));
    const yData = removeDisplayBaseline(getVisibleData(history.y));
    const zData = removeDisplayBaseline(getVisibleData(history.z));

    const visibleSeries = [];
    if (axisVisibility.X) visibleSeries.push(xData);
    if (axisVisibility.Y) visibleSeries.push(yData);
    if (axisVisibility.Z) visibleSeries.push(zData);

    const hasWaveform = visibleSeries.some(series => series.length >= 2);
    const scale = getDisplayScale(visibleSeries);
    const yMin = -scale;
    const yMax = scale;

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    for (let i = 0; i <= 4; i++) {
        const y = graphTop + (i / 4) * graphHeight;
        ctx.beginPath();
        ctx.moveTo(graphLeft, y);
        ctx.lineTo(graphRight, y);
        ctx.stroke();
    }
    for (let i = 0; i <= 5; i++) {
        const x = graphLeft + (i / 5) * graphWidth;
        ctx.beginPath();
        ctx.moveTo(x, graphTop);
        ctx.lineTo(x, graphBottom);
        ctx.stroke();
    }

    const zeroY = graphBottom - ((0 - yMin) / (yMax - yMin)) * graphHeight;
    ctx.strokeStyle = "rgba(255,255,255,0.30)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(graphLeft, zeroY);
    ctx.lineTo(graphRight, zeroY);
    ctx.stroke();

    ctx.font = "12px Inter, Arial, sans-serif";
    ctx.fillStyle = "rgba(220,230,235,0.72)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
        const value = yMax - (i / 4) * (yMax - yMin);
        const y = graphTop + (i / 4) * graphHeight;
        ctx.fillText(value.toFixed(1), graphLeft - 8, y);
    }

    ctx.save();
    ctx.translate(15, graphTop + graphHeight / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.font = "11px Inter, Arial, sans-serif";
    ctx.fillStyle = "rgba(220,230,235,0.60)";
    ctx.fillText("mm/s", 0, 0);
    ctx.restore();

    const sampleCount = Math.max(
        xData.length,
        yData.length,
        zData.length
    );
    const sampleRate = history.sampleRate || WAVEFORM_RATE_HZ;
    const durationSeconds = Math.min(WAVEFORM_DISPLAY_SECONDS, sampleCount / sampleRate);

    ctx.font = "11px Inter, Arial, sans-serif";
    ctx.fillStyle = "rgba(220,230,235,0.60)";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let i = 0; i <= 4; i++) {
        const x = graphLeft + (i / 4) * graphWidth;
        const seconds = durationSeconds > 0 ? -durationSeconds + (durationSeconds * i / 4) : 0;
        ctx.fillText(`${seconds.toFixed(1)} s`, x, graphBottom + 10);
    }

    function drawTrace(data, lineColor) {
        if (data.length < 2) return;

        const displayCount = Math.min(data.length, Math.max(300, Math.floor(graphWidth * 1.5)));
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

        if (started) ctx.stroke();
    }

    if (axisVisibility.X) drawTrace(xData, "#2F80ED");
    if (axisVisibility.Y) drawTrace(yData, "#F2994A");
    if (axisVisibility.Z) drawTrace(zData, "#10B981");

    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(220,230,235,0.60)";
    ctx.fillText(`${labelForNode(waveformNode)} • ${WAVEFORM_DISPLAY_SECONDS}s VIEW`, graphLeft + 8, graphTop + 5);
    ctx.textAlign = "right";
    ctx.fillStyle = "#10B981";
    ctx.fillText(`● LIVE • ${sampleRate} Hz`, graphRight - 6, graphTop + 5);

    if (!hasWaveform) {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(220,230,235,0.55)";
        ctx.font = "13px Inter, Arial, sans-serif";
        ctx.fillText("Waiting for waveform data", graphLeft + graphWidth / 2, graphTop + graphHeight / 2);
    }

    requestAnimationFrame(renderWaveform);
}

function initWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const badge = document.getElementById("wsStatus");

    if (badge) badge.textContent = "CONNECTING";
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        if (badge) {
            badge.textContent = "CONNECTED";
            badge.style.color = "var(--color-emerald)";
        }
        setSystemServerStatus(true);
    };

    ws.onmessage = event => {
        try {
            handleServerMessage(JSON.parse(event.data));
        } catch (error) {
            console.error("WebSocket JSON parse error:", error);
        }
    };

    ws.onclose = () => {
        if (badge) {
            badge.textContent = "DISCONNECTED";
            badge.style.color = "var(--color-crimson)";
        }
        setSystemServerStatus(false);
        setTimeout(initWebSocket, 3000);
    };

    ws.onerror = error => console.error("WebSocket error:", error);
}

function handleServerMessage(message) {
    if (message.type === "INITIAL_STATE") {
        if (Array.isArray(message.nodes)) message.nodes.forEach(updateNodeUI);
        if (Array.isArray(message.recent_alerts)) updateAlertsTable(message.recent_alerts);
        return;
    }

    if (message.type !== "TELEMETRY_UPDATE") return;

    const data = message.data || {};
    updateNodeUI(data);
    updateSystemStatus(message.system_status || {});
    updateDecision(message.decision || {});

    const nodeId = data.node_id;
    if (triaxialHistory[nodeId]) {
        const history = triaxialHistory[nodeId];
        history.sampleRate = safeNum(data.sample_rate_hz, 200) || 200;

        const waveX = Array.isArray(data.wave_x) ? data.wave_x : [];
        const waveY = Array.isArray(data.wave_y) ? data.wave_y : [];
        const waveZ = Array.isArray(data.wave_z) ? data.wave_z : [];

        // Do not synthesize a waveform from scalar vibration values. If a
        // waveform is not transmitted, the dashboard simply waits for it.
        const count = Math.min(waveX.length, waveY.length, waveZ.length);
        if (count > 0) {
            history.x.push(...waveX.slice(0, count).map(Number));
            history.y.push(...waveY.slice(0, count).map(Number));
            history.z.push(...waveZ.slice(0, count).map(Number));

            if (history.x.length > MAX_HISTORY_POINTS) history.x.splice(0, history.x.length - MAX_HISTORY_POINTS);
            if (history.y.length > MAX_HISTORY_POINTS) history.y.splice(0, history.y.length - MAX_HISTORY_POINTS);
            if (history.z.length > MAX_HISTORY_POINTS) history.z.splice(0, history.z.length - MAX_HISTORY_POINTS);
        }

        if (hasValue(data.waveform_mode)) {
            triaxialHistory[nodeId].waveformMode = data.waveform_mode;
        }
    }

    if (message.alert) {
        triggerAlertUI(message.alert);
        fetchAlerts();
    }

    updateWaveformSourceNote();
}

function updateNodeUI(node) {
    const nodeId = node.node_id;
    if (!triaxialHistory[nodeId]) return;

    const receivedAt = safeNum(node.timestamp, Date.now() / 1000) || Date.now() / 1000;
    nodeLastPacket[nodeId] = receivedAt < 1e12 ? receivedAt * 1000 : receivedAt;

    const vx = safeNum(node.vib_x);
    const vy = safeNum(node.vib_y);
    const vz = safeNum(node.vib_z);
    const magnitude = safeNum(node.vibration_val);

    setText(`vx_${nodeId}`, vx === null ? "X: — mm/s" : `X: ${vx.toFixed(3)} mm/s`);
    setText(`vy_${nodeId}`, vy === null ? "Y: — mm/s" : `Y: ${vy.toFixed(3)} mm/s`);
    setText(`vz_${nodeId}`, vz === null ? "Z: — mm/s" : `Z: ${vz.toFixed(3)} mm/s`);
    setText(`vmag_${nodeId}`, magnitude === null ? "|V|: — mm/s" : `|V|: ${magnitude.toFixed(3)} mm/s`);

    setText(`rate_${nodeId}`, hasValue(node.sample_rate_hz) ? `${node.sample_rate_hz} Hz` : "— Hz");
    setText(`battery_${nodeId}`, hasValue(node.battery) ? `${safeNum(node.battery, 0).toFixed(1)}%` : "—");
    setText(`rssi_${nodeId}`, hasValue(node.rssi) ? `${node.rssi} dBm` : "—");
    setText(`snr_${nodeId}`, hasValue(node.snr) ? `${safeNum(node.snr, 0).toFixed(1)} dB` : "—");
    setText(`fdom_${nodeId}`, hasValue(node.f_dom) ? `${safeNum(node.f_dom, 0).toFixed(2)} Hz` : "—");
    setText(`last_${nodeId}`, `Last packet: ${formatTimeOnly(node.timestamp)}`);

    const battery = safeNum(node.battery);
    const batteryBar = document.getElementById(`bat_bar_${nodeId}`);
    if (batteryBar) batteryBar.style.width = battery === null ? "0%" : `${Math.max(0, Math.min(100, battery))}%`;

    const sourceText = node.is_hardware ? "ESP32 HARDWARE" : "SIMULATION";
    setText(`source_${nodeId}`, `SOURCE: ${sourceText}`);

    const eventValue = hasValue(node.event) ? node.event : null;
    const eventText = eventValue === null
        ? "—"
        : (eventValue === true || String(eventValue).toUpperCase() === "TRUE" ? "EVENT" : "NO EVENT");
    setText(`event_${nodeId}`, eventText);

    const pill = document.getElementById(`pill_${nodeId}`);
    if (pill) {
        const isRecent = Date.now() - nodeLastPacket[nodeId] <= NODE_OFFLINE_TIMEOUT_SECONDS * 1000;
        const status = String(node.status || "ONLINE").toUpperCase();
        pill.textContent = isRecent && status !== "OFFLINE" ? "CONNECTED" : "OFFLINE";
        pill.className = `node-pill ${isRecent && status !== "OFFLINE" ? "online" : "offline"}`;
    }

    const card = document.getElementById(`card_${nodeId}`);
    if (card && waveformNode === nodeId) card.classList.add("waveform-node-selected");

    updateWaveformSourceNote();
}

function updateNodeOfflineStates() {
    NODE_IDS.forEach(nodeId => {
        const last = nodeLastPacket[nodeId];
        const pill = document.getElementById(`pill_${nodeId}`);
        if (!pill || !last) return;

        const online = Date.now() - last <= NODE_OFFLINE_TIMEOUT_SECONDS * 1000;
        pill.textContent = online ? "CONNECTED" : "OFFLINE";
        pill.className = `node-pill ${online ? "online" : "offline"}`;
    });
}

function updateWaveformSourceNote() {
    const history = triaxialHistory[waveformNode];
    const note = document.getElementById("waveformSourceNote");
    if (!note || !history) return;

    if (!history.x.length) {
        note.textContent = "Waiting for waveform data — no scalar values are substituted for missing waveform samples.";
        return;
    }

    const mode = history.waveformMode || "RECEIVED WAVEFORM";
    note.textContent = `G${waveformNode.slice(-2).replace(/^0+/, "")} • ${mode} • ${history.x.length} stored samples • ${history.sampleRate} Hz`;
}

function updateSystemStatus(status) {
    setStatusValue("status_dashboard_server", true);
    if (hasValue(status.raspberry_pi)) setStatusValue("status_raspberry_pi", status.raspberry_pi);
    if (hasValue(status.lora_gateway)) setStatusValue("status_lora_gateway", status.lora_gateway);
    if (hasValue(status.backhaul_4g)) setStatusValue("status_4g", status.backhaul_4g);

    if (hasValue(status.last_packet)) {
        setText("status_last_packet", formatTimeOnly(status.last_packet));
        setText("status_last_update", formatTimestamp(status.last_packet));
    }
}

function setSystemServerStatus(online) {
    const text = document.getElementById("systemStatusText");
    const dot = document.getElementById("systemDot");
    if (text) text.textContent = online ? "DASHBOARD ONLINE" : "DASHBOARD OFFLINE";
    if (dot) dot.style.backgroundColor = online ? "var(--color-emerald)" : "var(--color-crimson)";
    setStatusValue("status_dashboard_server", online);
}

function setStatusValue(id, value) {
    const element = document.getElementById(id);
    if (!element) return;

    if (typeof value === "boolean") {
        element.textContent = value ? "ONLINE" : "OFFLINE";
        element.style.color = value ? "var(--color-emerald)" : "var(--color-crimson)";
        return;
    }

    const normalized = String(value).toUpperCase();
    element.textContent = normalized;
    if (["ONLINE", "CONNECTED", "SIMULATED"].includes(normalized)) {
        element.style.color = "var(--color-emerald)";
    } else if (["OFFLINE", "DISCONNECTED"].includes(normalized)) {
        element.style.color = "var(--color-crimson)";
    } else {
        element.style.color = "var(--text-muted)";
    }
}

function updateDecision(decision) {
    if (!decision || (!hasValue(decision.classification) && !hasValue(decision.event_status) && !hasValue(decision.event))) {
        return;
    }

    const classification = hasValue(decision.classification) ? String(decision.classification).toUpperCase() : "NOT REPORTED";
    const confidence = hasValue(decision.confidence) && hasValue(decision.classification)
        ? `${safeNum(decision.confidence, 0).toFixed(1)}%`
        : "NOT REPORTED";
    const eventStatus = hasValue(decision.event_status)
        ? String(decision.event_status).toUpperCase()
        : (decision.event === true ? "DETECTED" : "NOT DETECTED");

    setText("mlClassification", classification);
    setText("mlConfidence", confidence);
    setText("mlEvent", eventStatus);
    setText("mlTimestamp", formatTimestamp(decision.timestamp));
    setText("mlNode", hasValue(decision.detected_node) ? labelForNode(decision.detected_node) : "NOT REPORTED");

    const source = document.getElementById("decisionSource");
    if (source) source.textContent = "UPSTREAM DECISION";

    updateAlertStateFromDecision(decision);
}

function updateAlertStateFromDecision(decision) {
    const status = hasValue(decision.event_status) ? String(decision.event_status).toUpperCase() : "";
    const event = decision.event === true || String(decision.event).toUpperCase() === "TRUE";

    let title = "NORMAL";
    let description = "No final detection decision has been reported.";
    let className = "alert-banner normal";

    if (status === "POSSIBLE EVENT") {
        title = "POSSIBLE EVENT";
        description = "The upstream processing unit has reported a possible event.";
        className = "alert-banner warning";
    } else if (status === "ELEPHANT DETECTED" || event) {
        title = "ELEPHANT DETECTED";
        description = "Final detection decision received from the upstream processing unit.";
        className = "alert-banner critical";
    }

    const banner = document.getElementById("alertBanner");
    if (banner) banner.className = className;
    setText("alertTitle", title);
    setText("alertDesc", description);
    setText("threatScore", title);
}

function triggerAlertUI(alert) {
    if (!alert) return;

    const decision = {
        classification: alert.classification,
        confidence: alert.confidence,
        event: true,
        event_status: alert.event_status || "ELEPHANT DETECTED",
        detected_node: alert.detected_node || alert.trigger_nodes,
        timestamp: alert.timestamp
    };
    updateDecision(decision);

    const direction = alert.direction;
    const location = alert.location;
    if (hasValue(direction)) setText("directionText", direction);
    if (hasValue(alert.tdoa_ms)) setText("tdoaText", `${alert.tdoa_ms} ms`);
    if (hasValue(alert.detected_node)) setText("sourceNodeText", labelForNode(alert.detected_node));
    if (hasValue(location)) setText("locationText", location);

    if (hasValue(alert.detected_node)) {
        NODE_IDS.forEach(id => {
            const mapNode = document.getElementById(`map_${id}`);
            if (mapNode) mapNode.classList.toggle("active", id === alert.detected_node);
        });
    }
}

function updateAlertsTable(alerts) {
    const tbody = document.getElementById("alertsTableBody");
    if (!tbody) return;

    if (!Array.isArray(alerts) || alerts.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty-table">No upstream events recorded.</td></tr>`;
        return;
    }

    tbody.innerHTML = alerts.map(alert => {
        const classification = hasValue(alert.classification) ? alert.classification : "NOT REPORTED";
        const confidence = hasValue(alert.confidence) ? `${Number(alert.confidence).toFixed(1)}%` : "NOT REPORTED";
        const eventStatus = hasValue(alert.event_status) ? alert.event_status : "EVENT";
        const frequency = hasValue(alert.dominant_frequency) ? `${Number(alert.dominant_frequency).toFixed(2)} Hz` : "—";
        const rms = hasValue(alert.rms) ? Number(alert.rms).toFixed(3) : "—";
        const direction = hasValue(alert.direction) ? alert.direction : "—";
        const location = hasValue(alert.location) ? alert.location : "—";
        const node = alert.detected_node || alert.trigger_nodes || "—";

        return `
            <tr>
                <td>${escapeHtml(formatTimeOnly(alert.timestamp))}</td>
                <td><strong>${escapeHtml(labelForNode(node))}</strong></td>
                <td>${escapeHtml(classification)}</td>
                <td>${escapeHtml(confidence)}</td>
                <td><span class="threat-badge ${String(alert.threat_level || "WARNING").toUpperCase()}">${escapeHtml(eventStatus)}</span></td>
                <td>${escapeHtml(frequency)}</td>
                <td>${escapeHtml(rms)}</td>
                <td>${escapeHtml(direction)}${location !== "—" ? `<br><span class="table-muted">${escapeHtml(location)}</span>` : ""}</td>
            </tr>
        `;
    }).join("");
}

async function fetchAlerts() {
    try {
        const response = await fetch("/api/alerts?limit=20");
        if (!response.ok) return;
        const alerts = await response.json();
        updateAlertsTable(alerts);
    } catch (error) {
        console.error("Failed to fetch event history:", error);
    }
}

async function openSTFTModal(nodeId = waveformNode) {
    currentStftNode = nodeId;
    const modal = document.getElementById("stftModal");
    const pill = document.getElementById("stftNodePill");
    if (pill) pill.textContent = labelForNode(nodeId);
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
        const response = await fetch(`/api/stft/${currentStftNode}?is_intrusion=false`);
        if (!response.ok) throw new Error(`STFT request failed: ${response.status}`);
        const data = await response.json();

        if (!data.available) {
            setText("stftPeakFreq", "—");
            setText("stftPeakEnergy", "—");
            setText("stftBandwidth", "—");
            setText("stftClass", data.message || "Waiting for waveform data");
            setText("inlinePeakFreq", "—");
            setText("inlinePeakEnergy", "—");
            setText("inlineBandwidth", "—");
            setText("inlineStftStatus", data.message || "Waiting for waveform data");
            renderSTFTHeatmap([], [], []);
            return;
        }

        setText("stftPeakFreq", `${data.peak_frequency_hz} Hz`);
        setText("stftPeakEnergy", `${data.peak_energy_db} dB`);
        setText("stftBandwidth", `${data.bandwidth_hz} Hz`);
        setText("stftClass", data.signal_class || "Received waveform");
        setText("inlinePeakFreq", `${data.peak_frequency_hz} Hz`);
        setText("inlinePeakEnergy", `${data.peak_energy_db} dB`);
        setText("inlineBandwidth", `${data.bandwidth_hz} Hz`);
        setText("inlineStftStatus", "AVAILABLE — RECEIVED DATA");

        renderSTFTHeatmap(data.stft_matrix, data.freq_axis, data.time_axis);
    } catch (error) {
        console.error("STFT error:", error);
        setText("inlineStftStatus", "Unable to load STFT data");
    }
}

function renderSTFTHeatmap(matrix, freqAxis, timeAxis) {
    if (!stftCanvas || !stftCtx) return;

    const wrapper = stftCanvas.parentElement;
    const rect = wrapper.getBoundingClientRect();
    stftCanvas.width = Math.max(1, Math.floor(rect.width));
    stftCanvas.height = 300;

    const width = stftCanvas.width;
    const height = stftCanvas.height;
    stftCtx.clearRect(0, 0, width, height);

    const waiting = document.getElementById("stftWaiting");

    if (!Array.isArray(matrix) || matrix.length === 0) {
        if (waiting) waiting.style.display = "flex";
        return;
    }

    if (waiting) waiting.style.display = "none";

    const timeCount = matrix.length;
    const freqCount = matrix[0].length;
    const cellWidth = width / timeCount;
    const cellHeight = height / freqCount;

    for (let t = 0; t < timeCount; t++) {
        for (let f = 0; f < freqCount; f++) {
            const intensity = Number(matrix[t][f]) || 0;
            stftCtx.fillStyle = intensityToSpectrogramColor(intensity);
            stftCtx.fillRect(t * cellWidth, height - (f + 1) * cellHeight, cellWidth + 0.5, cellHeight + 0.5);
        }
    }

    stftCtx.strokeStyle = "rgba(255,255,255,0.15)";
    stftCtx.lineWidth = 1;
    stftCtx.fillStyle = "rgba(255,255,255,0.7)";
    stftCtx.font = "10px Inter, Arial, sans-serif";

    [0, 25, 50, 75, 100].forEach(freq => {
        const y = height - (freq / 100) * height;
        stftCtx.beginPath();
        stftCtx.moveTo(0, y);
        stftCtx.lineTo(width, y);
        stftCtx.stroke();
        stftCtx.fillText(`${freq} Hz`, 6, Math.max(10, y - 4));
    });
}

function intensityToSpectrogramColor(value) {
    const intensity = Math.max(0, Math.min(1, Number(value) || 0));
    if (intensity < 0.15) return "#050811";
    if (intensity < 0.35) {
        const r = Math.floor((intensity - 0.15) / 0.2 * 139);
        const g = Math.floor((intensity - 0.15) / 0.2 * 92 + 92);
        return `rgb(${r}, ${g}, 246)`;
    }
    if (intensity < 0.6) {
        const g = Math.floor((1 - (intensity - 0.35) / 0.25) * 100);
        return `rgb(239, ${g}, 68)`;
    }
    if (intensity < 0.85) {
        const g = Math.floor((intensity - 0.6) / 0.25 * 158 + 50);
        return `rgb(245, ${g}, 11)`;
    }
    return "#FFFFFF";
}

async function triggerSimulation(type = "INBOUND") {
    try {
        const response = await fetch("/api/simulate/intrusion", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type })
        });
        if (!response.ok) console.error("Simulation request failed", response.status);
    } catch (error) {
        console.error("Error triggering simulation:", error);
    }
}

async function clearSimulation() {
    try {
        await fetch("/api/simulate/clear", { method: "POST" });
    } catch (error) {
        console.error("Error clearing simulation:", error);
    }

    resetDecisionUI();
    NODE_IDS.forEach(id => {
        const mapNode = document.getElementById(`map_${id}`);
        if (mapNode) mapNode.classList.remove("active");
        nodeEventState[id] = null;
    });
    setText("directionText", "Pending / Not available");
    setText("tdoaText", "Pending / Not available");
    setText("sourceNodeText", "Not available");
    setText("locationText", "Not available");
    fetchAlerts();
}

function resetDecisionUI() {
    const banner = document.getElementById("alertBanner");
    if (banner) banner.className = "alert-banner normal";
    setText("alertIcon", "🛡️");
    setText("alertTitle", "NORMAL");
    setText("alertDesc", "Waiting for the final decision from the upstream processing unit.");
    setText("threatScore", "NORMAL");
    setText("mlClassification", "NOT REPORTED");
    setText("mlConfidence", "NOT REPORTED");
    setText("mlEvent", "NOT REPORTED");
    setText("mlTimestamp", "—");
    setText("mlNode", "NOT REPORTED");
    setText("decisionSource", "WAITING FOR DECISION");
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}
