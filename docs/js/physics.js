/**
 * physics.js — Nonlinear magnetics and root-finding
 *
 * Ported from variable_inductor.py (_mu_T, _mu_D, _solve_Bdc, _solve_Bac_full,
 * _solve_Bac) and scipy.optimize.brentq.
 *
 * All SI units unless stated otherwise.
 */

// Permeability of free space (H/m)
const MU_0 = 4 * Math.PI * 1e-7;

// ── Permeability models ───────────────────────────────────────────────────────

/**
 * Nonlinear incremental (chord) permeability μ_T(B) in H/m.
 *
 * Model:  μ_T(B) = 1 / (k1·exp(k2·B²) + k3)
 *
 * The exponential argument is clamped to [-500, 500] to prevent overflow.
 *
 * @param {number} B   flux density (T)
 * @param {number} k1  BH model coefficient (H/m)
 * @param {number} k2  BH model coefficient (T⁻²)
 * @param {number} k3  BH model coefficient (H/m)
 * @returns {number} μ_T in H/m
 */
function muT(B, k1, k2, k3) {
  const arg = Math.min(Math.max(k2 * B * B, -500), 500);
  return 1.0 / (k1 * Math.exp(arg) + k3);
}

/**
 * Differential permeability dB/dH in H/m.
 *
 * Model:  μ_D(B) = 1 / (k1·(1 + 2·k2·B²)·exp(k2·B²) + k3)
 *
 * Used for AC inductance calculations because the incremental Lac is
 * proportional to dB/dH, not B/H.
 *
 * @param {number} B   flux density (T)
 * @param {number} k1  BH model coefficient (H/m)
 * @param {number} k2  BH model coefficient (T⁻²)
 * @param {number} k3  BH model coefficient (H/m)
 * @returns {number} μ_D in H/m
 */
function muD(B, k1, k2, k3) {
  const arg = Math.min(Math.max(k2 * B * B, -500), 500);
  const ex = Math.exp(arg);
  return 1.0 / (k1 * (1.0 + 2.0 * k2 * B * B) * ex + k3);
}

// ── Brent's root-finding method ───────────────────────────────────────────────

/**
 * Find a root of f in [a, b] using Brent's method (Illinois variant).
 *
 * Combines bisection, secant, and inverse quadratic interpolation for
 * guaranteed convergence with superlinear speed near the root.
 *
 * @param {function} f       scalar function of one variable
 * @param {number}   a       left bracket (f(a) and f(b) must have opposite signs)
 * @param {number}   b       right bracket
 * @param {number}   tol     absolute tolerance (default 1e-10)
 * @param {number}   maxIter maximum iterations (default 300)
 * @returns {number}  root x such that |f(x)| < tol or |b-a| < tol
 * @throws  {Error} if bracket has no sign change or does not converge
 */
function brentq(f, a, b, tol = 1e-10, maxIter = 300) {
  let fa = f(a);
  let fb = f(b);

  if (fa * fb > 0) {
    throw new Error(`brentq: f(a)=${fa} and f(b)=${fb} have the same sign — no bracket.`);
  }

  // Ensure |f(a)| >= |f(b)| so b is the better estimate
  if (Math.abs(fa) < Math.abs(fb)) {
    [a, b] = [b, a];
    [fa, fb] = [fb, fa];
  }

  let c = a, fc = fa;
  let mflag = true;
  let s = b, fs = fb;
  let d = 0;

  for (let i = 0; i < maxIter; i++) {
    if (Math.abs(b - a) < tol) return b;
    if (Math.abs(fb) < tol) return b;
    if (Math.abs(fs) < tol) return s;

    // Choose step: inverse quadratic interpolation or secant
    if (fa !== fc && fb !== fc) {
      // Inverse quadratic interpolation
      s = (a * fb * fc) / ((fa - fb) * (fa - fc))
        + (b * fa * fc) / ((fb - fa) * (fb - fc))
        + (c * fa * fb) / ((fc - fa) * (fc - fb));
    } else {
      // Secant
      s = b - fb * (b - a) / (fb - fa);
    }

    // Bisect if s is out of range or did not decrease fast enough
    const cond1 = !((3 * a + b) / 4 < s && s < b) &&
                  !((3 * a + b) / 4 > s && s > b);
    const cond2 = mflag  && Math.abs(s - b) >= Math.abs(b - c) / 2;
    const cond3 = !mflag && Math.abs(s - b) >= Math.abs(c - d) / 2;
    const cond4 = mflag  && Math.abs(b - c) < tol;
    const cond5 = !mflag && Math.abs(c - d) < tol;

    if (cond1 || cond2 || cond3 || cond4 || cond5) {
      s = (a + b) / 2;
      mflag = true;
    } else {
      mflag = false;
    }

    fs = f(s);
    d  = c;
    c  = b;
    fc = fb;

    if (fa * fs < 0) {
      b = s; fb = fs;
    } else {
      a = s; fa = fs;
    }

    if (Math.abs(fa) < Math.abs(fb)) {
      [a, b] = [b, a];
      [fa, fb] = [fb, fa];
    }
  }

  throw new Error(`brentq: did not converge after ${maxIter} iterations.`);
}

// ── Magnetic circuit solvers ──────────────────────────────────────────────────

/**
 * Solve for DC flux density B_dc (T) in the outer-leg circuit.
 *
 * Equation (implicit in B):
 *   N·I = B · Ae_outer · Req_outer(B)
 *
 * where:
 *   Req_outer(B) = Rc_h(B) + Rc_outer(B) + Rg_outer
 *   Rc_h(B)      = le_h   / (μ_T(B) · Ae_h)
 *   Rc_outer(B)  = le_outer / (μ_T(B) · Ae_outer)   [le_outer used raw]
 *   Rg_outer     = lg_outer / (kf_outer · μ0 · Ae_outer)  [constant]
 *
 * Note: le_outer is used WITHOUT subtracting lg_outer here; this matches the
 * Python _solve_Bdc implementation exactly (line 1775 of variable_inductor.py).
 *
 * @param {number} Idc       DC current (A)
 * @param {number} N_bias    number of bias winding turns
 * @param {number} Ae_outer  outer-leg cross-section (m²)
 * @param {number} le_outer  outer-leg magnetic path length (m)
 * @param {number} le_h      horizontal-yoke path length (m)
 * @param {number} Ae_h      horizontal-yoke cross-section (m²)
 * @param {number} lg_outer  outer-leg air-gap length (m)
 * @param {number} k1        BH model k1
 * @param {number} k2        BH model k2
 * @param {number} k3        BH model k3
 * @param {number} kf_outer  fringing factor for outer gap (default 1.0)
 * @returns {number}  B_dc in T (0 if Idc <= 0, NaN if solver fails)
 */
function solveBdc(Idc, N_bias, Ae_outer, le_outer, le_h, Ae_h, lg_outer,
                  k1, k2, k3, kf_outer = 1.0) {
  if (Idc <= 0.0) return 0.0;

  // Constant gap reluctance
  const Rg_outer = lg_outer / (kf_outer * MU_0 * Ae_outer);

  function f(B) {
    const mu = muT(B, k1, k2, k3);
    const Rc_h     = le_h    / (mu * Ae_h);
    const Rc_outer = le_outer / (mu * Ae_outer);
    const Req      = Rc_h + Rc_outer + Rg_outer;
    return B * Ae_outer * Req - N_bias * Idc;
  }

  try {
    return brentq(f, 1e-12, 5.0, 1e-10, 300);
  } catch (e) {
    return NaN;
  }
}

/**
 * Solve for AC flux density B_ac (T) in the centre leg and return [Bac, Lac].
 *
 * Both the centre and outer branches use differential permeability μ_D.
 *
 *   Req_op = (le_h/(μ_D(Bdc)·Ae_h) + (le_outer-lg_outer)/(μ_D(Bdc)·Ae_outer)
 *             + Rg_outer) / 2
 *
 * Then solve implicitly for Bac:
 *   N_main · Iac = Bac · Ae_center · (Rc_c(Bac) + Rg_c + Req_op)
 *   Rc_c(Bac) = (le_center - lg_c) / (μ_D(Bac) · Ae_center)
 *
 * Returns [Bac, Lac] where Lac = N_main · Bac · Ae_center / Iac.
 * Returns [NaN, NaN] if solver fails.
 *
 * @param {number}  Ibias            bias current (A)
 * @param {number}  Iac              AC current amplitude (A)
 * @param {number}  N_b              bias winding turns
 * @param {number}  lg_c             centre-leg gap (m)
 * @param {number}  N_main           main winding turns (may be overridden)
 * @param {number}  Ae_center        centre-leg cross-section (m²)
 * @param {number}  le_center        centre-leg path length (m)
 * @param {number}  Ae_outer         outer-leg cross-section (m²)
 * @param {number}  le_outer         outer-leg path length (m)
 * @param {number}  le_h             yoke path length (m)
 * @param {number}  Ae_h             yoke cross-section (m²)
 * @param {number}  lg_outer         outer-leg gap (m)
 * @param {number}  k1               BH k1
 * @param {number}  k2               BH k2
 * @param {number}  k3               BH k3
 * @param {number}  kf_center        fringing factor, centre gap (default 1.0)
 * @param {number}  kf_outer         fringing factor, outer gap (default 1.0)
 * @param {number|null} N_main_override  override N_main during root-finding (or null)
 * @returns {[number, number]}  [Bac (T), Lac (H)]
 */
function solveBacFull(Ibias, Iac, N_b, lg_c, N_main,
                      Ae_center, le_center, Ae_outer, le_outer, le_h, Ae_h,
                      lg_outer, k1, k2, k3,
                      kf_center = 1.0, kf_outer = 1.0,
                      N_main_override = null) {
  const _N_main = (N_main_override !== null) ? N_main_override : N_main;

  const Rg_c     = lg_c    / (kf_center * MU_0 * Ae_center);
  const Rg_outer = lg_outer / (kf_outer  * MU_0 * Ae_outer);

  // DC operating point of outer core
  const Bdc    = solveBdc(Ibias, N_b, Ae_outer, le_outer, le_h, Ae_h, lg_outer,
                           k1, k2, k3, kf_outer);
  const mu_out = muD(Bdc, k1, k2, k3);

  // Outer branch equivalent reluctance (two outer legs in parallel → /2)
  // Note: (le_outer - lg_outer) used here for Rc_outer, matching Python line 2018
  const Req_op = (
    le_h    / (mu_out * Ae_h)
    + (le_outer - lg_outer) / (mu_out * Ae_outer)
    + Rg_outer
  ) / 2.0;

  function f(Bac) {
    const mu_c = muD(Bac, k1, k2, k3);
    const Rc_c = (le_center - lg_c) / (mu_c * Ae_center);
    return Bac * Ae_center * (Rc_c + Rg_c + Req_op) - _N_main * Iac;
  }

  let Bac;
  try {
    Bac = brentq(f, 1e-12, 5.0, 1e-10, 300);
  } catch (e) {
    return [NaN, NaN];
  }
  const Lac = _N_main * Bac * Ae_center / Iac;
  return [Bac, Lac];
}

/**
 * Solve for AC flux density B_ac (T) in the centre leg (for AC analysis sweeps).
 *
 * Used by computeAcAnalysis. Returns Bac only (not Lac).
 * Outer branch uses μ_D(Bdc(Ibias)); centre uses μ_D(Bac).
 *
 * Note: Rc_o = le_o / (mu_out * Ae_o)  — le_o is used raw here,
 *       matching Python _solve_Bac (line 1965 of variable_inductor.py).
 *
 * @param {number} Ibias    bias current (A)
 * @param {number} Iac      AC current amplitude (A)
 * @param {number} N_main   main winding turns
 * @param {number} N_bias   bias winding turns
 * @param {number} Ae_c     centre-leg cross-section (m²)
 * @param {number} Ae_o     outer-leg cross-section (m²)
 * @param {number} Ae_h     yoke cross-section (m²)
 * @param {number} le_c     centre-leg path (m)
 * @param {number} le_o     outer-leg path (m)
 * @param {number} le_h     yoke path (m)
 * @param {number} lg_c     centre gap (m)
 * @param {number} lg_o     outer gap (m)
 * @param {number} k1       BH k1
 * @param {number} k2       BH k2
 * @param {number} k3       BH k3
 * @param {number} kf_center fringing factor, centre gap
 * @param {number} kf_outer  fringing factor, outer gap
 * @returns {number} Bac (T), or NaN if Iac <= 0 or solver fails
 */
function solveBac(Ibias, Iac, N_main, N_bias, Ae_c, Ae_o, Ae_h,
                  le_c, le_o, le_h, lg_c, lg_o,
                  k1, k2, k3, kf_center = 1.0, kf_outer = 1.0) {
  if (Iac <= 0.0) return NaN;

  const Rg_c = lg_c / (kf_center * MU_0 * Ae_c);
  const Rg_o = lg_o / (kf_outer  * MU_0 * Ae_o);

  // DC operating point of outer core
  const Bdc    = solveBdc(Ibias, N_bias, Ae_o, le_o, le_h, Ae_h, lg_o,
                           k1, k2, k3, kf_outer);
  const mu_out = muD(Bdc, k1, k2, k3);

  // Outer branch (two in parallel → /2)
  // Note: le_o used raw (not le_o - lg_o), matching Python _solve_Bac line 1965
  const Rc_h               = le_h / (mu_out * Ae_h);
  const Rc_o               = le_o / (mu_out * Ae_o);
  const Req_outer_parallel = (Rc_h + Rc_o + Rg_o) / 2.0;

  function f(Bac) {
    const mu_c = muD(Bac, k1, k2, k3);
    const Rc_c = (le_c - lg_c) / (mu_c * Ae_c);
    return Bac * Ae_c * (Rc_c + Rg_c + Req_outer_parallel) - N_main * Iac;
  }

  try {
    return brentq(f, 1e-12, 5.0, 1e-10, 300);
  } catch (e) {
    return NaN;
  }
}
