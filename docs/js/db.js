/**
 * db.js — Data tables: cores, AWG wire, materials
 *
 * Ported exactly from:
 *   data/core_db.py
 *   data/wire_db.py
 *   data/material_db.py
 *
 * Column layout per core entry (all in mm):
 *   [Core_L, Core_W, Core_H, Center_W, Outer_Sep, Window_L]
 *
 *   Core_L    : total core LENGTH  (axis along the legs)
 *   Core_W    : total core WIDTH   (axis across all legs)
 *   Core_H    : core HEIGHT/depth  (into page)
 *   Center_W  : centre-leg width
 *   Outer_Sep : centre-to-centre distance between outer legs' inner faces
 *   Window_L  : winding window length
 */

// ── Column index constants (0-based) ─────────────────────────────────────────
const COL_CORE_L   = 0;
const COL_CORE_W   = 1;
const COL_CORE_H   = 2;
const COL_CENTER_W = 3;
const COL_OUTER_SEP = 4;
const COL_WINDOW_L = 5;

// ── Core database ─────────────────────────────────────────────────────────────
//                         Core_L  Core_W  Core_H  Center_W  Outer_Sep  Window_L
const CORES = {
  "E 30/15/7 TDK":        [30.0,   15.2,   7.3,    7.2,      19.5,      9.7],
  "E 32/16/19 TDK":       [32.0,   16.4,   9.5,    9.5,      22.7,      11.2],
  "E 40/16/12 TDK":       [40.6,   16.5,   12.5,   12.5,     28.6,      10.5],
  "EFD 25/13/9 (CUSTOM)": [25.0,   12.5,   9.1,    6.51,     18.7,      9.3],
};

// ── AWG wire database ─────────────────────────────────────────────────────────
// Each entry: [AWG_number, S_Cu (m²), S_total (m²)]
// S_Cu    : bare copper cross-section area
// S_total : total wire cross-section (copper + insulation)
// Data covers AWG 41 (thinnest) → AWG 10 (thickest).
// Values ported exactly from data/wire_db.py.
const COL_AWG     = 0;
const COL_S_CU    = 1;
const COL_S_TOTAL = 2;

const AWG_DATA = [
  [41, 4.00e-9,  7.00e-9],
  [40, 5.00e-9,  8.60e-9],
  [39, 6.30e-9,  1.06e-8],
  [38, 8.00e-9,  1.30e-8],
  [37, 1.00e-8,  1.60e-8],
  [36, 1.27e-8,  1.97e-8],
  [35, 1.60e-8,  2.43e-8],
  [34, 2.01e-8,  3.00e-8],
  [33, 2.54e-8,  3.71e-8],
  [32, 3.20e-8,  4.59e-8],
  [31, 4.04e-8,  5.68e-8],
  [30, 5.09e-8,  7.04e-8],
  [29, 6.42e-8,  8.72e-8],
  [28, 8.10e-8,  1.083e-7],
  [27, 1.021e-7, 1.344e-7],
  [26, 1.287e-7, 1.671e-7],
  [25, 1.624e-7, 2.078e-7],
  [24, 2.047e-7, 2.586e-7],
  [23, 2.582e-7, 3.221e-7],
  [22, 3.255e-7, 4.013e-7],
  [21, 4.105e-7, 5.004e-7],
  [20, 5.176e-7, 6.244e-7],
  [19, 6.527e-7, 7.794e-7],
  [18, 8.231e-7, 9.735e-7],
  [17, 1.0379e-6, 1.2164e-6],
  [16, 1.3088e-6, 1.5207e-6],
  [15, 1.6504e-6, 1.9021e-6],
  [14, 2.0811e-6, 2.380e-6],
  [13, 2.6243e-6, 2.9793e-6],
  [12, 3.3092e-6, 3.7309e-6],
  [11, 4.1729e-6, 4.6738e-6],
  [10, 5.2620e-6, 5.8572e-6],
];

// Copper resistivity at 20 °C (Ω·m)
const R_CU = 1.72e-8;

// ── Material database ─────────────────────────────────────────────────────────
// BH nonlinear permeability model:
//   mu_T(B) = 1 / (k1·exp(k2·B²) + k3)            [incremental / chord]
//   mu_D(B) = 1 / (k1·(1+2·k2·B²)·exp(k2·B²) + k3) [differential]
// Coefficients k1 [H/m], k2 [T⁻²], k3 [H/m] are fitted to BH curve.
const MATERIALS = {
  "N87 (TDK)": {
    desc: "TDK EPCOS N87, MnZn, ~100 kHz",
    mu_i: 2200,
    k1: 0.062,
    k2: 42.995,
    k3: 302.904,
  },
  "User-defined": {
    desc: "User-defined coefficients",
    mu_i: null,
    k1: null,
    k2: null,
    k3: null,
  },
};

// ── Wire lookup helpers ───────────────────────────────────────────────────────

/**
 * Return the FIRST AWG row (from thinnest AWG 41 toward thickest AWG 10)
 * whose area in `col` is >= sTarget.
 * Matches Python find_awg_geq: returns thinnest wire that meets requirement.
 * Falls back to AWG 10 if none qualifies.
 * @param {number} sTarget  target area in m²
 * @param {number} col      COL_S_CU (default) or COL_S_TOTAL
 * @returns {Array} AWG row [awg, s_cu, s_total]
 */
function findAwgGeq(sTarget, col = COL_S_CU) {
  for (const row of AWG_DATA) {
    if (row[col] >= sTarget) return row;
  }
  return AWG_DATA[AWG_DATA.length - 1]; // fallback: AWG 10
}

/**
 * Return the AWG row for a specific AWG number.
 * Throws if AWG number not found.
 * @param {number} awgNum
 * @returns {Array} AWG row
 */
function findAwgMatch(awgNum) {
  for (const row of AWG_DATA) {
    if (row[COL_AWG] === awgNum) return row;
  }
  throw new Error(`AWG ${awgNum} not found in database.`);
}
