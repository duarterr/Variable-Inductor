/**
 * design.js — Main inductor design calculator
 *
 * Ported from variable_inductor.py run_interactive().
 * Implements calculate(inputs) → design dict (all keys match Python output).
 *
 * Depends on: db.js, core_geom.js, physics.js
 */

/**
 * Run the full design calculation for the variable inductor.
 *
 * @param {object} inp  Input parameters (see defaults for all keys)
 * @returns {object}    Design dictionary (matches Python run_interactive return)
 * @throws {Error}      If geometry is invalid or solvers fail
 */
function calculate(inp) {
  // ── SI unit conversions ────────────────────────────────────────────────────
  const L_nom        = inp.L_main_nom_uH * 1e-6;   // H
  const L_min        = inp.L_main_min_uH * 1e-6;   // H
  const f_sw         = inp.f_sw_kHz * 1e3;          // Hz
  const J_max        = inp.J_max_Acm2 * 1e4;        // A/m²
  const spacing      = inp.spacing_mm * 1e-3;        // m
  const thickness    = inp.thickness_mm * 1e-3;      // m
  const lg_outer     = inp.lg_outer_mm * 1e-3;       // m

  const k1 = inp.k1;
  const k2 = inp.k2;
  const k3 = inp.k3;

  // ── Core geometry ──────────────────────────────────────────────────────────
  const core_name = inp.core_name;

  const Cc_W  = coreW(core_name, "center");       // mm
  const Co_W  = coreW(core_name, "outer");        // mm
  const C_H   = coreH(core_name);                 // mm
  const Ch_L  = coreHL(core_name);                // mm  (yoke length)

  const Ae_center = Cc_W * C_H * 1e-6;           // m²
  const Ae_outer  = Co_W * C_H * 1e-6;           // m²
  const Ae_h      = Ch_L * C_H * 1e-6;           // m²

  const le_center = (coreL(core_name, "full") - Ch_L) * 1e-3;  // m
  const le_outer  = le_center;                                   // m  (same path)
  const le_h      = coreHW(core_name) * 1e-3;                   // m

  // Coil former dimensions (use "half" winding for CF_W as Python does)
  const CF_W_mm = coilFormerW(core_name, "half", inp.spacing_mm, inp.thickness_mm);
  const CF_L_mm = coilFormerL(core_name, inp.coil_length, inp.spacing_mm, inp.thickness_mm);
  const CF_W = CF_W_mm * 1e-3;   // m
  const CF_L = CF_L_mm * 1e-3;   // m
  const Aw   = CF_W * CF_L;      // m²

  // Outer gap reluctance (constant)
  const Rg_outer = lg_outer / (inp.kf_outer * MU_0 * Ae_outer);

  // Mean turn lengths (m)
  function meanTurn(leg_W_mm, cf_w_m) {
    const mW = leg_W_mm * 1e-3 + 2 * spacing + 2 * thickness + cf_w_m / 2;
    const mL = C_H * 1e-3        + 2 * spacing + 2 * thickness + cf_w_m / 2;
    return 2 * (mW + mL);
  }
  const lt_center = meanTurn(Cc_W, CF_W);  // m
  const lt_outer  = meanTurn(Co_W, CF_W);  // m

  // Area product requirement
  const AeAw_rec    = L_nom * inp.I_main_pk_A * inp.I_main_rms_A
                       / (inp.kw * inp.B_main_max_T * J_max);
  const AeAw_chosen = Ae_center * Aw;

  // Bundle of core/material params for solveBacFull calls
  // solveBacFull(Ibias, Iac, N_b, lg_c, N_main,
  //              Ae_center, le_center, Ae_outer, le_outer, le_h, Ae_h,
  //              lg_outer, k1, k2, k3, kf_center, kf_outer, override)
  function callBacFull(Ibias, Iac, N_b, lg_c, N_m, N_override = null) {
    return solveBacFull(
      Ibias, Iac, N_b, lg_c, N_m,
      Ae_center, le_center, Ae_outer, le_outer, le_h, Ae_h,
      lg_outer, k1, k2, k3,
      inp.kf_center, inp.kf_outer,
      N_override
    );
  }

  // Rough N_main estimate (Faraday ceiling)
  const N_main_rough = Math.ceil(L_nom * inp.I_main_pk_A / (inp.B_main_max_T * Ae_center));

  // ── Mode 1: N_main fixed → solve lg_center ────────────────────────────────
  let N_main, lg_center, lg_center_mm, N_main_calc;

  if (inp.design_mode === 1) {
    N_main      = inp.N_main;
    N_main_calc = L_nom * inp.I_main_pk_A / (inp.B_main_max_T * Ae_center); // float

    // Find lg_center such that solveBacFull(0, I_pk, 2, lg_c, N_main) = L_nom
    function f_lgc(lgc) {
      const [, Lac] = callBacFull(0.0, inp.I_main_pk_A, 2, lgc, N_main);
      if (isNaN(Lac)) throw new Error(`solveBacFull returned NaN at lgc=${lgc}`);
      return Lac - L_nom;
    }

    const _L_lo = callBacFull(0.0, inp.I_main_pk_A, 2, 1e-7, N_main)[1];
    const _L_hi = callBacFull(0.0, inp.I_main_pk_A, 2, 20e-3, N_main)[1];
    const signOk = !isNaN(_L_lo) && !isNaN(_L_hi) && (_L_lo - L_nom) * (_L_hi - L_nom) < 0;

    if (!signOk) {
      throw new Error(
        `Cannot bracket lg_center for N_main=${N_main}. ` +
        `L(lgc=0.1mm)=${(_L_lo*1e6).toFixed(1)}uH, ` +
        `L(lgc=20mm)=${(_L_hi*1e6).toFixed(1)}uH, ` +
        `target=${(L_nom*1e6).toFixed(1)}uH. ` +
        `Check N_main and core size.`
      );
    }

    lg_center    = brentq(f_lgc, 1e-7, 20e-3, 1e-10, 300);
    lg_center_mm = lg_center * 1e3;

  // ── Mode 3: both N_main and lg_center fixed — compute L directly ──────────
  } else if (inp.design_mode === 3) {
    N_main       = inp.N_main;
    lg_center_mm = inp.lg_center_mm;
    lg_center    = lg_center_mm * 1e-3;
    N_main_calc  = N_main; // no solver, reported as-is

  // ── Mode 2: lg_center fixed → solve N_main ────────────────────────────────
  } else {
    lg_center_mm = inp.lg_center_mm;
    lg_center    = lg_center_mm * 1e-3;

    // Find N_main (continuous) such that solveBacFull(0, I_pk, 2, lg_c, 1, override=N) = L_nom
    function f_Nac(N_cont) {
      const N = Math.max(1, Math.round(N_cont));
      const [, Lac] = callBacFull(0.0, inp.I_main_pk_A, 2, lg_center, 1, N);
      if (isNaN(Lac)) throw new Error(`solver returned NaN at N=${N}`);
      return Lac - L_nom;
    }

    const _L_lo2 = callBacFull(0.0, inp.I_main_pk_A, 2, lg_center, 1, 1)[1];
    const _L_hi2 = callBacFull(0.0, inp.I_main_pk_A, 2, lg_center, 1, 500)[1];
    const signOk2 = !isNaN(_L_lo2) && !isNaN(_L_hi2) && (_L_lo2 - L_nom) * (_L_hi2 - L_nom) < 0;

    let N_main_cont;
    if (signOk2) {
      N_main_cont = brentq(f_Nac, 1, 500, 0.5, 300);
    } else {
      throw new Error(
        `Cannot bracket N_main for lg_center=${lg_center_mm}mm. ` +
        `L(N=1)=${(_L_lo2*1e6).toFixed(1)}uH, L(N=500)=${(_L_hi2*1e6).toFixed(1)}uH.`
      );
    }

    N_main = Math.ceil(N_main_cont);
    N_main_calc = parseFloat(N_main); // float copy for reporting
  }

  // ── Centre-leg reluctance (linear approximation at B=0) ───────────────────
  const Rg_center = lg_center / (inp.kf_center * MU_0 * Ae_center);
  const mu_c0     = muD(0.0, k1, k2, k3);   // μ_D at B=0 = μ_T at B=0
  const Rc_c0     = (le_center - lg_center) / (mu_c0 * Ae_center);
  const Req_c     = Rc_c0 + Rg_center;

  // Recompute final L_nom with confirmed design
  const [, L_nom_final] = callBacFull(0.0, inp.I_main_pk_A, 2, lg_center, N_main);

  // ── Solve N_bias ────────────────────────────────────────────────────────────
  // Lac(N_bias) is monotonically decreasing with N_bias.
  // Find the smallest even integer N_bias such that Lac(I_bias_max) <= L_min.
  function lacAtN(N) {
    const [, Lac] = callBacFull(inp.I_bias_max_A, inp.I_main_pk_A, N, lg_center, N_main);
    return Lac;
  }

  let N_bias;
  if (inp.N_bias_override != null && inp.N_bias_override >= 1) {
    // User-specified per coil → total = 2 × per-coil
    N_bias = inp.N_bias_override * 2;
  } else {
    try {
      // Expand upper bracket until Lac(N_hi) <= L_min
      let N_lo = 2, N_hi = 100;
      while (lacAtN(N_hi) > L_min && N_hi < 10000) N_hi *= 2;
      if (lacAtN(N_hi) > L_min) throw new Error("Cannot reach L_min within N_bias limit");

      // Binary search: find smallest even N in [N_lo, N_hi] where Lac <= L_min
      while (N_hi - N_lo > 2) {
        let N_mid = Math.floor((N_lo + N_hi) / 2);
        if (N_mid % 2 !== 0) N_mid += 1;
        if (lacAtN(N_mid) > L_min) {
          N_lo = N_mid;
        } else {
          N_hi = N_mid;
        }
      }
      // N_hi is the smallest even N where Lac <= L_min
      N_bias = N_hi % 2 === 0 ? N_hi : N_hi + 1;
    } catch (e) {
      N_bias = 60; // fallback
    }
  }
  // Ensure even
  if (N_bias % 2 !== 0) N_bias += 1;

  // ── Final operating point with chosen N_bias ───────────────────────────────
  const [, L_bias_final] = callBacFull(
    inp.I_bias_max_A, inp.I_main_pk_A, N_bias, lg_center, N_main
  );
  const Bdc_final = solveBdc(
    inp.I_bias_max_A, N_bias, Ae_outer, le_outer, le_h, Ae_h, lg_outer,
    k1, k2, k3, inp.kf_outer
  );

  // mu_r needed for L_min target
  const Req_total_min = N_main * N_main / L_min;
  const Req_outer_min = 2.0 * (Req_total_min - Req_c);
  let mu_r_needed = NaN;
  if (Req_outer_min > Rg_outer) {
    mu_r_needed = (le_h / Ae_h + (le_outer - lg_outer) / Ae_outer)
                   / (MU_0 * (Req_outer_min - Rg_outer));
  }

  // ── Wire selection — main winding ──────────────────────────────────────────
  const S_req_main  = inp.I_main_rms_A / J_max;
  const S_skin_main = Math.PI * (7.5e-2) * (7.5e-2) / f_sw;

  const awg_req_main  = findAwgGeq(S_req_main,  COL_S_CU);
  const awg_skin_main = findAwgGeq(S_skin_main, COL_S_CU);

  // Default AWG = higher number (thinner) of the two constraints
  // (thinnest wire that satisfies both ampacity and skin depth)
  const AWG_main_default = Math.max(awg_req_main[COL_AWG], awg_skin_main[COL_AWG]);
  const AWG_main         = inp.AWG_main || AWG_main_default;
  const awg_main_row     = findAwgMatch(AWG_main);
  const S_main_Cu        = awg_main_row[COL_S_CU];
  const S_main_total     = awg_main_row[COL_S_TOTAL];

  const N_cond_main_auto = Math.max(1, Math.ceil(S_req_main / S_main_Cu));
  const N_cond_main      = (inp.N_cond_main != null) ? inp.N_cond_main : N_cond_main_auto;

  const Aw_used_main = N_main * N_cond_main * S_main_total;
  const kw_req_main  = Aw_used_main / Aw;

  // ── Wire selection — bias winding ──────────────────────────────────────────
  const S_req_bias = inp.I_bias_max_A / J_max;

  const awg_req_bias = findAwgGeq(S_req_bias, COL_S_CU);
  const AWG_bias     = inp.AWG_bias || awg_req_bias[COL_AWG];
  const awg_bias_row = findAwgMatch(AWG_bias);
  const S_bias_Cu    = awg_bias_row[COL_S_CU];
  const S_bias_total = awg_bias_row[COL_S_TOTAL];

  const N_cond_bias_auto = Math.max(1, Math.ceil(S_req_bias / S_bias_Cu));
  const N_cond_bias      = (inp.N_cond_bias != null) ? inp.N_cond_bias : N_cond_bias_auto;

  const Aw_used_bias = (N_bias / 2) * N_cond_bias * S_bias_total;
  const kw_req_bias  = Aw_used_bias / Aw;

  // ── Reluctance network at I_bias = 0 ──────────────────────────────────────
  const mu_out_0    = muT(0.0, k1, k2, k3);   // initial permeability (Bdc=0)
  const Rc_h_0      = le_h    / (mu_out_0 * Ae_h);
  const Rc_o_0      = (le_outer - lg_outer) / (mu_out_0 * Ae_outer);
  const Req_outer_0 = Rc_h_0 + Rc_o_0 + Rg_outer;
  const Req_total_0 = Req_outer_0 / 2.0 + Req_c;

  // ── Reluctance network at I_bias_max ──────────────────────────────────────
  const mu_out    = muT(Bdc_final, k1, k2, k3);
  const Rc_h_nl   = le_h    / (mu_out * Ae_h);
  const Rc_o_nl   = (le_outer - lg_outer) / (mu_out * Ae_outer);
  const Req_outer = Rc_h_nl + Rc_o_nl + Rg_outer;
  const Req_total = Req_outer / 2.0 + Req_c;

  // ── Operating point ────────────────────────────────────────────────────────
  const F_main    = N_main * inp.I_main_pk_A;
  const Phi_main  = F_main / Req_total;
  const B_center  = Phi_main / Ae_center;
  const L_main    = N_main * N_main / Req_total;

  const F_bias    = N_bias * inp.I_bias_max_A;
  const Phi_bias  = F_bias / (2.0 * Req_outer);
  const B_outer   = Phi_bias / Ae_outer;

  // ── Wire resistance ────────────────────────────────────────────────────────
  const wire_len_main = N_main * N_cond_main * lt_center;
  const wire_R_main   = R_CU * N_main * lt_center / (S_main_Cu * N_cond_main);

  const wire_len_bias = N_bias * N_cond_bias * lt_outer;
  const wire_R_bias   = R_CU * N_bias * lt_outer / (S_bias_Cu * N_cond_bias);

  // ── Current density ────────────────────────────────────────────────────────
  const J_main_Acm2 = (inp.I_main_rms_A / (S_main_Cu * N_cond_main)) * 1e-4;  // A/cm²
  const J_bias_Acm2 = (inp.I_bias_max_A / (S_bias_Cu * N_cond_bias)) * 1e-4;  // A/cm²

  // ── Return design dict (all keys match Python run_interactive) ─────────────
  return {
    // design mode
    design_mode: inp.design_mode,
    // targets
    L_main_nom_uH:       inp.L_main_nom_uH,
    L_main_min_uH:       inp.L_main_min_uH,
    L_nom_achieved_uH:   L_nom_final * 1e6,
    L_ac_at_bias_uH:     L_bias_final * 1e6,
    // material
    mat_name:    inp.mat_name,
    mu_i:        inp.mu_i,
    desc_mat:    inp.desc_mat,
    // inputs
    f_sw_kHz:      inp.f_sw_kHz,
    I_main_rms_A:  inp.I_main_rms_A,
    I_main_pk_A:   inp.I_main_pk_A,
    B_main_max_T:  inp.B_main_max_T,
    I_bias_max_A:  inp.I_bias_max_A,
    kw:            inp.kw,
    J_max_Acm2:    inp.J_max_Acm2,
    spacing_mm:    inp.spacing_mm,
    thickness_mm:  inp.thickness_mm,
    coil_length:   inp.coil_length,
    k1, k2, k3,
    // geometry
    core:          core_name,
    Ae_center_m2:  Ae_center,
    Ae_outer_m2:   Ae_outer,
    Ae_h_m2:       Ae_h,
    Aw_m2:         Aw,
    CF_W_mm:       CF_W_mm,
    CF_L_mm:       CF_L_mm,
    le_center_m:   le_center,
    le_outer_m:    le_outer,
    le_h_m:        le_h,
    lt_center_mm:  lt_center * 1e3,
    lt_outer_mm:   lt_outer  * 1e3,
    AeAw_rec_mm4:  AeAw_rec    * 1e12,
    AeAw_avail_mm4: AeAw_chosen * 1e12,
    // main winding
    N_main,
    N_main_calc,
    AWG_main,
    N_cond_main,
    S_main_Cu_mm2:    S_main_Cu    * 1e6,
    S_main_total_mm2: S_main_total * 1e6,
    kw_max:      inp.kw,
    kw_req_main,
    // gaps
    lg_center_mm,
    lg_center_calc_mm: lg_center_mm,
    lg_outer_mm:   inp.lg_outer_mm,
    lg_outer_m:    lg_outer,
    kf_center:     inp.kf_center,
    kf_outer:      inp.kf_outer,
    // bias winding
    N_bias,
    mu_r_needed,
    AWG_bias,
    N_cond_bias,
    S_bias_Cu_mm2:    S_bias_Cu    * 1e6,
    S_bias_total_mm2: S_bias_total * 1e6,
    kw_req_bias,
    // reluctances (at I_bias=0)
    Rc_h_0,
    Rc_outer_0: Rc_o_0,
    Req_outer_0,
    Req_total_0,
    // reluctances (at I_bias_max)
    Rg_center,
    Rg_outer,
    Rc_center:  Rc_c0,
    Rc_h:       Rc_h_nl,
    Rc_outer:   Rc_o_nl,
    Req_center: Req_c,
    Req_outer,
    Req_total,
    // operating point
    F_main,
    Phi_main_uWb:  Phi_main * 1e6,
    B_center_mT:   B_center * 1e3,
    L_main_uH:     L_main   * 1e6,
    Bdc_max_mT:    Bdc_final * 1e3,
    B_outer_mT:    B_outer  * 1e3,
    // resistance
    wire_len_main_m:          wire_len_main,
    R_main_winding_mOhm:      wire_R_main * 1e3,
    J_main_Acm2,
    wire_len_bias_m:          wire_len_bias,
    wire_len_bias_per_leg_m:  wire_len_bias / 2,
    R_bias_winding_mOhm:      wire_R_bias * 1e3,
    J_bias_Acm2,
    R_bias_per_leg_mOhm:      wire_R_bias * 1e3 / 2,
  };
}

/**
 * Default input values (match Python DEFAULTS + typical user choices).
 */
const DEFAULT_INPUTS = {
  L_main_nom_uH:  60.0,
  L_main_min_uH:  6.0,
  f_sw_kHz:       100.0,
  I_main_rms_A:   1.3,
  I_main_pk_A:    3.4,
  B_main_max_T:   0.35,
  I_bias_max_A:   0.5,
  mat_name:       "N87 (TDK)",
  mu_i:           2200,
  desc_mat:       "TDK EPCOS N87, MnZn, ~100 kHz",
  k1:             0.062,
  k2:             42.995,
  k3:             302.904,
  kw:             0.7854,
  J_max_Acm2:     450.0,
  coil_length:    "half",
  spacing_mm:     0.25,
  thickness_mm:   0.75,
  lg_outer_mm:    0.01,
  kf_outer:       1.0,
  kf_center:      1.06,
  core_name:      "E 30/15/7 TDK",
  design_mode:    1,
  N_main:         16,
  lg_center_mm:   0.3,
  AWG_main:       null,    // null → auto-select
  N_cond_main:    null,    // null → auto
  AWG_bias:       null,
  N_cond_bias:    null,    // null → auto
};
