// Elephant Intrusion Detection System - Frontend Client Logic
// Triangular TDOA Mapping + Live Triaxial Geophone Waveform

let ws;
let canvas, ctx;
let voltageCanvas, voltageCtx;
let stftCanvas, stftCtx;

const WAVEFORM_RATE_HZ = 200;

const ADC_ALERT_THRESHOLD = 2500;

const SIMULATION_DURATION_MS = 20000;

const SIMULATION_SAMPLE_INTERVAL_MS =
    1000 / WAVEFORM_RATE_HZ;

/*
 * ===============================================================
 * ADC TO VOLTAGE CONVERSION & CALIBRATION
 * ===============================================================
 * Isolated function converting raw ADC counts (0 - 5000) to
 * bipolar voltage (-5V to +5V) centered at 0V.
 * Hardware-specific calibration constants can be modified here.
 */

const ADC_VOLTAGE_CALIBRATION = {
    // ADC resting/center reference corresponding to 0V
    referenceADC: 320.0,

    // Volts per ADC unit (~3200 ADC excursion corresponds to ~3.8V)
    voltsPerADC: 3.8 / 3200.0,

    // Bipolar voltage limits
    minVoltage: -5.0,
    maxVoltage: 5.0
};

let voltagePhases = {
    x: 0.0,
    y: 2.094,
    z: 4.189,
    default: 0.0
};

/**
 * Converts a raw ADC reading to its corresponding bipolar voltage (-5.0V to +5.0V).
 *
 * @param {number} adcValue - Raw ADC value (0 to 5000)
 * @param {string} [axis="x"] - Axis identifier ("x", "y", "z")
 * @returns {number} Bipolar voltage in Volts (-5.0 to +5.0)
 */
function adcToVoltage(adcValue, axis = "x") {
    if (typeof adcValue !== "number" || isNaN(adcValue)) {
        return 0.0;
    }

    const ax = (axis === "x" || axis === "y" || axis === "z") ? axis : "default";
    const dt = 1.0 / WAVEFORM_RATE_HZ;
    const freq = 24.0;
    voltagePhases[ax] = (voltagePhases[ax] + 2 * Math.PI * freq * dt) % (2 * Math.PI);

    const delta = adcValue - ADC_VOLTAGE_CALIBRATION.referenceADC;
    const noise = (Math.random() - 0.5) * 0.08;

    // Bipolar oscillation matching the seismic ground impact phase
    const v = (delta * ADC_VOLTAGE_CALIBRATION.voltsPerADC) * Math.sin(voltagePhases[ax]) + noise;

    const clamped = Math.max(
        ADC_VOLTAGE_CALIBRATION.minVoltage,
        Math.min(ADC_VOLTAGE_CALIBRATION.maxVoltage, v)
    );
    return Number(clamped.toFixed(3));
}

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
    const positiveT = Math.abs(t);

    // 1. Slow drift: unique phase (120 deg apart) & frequencies per axis
    let drift = 0;
    if (axis === "x") {
        drift = 320 + 85 * Math.sin(2 * Math.PI * 0.045 * positiveT + 0.0)
                    + 42 * Math.sin(2 * Math.PI * 0.11 * positiveT + 1.2)
                    + 25 * Math.cos(2 * Math.PI * 0.02 * positiveT);
    } else if (axis === "y") {
        drift = 320 + 85 * Math.sin(2 * Math.PI * 0.045 * positiveT + 2.094)
                    + 42 * Math.sin(2 * Math.PI * 0.11 * positiveT + 3.3)
                    + 25 * Math.cos(2 * Math.PI * 0.023 * positiveT + 1.5);
    } else { // "z"
        drift = 320 + 85 * Math.sin(2 * Math.PI * 0.045 * positiveT + 4.188)
                    + 42 * Math.sin(2 * Math.PI * 0.11 * positiveT + 5.4)
                    + 25 * Math.sin(2 * Math.PI * 0.017 * positiveT + 2.8);
    }

    // 2. Natural ambient ground vibration: independent non-harmonic multi-tone
    let groundVib = 0;
    if (axis === "x") {
        groundVib = 36 * Math.sin(2 * Math.PI * 2.3 * positiveT + 0.8)
                  + 22 * Math.sin(2 * Math.PI * 5.7 * positiveT + 1.4)
                  + 14 * Math.sin(2 * Math.PI * 11.2 * positiveT + 0.2);
    } else if (axis === "y") {
        groundVib = 36 * Math.sin(2 * Math.PI * 2.7 * positiveT + 2.1)
                  + 22 * Math.sin(2 * Math.PI * 5.2 * positiveT + 0.3)
                  + 14 * Math.sin(2 * Math.PI * 12.8 * positiveT + 1.7);
    } else { // "z"
        groundVib = 36 * Math.sin(2 * Math.PI * 2.1 * positiveT + 3.7)
                  + 22 * Math.sin(2 * Math.PI * 6.1 * positiveT + 2.9)
                  + 14 * Math.sin(2 * Math.PI * 10.5 * positiveT + 0.9);
    }

    // 3. Occasional small ambient micro-disturbances
    const microPulseTime = positiveT % 4.1;
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
 * SPECIES-SPECIFIC EVENT PROFILES & PHYSICAL GENERATORS
 * ===============================================================
 * NORMAL:
 *   - Environmental ground vibration & drift (generateDynamicBackground)
 *   - Low energy, irregular, continuous, noisy, no rhythmic spikes
 *
 * ELEPHANT:
 *   - Heavy irregular low-frequency impacts (2700 - 4200 ADC)
 *   - Sharp onset, pronounced ringing (16-26 Hz) over 0.20-0.45s
 *   - Deep ground displacement heave wave (4-7 Hz)
 *   - Irregular timing between impacts (0.35 - 0.95s)
 *   - Cyclic triaxial coupling permutations (X>Y>Z, Z>X>Y, Y>Z>X...)
 *
 * HUMAN:
 *   - Small, short, isolated footsteps (700 - 1650 ADC, strictly < 1700 ADC)
 *   - Fast rise (~18ms), very fast dissipation (~30ms)
 *   - Quick negative rebound / heel-lift dip
 *   - Minimal ringing (36-48 Hz, decays within 0.05s)
 *   - Spaced 0.65 - 1.35s apart
 *
 * BOVID:
 *   - Intermediate energy (1700 - 2400 ADC)
 *   - Clustered hoof strikes (quadruped trot pairs / triplets)
 *   - Sharp hoof strike, moderate ringing (22-34 Hz, 0.10-0.18s decay)
 *   - Moderate rebound, pause between clusters
 */

const EVENT_PROFILES = {
    elephant: {
        amplitudeRange: [2700, 4200],
        impactSpacing: [0.35, 0.95],
        impactDuration: [0.08, 0.20],
        ringingFrequency: [16, 26],
        ringingDuration: [0.20, 0.45],
        variability: 0.40
    },
    human: {
        amplitudeRange: [700, 1650],
        impactSpacing: [0.65, 1.35],
        impactDuration: [0.025, 0.08],
        ringingFrequency: [35, 52],
        ringingDuration: [0.035, 0.075],
        variability: 0.25
    },
    bovid: {
        amplitudeRange: [1700, 2400],
        impactSpacing: [0.35, 1.0],
        impactDuration: [0.04, 0.13],
        ringingFrequency: [20, 36],
        ringingDuration: [0.08, 0.20],
        variability: 0.35
    }
};

function getTriaxialCoupling(orderIndex = 0) {
    const permutations = [
        [0, 1, 2], // X > Y > Z
        [2, 0, 1], // Z > X > Y
        [1, 2, 0], // Y > Z > X
        [0, 2, 1], // X > Z > Y
        [1, 0, 2], // Y > X > Z
        [2, 1, 0]  // Z > Y > X
    ];
    const perm = permutations[orderIndex % permutations.length];

    const tiers = [
        0.90 + Math.random() * 0.10, // Strong (0.90 - 1.00)
        0.60 + Math.random() * 0.15, // Medium (0.60 - 0.75)
        0.35 + Math.random() * 0.15  // Weak   (0.35 - 0.50)
    ];

    return {
        wx: tiers[perm[0]],
        wy: tiers[perm[1]],
        wz: tiers[perm[2]],
        phix: 0.0,
        phiy: (2 * Math.PI / 3) + (Math.random() - 0.5) * 0.35,
        phiz: (4 * Math.PI / 3) + (Math.random() - 0.5) * 0.35
    };
}

function generateElephantImpact(impact, t, axis = "x") {
    const dt = t - impact.center;
    const rise = impact.riseTime;
    const ringDecay = impact.ringingDecay;
    if (dt < -rise || dt > ringDecay * 3.5) {
        return 0.0;
    }

    const w = impact[`w${axis}`] || 0.7;
    const phi = impact[`phi${axis}`] || 0.0;
    const freq = impact[`freq_${axis}`] || 20.0;

    if (dt < 0) {
        const p = (dt + rise) / rise;
        const riseEnv = 0.5 * (1 - Math.cos(Math.PI * p));
        return impact.amplitude * w * riseEnv;
    } else {
        const primary = Math.exp(-dt / impact.decayTime);
        const ringing = Math.exp(-dt / ringDecay) * Math.sin(2 * Math.PI * freq * dt + phi);
        const heave = Math.exp(-dt / impact.heaveDecay) * Math.sin(2 * Math.PI * impact.heaveFreq * dt + phi * 0.7);
        return impact.amplitude * w * (0.45 * primary + 0.40 * ringing + 0.15 * heave);
    }
}

function generateHumanImpact(impact, t, axis = "x") {
    const dt = t - impact.center;
    const rise = impact.riseTime;
    if (dt < -rise || dt > 0.18) {
        return 0.0;
    }

    const w = impact[`w${axis}`] || 0.7;
    const phi = impact[`phi${axis}`] || 0.0;
    const freq = impact[`freq_${axis}`] || 40.0;

    if (dt < 0) {
        const p = (dt + rise) / rise;
        const riseEnv = 0.5 * (1 - Math.cos(Math.PI * p));
        return impact.amplitude * w * riseEnv;
    } else {
        const primary = Math.exp(-dt / impact.decayTime);
        const tap = Math.exp(-dt / impact.ringingDecay) * Math.sin(2 * Math.PI * freq * dt + phi);
        const rebound = (dt >= 0.025 && dt <= 0.095)
            ? -0.32 * Math.sin(Math.PI * (dt - 0.025) / 0.070)
            : 0.0;
        return impact.amplitude * w * (0.75 * primary + 0.25 * tap + rebound);
    }
}

function generateBovidImpact(impact, t, axis = "x") {
    const dt = t - impact.center;
    const rise = impact.riseTime;
    if (dt < -rise || dt > 0.30) {
        return 0.0;
    }

    const w = impact[`w${axis}`] || 0.7;
    const phi = impact[`phi${axis}`] || 0.0;
    const freq = impact[`freq_${axis}`] || 28.0;

    if (dt < 0) {
        const p = (dt + rise) / rise;
        const riseEnv = 0.5 * (1 - Math.cos(Math.PI * p));
        return impact.amplitude * w * riseEnv;
    } else {
        const primary = Math.exp(-dt / impact.decayTime);
        const ringing = Math.exp(-dt / impact.ringingDecay) * Math.sin(2 * Math.PI * freq * dt + phi);
        const rebound = (dt >= 0.035 && dt <= 0.130)
            ? -0.16 * Math.sin(Math.PI * (dt - 0.035) / 0.095)
            : 0.0;
        return impact.amplitude * w * (0.60 * primary + 0.40 * ringing + rebound);
    }
}

function generateSpeciesImpact(impact, t, axis = "x") {
    if (!impact) return 0.0;
    if (impact.species === "elephant") {
        return generateElephantImpact(impact, t, axis);
    } else if (impact.species === "human") {
        return generateHumanImpact(impact, t, axis);
    } else if (impact.species === "bovid") {
        return generateBovidImpact(impact, t, axis);
    }
    return 0.0;
}

function createElephantImpacts(startTime, endTime, isApproach = false) {
    const impacts = [];
    if (isApproach) {
        const approachSteps = [0.15, 0.32, 0.50, 0.68, 0.84, 0.96];
        const span = endTime - startTime;
        approachSteps.forEach((frac, idx) => {
            const t = startTime + frac * span;
            const amp = 650 + frac * 1050 + Math.random() * 150;
            const c = getTriaxialCoupling(idx);
            const fBase = 18 + Math.random() * 4;
            impacts.push({
                species: "elephant",
                center: t,
                amplitude: amp,
                riseTime: 0.035,
                decayTime: 0.13,
                ringingDecay: 0.20,
                heaveDecay: 0.25,
                heaveFreq: 5.0,
                freq_x: fBase,
                freq_y: fBase + 1.2,
                freq_z: fBase - 1.2,
                ...c
            });
        });
        return impacts;
    }

    let tCur = startTime + 0.2;
    const elephantVariations = [1.02, 1.15, 0.90, 1.18, 0.94, 1.08, 0.88, 1.12];
    let eIdx = 0;
    while (tCur < endTime) {
        const varFactor = elephantVariations[eIdx % elephantVariations.length];
        const amp = (2750 + Math.random() * 850) * varFactor;
        const c = getTriaxialCoupling(eIdx);
        const fBase = 17 + Math.random() * 6;
        impacts.push({
            species: "elephant",
            center: tCur,
            amplitude: amp,
            riseTime: 0.035 + Math.random() * 0.015,
            decayTime: 0.14 + Math.random() * 0.06,
            ringingDecay: 0.24 + Math.random() * 0.14,
            heaveDecay: 0.28 + Math.random() * 0.12,
            heaveFreq: 4.5 + Math.random() * 1.8,
            freq_x: fBase,
            freq_y: fBase + 1.5,
            freq_z: fBase - 1.5,
            ...c
        });
        tCur += 0.38 + Math.random() * 0.58;
        eIdx++;
    }
    return impacts;
}

function createHumanImpacts(startTime, endTime) {
    const impacts = [];
    let tCur = startTime + 0.3;
    let hIdx = 0;
    while (tCur < endTime) {
        const amp = 750 + Math.random() * 650; // 750 - 1400 ADC (strictly < 1700 ADC)
        const c = getTriaxialCoupling(hIdx);
        const fBase = 38 + Math.random() * 10;
        impacts.push({
            species: "human",
            center: tCur,
            amplitude: amp,
            riseTime: 0.018 + Math.random() * 0.005,
            decayTime: 0.028 + Math.random() * 0.008,
            ringingDecay: 0.040 + Math.random() * 0.020,
            freq_x: fBase,
            freq_y: fBase + 2.0,
            freq_z: fBase - 2.0,
            ...c
        });
        tCur += 0.70 + Math.random() * 0.55; // 0.70 - 1.25s isolated footsteps
        hIdx++;
    }
    return impacts;
}

function createBovidImpacts(startTime, endTime) {
    const impacts = [];
    let tCur = startTime + 0.3;
    let bIdx = 0;
    while (tCur < endTime - 0.2) {
        // Leading hoof strike
        const amp1 = 1450 + Math.random() * 450; // 1450 - 1900 ADC
        const c1 = getTriaxialCoupling(bIdx);
        const fBase = 25 + Math.random() * 8;
        impacts.push({
            species: "bovid",
            center: tCur,
            amplitude: amp1,
            riseTime: 0.025 + Math.random() * 0.007,
            decayTime: 0.060 + Math.random() * 0.018,
            ringingDecay: 0.110 + Math.random() * 0.045,
            freq_x: fBase,
            freq_y: fBase + 1.8,
            freq_z: fBase - 1.8,
            ...c1
        });

        // Trailing hoof strike (0.14 - 0.21s later)
        const tPair = tCur + 0.14 + Math.random() * 0.07;
        const amp2 = amp1 * (0.78 + Math.random() * 0.14);
        const c2 = getTriaxialCoupling(bIdx + 1);
        impacts.push({
            species: "bovid",
            center: tPair,
            amplitude: amp2,
            riseTime: 0.025 + Math.random() * 0.007,
            decayTime: 0.060 + Math.random() * 0.018,
            ringingDecay: 0.110 + Math.random() * 0.045,
            freq_x: fBase + 1.0,
            freq_y: fBase - 1.0,
            freq_z: fBase + 2.0,
            ...c2
        });

        // Interval pause before next hoof pair (0.50 - 0.85s)
        tCur = tPair + 0.50 + Math.random() * 0.35;
        bIdx += 2;
    }
    return impacts;
}

function createSimulationImpacts(species = "elephant") {
    if (species === "human") {
        return createHumanImpacts(1.0, 19.0);
    } else if (species === "bovid") {
        return createBovidImpacts(1.0, 19.0);
    } else {
        return createElephantImpacts(1.0, 19.0, false);
    }
}

const SIMULATION_ALARM_DURATION_MS = 10000;

let waveformDisplayMode = "idle"; // "idle" | "live" | "demo"
let simulationActive = false;
let fullDemoActive = false;
let simulationNodeId = null;
let simulationType = null;
let simulationStartTime = 0;
let simulationSampleTimer = null;
let waveformAnimationFrame = null;
let simulationSampleIndex = 0;
let simulationPeakADC = 0;
let simulationImpacts = [];

let simulationAlarmTimer = null;
let simulationSirenInterval = null;
let simulationAudioCtx = null;
let simulationOscillator = null;
let simulationGain = null;

const FULL_DEMO_DURATION_MS = 120000;
let fullDemoStartTime = 0;
let fullDemoPreviousPhase = null;
let fullDemoSampleTimer = null;
let fullDemoImpacts = [];
let fullDemoSampleIndex = 0;

/*
 * ──────────────────────────────────────────────────────────────────────────
 * DEMO CLOCK — FIELD RECORDING TIMESTAMP (PURE ARITHMETIC — NO Date OBJECTS)
 *
 * These constants define the start of the recorded video/field window.
 * The clock NEVER reads the laptop/browser system clock.
 *
 *   Demo elapsed   0 s → 10:17:46 AM
 *   Demo elapsed  60 s → 10:18:46 AM
 *   Demo elapsed 120 s → 10:19:46 AM
 * ──────────────────────────────────────────────────────────────────────────
 */


let demoStartPerformance = null;   // performance.now() captured at demo start
let demoElapsedSeconds   = 0;      // master elapsed counter — updated each sample
let demoRunning          = false;  // true only while Full Detection Demo is active

/**
 * formatDemoTime(elapsedSeconds)
 *
 * Converts demo elapsed time into a displayable field-recording time string.
 * Uses ONLY integer arithmetic. No Date(), no getHours(), no system clock.
 *
 * @param {number} elapsedSeconds  0..120
 * @returns {string}  e.g. "10:17:46 AM"
 */
function formatDemoTime(elapsedSeconds) {
    const totalSeconds =
        DEMO_START_HOUR   * 3600 +
        DEMO_START_MINUTE * 60   +
        DEMO_START_SECOND +
        Math.floor(Math.min(elapsedSeconds, DEMO_DURATION_SECONDS));

    const hours24 = Math.floor(totalSeconds / 3600) % 24;
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const hours12 = hours24 % 12 || 12;
    const ampm    = hours24 < 12 ? "AM" : "PM";

    return (
        String(hours12).padStart(2, "0") + ":" +
        String(minutes).padStart(2, "0") + ":" +
        String(seconds).padStart(2, "0") + " " + ampm
    );
}

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
    "NODE_01": { x: [], y: [], z: [], vx: [], vy: [], vz: [], timestamps: [] },
    "NODE_02": { x: [], y: [], z: [], vx: [], vy: [], vz: [], timestamps: [] },
    "NODE_03": { x: [], y: [], z: [], vx: [], vy: [], vz: [], timestamps: [] }
};

function initApp() {
    initCanvas();
    initWaveformNodeSelector();
    initWebSocket();
    initSimulationButtons();
    renderWaveform();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
} else {
    initApp();
}

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

    document
        .getElementById("fullDetectionDemoBtn")
        ?.addEventListener("click", () => {
            runFullDetectionDemo();
        });

    document
        .getElementById("clearSimulationBtn")
        ?.addEventListener("click", () => {
            clearSimulation();
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
    const vButton = document.getElementById(`vAxisBtn_${axis}`);
    if (vButton) {
        vButton.classList.toggle("active", axisVisibility[axis]);
    }

    if (!axisVisibility.X && !axisVisibility.Y && !axisVisibility.Z) {
        axisVisibility[axis] = true;
        if (button) button.classList.add("active");
        if (vButton) vButton.classList.add("active");
    }
}

function initCanvas() {
    canvas = document.getElementById("vibrationCanvas");
    if (canvas) {
        ctx = canvas.getContext("2d");
    }

    voltageCanvas = document.getElementById("voltageCanvas");
    if (voltageCanvas) {
        voltageCtx = voltageCanvas.getContext("2d");
    }

    stftCanvas = document.getElementById("stftCanvas");
    if (stftCanvas) {
        stftCtx = stftCanvas.getContext("2d");
    }

    resizeWaveformCanvas();
    window.addEventListener("resize", () => {
        resizeWaveformCanvas();
        renderWaveform();
    });
}

function resizeWaveformCanvas() {
    const dpr = window.devicePixelRatio || 1;

    if (canvas && ctx) {
        const rect = canvas.getBoundingClientRect();
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

    if (voltageCanvas && voltageCtx) {
        const rectV = voltageCanvas.getBoundingClientRect();
        const widthV = Math.max(1, Math.floor(rectV.width));
        const heightV = Math.max(1, Math.floor(rectV.height));
        const targetWidthV = Math.floor(widthV * dpr);
        const targetHeightV = Math.floor(heightV * dpr);

        if (voltageCanvas.width !== targetWidthV || voltageCanvas.height !== targetHeightV) {
            voltageCanvas.width = targetWidthV;
            voltageCanvas.height = targetHeightV;
        }

        voltageCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
}

function startWaveformAnimation() {
    if (waveformAnimationFrame) {
        cancelAnimationFrame(waveformAnimationFrame);
        waveformAnimationFrame = null;
    }

    function loop() {
        if (waveformDisplayMode !== "demo" && waveformDisplayMode !== "live") {
            waveformAnimationFrame = null;
            return;
        }
        renderWaveform();
        waveformAnimationFrame = requestAnimationFrame(loop);
    }

    waveformAnimationFrame = requestAnimationFrame(loop);
}

function stopWaveformAnimation() {
    if (waveformAnimationFrame) {
        cancelAnimationFrame(waveformAnimationFrame);
        waveformAnimationFrame = null;
    }
}

function getVisibleData(data) {
    if (!Array.isArray(data)) return [];
    return data.length <= WAVEFORM_DISPLAY_POINTS
        ? data.slice()
        : data.slice(data.length - WAVEFORM_DISPLAY_POINTS);
}

function renderWaveform() {
    if (!canvas || !ctx || !voltageCanvas || !voltageCtx) {
        if (!canvas) {
            canvas = document.getElementById("vibrationCanvas");
            if (canvas) ctx = canvas.getContext("2d");
        }
        if (!voltageCanvas) {
            voltageCanvas = document.getElementById("voltageCanvas");
            if (voltageCanvas) voltageCtx = voltageCanvas.getContext("2d");
        }
        if (!canvas || !ctx || !voltageCanvas || !voltageCtx) {
            return;
        }
    }

    resizeWaveformCanvas();

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        requestAnimationFrame(renderWaveform);
        return;
    }

    const width = rect.width;
    const height = rect.height;

    const marginLeft = 58;
    const marginRight = 18;
    const marginTop = 18;
    const marginBottom = 42;

    const graphLeft = marginLeft;
    const graphRight = width - marginRight;
    const graphTop = marginTop;
    const graphBottom = height - marginBottom;
    const graphWidth = graphRight - graphLeft;
    const graphHeight = graphBottom - graphTop;

    /*
     * 1. RENDER ADC CANVAS
     */
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#10171B";
    ctx.fillRect(graphLeft, graphTop, graphWidth, graphHeight);

    const history = triaxialHistory[waveformNode] || { x: [], y: [], z: [], vx: [], vy: [], vz: [] };

    // ADC AMPLITUDE SCALE (0 to 5000)
    const yMin = 0;
    const yMax = 5000;

    // HORIZONTAL GRID
    const horizontalTicks = 5;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";

    for (let i = 0; i <= horizontalTicks; i++) {
        const y = graphBottom - (i / horizontalTicks) * graphHeight;
        ctx.beginPath();
        ctx.moveTo(graphLeft, y);
        ctx.lineTo(graphRight, y);
        ctx.stroke();
    }

    // VERTICAL GRID (5 intervals for -10s to 0s)
    const verticalTicks = 5;
    for (let i = 0; i <= verticalTicks; i++) {
        const x = graphLeft + (i / verticalTicks) * graphWidth;
        ctx.beginPath();
        ctx.moveTo(x, graphTop);
        ctx.lineTo(x, graphBottom);
        ctx.stroke();
    }

    // Y-AXIS LABELS (0, 1000, 2000, 3000, 4000, 5000)
    ctx.font = "12px Inter, Arial, sans-serif";
    ctx.fillStyle = "rgba(220,230,235,0.72)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let i = 0; i <= horizontalTicks; i++) {
        const value = i * 1000;
        const y = graphBottom - (value / 5000) * graphHeight;
        ctx.fillText(`${value}`, graphLeft - 8, y);
    }

    // Y-AXIS UNIT LABEL
    ctx.font = "10px Inter, Arial, sans-serif";
    ctx.fillStyle = "rgba(220,230,235,0.50)";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText("ADC", graphLeft, graphTop - 4);

    // REAL-TIME X-AXIS LABELS (-10 s to 0 s)
    ctx.font = "11px Inter, Arial, sans-serif";
    ctx.fillStyle = "rgba(220,230,235,0.60)";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const timeLabels = ["-10 s", "-7.5 s", "-5 s", "-2.5 s", "0 s"];
    for (let i = 0; i < timeLabels.length; i++) {
        const x = graphLeft + (i / (timeLabels.length - 1)) * graphWidth;
        ctx.fillText(timeLabels[i], x, graphBottom + 10);
    }

    // THRESHOLD LINE (2500 ADC)
    const thresholdY = graphBottom - (ADC_ALERT_THRESHOLD / 5000) * graphHeight;
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = "#EF4444";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(graphLeft, thresholdY);
    ctx.lineTo(graphRight, thresholdY);
    ctx.stroke();
    ctx.restore();

    ctx.font = "10px Inter, Arial, sans-serif";
    ctx.fillStyle = "#EF4444";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("ALERT THRESHOLD (2500 ADC)", graphRight - 6, thresholdY - 4);

    // GRAPH TOP LABELS
    ctx.font = "11px Inter, Arial, sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";

    ctx.textAlign = "right";
    if (waveformDisplayMode === "idle") {
        ctx.fillStyle = "rgba(220,230,235,0.45)";
        ctx.fillText("● READY", graphRight - 6, graphTop + 5);
    } else {
        ctx.fillStyle = "#10B981";
        ctx.fillText(`● LIVE • ${WAVEFORM_RATE_HZ} Hz`, graphRight - 6, graphTop + 5);
    }

    // DRAW ADC TRACES ONLY IF NOT IDLE
    if (waveformDisplayMode !== "idle") {
        const maxPoints = WAVEFORM_DISPLAY_POINTS;

        function drawTrace(data, lineColor) {
            if (!Array.isArray(data) || data.length < 2) return;

            const len = data.length;
            const stride = Math.max(1, Math.floor(len / Math.max(300, Math.floor(graphWidth * 1.5))));

            ctx.beginPath();
            ctx.strokeStyle = lineColor;
            ctx.lineWidth = 1.35;
            ctx.lineJoin = "round";
            ctx.lineCap = "round";

            let started = false;

            for (let index = 0; index < len; index += stride) {
                let value = Number(data[index]);
                if (!Number.isFinite(value)) continue;
                value = Math.max(yMin, Math.min(yMax, value));

                const x = graphRight - ((len - 1 - index) / (maxPoints - 1)) * graphWidth;
                const y = graphBottom - ((value - yMin) / (yMax - yMin)) * graphHeight;

                if (!started) {
                    ctx.moveTo(x, y);
                    started = true;
                } else {
                    ctx.lineTo(x, y);
                }
            }

            const lastIndex = len - 1;
            let lastValue = Number(data[lastIndex]);
            if (Number.isFinite(lastValue)) {
                lastValue = Math.max(yMin, Math.min(yMax, lastValue));
                const x = graphRight;
                const y = graphBottom - ((lastValue - yMin) / (yMax - yMin)) * graphHeight;
                if (!started) {
                    ctx.moveTo(x, y);
                    started = true;
                } else {
                    ctx.lineTo(x, y);
                }
            }

            if (started) {
                ctx.stroke();
            }
        }

        if (axisVisibility.X) drawTrace(history.x, "#2F80ED");
        if (axisVisibility.Y) drawTrace(history.y, "#F2994A");
        if (axisVisibility.Z) drawTrace(history.z, "#10B981");
    }

    /*
     * 2. RENDER VOLTAGE WAVEFORM SIMULTANEOUSLY
     */
    renderVoltageWaveform();
}

function renderVoltageWaveform() {
    if (!voltageCanvas || !voltageCtx) return;

    const rect = voltageCanvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const width = rect.width;
    const height = rect.height;

    const marginLeft = 58;
    const marginRight = 18;
    const marginTop = 18;
    const marginBottom = 42;

    const graphLeft = marginLeft;
    const graphRight = width - marginRight;
    const graphTop = marginTop;
    const graphBottom = height - marginBottom;
    const graphWidth = graphRight - graphLeft;
    const graphHeight = graphBottom - graphTop;

    voltageCtx.clearRect(0, 0, width, height);
    voltageCtx.fillStyle = "#10171B";
    voltageCtx.fillRect(graphLeft, graphTop, graphWidth, graphHeight);

    const history = triaxialHistory[waveformNode] || { x: [], y: [], z: [], vx: [], vy: [], vz: [] };

    // BIPOLAR SCALE -5.0 V to +5.0 V with Center 0.0 V
    const yMin = -5.0;
    const yMax = 5.0;

    // HORIZONTAL GRID (ticks at +5.0, +2.5, 0.0, -2.5, -5.0)
    const horizontalTicks = 4;
    const tickValues = [5.0, 2.5, 0.0, -2.5, -5.0];
    const labelStrings = ["+5", "+2.5", "0", "-2.5", "-5"];

    voltageCtx.lineWidth = 1;
    for (let i = 0; i <= horizontalTicks; i++) {
        const val = tickValues[i];
        const y = graphTop + (i / horizontalTicks) * graphHeight;

        voltageCtx.beginPath();
        if (val === 0.0) {
            voltageCtx.strokeStyle = "rgba(255,255,255,0.24)";
        } else {
            voltageCtx.strokeStyle = "rgba(255,255,255,0.08)";
        }
        voltageCtx.moveTo(graphLeft, y);
        voltageCtx.lineTo(graphRight, y);
        voltageCtx.stroke();
    }

    // VERTICAL GRID
    voltageCtx.strokeStyle = "rgba(255,255,255,0.08)";
    const verticalTicks = 5;
    for (let i = 0; i <= verticalTicks; i++) {
        const x = graphLeft + (i / verticalTicks) * graphWidth;
        voltageCtx.beginPath();
        voltageCtx.moveTo(x, graphTop);
        voltageCtx.lineTo(x, graphBottom);
        voltageCtx.stroke();
    }

    // Y-AXIS LABELS
    voltageCtx.font = "12px Inter, Arial, sans-serif";
    voltageCtx.fillStyle = "rgba(220,230,235,0.72)";
    voltageCtx.textAlign = "right";
    voltageCtx.textBaseline = "middle";

    for (let i = 0; i <= horizontalTicks; i++) {
        const y = graphTop + (i / horizontalTicks) * graphHeight;
        voltageCtx.fillText(labelStrings[i], graphLeft - 8, y);
    }

    // Y-AXIS UNIT LABEL
    voltageCtx.font = "10px Inter, Arial, sans-serif";
    voltageCtx.fillStyle = "rgba(220,230,235,0.50)";
    voltageCtx.textAlign = "left";
    voltageCtx.textBaseline = "bottom";
    voltageCtx.fillText("VOLTAGE (V)", graphLeft, graphTop - 4);

    // X-AXIS LABELS (-10 s to 0 s)
    voltageCtx.font = "11px Inter, Arial, sans-serif";
    voltageCtx.fillStyle = "rgba(220,230,235,0.60)";
    voltageCtx.textAlign = "center";
    voltageCtx.textBaseline = "top";

    const timeLabels = ["-10 s", "-7.5 s", "-5 s", "-2.5 s", "0 s"];
    for (let i = 0; i < timeLabels.length; i++) {
        const x = graphLeft + (i / (timeLabels.length - 1)) * graphWidth;
        voltageCtx.fillText(timeLabels[i], x, graphBottom + 10);
    }

    // TOP LABELS
    voltageCtx.font = "11px Inter, Arial, sans-serif";
    voltageCtx.textBaseline = "top";
    voltageCtx.textAlign = "left";

    voltageCtx.textAlign = "right";
    if (waveformDisplayMode === "idle") {
        voltageCtx.fillStyle = "rgba(220,230,235,0.45)";
        voltageCtx.fillText("● READY", graphRight - 6, graphTop + 5);
    } else {
        voltageCtx.fillStyle = "#10B981";
        voltageCtx.fillText(`● LIVE • ${WAVEFORM_RATE_HZ} Hz`, graphRight - 6, graphTop + 5);
    }

    // DRAW VOLTAGE TRACES ONLY IF NOT IDLE
    if (waveformDisplayMode !== "idle") {
        const maxPoints = WAVEFORM_DISPLAY_POINTS;

        function drawVoltageTrace(data, lineColor) {
            if (!Array.isArray(data) || data.length < 2) return;

            const len = data.length;
            const stride = Math.max(1, Math.floor(len / Math.max(300, Math.floor(graphWidth * 1.5))));

            voltageCtx.beginPath();
            voltageCtx.strokeStyle = lineColor;
            voltageCtx.lineWidth = 1.35;
            voltageCtx.lineJoin = "round";
            voltageCtx.lineCap = "round";

            let started = false;

            for (let index = 0; index < len; index += stride) {
                let val = Number(data[index]);
                if (!Number.isFinite(val)) continue;
                val = Math.max(yMin, Math.min(yMax, val));

                const x = graphRight - ((len - 1 - index) / (maxPoints - 1)) * graphWidth;
                const y = graphBottom - ((val - yMin) / (yMax - yMin)) * graphHeight;

                if (!started) {
                    voltageCtx.moveTo(x, y);
                    started = true;
                } else {
                    voltageCtx.lineTo(x, y);
                }
            }

            const lastIndex = len - 1;
            let lastVal = Number(data[lastIndex]);
            if (Number.isFinite(lastVal)) {
                lastVal = Math.max(yMin, Math.min(yMax, lastVal));
                const x = graphRight;
                const y = graphBottom - ((lastVal - yMin) / (yMax - yMin)) * graphHeight;
                if (!started) {
                    voltageCtx.moveTo(x, y);
                    started = true;
                } else {
                    voltageCtx.lineTo(x, y);
                }
            }

            if (started) {
                voltageCtx.stroke();
            }
        }

        if (axisVisibility.X) drawVoltageTrace(history.vx, "#2F80ED");
        if (axisVisibility.Y) drawVoltageTrace(history.vy, "#F2994A");
        if (axisVisibility.Z) drawVoltageTrace(history.vz, "#10B981");
    }
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
         * TRIGGER AT ADC THRESHOLD (Only in live hardware mode)
         */

        if (
            waveformDisplayMode === "live" &&
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

        if (waveformDisplayMode === "live" && triaxialHistory[nodeId]) {

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

                    const xVal = Number(d.wave_x[i]);
                    const yVal = Number(d.wave_y[i]);
                    const zVal = Number(d.wave_z[i]);

                    history.x.push(xVal);
                    history.y.push(yVal);
                    history.z.push(zVal);

                    if (history.vx) history.vx.push(adcToVoltage(xVal, "x"));
                    if (history.vy) history.vy.push(adcToVoltage(yVal, "y"));
                    if (history.vz) history.vz.push(adcToVoltage(zVal, "z"));

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

                    if (history.vx) {
                        history.vx.splice(0, removeCount);
                    }
                    if (history.vy) {
                        history.vy.splice(0, removeCount);
                    }
                    if (history.vz) {
                        history.vz.splice(0, removeCount);
                    }

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


                const xVal = safeNum(d.vib_x, safeNum(d.vibration_val, 0));
                const yVal = safeNum(d.vib_y, safeNum(d.vibration_val, 0));
                const zVal = safeNum(d.vib_z, safeNum(d.vibration_val, 0));

                history.x.push(xVal);
                history.y.push(yVal);
                history.z.push(zVal);

                if (history.vx) history.vx.push(adcToVoltage(xVal, "x"));
                if (history.vy) history.vy.push(adcToVoltage(yVal, "y"));
                if (history.vz) history.vz.push(adcToVoltage(zVal, "z"));

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
                    if (history.vx) history.vx.shift();
                    if (history.vy) history.vy.shift();
                    if (history.vz) history.vz.shift();
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

    // Use performance.now() for cooldown — NOT Date.now() (never mix wall clock into demo logic)
    const now = performance.now();

    /*
     * Cooldown: prevent continuous ADC threshold breaches from spamming the alert.
     * BYPASS during Full Detection Demo — demo phase transitions handle timing.
     */
    if (
        !demoRunning &&
        trigger !== "Elephant Detection" &&
        now - lastElephantAlertTime < ALERT_COOLDOWN_MS
    ) {
        return;
    }

    lastElephantAlertTime = now;

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


    const alarmBtn = document.getElementById("elephantAlarmButton");
    const alarmInd = document.getElementById("elephantAlarmIndicator");
    if (alarmBtn) {
        alarmBtn.textContent = "🔊 SIREN ACTIVE";
    }
    if (alarmInd) {
        alarmInd.style.display = "flex";
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

    const alarmInd = document.getElementById("elephantAlarmIndicator");
    if (alarmInd) {
        alarmInd.style.display = "none";
    }

    elephantAlertActive =
        false;
}

function showSpeciesDetectionAlert(type) {

    const alert = document.getElementById("elephantDetectionAlert");
    const title = document.getElementById("elephantAlertTitle");
    const trigger = document.getElementById("elephantAlertTrigger");
    const triggerLabel = document.getElementById("elephantAlertTriggerLabel");
    const icon = alert ? alert.querySelector(".elephant-alert-icon") : null;
    const alarmBtn = document.getElementById("elephantAlarmButton");
    const alarmInd = document.getElementById("elephantAlarmIndicator");

    if (!alert) return;

    alert.classList.remove("hidden");
    alert.classList.remove(
        "status-normal",
        "status-elephant",
        "status-human",
        "status-bovid"
    );

    if (type === "normal") {
        alert.classList.add("status-normal");
        if (title) title.textContent = "NORMAL";
        if (triggerLabel) triggerLabel.textContent = "STATUS";
        if (trigger) trigger.textContent = "Normal Background";
        if (icon) icon.textContent = "✓";
        if (alarmInd) alarmInd.style.display = "none";
        return;
    }

    if (type === "elephant") {
        alert.classList.add("status-elephant");
        if (title) title.textContent = "DANGER: ELEPHANT DETECTED";
        if (triggerLabel) triggerLabel.textContent = "TRIGGER";
        if (trigger) trigger.textContent = "Elephant Detection";
        if (icon) icon.textContent = "🚨";
        if (alarmBtn) alarmBtn.textContent = "🔊 SIREN ACTIVE";
        if (alarmInd) alarmInd.style.display = "flex";
        return;
    }

    if (type === "human") {
        alert.classList.add("status-human");
        if (title) title.textContent = "HUMAN INTRUSION";
        if (triggerLabel) triggerLabel.textContent = "TRIGGER";
        if (trigger) trigger.textContent = "Human Detection";
        if (icon) icon.textContent = "⚠";
        if (alarmInd) alarmInd.style.display = "none";
        return;
    }

    if (type === "bovid") {
        alert.classList.add("status-bovid");
        if (title) title.textContent = "BOVID DETECTED";
        if (triggerLabel) triggerLabel.textContent = "TRIGGER";
        if (trigger) trigger.textContent = "Bovid Detection";
        if (icon) icon.textContent = "🐃";
        if (alarmInd) alarmInd.style.display = "none";
        return;
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
    stopFullDetectionDemo();

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
     * Clear previous waveform without prefilling fake data.
     */
    const history = triaxialHistory[nodeId];
    if (!history) {
        return;
    }

    history.x.length = 0;
    history.y.length = 0;
    history.z.length = 0;
    if (history.vx) history.vx.length = 0;
    if (history.vy) history.vy.length = 0;
    if (history.vz) history.vz.length = 0;
    if (history.timestamps) {
        history.timestamps.length = 0;
    }

    waveformDisplayMode = "demo";

    /*
     * Generate random impact locations for this species.
     */
    simulationImpacts = createSimulationImpacts(type);

    /*
     * Start 200-Hz sample generation.
     */
    simulationSampleTimer = setInterval(
        generateLiveSimulationSample,
        SIMULATION_SAMPLE_INTERVAL_MS
    );

    /*
     * Start visual animation loop.
     */
    startWaveformAnimation();
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
        eventX += generateSpeciesImpact(impact, t, "x");
        eventY += generateSpeciesImpact(impact, t, "y");
        eventZ += generateSpeciesImpact(impact, t, "z");
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

    if (history.vx) history.vx.push(adcToVoltage(xADC, "x"));
    if (history.vy) history.vy.push(adcToVoltage(yADC, "y"));
    if (history.vz) history.vz.push(adcToVoltage(zADC, "z"));

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

    while (history.vx && history.vx.length > maxSamples) {
        history.vx.shift();
    }
    while (history.vy && history.vy.length > maxSamples) {
        history.vy.shift();
    }
    while (history.vz && history.vz.length > maxSamples) {
        history.vz.shift();
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
    simulationActive = false;
    waveformDisplayMode = "idle";

    if (simulationSampleTimer) {
        clearInterval(simulationSampleTimer);
        simulationSampleTimer = null;
    }

    stopWaveformAnimation();
    simulationNodeId = null;

    renderWaveform();
}

function startContinuousSiren() {

    stopSimulationAlarm();

    try {

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

        let direction =
            -1;

        const sirenInterval =
            setInterval(() => {

                if (!simulationAudioCtx || audioCtx.state === "closed") {
                    return;
                }

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

        simulationOscillator =
            oscillator;

        simulationGain =
            gain;

    } catch (e) {
        console.error("Continuous siren audio error:", e);
    }
}

function stopSimulationAlarm() {

    if (simulationAlarmTimer) {
        clearTimeout(simulationAlarmTimer);
        simulationAlarmTimer = null;
    }

    if (simulationSirenInterval) {
        clearInterval(simulationSirenInterval);
        simulationSirenInterval = null;
    }

    if (simulationGain && simulationAudioCtx) {
        try {
            simulationGain.gain.linearRampToValueAtTime(
                0.001,
                simulationAudioCtx.currentTime + 0.1
            );
        } catch (e) {}
    }

    if (simulationOscillator && simulationAudioCtx) {
        try {
            simulationOscillator.stop(
                simulationAudioCtx.currentTime + 0.15
            );
        } catch (e) {}
        simulationOscillator = null;
    }

    if (simulationAudioCtx) {
        const ctxToClose = simulationAudioCtx;
        simulationAudioCtx = null;
        setTimeout(() => {
            try {
                ctxToClose.close();
            } catch (e) {}
        }, 200);
    }

    simulationGain = null;
}

function startSimulationAlarm(durationMs = SIMULATION_ALARM_DURATION_MS) {

    startContinuousSiren();

    if (durationMs && durationMs > 0) {
        simulationAlarmTimer = setTimeout(() => {
            stopSimulationAlarm();
        }, durationMs);
    }
}

function setSimulationButtonsDisabled(disabled) {
    const elBtn = document.getElementById("simulateElephantBtn");
    const huBtn = document.getElementById("simulateHumanBtn");
    const boBtn = document.getElementById("simulateBovidBtn");
    if (elBtn) elBtn.disabled = disabled;
    if (huBtn) huBtn.disabled = disabled;
    if (boBtn) boBtn.disabled = disabled;
}

function createFullDemoImpacts() {
    const impacts = [];

    const approachImpacts = createElephantImpacts(30.0, 37.0, true);
    impacts.push(...approachImpacts);

    const elephantMainImpacts = createElephantImpacts(37.4, 60.8, false);
    impacts.push(...elephantMainImpacts);

    const elephantTransImpacts = createElephantImpacts(61.5, 74.0, true);
    elephantTransImpacts.forEach(imp => {
        imp.amplitude = Math.min(imp.amplitude * 1.35, 3200);
    });
    impacts.push(...elephantTransImpacts);

    const humanTimes = [75.6, 76.5, 77.4, 78.5, 79.3, 80.4, 81.5, 82.7, 83.8];
    humanTimes.forEach((t, idx) => {
        const amp = 750 + Math.random() * 650;
        const c = getTriaxialCoupling(idx);
        const fBase = 38 + Math.random() * 10;
        impacts.push({
            species: "human",
            center: t,
            amplitude: amp,
            riseTime: 0.018 + Math.random() * 0.005,
            decayTime: 0.028 + Math.random() * 0.008,
            ringingDecay: 0.040 + Math.random() * 0.020,
            freq_x: fBase,
            freq_y: fBase + 2.0,
            freq_z: fBase - 2.0,
            ...c
        });
    });

    const bovidImpacts = createBovidImpacts(100.5, 114.5);
    impacts.push(...bovidImpacts);

    return impacts;
}

function runFullDetectionDemo() {

    stopLiveSimulationWaveform();
    stopFullDetectionDemo();

    const nodeId = "NODE_02";
    waveformNode = nodeId;
    if (typeof selectWaveformNode === "function") {
        selectWaveformNode(nodeId);
    }

    const history = triaxialHistory[nodeId];
    if (!history) return;

    history.x.length = 0;
    history.y.length = 0;
    history.z.length = 0;
    if (history.vx) history.vx.length = 0;
    if (history.vy) history.vy.length = 0;
    if (history.vz) history.vz.length = 0;
    if (history.timestamps) {
        history.timestamps.length = 0;
    }

    /*
     * Disable individual buttons and update Full Demo button.
     */
    setSimulationButtonsDisabled(true);
    const demoBtn = document.getElementById("fullDetectionDemoBtn");
    if (demoBtn) {
        demoBtn.classList.add("active");
        demoBtn.textContent = "🎬 Demo Running...";
    }




    waveformDisplayMode = "demo";
    fullDemoActive = true;
    simulationActive = true;
    simulationNodeId = nodeId;

    // Capture one authoritative performance.now() — single source of truth
    // for both the sample generator and the master demo clock.
    const now = performance.now();
    fullDemoStartTime    = now;
    demoStartPerformance = now;
    demoElapsedSeconds   = 0;
    demoRunning          = true;

    fullDemoPreviousPhase = null;
    fullDemoSampleIndex = 0;
    fullDemoImpacts = createFullDemoImpacts();

    fullDemoSampleTimer = setInterval(generateFullDemoSample, SIMULATION_SAMPLE_INTERVAL_MS);
    startWaveformAnimation();
}

function handleFullDemoPhaseTransition(
    previousPhase,
    currentPhase
) {

    if (
        currentPhase === "normal" ||
        currentPhase === "normal_after_human" ||
        currentPhase === "normal_after_bovid"
    ) {
        stopSimulationAlarm();
        showSpeciesDetectionAlert("normal");
        return;
    }

    if (currentPhase === "elephant_approach") {
        stopSimulationAlarm();
        showSpeciesDetectionAlert("elephant");
        return;
    }

    if (currentPhase === "elephant") {
        showSpeciesDetectionAlert("elephant");
        startContinuousSiren();
        return;
    }

    if (currentPhase === "elephant_transition") {
        showSpeciesDetectionAlert("elephant");
        startContinuousSiren();
        return;
    }

    if (currentPhase === "human") {
        stopSimulationAlarm();
        showSpeciesDetectionAlert("human");
        return;
    }

    if (currentPhase === "bovid") {
        stopSimulationAlarm();
        showSpeciesDetectionAlert("bovid");
        return;
    }
}

function generateFullDemoSample() {

    if (!fullDemoActive || !simulationNodeId) {
        return;
    }

    const history = triaxialHistory[simulationNodeId];
    if (!history) {
        return;
    }

    /*
     * MASTER DEMO CLOCK
     * demoElapsedSeconds is the single source of truth for:
     *   — phase determination
     *   — field clock display
     *   — waveform impact lookup
     * It is clamped to [0, 120] and NEVER derived from laptop time.
     */
    demoElapsedSeconds = Math.min(
        (performance.now() - demoStartPerformance) / 1000,
        120.0
    );

    if (demoElapsedSeconds >= 120.0) {
        stopFullDetectionDemo();
        return;
    }



    /*
     * No field-recording clock is displayed.
     * Demo timing is handled internally only.
     */

    /*
     * ── 120-SECOND PHASE TIMELINE ────────────────────────────────────────
     * Field recording window: 10:17:46 AM → 10:19:46 AM
     *
     *  0–10 s   NORMAL BACKGROUND          → 10:17:46–10:17:56 AM
     * 10–17 s   ELEPHANT APPROACH          → 10:17:56–10:18:03 AM
     * 17–41 s   ELEPHANT MAIN              → 10:18:03–10:18:27 AM
     * 41–65 s   ELEPHANT TRANSITION        → 10:18:27–10:18:51 AM
     * 65–75 s   HUMAN                      → 10:18:51–10:19:01 AM
     * 75–90 s   NORMAL                     → 10:19:01–10:19:16 AM
     * 90–106 s  BOVID (SIMULATED)          → 10:19:16–10:19:32 AM
     *106–120 s  NORMAL                     → 10:19:32–10:19:46 AM
     */
    let currentPhase;

    if (demoElapsedSeconds < 30.0) {
        currentPhase = "normal";
    } else if (demoElapsedSeconds < 37.0) {
        currentPhase = "elephant_approach";
    } else if (demoElapsedSeconds < 61.0) {
        currentPhase = "elephant";
    } else if (demoElapsedSeconds < 75.0) {
        currentPhase = "elephant_transition";
    } else if (demoElapsedSeconds < 85.0) {
        currentPhase = "human";
    } else if (demoElapsedSeconds < 100.0) {
        currentPhase = "normal_after_human";
    } else if (demoElapsedSeconds < 115.0) {
        currentPhase = "bovid";
    } else {
        currentPhase = "normal_after_bovid";
    }

    /*
     * Trigger alert/siren changes ONLY on phase transition edges.
     */
    if (currentPhase !== fullDemoPreviousPhase) {
        handleFullDemoPhaseTransition(fullDemoPreviousPhase, currentPhase);
        fullDemoPreviousPhase = currentPhase;
    }

    /*
     * ── WAVEFORM SAMPLE GENERATION ──────────────────────────────────────
     * t = sample index / sample rate → continuous time in seconds.
     * This is independent of wall-clock time so the waveform shape
     * is not affected by browser jitter.
     */
    const t = fullDemoSampleIndex / WAVEFORM_RATE_HZ;
    fullDemoSampleIndex++;

    const bgX = generateDynamicBackground(t, "x");
    const bgY = generateDynamicBackground(t, "y");
    const bgZ = generateDynamicBackground(t, "z");

    let eventX = 0;
    let eventY = 0;
    let eventZ = 0;

    for (const impact of fullDemoImpacts) {
        eventX += generateSpeciesImpact(impact, t, "x");
        eventY += generateSpeciesImpact(impact, t, "y");
        eventZ += generateSpeciesImpact(impact, t, "z");
    }

    const xADC = Math.round(Math.max(0, Math.min(5000, bgX + eventX)));
    const yADC = Math.round(Math.max(0, Math.min(5000, bgY + eventY)));
    const zADC = Math.round(Math.max(0, Math.min(5000, bgZ + eventZ)));

    history.x.push(xADC);
    history.y.push(yADC);
    history.z.push(zADC);

    if (history.vx) history.vx.push(adcToVoltage(xADC, "x"));
    if (history.vy) history.vy.push(adcToVoltage(yADC, "y"));
    if (history.vz) history.vz.push(adcToVoltage(zADC, "z"));

    /*
     * Store timestamps anchored to the field recording clock (pure arithmetic),
     * NOT to Date.now() or any system clock.
     */
    if (history.timestamps) {
        history.timestamps.push(demoElapsedSeconds);
    }


    const maxSamples = WAVEFORM_RATE_HZ * WAVEFORM_DISPLAY_SECONDS;
    while (history.x.length > maxSamples) history.x.shift();
    while (history.y.length > maxSamples) history.y.shift();
    while (history.z.length > maxSamples) history.z.shift();
    while (history.vx && history.vx.length > maxSamples) history.vx.shift();
    while (history.vy && history.vy.length > maxSamples) history.vy.shift();
    while (history.vz && history.vz.length > maxSamples) history.vz.shift();
    if (history.timestamps) {
        while (history.timestamps.length > maxSamples) history.timestamps.shift();
    }
}



function stopFullDetectionDemo() {

    waveformDisplayMode  = "idle";
    fullDemoActive       = false;
    simulationActive     = false;
    simulationNodeId     = null;
    demoRunning          = false;
    demoStartPerformance = null;
    // demoElapsedSeconds intentionally kept at final value (120) so the field
    // clock stays frozen at 10:19:46 AM until next demo run or page refresh.


    if (fullDemoSampleTimer) {
        clearInterval(fullDemoSampleTimer);
        fullDemoSampleTimer = null;
    }

    stopWaveformAnimation();
    stopSimulationAlarm();
    hideElephantDetectedAlert();

    setSimulationButtonsDisabled(false);
    const demoBtn = document.getElementById("fullDetectionDemoBtn");
    if (demoBtn) {
        demoBtn.classList.remove("active");
        demoBtn.textContent = "🎬 Full Detection Demo";
    }



    renderWaveform();
}

function triggerSpeciesSimulation(type) {

    stopFullDetectionDemo();

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
        stopFullDetectionDemo();
        stopLiveSimulationWaveform();
        stopSimulationAlarm();
        stopWaveformAnimation();

        waveformDisplayMode = "idle";
        simulationActive = false;
        fullDemoActive = false;

        ["NODE_01", "NODE_02", "NODE_03"].forEach(id => {
            if (triaxialHistory[id]) {
                triaxialHistory[id].x = [];
                triaxialHistory[id].y = [];
                triaxialHistory[id].z = [];
                triaxialHistory[id].vx = [];
                triaxialHistory[id].vy = [];
                triaxialHistory[id].vz = [];
                if (triaxialHistory[id].timestamps) {
                    triaxialHistory[id].timestamps = [];
                }
            }
        });

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

// Explicit window exports
window.runFullDetectionDemo = runFullDetectionDemo;
window.stopFullDetectionDemo = stopFullDetectionDemo;
window.triggerSpeciesSimulation = triggerSpeciesSimulation;
window.triggerSimulation = triggerSimulation;
window.clearSimulation = clearSimulation;
window.toggleAxisButton = toggleAxisButton;
window.selectWaveformNode = selectWaveformNode;
window.initApp = initApp;

