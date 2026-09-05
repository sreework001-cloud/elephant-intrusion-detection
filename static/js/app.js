// Elephant Intrusion Detection System - Frontend Client Logic (Triangular TDOA Mapping)

let ws;
let canvas, ctx;
let stftCanvas, stftCtx;
const WAVEFORM_RATE_HZ = 200;
const WAVEFORM_HISTORY_SECONDS = 60;
const maxHistoryPoints = WAVEFORM_RATE_HZ * WAVEFORM_HISTORY_SECONDS;
let currentStftNode = "NODE_01";
let currentStftIntrusion = false;
let axisVisibility = {
    X: true,
    Y: true,
    Z: true
};

let triaxialHistory = {
    "NODE_01": { x: new Array(maxHistoryPoints).fill(0.18), y: new Array(maxHistoryPoints).fill(0.15), z: new Array(maxHistoryPoints).fill(0.22) },
    "NODE_02": { x: new Array(maxHistoryPoints).fill(0.16), y: new Array(maxHistoryPoints).fill(0.14), z: new Array(maxHistoryPoints).fill(0.19) },
    "NODE_03": { x: new Array(maxHistoryPoints).fill(0.12), y: new Array(maxHistoryPoints).fill(0.11), z: new Array(maxHistoryPoints).fill(0.15) }
};

document.addEventListener("DOMContentLoaded", () => {
    initCanvas();
    initWebSocket();
});

function toggleAxisButton(axis) {

    axisVisibility[axis] = !axisVisibility[axis];

    const button = document.getElementById(`axisBtn_${axis}`);

    if (button) {
        button.classList.toggle(
            "active",
            axisVisibility[axis]
        );
    }

    /*
     * Prevent the user from turning all three axes off.
     * At least one waveform should always remain visible.
     */
    const activeAxes =
        Object.values(axisVisibility)
            .filter(Boolean)
            .length;

    if (activeAxes === 0) {

        axisVisibility[axis] = true;

        if (button) {
            button.classList.add("active");
        }
    }
}

function initCanvas() {
    canvas = document.getElementById("vibrationCanvas");
    if (!canvas) return;
    ctx = canvas.getContext("2d");
    
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    
    stftCanvas = document.getElementById("stftCanvas");
    if (stftCanvas) {
        stftCtx = stftCanvas.getContext("2d");
    }
    
    requestAnimationFrame(renderWaveform);
}

function renderWaveform() {

    if (!ctx || !canvas) {
        requestAnimationFrame(renderWaveform);
        return;
    }

    const rect = canvas.getBoundingClientRect();

    if (rect.width <= 0 || rect.height <= 0) {
        requestAnimationFrame(renderWaveform);
        return;
    }

    // =========================================================
    // CANVAS RESOLUTION
    // =========================================================

    const dpr = window.devicePixelRatio || 1;

    const displayWidth = Math.floor(rect.width);
    const displayHeight = Math.floor(rect.height);

    if (
        canvas.width !== displayWidth * dpr ||
        canvas.height !== displayHeight * dpr
    ) {

        canvas.width = displayWidth * dpr;
        canvas.height = displayHeight * dpr;

        canvas.style.width = `${displayWidth}px`;
        canvas.style.height = `${displayHeight}px`;

        ctx.setTransform(
            dpr,
            0,
            0,
            dpr,
            0,
            0
        );
    }

    const width = displayWidth;
    const height = displayHeight;

    // =========================================================
    // GRAPH CONFIGURATION
    // =========================================================

    const marginLeft = 55;
    const marginRight = 15;
    const marginTop = 15;
    const marginBottom = 35;

    const graphLeft = marginLeft;
    const graphRight = width - marginRight;
    const graphTop = marginTop;
    const graphBottom = height - marginBottom;

    const graphWidth =
        graphRight - graphLeft;

    const graphHeight =
        graphBottom - graphTop;

    // =========================================================
    // DISPLAY WINDOW
    // =========================================================

    /*
     * 200 Hz × 10 seconds = 2000 samples.
     *
     * This is much easier to visually analyse than the
     * previous 60-second compressed display.
     */

    const DISPLAY_SECONDS = 10;

    const DISPLAY_POINTS =
        WAVEFORM_RATE_HZ * DISPLAY_SECONDS;

    // =========================================================
    // CLEAR CANVAS
    // =========================================================

    ctx.clearRect(
        0,
        0,
        width,
        height
    );

    // =========================================================
    // GRAPH BACKGROUND
    // =========================================================

    ctx.fillStyle = "#10171B";

    ctx.fillRect(
        graphLeft,
        graphTop,
        graphWidth,
        graphHeight
    );

    // =========================================================
    // GET ACTIVE NODE
    // =========================================================

    const activeNode = "NODE_01";

    const history =
        triaxialHistory[activeNode];

    if (!history) {
        requestAnimationFrame(renderWaveform);
        return;
    }

    // =========================================================
    // DETERMINE VISIBLE DATA
    // =========================================================

    function getVisibleData(data) {

        if (!Array.isArray(data)) {
            return [];
        }

        if (data.length <= DISPLAY_POINTS) {
            return data.slice();
        }

        return data.slice(
            data.length - DISPLAY_POINTS
        );
    }

    // =========================================================
    // CENTER SIGNAL AROUND ZERO
    // =========================================================

    /*
     * The incoming signal can contain a DC/baseline component.
     *
     * We remove only the display baseline here.
     * The original data stored in triaxialHistory remains
     * unchanged.
     */

    function centerSignal(data) {

        if (!data || data.length === 0) {
            return [];
        }

        let sum = 0;
        let count = 0;

        for (let value of data) {

            const number =
                Number(value);

            if (Number.isFinite(number)) {

                sum += number;
                count++;
            }
        }

        if (count === 0) {
            return [];
        }

        const mean =
            sum / count;

        return data.map(value => {

            const number =
                Number(value);

            if (!Number.isFinite(number)) {
                return 0;
            }

            return number - mean;
        });
    }

    const xData =
        centerSignal(
            getVisibleData(history.x)
        );

    const yData =
        centerSignal(
            getVisibleData(history.y)
        );

    const zData =
        centerSignal(
            getVisibleData(history.z)
        );

    // =========================================================
    // FIND DISPLAY SCALE
    // =========================================================

    let maxAbs = 0;

    function inspectScale(data) {

        for (const value of data) {

            const n = Math.abs(
                Number(value)
            );

            if (Number.isFinite(n)) {
                maxAbs = Math.max(
                    maxAbs,
                    n
                );
            }
        }
    }

    if (axisVisibility.X) inspectScale(xData);
    if (axisVisibility.Y) inspectScale(yData);
    if (axisVisibility.Z) inspectScale(zData);

    /*
     * Keep a sensible minimum scale.
     * Increase automatically for stronger events.
     */

    let scale;

    if (maxAbs < 1) {
        scale = 1;
    }
    else if (maxAbs < 2) {
        scale = 2;
    }
    else if (maxAbs < 5) {
        scale = 5;
    }
    else if (maxAbs < 10) {
        scale = 10;
    }
    else if (maxAbs < 20) {
        scale = 20;
    }
    else {
        scale =
            Math.ceil(maxAbs / 10) * 10;
    }

    const yMin = -scale;
    const yMax = scale;

    // =========================================================
    // GRID
    // =========================================================

    ctx.lineWidth = 1;

    ctx.strokeStyle =
        "rgba(255,255,255,0.08)";

    // Horizontal grid

    const horizontalTicks = 5;

    for (
        let i = 0;
        i <= horizontalTicks;
        i++
    ) {

        const ratio =
            i / horizontalTicks;

        const y =
            graphTop +
            ratio * graphHeight;

        ctx.beginPath();

        ctx.moveTo(
            graphLeft,
            y
        );

        ctx.lineTo(
            graphRight,
            y
        );

        ctx.stroke();
    }

    // Vertical grid

    const verticalTicks = 5;

    for (
        let i = 0;
        i <= verticalTicks;
        i++
    ) {

        const ratio =
            i / verticalTicks;

        const x =
            graphLeft +
            ratio * graphWidth;

        ctx.beginPath();

        ctx.moveTo(
            x,
            graphTop
        );

        ctx.lineTo(
            x,
            graphBottom
        );

        ctx.stroke();
    }

    // =========================================================
    // ZERO LINE
    // =========================================================

    const zeroY =
        graphBottom -
        ((0 - yMin) /
        (yMax - yMin)) *
        graphHeight;

    ctx.strokeStyle =
        "rgba(255,255,255,0.28)";

    ctx.lineWidth = 1.4;

    ctx.beginPath();

    ctx.moveTo(
        graphLeft,
        zeroY
    );

    ctx.lineTo(
        graphRight,
        zeroY
    );

    ctx.stroke();

    // =========================================================
    // Y AXIS LABELS
    // =========================================================

    ctx.font =
        "12px Inter, Arial, sans-serif";

    ctx.fillStyle =
        "rgba(220,230,235,0.75)";

    ctx.textAlign = "right";

    ctx.textBaseline = "middle";

    for (
        let i = 0;
        i <= horizontalTicks;
        i++
    ) {

        const value =
            yMax -
            (i / horizontalTicks) *
            (yMax - yMin);

        const y =
            graphTop +
            (i / horizontalTicks) *
            graphHeight;

        ctx.fillText(
            Number(value.toFixed(1)),
            graphLeft - 8,
            y
        );
    }

    // =========================================================
    // Y UNIT
    // =========================================================

    ctx.save();

    ctx.translate(
        13,
        graphTop + graphHeight / 2
    );

    ctx.rotate(
        -Math.PI / 2
    );

    ctx.textAlign = "center";

    ctx.textBaseline = "middle";

    ctx.font =
        "11px Inter, Arial, sans-serif";

    ctx.fillStyle =
        "rgba(220,230,235,0.60)";

    ctx.fillText(
        "mm/s",
        0,
        0
    );

    ctx.restore();

    // =========================================================
    // TIME AXIS
    // =========================================================

    ctx.font =
        "11px Inter, Arial, sans-serif";

    ctx.fillStyle =
        "rgba(220,230,235,0.60)";

    ctx.textAlign = "center";

    ctx.textBaseline = "top";

    const timeLabels = [
        "-10 s",
        "-7.5 s",
        "-5 s",
        "-2.5 s",
        "0 s"
    ];

    for (
        let i = 0;
        i < timeLabels.length;
        i++
    ) {

        const x =
            graphLeft +
            (i /
            (timeLabels.length - 1)) *
            graphWidth;

        ctx.fillText(
            timeLabels[i],
            x,
            graphBottom + 10
        );
    }

    // =========================================================
    // DRAW WAVEFORM
    // =========================================================

    function drawTrace(
        data,
        lineColor
    ) {

        if (
            !Array.isArray(data) ||
            data.length < 2
        ) {
            return;
        }

        ctx.strokeStyle =
            lineColor;

        ctx.lineWidth = 1.25;

        ctx.lineJoin =
            "round";

        ctx.lineCap =
            "round";

        ctx.beginPath();

        let started = false;

        for (
            let i = 0;
            i < data.length;
            i++
        ) {

            let value =
                Number(data[i]);

            if (!Number.isFinite(value)) {
                continue;
            }

            /*
             * Clip only the display value.
             * The stored data is untouched.
             */

            value =
                Math.max(
                    yMin,
                    Math.min(
                        yMax,
                        value
                    )
                );

            const x =
                graphLeft +
                (i /
                (data.length - 1)) *
                graphWidth;

            const y =
                graphBottom -
                ((value - yMin) /
                (yMax - yMin)) *
                graphHeight;

            if (!started) {

                ctx.moveTo(
                    x,
                    y
                );

                started = true;

            } else {

                ctx.lineTo(
                    x,
                    y
                );
            }
        }

        if (started) {
            ctx.stroke();
        }
    }

    // =========================================================
    // DRAW X / Y / Z
    // =========================================================

    if (axisVisibility.X) {

        drawTrace(
            xData,
            "#2F80ED"
        );
    }

    if (axisVisibility.Y) {

        drawTrace(
            yData,
            "#F2994A"
        );
    }

    if (axisVisibility.Z) {

        drawTrace(
            zData,
            "#10B981"
        );
    }

    // =========================================================
    // LIVE INDICATOR
    // =========================================================

    ctx.font =
        "11px Inter, Arial, sans-serif";

    ctx.textAlign = "right";

    ctx.textBaseline = "top";

    ctx.fillStyle =
        "#10B981";

    ctx.fillText(
        "● LIVE • 200 Hz",
        graphRight - 6,
        graphTop + 5
    );

    // =========================================================
    // CONTINUE REAL-TIME RENDERING
    // =========================================================

    requestAnimationFrame(
        renderWaveform
    );
}

    // ---------------------------------------------------------
    // DRAW WAVEFORM
    // ---------------------------------------------------------

    function drawTrace(dataArray, lineColor, lineWidth = 1.2) {

        if (!Array.isArray(dataArray) || dataArray.length < 2) {
            return;
        }

        /*
         * The dashboard may contain up to 12,000 points
         * because the acquisition rate is 200 Hz.
         *
         * Drawing every point is unnecessary for the screen.
         * We therefore downsample only for DISPLAY.
         *
         * Original data remains untouched.
         */

        const displayPoints = Math.min(
            dataArray.length,
            1000
        );

        const startIndex =
            Math.max(
                0,
                dataArray.length - displayPoints
            );

        const samples =
            dataArray.slice(startIndex);

        if (samples.length < 2) {
            return;
        }

        ctx.strokeStyle = lineColor;
        ctx.lineWidth = lineWidth;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";

        ctx.beginPath();

        for (let i = 0; i < samples.length; i++) {

            let value = Number(samples[i]);

            if (!Number.isFinite(value)) {
                continue;
            }

            // Prevent extreme values from destroying the scale
            value = Math.max(
                Y_MIN,
                Math.min(Y_MAX, value)
            );

            const x =
                graphLeft +
                (i / (samples.length - 1)) *
                graphWidth;

            const y =
                graphBottom -
                ((value - Y_MIN) / (Y_MAX - Y_MIN)) *
                graphHeight;

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }

        ctx.stroke();
    }

    // X-axis
    if (axisVisibility.X) {
        drawTrace(
            history.x,
            "#2F80ED",
            1.3
        );
    }

    // Y-axis
    if (axisVisibility.Y) {
        drawTrace(
            history.y,
            "#F2994A",
            1.3
        );
    }

    // Z-axis
    if (axisVisibility.Z) {
        drawTrace(
            history.z,
            "#10B981",
            1.3
        );
    }

    // ---------------------------------------------------------
    // LIVE INDICATOR
    // ---------------------------------------------------------

    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.font = "11px Inter, Arial, sans-serif";

    ctx.fillStyle = "rgba(16,185,129,0.9)";

    ctx.fillText(
        "● LIVE • 200 Hz",
        graphRight,
        graphTop + 4
    );

    // ---------------------------------------------------------
    // CONTINUE ANIMATION
    // ---------------------------------------------------------

    requestAnimationFrame(renderWaveform);
}

// WebSocket Management
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
            const payload = JSON.parse(event.data);
            handleServerMessage(payload);
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
    } else if (msg.type === "TELEMETRY_UPDATE") {
        const d = msg.data;
        updateNodeUI(d);
        
        if (triaxialHistory[d.node_id]) {
            let history = triaxialHistory[d.node_id];
            
            if (Array.isArray(d.wave_x) && Array.isArray(d.wave_y) && Array.isArray(d.wave_z) && d.wave_x.length > 0) {
                history.x.push(...d.wave_x);
                history.y.push(...d.wave_y);
                history.z.push(...d.wave_z);
                
                if (history.x.length > maxHistoryPoints) history.x.splice(0, history.x.length - maxHistoryPoints);
                if (history.y.length > maxHistoryPoints) history.y.splice(0, history.y.length - maxHistoryPoints);
                if (history.z.length > maxHistoryPoints) history.z.splice(0, history.z.length - maxHistoryPoints);
            } else {
                history.x.shift();
                history.x.push(d.vib_x || d.vibration_val * 0.58);
                
                history.y.shift();
                history.y.push(d.vib_y || d.vibration_val * 0.52);
                
                history.z.shift();
                history.z.push(d.vib_z || d.vibration_val * 0.63);
            }
        }
        
        if (msg.alert) {
            triggerAlertUI(msg.alert);
        }
    }
}

function safeNum(val, fallback = 0.0) {
    const n = parseFloat(val);
    return isNaN(n) ? fallback : n;
}

function updateNodeUI(node) {
    const nodeId = node.node_id;
    
    const vx = safeNum(node.vib_x, safeNum(node.vibration_val, 0.3) * 0.58);
    const vy = safeNum(node.vib_y, safeNum(node.vibration_val, 0.3) * 0.52);
    const vz = safeNum(node.vib_z, safeNum(node.vibration_val, 0.3) * 0.63);
    const vmag = safeNum(node.vibration_val, Math.sqrt(vx*vx + vy*vy + vz*vz));
    
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
            pill.innerHTML = `⚡ ESP32 HARDWARE <br/><span style='font-size:0.65rem; opacity:0.9;'>REAL-TIME | Rate: ${node.sample_rate_hz || 200} Hz | Block: ${node.block_id || 0} Chunk: ${(node.chunk_id || 0)+1}/4</span>`;
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
    
    // Update TDOA Map Box
    const tdoaVec = document.getElementById("tdoaVectorText");
    if (tdoaVec) tdoaVec.textContent = alert.direction;
    
    const nearestEl = document.getElementById("nearestNodeText");
    if (nearestEl && alert.nearest_label) nearestEl.textContent = `${alert.nearest_label}`;
    
    // Update TDOA Delays on Node Cards
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

// STFT Spectrogram Modal Logic
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
    if (!stftCanvas) return;
    stftCtx = stftCanvas.getContext("2d");
    
    const rect = stftCanvas.parentElement.getBoundingClientRect();
    stftCanvas.width = rect.width - 60;
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
    
    stftCtx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    stftCtx.lineWidth = 1;
    for (let f = 10; f < 50; f += 10) {
        const y = h - (f / 50.0) * h;
        stftCtx.beginPath();
        stftCtx.moveTo(0, y);
        stftCtx.lineTo(w, y);
        stftCtx.stroke();
        
        stftCtx.fillStyle = "rgba(255, 255, 255, 0.7)";
        stftCtx.font = "10px Inter";
        stftCtx.fillText(`${f} Hz`, 6, y - 3);
    }
}

function intensityToSpectrogramColor(val) {
    if (val < 0.15) {
        return `#050811`;
    } else if (val < 0.35) {
        const r = Math.floor((val - 0.15) / 0.2 * 139);
        const g = Math.floor((val - 0.15) / 0.2 * 92 + 92);
        const b = 246;
        return `rgb(${r}, ${g}, ${b})`;
    } else if (val < 0.6) {
        const r = 239;
        const g = Math.floor((1 - (val - 0.35) / 0.25) * 100);
        const b = 68;
        return `rgb(${r}, ${g}, ${b})`;
    } else if (val < 0.85) {
        const r = 245;
        const g = Math.floor((val - 0.6) / 0.25 * 158 + 50);
        const b = 11;
        return `rgb(${r}, ${g}, ${b})`;
    } else {
        return `#FFFFFF`;
    }
}

// Action Triggers
async function triggerSimulation(type = "INBOUND_NW") {
    try {
        await fetch("/api/simulate/intrusion", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: type })
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
