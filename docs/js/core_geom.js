/**
 * core_geom.js — Core geometry helpers
 *
 * Ported exactly from data/core_db.py.
 * All distances in mm. All functions reproduce the original SMath formulas.
 *
 * Depends on: db.js (CORES, COL_* constants)
 */

/**
 * Width (mm) of the requested leg.
 *   center → Center_W column
 *   outer/half → (Core_L - Outer_Sep) / 2
 * @param {string} name  core name key
 * @param {string} leg   "center" | "outer" | "half"
 * @returns {number} mm
 */
function coreW(name, leg = "center") {
  const d = CORES[name];
  if (!d) throw new Error(`Unknown core: ${name}`);
  if (leg === "center") {
    return d[COL_CENTER_W];
  } else if (leg === "outer" || leg === "half") {
    return (d[COL_CORE_L] - d[COL_OUTER_SEP]) / 2;
  } else {
    throw new Error(`coreW: unknown leg '${leg}'. Use 'center' or 'outer'.`);
  }
}

/**
 * Core height / depth (mm).
 * @param {string} name
 * @returns {number} mm
 */
function coreH(name) {
  const d = CORES[name];
  if (!d) throw new Error(`Unknown core: ${name}`);
  return d[COL_CORE_H];
}

/**
 * Magnetic path length along the vertical legs (mm).
 *   full  → 2 * Core_W   (complete E+E set)
 *   other → Core_W       (half set)
 * @param {string} name
 * @param {string} length  "full" | "half"
 * @returns {number} mm
 */
function coreL(name, length = "full") {
  const d = CORES[name];
  if (!d) throw new Error(`Unknown core: ${name}`);
  if (length === "full") {
    return 2 * d[COL_CORE_W];
  } else {
    return d[COL_CORE_W];
  }
}

/**
 * Yoke (horizontal leg) length (mm).
 *   Core_h_L = Core_W - Window_L
 * @param {string} name
 * @returns {number} mm
 */
function coreHL(name) {
  const d = CORES[name];
  if (!d) throw new Error(`Unknown core: ${name}`);
  return d[COL_CORE_W] - d[COL_WINDOW_L];
}

/**
 * Yoke effective magnetic path width (mm) = le_h.
 *   Core_h_W = Core_L - (Core_L - Outer_Sep) / 2
 *            = Core_L/2 + Outer_Sep/2
 * @param {string} name
 * @returns {number} mm
 */
function coreHW(name) {
  const d = CORES[name];
  if (!d) throw new Error(`Unknown core: ${name}`);
  return d[COL_CORE_L] - (d[COL_CORE_L] - d[COL_OUTER_SEP]) / 2;
}

/**
 * Coil former width (mm).
 *   slot_W = (Outer_Sep - Center_W) / 2
 *   full  → slot_W - 2*spacing - thickness
 *   half  → (slot_W - 3*spacing - 2*thickness) / 2
 * @param {string} name
 * @param {string} winding   "full" | "half"
 * @param {number} spacing   core-to-former clearance (mm)
 * @param {number} thickness former wall thickness (mm)
 * @returns {number} mm
 */
function coilFormerW(name, winding, spacing, thickness) {
  const d = CORES[name];
  if (!d) throw new Error(`Unknown core: ${name}`);
  const slotW = (d[COL_OUTER_SEP] - d[COL_CENTER_W]) / 2;
  if (winding === "full") {
    return slotW - 2 * spacing - thickness;
  } else if (winding === "half") {
    return (slotW - 3 * spacing - 2 * thickness) / 2;
  } else {
    throw new Error(`coilFormerW: unknown winding '${winding}'.`);
  }
}

/**
 * Coil former length (mm).
 *   full  → 2 * (Window_L - spacing - thickness)
 *   other → Window_L - 2*spacing - 2*thickness
 * @param {string} name
 * @param {string} coilLength  "full" | "half"
 * @param {number} spacing     core-to-former clearance (mm)
 * @param {number} thickness   former wall thickness (mm)
 * @returns {number} mm
 */
function coilFormerL(name, coilLength, spacing, thickness) {
  const d = CORES[name];
  if (!d) throw new Error(`Unknown core: ${name}`);
  const winL = d[COL_WINDOW_L];
  if (coilLength === "full") {
    return 2 * (winL - spacing - thickness);
  } else {
    return winL - 2 * spacing - 2 * thickness;
  }
}
