/**
 * plots.js — Plotly chart wrappers
 *
 * Ported from variable_inductor.py plot_dc_analysis() and plot_ac_analysis().
 *
 * Depends on: analysis.js, Plotly (global)
 */

// tab10 palette (matches matplotlib default)
const TAB10 = [
  "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
  "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
];

/**
 * Render DC bias analysis chart (Ldc + Ldc_eff on left Y, Bdc on right Y).
 *
 * Matches the Python dual-axis matplotlib figure.
 *
 * @param {object} design   Design dict from calculate()
 * @param {string} divId    ID of the target <div> element
 * @param {number} nPoints  Number of sweep points (default 300)
 */
function plotDcAnalysis(design, divId, nPoints = 300) {
  const { I_arr, Bdc_arr, Ldc_arr, Leff_arr } = computeDcAnalysis(design, nPoints);

  // Convert to plain arrays and scale
  const I_A = Array.from(I_arr);
  const Ldc_uH = Array.from(Ldc_arr).map(v => v * 1e6);
  const Lef_uH = Array.from(Leff_arr).map(v => v * 1e6);
  const Bdc_mT = Array.from(Bdc_arr).map(v => v * 1e3);

  const c1 = "#1f77b4";
  const c2 = "#2ca02c";
  const c3 = "#d62728";

  const traceLdc = {
    x: I_A, y: Ldc_uH,
    name: "L<sub>DC</sub>",
    type: "scatter", mode: "lines",
    line: { color: c1, width: 2.2 },
    yaxis: "y1",
  };

  const traceLeff = {
    x: I_A, y: Lef_uH,
    name: "L<sub>DC,eff</sub>",
    type: "scatter", mode: "lines",
    line: { color: c2, width: 2.0, dash: "dash" },
    yaxis: "y1",
  };

  const traceBdc = {
    x: I_A, y: Bdc_mT,
    name: "B<sub>DC,outer</sub>",
    type: "scatter", mode: "lines",
    line: { color: c3, width: 1.4, dash: "dot" },
    yaxis: "y2",
  };

  const layout = {
    title: {
      text: `DC bias analysis — ${design.core}<br>` +
        `<span style="font-size:11px">N_bias=${design.N_bias} (per leg), ` +
        `lg_outer=${design.lg_outer_mm} mm</span>`,
      font: { size: 13 },
    },
    xaxis: {
      title: "Bias current I<sub>DC</sub> (A)",
      range: [0, design.I_bias_max_A],
      zeroline: true,
    },
    yaxis: {
      title: "Inductance (μH)",
      rangemode: "tozero",
      tickformat: ".0f",
    },
    yaxis2: {
      title: "B<sub>DC,outer</sub> (mT)",
      overlaying: "y",
      side: "right",
      rangemode: "tozero",
      tickformat: ".0f",
      titlefont: { color: c3 },
      tickfont: { color: c3 },
    },
    legend: { x: 0.98, xanchor: "right", y: 0.98 },
    plot_bgcolor: "white",
    paper_bgcolor: "white",
    margin: { l: 60, r: 70, t: 80, b: 55 },
    grid: { rows: 1, columns: 1 },
  };

  Plotly.newPlot(divId, [traceLdc, traceLeff, traceBdc], layout, { responsive: true });
}

/**
 * Render AC analysis chart (two subplots: Lac top, Bac bottom).
 *
 * Matches the Python two-panel matplotlib figure.
 *
 * @param {object}   design          Design dict from calculate()
 * @param {string}   divId           ID of the target <div> element
 * @param {number[]} IacFractions    Fractions of I_pk (default [0.25, 0.5, 1.0])
 * @param {number}   nPoints         Sweep points (default 300)
 */
function plotAcAnalysis(design, divId, IacFractions = [0.25, 0.5, 1.0], nPoints = 300) {
  const { I_bias_arr, Lac_matrix, Bac_matrix, Iac_list } =
    computeAcAnalysis(design, IacFractions, nPoints);

  const I_A = Array.from(I_bias_arr);
  const I_pk = design.I_main_pk_A;

  const tracesLac = [];
  const tracesBac = [];

  for (let j = 0; j < Iac_list.length; j++) {
    const Iac = Iac_list[j];
    const frac = Iac / I_pk;
    const label = `I<sub>ac</sub> = ${Iac.toFixed(2)} A  (${Math.round(frac * 100)}% I<sub>pk</sub>)`;
    const color = TAB10[j % TAB10.length];

    tracesLac.push({
      x: I_A,
      y: Array.from(Lac_matrix[j]).map(v => v * 1e6),
      name: label,
      legendgroup: `grp${j}`,
      type: "scatter", mode: "lines",
      line: { color, width: 2.0 },
      xaxis: "x", yaxis: "y1",
    });

    tracesBac.push({
      x: I_A,
      y: Array.from(Bac_matrix[j]).map(v => v * 1e3),
      name: label,
      legendgroup: `grp${j}`,
      showlegend: false,
      type: "scatter", mode: "lines",
      line: { color, width: 2.0 },
      xaxis: "x", yaxis: "y2",
    });
  }

  const layout = {
    title: {
      text: `Main winding analysis — ${design.core}<br>` +
        `<span style="font-size:10px">N_main=${design.N_main}, N_bias=${design.N_bias} (per leg), ` +
        `lg_center=${design.lg_center_mm.toFixed(3)} mm, lg_outer=${design.lg_outer_mm} mm</span>`,
      font: { size: 13 },
    },
    grid: { rows: 2, columns: 1, subplots: [["xy1"], ["xy2"]], roworder: "top to bottom" },
    xaxis: {
      title: "Bias current I<sub>bias</sub> (A)",
      range: [0, design.I_bias_max_A],
      zeroline: true,
      anchor: "y2",
    },
    yaxis: {
      title: "L<sub>Main</sub> (μH)",
      rangemode: "tozero",
      tickformat: ".0f",
      domain: [0.52, 1.0],
    },
    yaxis2: {
      title: "B<sub>Main,center</sub> (mT)",
      rangemode: "tozero",
      tickformat: ".0f",
      domain: [0.0, 0.46],
    },
    legend: { x: 0.98, xanchor: "right", y: 0.98 },
    plot_bgcolor: "white",
    paper_bgcolor: "white",
    margin: { l: 65, r: 30, t: 90, b: 55 },
  };

  Plotly.newPlot(divId, [...tracesLac, ...tracesBac], layout, { responsive: true });
}
