/**
 * analysis.js — DC and AC sweep analyses
 *
 * Ported from variable_inductor.py:
 *   compute_dc_analysis()
 *   compute_ac_analysis()
 *
 * Depends on: db.js, physics.js
 */

/**
 * DC bias analysis: solve Bdc(I), then compute Ldc and Ldc_eff.
 *
 *   Ldc(I)     = 2 · N_bias · Bdc(I) · Ae_outer / I
 *   Ldc_eff(I) = Ldc(I) + I · dLdc/dI   (numerical central difference)
 *
 * The first point avoids I=0 (singularity); starts from I_max/nPoints.
 *
 * @param {object} design    Design dict from calculate()
 * @param {number} nPoints   Number of I_bias points (default 300)
 * @returns {{I_arr, Bdc_arr, Ldc_arr, Leff_arr}}  all Float64Array
 */
function computeDcAnalysis(design, nPoints = 300) {
  const N_bias   = design.N_bias;
  const Ae_outer = design.Ae_outer_m2;
  const le_outer = design.le_outer_m;
  const le_h     = design.le_h_m;
  const Ae_h     = design.Ae_h_m2;
  const lg_outer = design.lg_outer_m;
  const k1       = design.k1;
  const k2       = design.k2;
  const k3       = design.k3;
  const I_max    = design.I_bias_max_A;
  const kf_outer = design.kf_outer;

  function Bdc(I) {
    return solveBdc(I, N_bias, Ae_outer, le_outer, le_h, Ae_h, lg_outer,
                    k1, k2, k3, kf_outer);
  }

  function Ldc(I) {
    if (I <= 0.0) return NaN;
    return 2.0 * N_bias * Bdc(I) * Ae_outer / I;
  }

  // Step size for numerical derivative (central difference)
  const h = I_max * 1e-5;

  function Ldc_eff(I) {
    if (I <= h) return NaN;
    const dL = (Ldc(I + h) - Ldc(I - h)) / (2.0 * h);
    return Ldc(I) + I * dL;
  }

  // Avoid I=0; start from I_max/nPoints
  const I_arr    = new Float64Array(nPoints);
  const Bdc_arr  = new Float64Array(nPoints);
  const Ldc_arr  = new Float64Array(nPoints);
  const Leff_arr = new Float64Array(nPoints);

  for (let i = 0; i < nPoints; i++) {
    const I = I_max / nPoints + (I_max - I_max / nPoints) * i / (nPoints - 1);
    I_arr[i]    = I;
    Bdc_arr[i]  = Bdc(I);
    Ldc_arr[i]  = Ldc(I);
    Leff_arr[i] = Ldc_eff(I);
  }

  return { I_arr, Bdc_arr, Ldc_arr, Leff_arr };
}

/**
 * AC analysis: compute Lac and Bac vs I_bias for several AC current amplitudes.
 *
 *   Lac(Ibias, Iac) = N_main · Bac · Ae_c / Iac
 *
 * Uses solveBac (not solveBacFull) matching Python compute_ac_analysis.
 *
 * @param {object}   design          Design dict from calculate()
 * @param {number[]} IacFractions    Fractions of I_pk (default [0.25, 0.5, 1.0])
 * @param {number}   nPoints         Number of I_bias points (default 300)
 * @returns {{I_bias_arr, Lac_matrix, Bac_matrix, Iac_list}}
 *   I_bias_arr : Float64Array length nPoints
 *   Lac_matrix : Array of Float64Array (one per Iac fraction)
 *   Bac_matrix : Array of Float64Array (one per Iac fraction)
 *   Iac_list   : number[] actual AC current values used
 */
function computeAcAnalysis(design, IacFractions = [0.25, 0.5, 1.0], nPoints = 300) {
  const N_main   = design.N_main;
  const N_bias   = design.N_bias;
  const Ae_c     = design.Ae_center_m2;
  const Ae_o     = design.Ae_outer_m2;
  const Ae_h     = design.Ae_h_m2;
  const le_c     = design.le_center_m;
  const le_o     = design.le_outer_m;
  const le_h     = design.le_h_m;
  const lg_c     = design.lg_center_mm * 1e-3;
  const lg_o     = design.lg_outer_m;
  const k1       = design.k1;
  const k2       = design.k2;
  const k3       = design.k3;
  const I_pk     = design.I_main_pk_A;
  const I_max    = design.I_bias_max_A;
  const kf_c     = design.kf_center;
  const kf_o     = design.kf_outer;

  const Iac_list = IacFractions.map(f => Math.round(I_pk * f * 10000) / 10000);

  // Build I_bias array including 0
  const I_bias_arr = new Float64Array(nPoints);
  for (let i = 0; i < nPoints; i++) {
    I_bias_arr[i] = I_max * i / (nPoints - 1);
  }

  const Lac_matrix = IacFractions.map(() => new Float64Array(nPoints).fill(NaN));
  const Bac_matrix = IacFractions.map(() => new Float64Array(nPoints).fill(NaN));

  for (let j = 0; j < Iac_list.length; j++) {
    const Iac = Iac_list[j];
    for (let i = 0; i < nPoints; i++) {
      const Ib  = I_bias_arr[i];
      const Bac = solveBac(
        Ib, Iac, N_main, N_bias, Ae_c, Ae_o, Ae_h,
        le_c, le_o, le_h, lg_c, lg_o,
        k1, k2, k3, kf_c, kf_o
      );
      if (!isNaN(Bac)) {
        Bac_matrix[j][i] = Bac;
        Lac_matrix[j][i] = N_main * Bac * Ae_c / Iac;
      }
    }
  }

  return { I_bias_arr, Lac_matrix, Bac_matrix, Iac_list };
}
