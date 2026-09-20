// Elephant Intrusion Detection System - Frontend Client Logic
// Triangular TDOA Mapping + Live Triaxial Geophone Waveform

let ws;
let canvas, ctx;
let stftCanvas, stftCtx;

const WAVEFORM_RATE_HZ = 200;

const ADC_ALERT_THRESHOLD = 2500;

const SIMULATION_DURATION_MS = 20000;

const SIMULATION_SAMPLE_INTERVAL_MS =
    1000 / WAVEFORM_RATE_HZ;

let simulationActive = false;

let simulationNodeId = null;

let simulationStartTime = 0;

let simulationSampleTimer = null;

let simulationAnimationFrame = null;

let simulationSampleIndex = 0;

let simulationType = "elephant";

let simulationPeakADC = 0;

let simulationImpacts = [];

/*
 * ===============================================================
 * DYNAMIC ENVIRONMENTAL BASELINE GENERATOR
 * ===============================================================
 * No fixed baseline. Contains slow multi-harmonic drift,
 * ambient ground vibration, random pink/white noise, and occasional
 * micro-disturbances.
 * X, Y, and Z are computed independently with out-of-phase drift,
 * different vibration frequencies, and independent noise so they
 * continuously cross each other.
 */
function generateDynamicBackground(t, axis = "x") {
    // 1. Slow drift: unique phase (120 deg apart) & frequencies per axis
    let drift = 0;
    if (axis === "x") {
        drift = 320 + 85 * Math.sin(2 * Math.PI * 0.045 * t + 0.0)
                    + 42 * Math.sin(2 * Math.PI * 0.11 * t + 1.2)
                    + 25 * Math.cos(2 * Math.PI * 0.02 * t);
    } else if (axis === "y") {
        drift = 320 + 85 * Math.sin(2 * Math.PI * 0.045 * t + 2.094)
                    + 42 * Math.sin(2 * Math.PI * 0.11 * t + 3.3)
                    + 25 * Math.cos(2 * Math.PI * 0.023 * t + 1.5);
    } else { // "z"
        drift = 320 + 85 * Math.sin(2 * Math.PI * 0.045 * t + 4.188)
                    + 42 * Math.sin(2 * Math.PI * 0.11 * t + 5.4)
                    + 25 * Math.sin(2 * Math.PI * 0.017 * t + 2.8);
    }

    // 2. Natural ambient ground vibration: independent non-harmonic multi-tone
    let groundVib = 0;
    if (axis === "x") {
        groundVib = 36 * Math.sin(2 * Math.PI * 2.3 * t + 0.8)
                  + 22 * Math.sin(2 * Math.PI * 5.7 * t + 1.4)
                  + 14 * Math.sin(2 * Math.PI * 11.2 * t + 0.2);
    } else if (axis === "y") {
        groundVib = 36 * Math.sin(2 * Math.PI * 2.7 * t + 2.1)
                  + 22 * Math.sin(2 * Math.PI * 5.2 * t + 0.3)
                  + 14 * Math.sin(2 * Math.PI * 12.8 * t + 1.7);
    } else { // "z"
        groundVib = 36 * Math.sin(2 * Math.PI * 2.1 * t + 3.7)
                  + 22 * Math.sin(2 * Math.PI * 6.1 * t + 2.9)
                  + 14 * Math.sin(2 * Math.PI * 10.5 * t + 0.9);
    }

    // 3. Occasional small ambient micro-disturbances
    const microPulseTime = t % 4.1;
    let microDisturbance = 0;
    if (microPulseTime < 0.25) {
        const pEnv = Math.exp(-microPulseTime / 0.06);
        if (axis === "x") microDisturbance = 45 * pEnv * Math.sin(2 * Math.PI * 18 * microPulseTime);
        else if (axis === "y") microDisturbance = 55 * pEnv * Math.sin(2 * Math.PI * 21 * microPulseTime + 1.0);
        else microDisturbance = 40 * pEnv * Math.sin(2 * Math.PI * 16 * microPulseTime + 2.0);
    }

    // 4. Independent random sensor jitter
    const sensorNoise = (Math.random() - 0.5) * 55;

    return drift + groundVib + microDisturbance + sensorNoise;
}

/*
 * ===============================================================
 * IRREGULAR TRANSIENT IMPACT GENERATOR
 * ===============================================================
 * Each impact has irregular timing, varying amplitude, and independent
 * coupling weights for X, Y, and Z so axes naturally cross during impacts.
 */
function createSimulationImpacts(species = "elephant") {
    const impacts = [];
    let tCur = 1.9;
    const endEventTime = 8.6;

    let baseAmpMin = 2400, baseAmpMax = 3600;
    let widthMin = 0.07, widthMax = 0.12;
    let freqMin = 20, freqMax = 28;
    let stepMin = 0.65, stepMax = 1.10;

    if (species === "human") {
        baseAmpMin = 500;
        baseAmpMax = 1100;
        widthMin = 0.04;
        widthMax = 0.075;
        freqMin = 30;
        freqMax = 42;
        stepMin = 0.55;
        stepMax = 0.95;
    } else if (species === "bovid") {
        baseAmpMin = 1250;
        baseAmpMax = 1850;
        widthMin = 0.05;
        widthMax = 0.09;
        freqMin = 24;
        freqMax = 36;
        stepMin = 0.50;
        stepMax = 0.85;
    }

    const variations = [0.8, 0.9, 1.0, 1.15, 0.85, 0.95, 1.05];

    while (tCur < endEventTime) {
        const ampVariation = variations[impacts.length % variations.length];
        const amp = (baseAmpMin + Math.random() * (baseAmpMax - baseAmpMin)) * ampVariation;

        // Independent X, Y, Z coupling weights: random dominant axis per impact
        const weights = [
            0.45 + Math.random() * 0.20,
            0.65 + Math.random() * 0.20,
            0.92 + Math.random() * 0.08
        ];
        for (let j = weights.length - 1; j > 0; j--) {
            const k = Math.floor(Math.random() * (j + 1));
            [weights[j], weights[k]] = [weights[k], weights[j]];
        }

        impacts.push({
            center: tCur,
            amplitude: amp,
            width: widthMin + Math.random() * (widthMax - widthMin),
            wx: weights[0],
            wy: weights[1],
            wz: weights[2],
            freq_x: freqMin + Math.random() * (freqMax - freqMin),
            freq_y: freqMin + Math.random() * (freqMax - freqMin),
            freq_z: freqMin + Math.random() * (freqMax - freqMin)
        });

        tCur += stepMin + Math.random() * (stepMax - stepMin);
    }

    return impacts;
}

const SIMULATION_ALARM_DURATION_MS = 10000;

let simulationAlarmTimer = null;

let simulationSirenInterval = null;

let simulationAudioCtx = null;

const ALERT_COOLDOWN_MS = 5000;

let lastElephantAlertTime = 0;

let elephantAlertActive = false;
const WAVEFORM_HISTORY_SECONDS = 20;
const maxHistoryPoints = WAVEFORM_RATE_HZ * WAVEFORM_HISTORY_SECONDS;
const WAVEFORM_DISPLAY_SECONDS = 10;
const WAVEFORM_DISPLAY_POINTS = WAVEFORM_RATE_HZ * WAVEFORM_DISPLAY_SECONDS;

const WAVEFORM_UPDATE_INTERVAL_MS = 50;
let lastWaveformRenderTime = 0;

let currentStftNode = "NODE_01";
let currentStftIntrusion = false;
let waveformNode = "NODE_01";

let axisVisibility = {
    X: true,
    Y: true,
    Z: true
};

let triaxialHistory = {
    "NODE_01": { x: [], y: [], z: [], timestamps: [] },
    "NODE_02": { x: [], y: [], z: [], timestamps: [] },
    "NODE_03": { x: [], y: [], z: [], timestamps: [] }
};

function createInitialHistory() {

    for (const nodeId of Object.keys(triaxialHistory)) {

        triaxialHistory[nodeId].x = [];
        triaxialHistory[nodeId].y = [];
        triaxialHistory[nodeId].z = [];
        triaxialHistory[nodeId].timestamps = [];

        for (let i = 0; i < maxHistoryPoints; i++) {
            const t = (i - maxHistoryPoints) / WAVEFORM_RATE_HZ;
            triaxialHistory[nodeId].x.push(
                Math.round(Math.max(0, Math.min(5000, generateDynamicBackground(t, "x"))))
            );
            triaxialHistory[nodeId].y.push(
                Math.round(Math.max(0, Math.min(5000, generateDynamicBackground(t, "y"))))
            );
            triaxialHistory[nodeId].z.push(
                Math.round(Math.max(0, Math.min(5000, generateDynamicBackground(t, "z"))))
            );
            triaxialHistory[nodeId].timestamps.push(null);
        }
    }
}

let ambientBackgroundTimer = null;
let ambientSampleTime = 0;

function startAmbientBackgroundGenerator() {
    if (ambientBackgroundTimer) return;
    ambientBackgroundTimer = setInterval(() => {
        if (simulationActive) return;

        for (const nid of Object.keys(triaxialHistory)) {
            const h = triaxialHistory[nid];
            if (!h) continue;

            for (let s = 0; s < 10; s++) {
                const t = ambientSampleTime + (s / WAVEFORM_RATE_HZ);
                const x = Math.max(0, Math.min(5000, generateDynamicBackground(t, "x")));
                const y = Math.max(0, Math.min(5000, generateDynamicBackground(t, "y")));
                const z = Math.max(0, Math.min(5000, generateDynamicBackground(t, "z")));

                h.x.push(x);
                h.y.push(y);
                h.z.push(z);

                const maxSamples = WAVEFORM_RATE_HZ * WAVEFORM_DISPLAY_SECONDS;
                while (h.x.length > maxSamples) h.x.shift();
                while (h.y.length > maxSamples) h.y.shift();
                while (h.z.length > maxSamples) h.z.shift();

                if (h.timestamps) {
                    h.timestamps.push(Date.now() / 1000);
                    while (h.timestamps.length > maxSamples) h.timestamps.shift();
                }
            }
        }
        ambientSampleTime += 10 / WAVEFORM_RATE_HZ;
    }, 50);
}

createInitialHistory();

document.addEventListener("DOMContentLoaded", () => {
    initCanvas();
    initWaveformNodeSelector();
    initWebSocket();
    initSimulationButtons();
    startAmbientBackgroundGenerator();
});

function initSimulationButtons() {
    document
        .getElementById("simulateElephantBtn")
        ?.addEventListener("click", () => {
            triggerSpeciesSimulation("elephant");
        });

    document
        .getElementById("simulateHumanBtn")
        ?.addEventListener("click", () => {
            triggerSpeciesSimulation("human");
        });

    document
        .getElementById("simulateBovidBtn")
        ?.addEventListener("click", () => {
            triggerSpeciesSimulation("bovid");
        });
}

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


function renderWaveform(timestamp = 0) {

    if (!canvas || !ctx) {
        requestAnimationFrame(renderWaveform);
        return;
    }

    if (
        !simulationActive &&
        lastWaveformRenderTime !== 0 &&
        timestamp - lastWaveformRenderTime <
            WAVEFORM_UPDATE_INTERVAL_MS
    ) {
        requestAnimationFrame(renderWaveform);
        return;
    }

    lastWaveformRenderTime =
        timestamp;

    const rect =
        canvas.getBoundingClientRect();

    if (
        rect.width <= 0 ||
        rect.height <= 0
    ) {
        requestAnimationFrame(renderWaveform);
        return;
    }

    resizeWaveformCanvas();

    const width = rect.width;
    const height = rect.height;

    const marginLeft = 58;
    const marginRight = 18;
    const marginTop = 18;
    const marginBottom = 42;

    const graphLeft =
        marginLeft;

    const graphRight =
        width - marginRight;

    const graphTop =
        marginTop;

    const graphBottom =
        height - marginBottom;

    const graphWidth =
        graphRight - graphLeft;

    const graphHeight =
        graphBottom - graphTop;


    /*
     * CLEAR GRAPH
     */

    ctx.clearRect(
        0,
        0,
        width,
        height
    );

    ctx.fillStyle =
        "#10171B";

    ctx.fillRect(
        graphLeft,
        graphTop,
        graphWidth,
        graphHeight
    );


    const history =
        triaxialHistory[
            waveformNode
        ];

    if (!history) {
        requestAnimationFrame(
            renderWaveform
        );
        return;
    }


    /*
     * LAST 10 SECONDS OF DATA
     */

    const xData =
        getVisibleData(
            history.x
        );

    const yData =
        getVisibleData(
            history.y
        );

    const zData =
        getVisibleData(
            history.z
        );


    /*
     * FIXED ADC AMPLITUDE SCALE
     *
     * Y AXIS:
     *
     * 0
     * 1000
     * 2000
     * 3000
     * 4000
     * 5000
     */

    const yMin = 0;
    const yMax = 5000;


    /*
     * GRID
     */

    ctx.lineWidth = 1;

    ctx.strokeStyle =
        "rgba(255,255,255,0.08)";


    /*
     * HORIZONTAL GRID
     */

    const horizontalTicks = 5;

    for (
        let i = 0;
        i <= horizontalTicks;
        i++
    ) {

        const y =
            graphBottom -
            (i / horizontalTicks) *
                graphHeight;

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


    /*
     * VERTICAL GRID
     */

    const verticalTicks = 5;

    for (
        let i = 0;
        i <= verticalTicks;
        i++
    ) {

        const x =
            graphLeft +
            (i / verticalTicks) *
                graphWidth;

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


    /*
     * Y AXIS LABELS
     *
     * ADC AMPLITUDE
     */

    ctx.font =
        "12px Inter, Arial, sans-serif";

    ctx.fillStyle =
        "rgba(220,230,235,0.72)";

    ctx.textAlign =
        "right";

    ctx.textBaseline =
        "middle";


    for (
        let i = 0;
        i <= horizontalTicks;
        i++
    ) {

        const value =
            i * 1000;

        const y =
            graphBottom -
            (value / 5000) *
                graphHeight;

        ctx.fillText(
            `${value}`,
            graphLeft - 8,
            y
        );
    }



    /*
     * IMPORTANT:
     * NO "mm/s" LABEL.
     *
     * The previous mm/s label has
     * intentionally been removed.
     */


    /*
     * REAL-TIME X-AXIS
     */

    ctx.font =
        "11px Inter, Arial, sans-serif";

    ctx.fillStyle =
        "rgba(220,230,235,0.60)";

    ctx.textAlign =
        "center";

    ctx.textBaseline =
        "top";


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
            (i / (timeLabels.length - 1)) *
            graphWidth;

        ctx.fillText(
            timeLabels[i],
            x,
            graphBottom + 10
        );
    }


    /*
     * DRAW WAVEFORM
     */

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

        const displayCount =
            Math.min(
                data.length,
                Math.max(
                    300,
                    Math.floor(
                        graphWidth * 1.5
                    )
                )
            );

        const stride =
            Math.max(
                1,
                Math.floor(
                    data.length /
                        displayCount
                )
            );


        ctx.beginPath();

        ctx.strokeStyle =
            lineColor;

        ctx.lineWidth =
            1.35;

        ctx.lineJoin =
            "round";

        ctx.lineCap =
            "round";


        let started =
            false;


        for (
            let index = 0;
            index < data.length;
            index += stride
        ) {

            let value =
                Number(
                    data[index]
                );

            if (
                !Number.isFinite(value)
            ) {
                continue;
            }


            /*
             * ADC RANGE
             *
             * Keep values inside
             * 0 - 5000.
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
                (index /
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


        /*
         * Always draw final sample.
         */

        const lastIndex =
            data.length - 1;

        if (
            lastIndex >= 0
        ) {

            const lastValue =
                Number(
                    data[lastIndex]
                );

            if (
                Number.isFinite(
                    lastValue
                )
            ) {

                const value =
                    Math.max(
                        yMin,
                        Math.min(
                            yMax,
                            lastValue
                        )
                    );


                const x =
                    graphRight;


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

                } else {

                    ctx.lineTo(
                        x,
                        y
                    );
                }
            }
        }


        if (started) {
            ctx.stroke();
        }
    }


    /*
     * X CHANNEL
     */

    if (axisVisibility.X) {

        drawTrace(
            xData,
            "#2F80ED"
        );
    }


    /*
     * Y CHANNEL
     */

    if (axisVisibility.Y) {

        drawTrace(
            yData,
            "#F2994A"
        );
    }


    /*
     * Z CHANNEL
     */

    if (axisVisibility.Z) {

        drawTrace(
            zData,
            "#10B981"
        );
    }


    /*
     * GRAPH TOP LABEL
     */

    ctx.font =
        "11px Inter, Arial, sans-serif";

    ctx.textBaseline =
        "top";

    ctx.textAlign =
        "left";

    ctx.fillStyle =
        "rgba(220,230,235,0.60)";


    ctx.fillText(
        `${waveformNode.replace(
            "NODE_",
            "G"
        )} • ${WAVEFORM_DISPLAY_SECONDS}s VIEW`,
        graphLeft + 8,
        graphTop + 5
    );


    /*
     * LIVE INDICATOR
     */

    ctx.textAlign =
        "right";

    ctx.fillStyle =
        "#10B981";


    ctx.fillText(
        `● LIVE • ${WAVEFORM_RATE_HZ} Hz`,
        graphRight - 6,
        graphTop + 5
    );


    requestAnimationFrame(
        renderWaveform
    );
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

        /*
         * =========================================================
         * ADC THRESHOLD DETECTION
         * =========================================================
         *
         * If any waveform sample crosses 2000 ADC,
         * immediately trigger the elephant alert.
         */

        let waveformMax =
            0;

        let triggeringSensor =
            d.node_id || "NODE_01";


        if (
            Array.isArray(d.wave_x)
        ) {

            waveformMax =
                Math.max(
                    waveformMax,
                    ...d.wave_x
                        .map(Number)
                        .filter(
                            Number.isFinite
                        )
                );
        }


        if (
            Array.isArray(d.wave_y)
        ) {

            waveformMax =
                Math.max(
                    waveformMax,
                    ...d.wave_y
                        .map(Number)
                        .filter(
                            Number.isFinite
                        )
                );
        }


        if (
            Array.isArray(d.wave_z)
        ) {

            waveformMax =
                Math.max(
                    waveformMax,
                    ...d.wave_z
                        .map(Number)
                        .filter(
                            Number.isFinite
                        )
                );
        }


        /*
         * Also check the current scalar
         * vibration values if waveform blocks
         * are not available.
         */

        waveformMax =
            Math.max(
                waveformMax,
                Math.abs(
                    safeNum(
                        d.vib_x,
                        0
                    )
                ),
                Math.abs(
                    safeNum(
                        d.vib_y,
                        0
                    )
                ),
                Math.abs(
                    safeNum(
                        d.vib_z,
                        0
                    )
                )
            );


        /*
         * TRIGGER AT ADC THRESHOLD
         */

        if (
            !simulationActive &&
            waveformMax >=
            ADC_ALERT_THRESHOLD
        ) {

            showElephantDetectedAlert({

                sensor:
                    triggeringSensor,

                trigger:
                    "ADC Threshold Exceeded",

                description:
                    `Ground vibration exceeded ${ADC_ALERT_THRESHOLD} ADC.`
            });
        }

        updateNodeUI(d);

        const nodeId = d.node_id;

        if (triaxialHistory[nodeId]) {

            if (
                simulationActive &&
                nodeId === simulationNodeId
            ) {
                /*
                 * Do not overwrite the simulated waveform
                 * with incoming live telemetry while simulation
                 * is running.
                 */
            } else {

                const history =
                    triaxialHistory[nodeId];

            if (
                Array.isArray(d.wave_x) &&
                Array.isArray(d.wave_y) &&
                Array.isArray(d.wave_z) &&
                d.wave_x.length > 0
            ) {

                const sampleCount =
                    Math.min(
                        d.wave_x.length,
                        d.wave_y.length,
                        d.wave_z.length
                    );

                const sampleRate =
                    safeNum(
                        d.sample_rate_hz,
                        WAVEFORM_RATE_HZ
                    );

                /*
                 * Backend timestamp represents
                 * the time at which this waveform
                 * packet reached the backend.
                 *
                 * We treat it as the timestamp
                 * of the last sample in this block.
                 */

                const packetEndTime =
                    safeNum(
                        d.timestamp,
                        Date.now() / 1000
                    );

                const blockDuration =
                    sampleCount /
                    sampleRate;

                const packetStartTime =
                    packetEndTime -
                    blockDuration;


                for (
                    let i = 0;
                    i < sampleCount;
                    i++
                ) {

                    history.x.push(
                        Number(d.wave_x[i])
                    );

                    history.y.push(
                        Number(d.wave_y[i])
                    );

                    history.z.push(
                        Number(d.wave_z[i])
                    );


                    /*
                     * Calculate the real timestamp
                     * of each sample.
                     */

                    const sampleTimestamp =
                        packetStartTime +
                        (i / sampleRate);

                    history.timestamps.push(
                        sampleTimestamp
                    );
                }


                /*
                 * Keep only the configured
                 * waveform history length.
                 */

                if (
                    history.x.length >
                    maxHistoryPoints
                ) {

                    const removeCount =
                        history.x.length -
                        maxHistoryPoints;

                    history.x.splice(
                        0,
                        removeCount
                    );

                    history.y.splice(
                        0,
                        removeCount
                    );

                    history.z.splice(
                        0,
                        removeCount
                    );

                    history.timestamps.splice(
                        0,
                        removeCount
                    );
                }


            } else {

                /*
                 * Fallback when a complete
                 * waveform block is not available.
                 */

                const currentTime =
                    safeNum(
                        d.timestamp,
                        Date.now() / 1000
                    );


                history.x.push(
                    safeNum(
                        d.vib_x,
                        safeNum(
                            d.vibration_val,
                            0
                        )
                    )
                );

                history.y.push(
                    safeNum(
                        d.vib_y,
                        safeNum(
                            d.vibration_val,
                            0
                        )
                    )
                );

                history.z.push(
                    safeNum(
                        d.vib_z,
                        safeNum(
                            d.vibration_val,
                            0
                        )
                    )
                );

                history.timestamps.push(
                    currentTime
                );


                if (
                    history.x.length >
                    maxHistoryPoints
                ) {

                    history.x.shift();
                    history.y.shift();
                    history.z.shift();
                    history.timestamps.shift();
                }
            }
        }
    }

        if (msg.alert) {
            triggerAlertUI(
                msg.alert
            );
        }

        return;
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
            pill.textContent = "ONLINE";
            pill.className = "node-pill online";
            pill.style = "";
        }
    }
}

function showElephantDetectedAlert({
    sensor = "G1",
    trigger = "ADC Threshold Exceeded",
    description = ""
} = {}) {

    const now =
        Date.now();


    /*
     * Prevent continuous waveform samples
     * above the threshold from repeatedly
     * triggering the alarm.
     */

    if (
        trigger !== "Elephant Detection" &&
        now -
        lastElephantAlertTime <
        ALERT_COOLDOWN_MS
    ) {
        return;
    }


    lastElephantAlertTime =
        now;

    elephantAlertActive =
        true;


    const alert =
        document.getElementById(
            "elephantDetectionAlert"
        );


    const title =
        document.getElementById(
            "elephantAlertTitle"
        );


    const desc =
        document.getElementById(
            "elephantAlertDescription"
        );


    const timeEl =
        document.getElementById(
            "elephantAlertTime"
        );


    const triggerEl =
        document.getElementById(
            "elephantAlertTrigger"
        );


    const sensorEl =
        document.getElementById(
            "elephantAlertSensor"
        );


    if (!alert) {
        return;
    }


    alert.classList.remove(
        "hidden"
    );


    if (title) {

        title.textContent =
            "ELEPHANT DETECTED!";
    }


    if (desc) {

        desc.textContent =
            "";
        desc.style.display =
            "none";
    }


    if (timeEl) {

        timeEl.textContent =
            new Date()
                .toLocaleTimeString();
    }


    if (triggerEl) {

        triggerEl.textContent =
            trigger;
    }


    if (sensorEl) {

        sensorEl.textContent =
            sensor.replace(
                "NODE_",
                "G"
            );
    }


    /*
     * ACTIVATE ALARM
     */

    if (trigger !== "Elephant Detection") {
        playAlertSound();
    }
}

function hideElephantDetectedAlert() {

    const alert =
        document.getElementById(
            "elephantDetectionAlert"
        );

    if (alert) {

        alert.classList.add(
            "hidden"
        );
    }

    elephantAlertActive =
        false;
}

function showSpeciesDetectionAlert(type) {

    const alert =
        document.getElementById(
            "elephantDetectionAlert"
        );

    const title =
        document.getElementById(
            "elephantAlertTitle"
        );

    const description =
        document.getElementById(
            "elephantAlertDescription"
        );

    const trigger =
        document.getElementById(
            "elephantAlertTrigger"
        );

    /*
     * IMPORTANT:
     * Do NOT show sensor name.
     */

    const sensor =
        document.getElementById(
            "elephantAlertSensor"
        );

    if (!alert) {
        return;
    }

    alert.classList.remove(
        "hidden"
    );

    if (type === "elephant") {

        if (title) {
            title.textContent =
                "ELEPHANT DETECTED!";
        }

        if (trigger) {
            trigger.textContent =
                "Elephant Detection";
        }

    }

    else if (
        type === "human"
    ) {

        if (title) {
            title.textContent =
                "HUMAN DETECTED!";
        }

        if (trigger) {
            trigger.textContent =
                "Human Detection";
        }

    }

    else if (
        type === "bovid"
    ) {

        if (title) {
            title.textContent =
                "BOVID DETECTED!";
        }

        if (trigger) {
            trigger.textContent =
                "Bovid Detection";
        }

    }

    /*
     * NO EXTRA DESCRIPTION
     */

    if (description) {
        description.textContent =
            "";
        description.style.display =
            "none";
    }

    /*
     * REMOVE SENSOR NAME FROM ALERT.
     */

    if (sensor) {

        sensor.textContent =
            "";

        if (sensor.parentElement) {
            sensor.parentElement.style.display =
                "none";
        }
    }

    const time =
        document.getElementById(
            "elephantAlertTime"
        );

    if (time) {

        time.textContent =
            new Date()
                .toLocaleTimeString();
    }
}

function testAlarmSound() {

    playAlertSound();

}

function triggerAlertUI(alert) {

    /*
     * MAIN ELEPHANT ALERT
     */

    showElephantDetectedAlert({

        sensor:
            alert.latest_node ||
            alert.nearest_node ||
            "NODE_01",

        trigger:
            "TDOA / Fusion Detection",

        description:
            alert.details ||
            "Elephant intrusion detected by the geophone sensor array."
    });


    /*
     * TDOA VECTOR
     */

    const tdoaVec =
        document.getElementById(
            "tdoaVectorText"
        );

    if (tdoaVec) {

        tdoaVec.textContent =
            "Localized Activity";
    }


    /*
     * NEAREST SENSOR
     */

    const nearestEl =
        document.getElementById(
            "nearestNodeText"
        );

    if (
        nearestEl &&
        alert.nearest_node
    ) {

        nearestEl.textContent =
            alert.nearest_node
                .replace(
                    "NODE_",
                    "G"
                );
    }


    /*
     * TDOA DELAYS
     */

    if (
        alert.tdoa_delays
    ) {

        Object.keys(
            alert.tdoa_delays
        ).forEach(
            nid => {

                const tEl =
                    document.getElementById(
                        `tdoa_${nid}`
                    );

                if (tEl) {

                    const val =
                        alert.tdoa_delays[
                            nid
                        ];

                    tEl.innerHTML =
                        `${
                            val < 900
                                ? val.toFixed(1)
                                : "--"
                        }
                        <span
                            style="
                                font-size:0.75rem;
                            "
                        >
                            ms
                        </span>`;
                }
            }
        );
    }


    /*
     * HIGHLIGHT TRIGGERING NODE
     */

    if (
        alert.latest_node
    ) {

        const trailNode =
            document.getElementById(
                `trail_${alert.latest_node}`
            );

        if (trailNode) {

            trailNode.classList.add(
                "active"
            );
        }
    }


    /*
     * Refresh fusion log
     */

    fetchAlerts();
}

function updateAlertsTable(alerts) {
    const tbody = document.getElementById("alertsTableBody");
    if (!tbody) return;

    if (!alerts || alerts.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No intrusion alerts recorded.</td></tr>`;
        return;
    }

    tbody.innerHTML = alerts.map(a => {
        const dateStr = new Date(a.timestamp * 1000).toLocaleTimeString();
        const mainNode = a.nearest_node || (a.trigger_nodes ? a.trigger_nodes.split(" -> ")[0] : "NODE_01");
        return `
            <tr class="clickable-row" onclick="openSTFTModal('${mainNode}', true)" title="Click to view STFT Spectrogram for this event">
                <td>${dateStr}</td>
                <td><strong>${a.trigger_nodes}</strong></td>
                <td><span class="threat-badge ${a.threat_level}">${a.threat_level}</span></td>
                <td><strong>${a.confidence}%</strong></td>
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

function startLiveSimulationWaveform(
    nodeId = "NODE_02",
    type = "elephant"
) {

    stopLiveSimulationWaveform();

    waveformNode =
        nodeId;

    if (typeof selectWaveformNode === "function") {
        selectWaveformNode(nodeId);
    }

    simulationNodeId =
        nodeId;

    simulationType =
        type;

    simulationActive =
        true;

    simulationStartTime =
        performance.now();

    simulationSampleIndex =
        0;

    simulationPeakADC =
        0;

    /*
     * Clear previous waveform.
     */

    const history =
        triaxialHistory[nodeId];

    if (!history) {
        return;
    }

    history.x.length = 0;
    history.y.length = 0;
    history.z.length = 0;

    if (history.timestamps) {
        history.timestamps.length = 0;
    }

    /*
     * Pre-fill the 10-second rolling display window with dynamic background
     * so that the waveform graph begins with natural ambient ground vibration
     * rather than an empty canvas or flat zero.
     */
    const prefillSamples =
        WAVEFORM_RATE_HZ * WAVEFORM_DISPLAY_SECONDS;

    for (let i = 0; i < prefillSamples; i++) {
        const tPre = (i - prefillSamples) / WAVEFORM_RATE_HZ;
        history.x.push(Math.round(Math.max(0, Math.min(5000, generateDynamicBackground(tPre, "x")))));
        history.y.push(Math.round(Math.max(0, Math.min(5000, generateDynamicBackground(tPre, "y")))));
        history.z.push(Math.round(Math.max(0, Math.min(5000, generateDynamicBackground(tPre, "z")))));
        if (history.timestamps) {
            history.timestamps.push(null);
        }
    }

    /*
     * Generate random impact locations for
     * this species simulation.
     */

    simulationImpacts =
        createSimulationImpacts(
            type
        );

    /*
     * Start 200-Hz live sample generation.
     */

    simulationSampleTimer =
        setInterval(
            generateLiveSimulationSample,
            SIMULATION_SAMPLE_INTERVAL_MS
        );

    /*
     * Continuously redraw the graph.
     */

    simulationAnimationFrame =
        requestAnimationFrame(
            animateSimulationWaveform
        );

}

function animateSimulationWaveform() {

    if (
        !simulationActive
    ) {
        return;
    }

    renderWaveform();

    simulationAnimationFrame =
        requestAnimationFrame(
            animateSimulationWaveform
        );

}

function generateLiveSimulationSample() {

    if (
        !simulationActive ||
        !simulationNodeId
    ) {
        return;
    }

    const history =
        triaxialHistory[
            simulationNodeId
        ];

    if (!history) {
        return;
    }

    const elapsed =
        performance.now() -
        simulationStartTime;

    /*
     * EXACTLY 20 SECOND SIMULATION
     */

    if (
        elapsed >=
        SIMULATION_DURATION_MS
    ) {

        stopLiveSimulationWaveform();

        return;
    }

    const t =
        simulationSampleIndex /
        WAVEFORM_RATE_HZ;

    simulationSampleIndex++;

    /*
     * -------------------------------------------------------
     * DYNAMIC BASELINE & TRANSIENT IMPACTS
     * -------------------------------------------------------
     */

    const bgX = generateDynamicBackground(t, "x");
    const bgY = generateDynamicBackground(t, "y");
    const bgZ = generateDynamicBackground(t, "z");

    let eventX = 0;
    let eventY = 0;
    let eventZ = 0;

    for (const impact of simulationImpacts) {
        const distance = t - impact.center;
        if (Math.abs(distance) > impact.width * 4.0) {
            continue;
        }

        const envelope = Math.exp(-Math.abs(distance) / impact.width);
        const ringX = Math.sin(2 * Math.PI * impact.freq_x * distance);
        const ringY = Math.sin(2 * Math.PI * impact.freq_y * distance);
        const ringZ = Math.sin(2 * Math.PI * impact.freq_z * distance);

        eventX += impact.amplitude * impact.wx * envelope * (0.55 + 0.45 * ringX);
        eventY += impact.amplitude * impact.wy * envelope * (0.55 + 0.45 * ringY);
        eventZ += impact.amplitude * impact.wz * envelope * (0.55 + 0.45 * ringZ);
    }

    const xADC = Math.round(Math.max(0, Math.min(5000, bgX + eventX)));
    const yADC = Math.round(Math.max(0, Math.min(5000, bgY + eventY)));
    const zADC = Math.round(Math.max(0, Math.min(5000, bgZ + eventZ)));

    /*
     * -------------------------------------------------------
     * APPEND NEW SAMPLE
     * -------------------------------------------------------
     */

    history.x.push(xADC);

    history.y.push(yADC);

    history.z.push(zADC);

    /*
     * -------------------------------------------------------
     * KEEP ROLLING 10-SECOND DISPLAY WINDOW
     * -------------------------------------------------------
     */

    const maxSamples =
        WAVEFORM_RATE_HZ *
        WAVEFORM_DISPLAY_SECONDS;

    while (
        history.x.length >
        maxSamples
    ) {
        history.x.shift();
    }

    while (
        history.y.length >
        maxSamples
    ) {
        history.y.shift();
    }

    while (
        history.z.length >
        maxSamples
    ) {
        history.z.shift();
    }

    if (history.timestamps) {
        history.timestamps.push(Date.now() / 1000);
        while (history.timestamps.length > maxSamples) {
            history.timestamps.shift();
        }
    }

    /*
     * Track maximum.
     */

    simulationPeakADC =
        Math.max(
            simulationPeakADC,
            xADC,
            yADC,
            zADC
        );

}

function stopLiveSimulationWaveform() {

    ambientSampleTime =
        simulationSampleIndex / WAVEFORM_RATE_HZ;

    simulationActive =
        false;


    if (
        simulationSampleTimer
    ) {

        clearInterval(
            simulationSampleTimer
        );

        simulationSampleTimer =
            null;
    }


    if (
        simulationAnimationFrame
    ) {

        cancelAnimationFrame(
            simulationAnimationFrame
        );

        simulationAnimationFrame =
            null;
    }


    simulationNodeId =
        null;
}

function startSimulationAlarm() {

    /*
     * Stop any previous simulation alarm.
     */

    if (simulationAlarmTimer) {

        clearTimeout(
            simulationAlarmTimer
        );

        simulationAlarmTimer =
            null;
    }

    if (simulationSirenInterval) {

        clearInterval(
            simulationSirenInterval
        );

        simulationSirenInterval =
            null;
    }

    if (simulationAudioCtx) {

        try {
            simulationAudioCtx.close();
        } catch (e) {}

        simulationAudioCtx =
            null;
    }


    /*
     * Web Audio API.
     */

    const AudioContext =
        window.AudioContext ||
        window.webkitAudioContext;


    if (!AudioContext) {
        return;
    }


    const audioCtx =
        new AudioContext();

    simulationAudioCtx =
        audioCtx;


    if (
        audioCtx.state ===
        "suspended"
    ) {

        audioCtx.resume();
    }


    const oscillator =
        audioCtx.createOscillator();


    const gain =
        audioCtx.createGain();


    oscillator.type =
        "sawtooth";


    /*
     * Start at high siren frequency.
     */

    oscillator.frequency.setValueAtTime(
        900,
        audioCtx.currentTime
    );


    /*
     * Siren sweep.
     */

    oscillator.frequency.setValueAtTime(
        900,
        audioCtx.currentTime
    );


    oscillator.frequency.linearRampToValueAtTime(
        500,
        audioCtx.currentTime + 0.5
    );


    oscillator.frequency.linearRampToValueAtTime(
        900,
        audioCtx.currentTime + 1.0
    );


    oscillator.frequency.linearRampToValueAtTime(
        500,
        audioCtx.currentTime + 1.5
    );


    oscillator.frequency.linearRampToValueAtTime(
        900,
        audioCtx.currentTime + 2.0
    );


    /*
     * Continue the siren pattern for
     * the full 10 seconds.
     */

    let direction =
        -1;


    const sirenInterval =
        setInterval(() => {

            const currentTime =
                audioCtx.currentTime;

            const currentFrequency =
                direction === -1
                    ? 500
                    : 900;

            oscillator.frequency.linearRampToValueAtTime(
                currentFrequency,
                currentTime + 0.5
            );

            direction *= -1;

        }, 500);

    simulationSirenInterval =
        sirenInterval;


    /*
     * Volume.
     */

    gain.gain.setValueAtTime(
        0.0,
        audioCtx.currentTime
    );


    gain.gain.linearRampToValueAtTime(
        0.32,
        audioCtx.currentTime + 0.08
    );


    oscillator.connect(
        gain
    );


    gain.connect(
        audioCtx.destination
    );


    oscillator.start();


    /*
     * STOP EVERYTHING AFTER 10 SECONDS.
     */

    simulationAlarmTimer =
        setTimeout(() => {

            clearInterval(
                sirenInterval
            );

            simulationSirenInterval =
                null;


            gain.gain.linearRampToValueAtTime(
                0.001,
                audioCtx.currentTime + 0.15
            );


            oscillator.stop(
                audioCtx.currentTime + 0.2
            );


            setTimeout(() => {

                audioCtx.close();
                if (simulationAudioCtx === audioCtx) {
                    simulationAudioCtx = null;
                }

            }, 300);


            simulationAlarmTimer =
                null;

        }, SIMULATION_ALARM_DURATION_MS);
}

function triggerSpeciesSimulation(type) {

    /*
     * Use the selected simulation node internally.
     *
     * Do NOT display the node name on the alert.
     */

    const simulationNode =
        "NODE_02";

    startLiveSimulationWaveform(
        simulationNode,
        type
    );

    /*
     * Show the correct species immediately.
     */

    showSpeciesDetectionAlert(
        type
    );

    /*
     * Siren ONLY for elephant simulation.
     */

    if (
        type === "elephant"
    ) {

        startSimulationAlarm();

    }

}

async function triggerSimulation(
    type = "INBOUND_NW"
) {

    /*
     * Determine which sensor should show
     * the simulated event.
     */

    let simulationNode =
        "NODE_02";


    if (
        type === "INBOUND_NE"
    ) {

        simulationNode =
            "NODE_03";

    } else if (
        type === "OUTBOUND"
    ) {

        simulationNode =
            "NODE_02";
    }


    /*
     * ======================================================
     * 1. START LIVE SIMULATION WAVEFORM
     * ======================================================
     *
     * This happens immediately when the
     * simulation button is clicked.
     */

    startLiveSimulationWaveform(
        simulationNode,
        "elephant"
    );


    /*
     * ======================================================
     * 2. SHOW ELEPHANT DETECTED
     * ======================================================
     */

    showElephantDetectedAlert({

        sensor:
            simulationNode,

        trigger:
            "Elephant Detection",

        description:
            ""
    });


    /*
     * ======================================================
     * 3. START 10-SECOND SIREN
     * ======================================================
     */

    startSimulationAlarm();


    /*
     * ======================================================
     * 4. KEEP EXISTING BACKEND SIMULATION
     * ======================================================
     */

    try {

        await fetch(
            "/api/simulate/intrusion",
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify({
                        type
                    })
            }
        );

    } catch (e) {

        console.error(
            "Error triggering simulation:",
            e
        );
    }
}

async function clearSimulation() {

    try {

        await fetch(
            "/api/simulate/clear",
            {
                method: "POST"
            }
        );


        /*
         * Hide elephant detection banner and stop simulation siren.
         */

        hideElephantDetectedAlert();

        stopLiveSimulationWaveform();

        if (simulationAlarmTimer) {
            clearTimeout(simulationAlarmTimer);
            simulationAlarmTimer = null;
        }

        if (simulationSirenInterval) {
            clearInterval(simulationSirenInterval);
            simulationSirenInterval = null;
        }

        if (simulationAudioCtx) {
            try {
                simulationAudioCtx.close();
            } catch (e) {}
            simulationAudioCtx = null;
        }

        createInitialHistory();
        renderWaveform();


        /*
         * Reset TDOA information.
         */

        const tdoaVec =
            document.getElementById(
                "tdoaVectorText"
            );

        if (tdoaVec) {

            tdoaVec.textContent =
                "Localized Activity";
        }


        const nearestEl =
            document.getElementById(
                "nearestNodeText"
            );

        if (nearestEl) {

            nearestEl.textContent =
                "G1";
        }


        /*
         * Reset active sensor map nodes.
         */

        [
            "NODE_01",
            "NODE_02",
            "NODE_03"
        ].forEach(
            id => {

                const trailNode =
                    document.getElementById(
                        `trail_${id}`
                    );

                if (trailNode) {

                    trailNode.classList.remove(
                        "active"
                    );
                }
            }
        );


    } catch (e) {

        console.error(
            "Error clearing simulation:",
            e
        );
    }
}

function playAlertSound() {

    try {

        const AudioContext =
            window.AudioContext ||
            window.webkitAudioContext;


        if (!AudioContext) {
            return;
        }


        const audioCtx =
            new AudioContext();


        if (
            audioCtx.state ===
            "suspended"
        ) {

            audioCtx.resume();
        }


        const osc =
            audioCtx.createOscillator();


        const gain =
            audioCtx.createGain();


        osc.type =
            "sawtooth";


        /*
         * ALARM TONE
         */

        osc.frequency.setValueAtTime(
            880,
            audioCtx.currentTime
        );


        osc.frequency.exponentialRampToValueAtTime(
            440,
            audioCtx.currentTime + 0.25
        );


        osc.frequency.setValueAtTime(
            880,
            audioCtx.currentTime + 0.35
        );


        osc.frequency.exponentialRampToValueAtTime(
            440,
            audioCtx.currentTime + 0.60
        );


        gain.gain.setValueAtTime(
            0.35,
            audioCtx.currentTime
        );


        gain.gain.exponentialRampToValueAtTime(
            0.01,
            audioCtx.currentTime + 0.7
        );


        osc.connect(gain);

        gain.connect(
            audioCtx.destination
        );


        osc.start();


        osc.stop(
            audioCtx.currentTime + 0.7
        );


    } catch (e) {

        console.error(
            "Alarm sound error:",
            e
        );
    }
}
