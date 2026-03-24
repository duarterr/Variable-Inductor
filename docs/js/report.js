/**
 * report.js — PDF report generation with jsPDF + AutoTable
 *
 * Ported from variable_inductor.py generate_report().
 * Captures Plotly charts as PNG images and embeds them.
 *
 * Depends on: jsPDF (window.jspdf.jsPDF), jsPDF-AutoTable plugin, Plotly
 */

/**
 * Generate and download a PDF design report.
 *
 * @param {object} design     Design dict from calculate()
 * @param {string} dcDivId    ID of the DC analysis Plotly div
 * @param {string} acDivId    ID of the AC analysis Plotly div
 */
async function generatePDF(design, dcDivId = "plot-dc", acDivId = "plot-ac") {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  const PAGE_W  = 210;
  const MARGIN  = 18;
  const CONTENT = PAGE_W - 2 * MARGIN;
  let y = MARGIN;

  // Accent colour matching Python PDF: #2980b9
  const ACCENT    = [41, 128, 185];
  const DARK      = [44, 62, 80];
  const GREY_DARK = [52, 73, 94];
  const GREY_LIGHT = [242, 244, 245];
  const WHITE      = [255, 255, 255];

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function addPage() {
    doc.addPage();
    y = MARGIN;
  }

  function checkY(needed) {
    if (y + needed > 297 - MARGIN) addPage();
  }

  function setColor(rgb) {
    doc.setTextColor(rgb[0], rgb[1], rgb[2]);
  }

  function title(text) {
    checkY(12);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    setColor(DARK);
    doc.text(text, MARGIN, y);
    y += 7;
  }

  function h2(text) {
    checkY(10);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    setColor(ACCENT);
    doc.text(text, MARGIN, y);
    y += 6;
  }

  function sub(text) {
    checkY(6);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    setColor([127, 140, 141]);
    doc.text(text, MARGIN, y);
    y += 5;
  }

  function hr() {
    checkY(4);
    doc.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, y, MARGIN + CONTENT, y);
    y += 4;
  }

  function note(text) {
    checkY(8);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8);
    setColor([127, 140, 141]);
    const lines = doc.splitTextToSize(text, CONTENT);
    doc.text(lines, MARGIN, y);
    y += lines.length * 4 + 2;
  }

  function table(head, rows) {
    checkY(20);
    doc.autoTable({
      head: [head],
      body: rows,
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      tableWidth: CONTENT,
      styles: {
        fontSize: 8,
        cellPadding: { top: 2, bottom: 2, left: 3, right: 3 },
        valign: "middle",
      },
      headStyles: {
        fillColor: DARK,
        textColor: WHITE,
        fontStyle: "bold",
        halign: "center",
      },
      alternateRowStyles: { fillColor: GREY_LIGHT },
      columnStyles: {
        0: { halign: "left" },
        1: { halign: "center" },
        2: { halign: "center" },
        3: { halign: "center" },
      },
      didDrawPage: () => { y = doc.lastAutoTable.finalY + 4; },
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Cover page ──────────────────────────────────────────────────────────────
  title("Variable Inductor Design Report");
  const now = new Date();
  const dateStr = now.toISOString().replace("T", " ").substring(0, 16);
  sub(`Core: ${design.core}  |  Generated: ${dateStr}`);
  hr();

  // ── Electrical specifications ────────────────────────────────────────────────
  h2("Electrical Specifications");
  table(
    ["Parameter", "Symbol", "Value", "Unit"],
    [
      ["Main winding nominal inductance (I_bias=0)",    "L_main_nom",  `${design.L_main_nom_uH.toFixed(1)}`,         "μH"],
      ["Main winding minimum inductance (I_bias_max)",  "L_main_min",  `${design.L_main_min_uH.toFixed(1)}`,         "μH"],
      ["Nominal inductance (achieved)",                  "L_main_nom*", `${design.L_nom_achieved_uH.toFixed(2)}`,     "μH"],
      ["Minimum inductance (achieved)",                  "L_main_min*", `${design.L_ac_at_bias_uH.toFixed(2)}`,      "μH"],
      ["Switching frequency",                            "f_sw",        `${design.f_sw_kHz}`,                        "kHz"],
      ["Main winding RMS current",                       "I_main_rms",  `${design.I_main_rms_A}`,                    "A"],
      ["Main winding peak current",                      "I_main_pk",   `${design.I_main_pk_A}`,                     "A"],
      ["Max flux density",                               "B_main_max",  `${design.B_main_max_T}`,                    "T"],
      ["Bias winding max DC current",                    "I_bias_max",  `${design.I_bias_max_A}`,                    "A"],
    ]
  );

  // ── Core material ─────────────────────────────────────────────────────────────
  h2("Core Material");
  sub(`Material: ${design.mat_name}  |  ${design.desc_mat}`);
  table(
    ["Parameter", "Symbol", "Value", "Unit"],
    [
      ["Initial permeability", "μ_i", `${design.mu_i}`,  "—"],
      ["BH model k1",          "k1",  `${design.k1}`,   "H/m"],
      ["BH model k2",          "k2",  `${design.k2}`,   "T⁻²"],
      ["BH model k3",          "k3",  `${design.k3}`,   "H/m"],
    ]
  );

  // ── Core geometry ──────────────────────────────────────────────────────────────
  h2("Core Geometry");
  const span = design.coil_length === "full" ? "Set of E+E cores" : "Set of E+I cores";
  sub(`Core: ${design.core}  |  ${span}`);
  table(
    ["Parameter", "Symbol", "Value", "Unit"],
    [
      ["Centre-leg cross-section",  "Ae_center", `${(design.Ae_center_m2*1e6).toFixed(2)}`, "mm²"],
      ["Outer-leg cross-section",   "Ae_outer",  `${(design.Ae_outer_m2 *1e6).toFixed(2)}`, "mm²"],
      ["Horizontal cross-section",  "Ae_h",      `${(design.Ae_h_m2     *1e6).toFixed(2)}`, "mm²"],
      ["Centre-leg path",           "le_center", `${(design.le_center_m *1e3).toFixed(2)}`, "mm"],
      ["Outer-leg path",            "le_outer",  `${(design.le_outer_m  *1e3).toFixed(2)}`, "mm"],
      ["Horizontal path",           "le_h",      `${(design.le_h_m      *1e3).toFixed(2)}`, "mm"],
      ["Coil former width",         "CF_W",      `${design.CF_W_mm.toFixed(2)}`,            "mm"],
      ["Coil former length",        "CF_L",      `${design.CF_L_mm.toFixed(2)}`,            "mm"],
      ["Window area",               "Aw",        `${(design.Aw_m2       *1e6).toFixed(2)}`, "mm²"],
      ["AeAw required",             "AeAw_req",  `${design.AeAw_rec_mm4.toFixed(2)}`,        "mm⁴"],
      ["AeAw available",            "AeAw_avail",`${design.AeAw_avail_mm4.toFixed(2)}`,      "mm⁴"],
    ]
  );

  // ── Air gaps ───────────────────────────────────────────────────────────────────
  h2("Air Gaps");
  table(
    ["Parameter", "Symbol", "Value", "Unit"],
    [
      ["Centre-leg gap", "lg_center", `${design.lg_center_mm}`, "mm"],
      ["Outer-leg gap",  "lg_outer",  `${design.lg_outer_mm}`,  "mm"],
    ]
  );

  addPage();

  // ── Main winding ───────────────────────────────────────────────────────────────
  h2("Main Winding (Centre Leg)");
  table(
    ["Parameter", "Symbol", "Value", "Unit"],
    [
      ["Calculated turns",          "N_main_calc",   `${design.N_main_calc.toFixed(4)}`,        "—"],
      ["Chosen turns",              "N_main",        `${design.N_main}`,                        "—"],
      ["AWG",                       "AWG_main",      `${design.AWG_main}`,                      "—"],
      ["Parallel conductors",       "N_cond_main",   `${design.N_cond_main}`,                   "—"],
      ["Window fill factor",        "kw_req_main",   `${(design.kw_req_main*100).toFixed(2)}`,  "%"],
      ["Mean turn length",          "lt_center",     `${design.lt_center_mm.toFixed(2)}`,       "mm"],
      ["Total wire length",         "l_main",        `${design.wire_len_main_m.toFixed(4)}`,    "m"],
      ["Winding resistance",        "R_main",        `${design.R_main_winding_mOhm.toFixed(4)}`,"mΩ"],
    ]
  );

  // ── Bias winding ───────────────────────────────────────────────────────────────
  h2("Bias Winding (Outer Legs)");
  table(
    ["Parameter", "Symbol", "Value", "Unit"],
    [
      ["Total turns",               "N_bias",        `${design.N_bias}`,                        "—"],
      ["Turns per outer leg",       "N_bias/2",      `${Math.floor(design.N_bias/2)}`,          "—"],
      ["AWG",                       "AWG_bias",      `${design.AWG_bias}`,                      "—"],
      ["Parallel conductors",       "N_cond_bias",   `${design.N_cond_bias}`,                   "—"],
      ["Window fill factor",        "kw_bias",       `${(design.kw_req_bias*100).toFixed(2)}`,  "%"],
      ["Mean turn length (outer)",  "lt_outer",      `${design.lt_outer_mm.toFixed(2)}`,        "mm"],
      ["Wire length per leg",       "l_bias/leg",    `${design.wire_len_bias_per_leg_m.toFixed(4)}`,"m"],
      ["Wire length total",         "l_bias",        `${design.wire_len_bias_m.toFixed(4)}`,    "m"],
      ["Resistance per leg",        "R_bias/leg",    `${design.R_bias_per_leg_mOhm.toFixed(4)}`,"mΩ"],
      ["Total resistance",          "R_bias",        `${design.R_bias_winding_mOhm.toFixed(4)}`,"mΩ"],
      ["μ_r needed @ I_bias_max",   "μ_r_req",       `${isNaN(design.mu_r_needed) ? "—" : design.mu_r_needed.toFixed(1)}`,"—"],
    ]
  );

  addPage();

  // ── Operating points ──────────────────────────────────────────────────────────
  h2("Operating Points");
  table(
    ["Parameter", "Symbol", "Value", "Unit"],
    [
      ["Main inductance (I_bias=0)",     "L_main_nom", `${design.L_nom_achieved_uH.toFixed(2)}`,  "μH"],
      ["Main inductance (I_bias_max)",   "L_main_min", `${design.L_ac_at_bias_uH.toFixed(2)}`,    "μH"],
      ["MMF main winding (I_main_pk)",   "F_main",     `${design.F_main.toFixed(1)}`,             "A·t"],
      ["Flux centre leg (I_main_pk)",    "Phi_main",   `${design.Phi_main_uWb.toFixed(4)}`,       "μWb"],
      ["B centre leg (I_main_pk)",       "B_center",   `${design.B_center_mT.toFixed(2)}`,        "mT"],
      ["B outer leg (linear)",           "B_outer",    `${design.B_outer_mT.toFixed(2)}`,         "mT"],
      ["Bdc outer (nonlinear, max)",     "Bdc_max",    `${design.Bdc_max_mT.toFixed(2)}`,         "mT"],
    ]
  );

  // ── Reluctance @ I_bias=0 ──────────────────────────────────────────────────────
  h2("Reluctance Network at I_bias=0 (A·t/Wb)");
  table(
    ["Reluctance element", "Symbol", "Value", "Unit"],
    [
      ["Horizontal (μ_i)",        "Rc_h_0",     `${design.Rc_h_0.toExponential(4)}`,     "A·t/Wb"],
      ["Outer core (μ_i)",        "Rc_outer_0", `${design.Rc_outer_0.toExponential(4)}`, "A·t/Wb"],
      ["Outer gap",               "Rg_outer",   `${design.Rg_outer.toExponential(4)}`,   "A·t/Wb"],
      ["Centre core (linear)",    "Rc_center",  `${design.Rc_center.toExponential(4)}`,  "A·t/Wb"],
      ["Centre gap",              "Rg_center",  `${design.Rg_center.toExponential(4)}`,  "A·t/Wb"],
      ["Equiv. outer branch",     "Req_outer_0",`${design.Req_outer_0.toExponential(4)}`,"A·t/Wb"],
      ["Equiv. centre branch",    "Req_center", `${design.Req_center.toExponential(4)}`, "A·t/Wb"],
      ["Total equivalent",        "Req_total_0",`${design.Req_total_0.toExponential(4)}`,"A·t/Wb"],
    ]
  );

  // ── Reluctance @ I_bias_max ───────────────────────────────────────────────────
  h2("Reluctance Network at I_bias_max (A·t/Wb)");
  table(
    ["Reluctance element", "Symbol", "Value", "Unit"],
    [
      ["Horizontal (nonlinear)",  "Rc_h",       `${design.Rc_h.toExponential(4)}`,       "A·t/Wb"],
      ["Outer core (nonlinear)",  "Rc_outer",   `${design.Rc_outer.toExponential(4)}`,   "A·t/Wb"],
      ["Outer gap",               "Rg_outer",   `${design.Rg_outer.toExponential(4)}`,   "A·t/Wb"],
      ["Centre core (linear)",    "Rc_center",  `${design.Rc_center.toExponential(4)}`,  "A·t/Wb"],
      ["Centre gap",              "Rg_center",  `${design.Rg_center.toExponential(4)}`,  "A·t/Wb"],
      ["Equiv. outer branch",     "Req_outer",  `${design.Req_outer.toExponential(4)}`,  "A·t/Wb"],
      ["Equiv. centre branch",    "Req_center", `${design.Req_center.toExponential(4)}`, "A·t/Wb"],
      ["Total equivalent",        "Req_total",  `${design.Req_total.toExponential(4)}`,  "A·t/Wb"],
    ]
  );

  addPage();

  // ── Plots ─────────────────────────────────────────────────────────────────────
  h2("Plots");

  // Capture Plotly charts as PNG
  async function addPlotImage(divId, captionText, aspectH) {
    const el = document.getElementById(divId);
    if (!el || !el._fullLayout) return; // Plotly not yet rendered

    note(captionText);
    checkY(10);

    try {
      const imgData = await Plotly.toImage(el, {
        format: "png", width: 800, height: Math.round(800 * aspectH),
      });
      const imgW = CONTENT * 0.9;
      const imgH = imgW * aspectH;
      checkY(imgH + 8);
      doc.addImage(imgData, "PNG", MARGIN + (CONTENT - imgW) / 2, y, imgW, imgH);
      y += imgH + 8;
    } catch (e) {
      sub(`[Chart capture failed: ${e.message}]`);
    }
  }

  await addPlotImage(
    dcDivId,
    "DC inductance and effective DC inductance vs bias current. Solved nonlinearly via μ_T(B).",
    4.5 / 8
  );

  await addPlotImage(
    acDivId,
    "AC inductance and flux density in the centre leg vs bias current, for several AC current amplitudes.",
    7 / 8
  );

  // ── Core geometry diagram ──────────────────────────────────────────────────────
  const svgContainer = document.getElementById("svg-core-container");
  const svgEl = svgContainer ? svgContainer.querySelector("svg") : null;
  if (svgEl) {
    h2("Core Geometry");
    checkY(10);
    try {
      // Serialise live inline SVG → Blob URL → img → canvas → PNG
      const svgData = new XMLSerializer().serializeToString(svgEl);
      const blob    = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
      const url     = URL.createObjectURL(blob);
      await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          try {
            const W = img.naturalWidth  || 1060;
            const H = img.naturalHeight || 322;
            const pdfImgW = CONTENT * 0.95;
            const pdfImgH = pdfImgW * (H / W);
            const cv = document.createElement("canvas");
            cv.width  = W * 2;
            cv.height = H * 2;
            const cx = cv.getContext("2d");
            cx.scale(2, 2);
            cx.drawImage(img, 0, 0, W, H);
            URL.revokeObjectURL(url);
            const png = cv.toDataURL("image/png");
            checkY(pdfImgH + 8);
            doc.addImage(png, "PNG", MARGIN + (CONTENT - pdfImgW) / 2, y, pdfImgW, pdfImgH);
            y += pdfImgH + 6;
            resolve();
          } catch(e2) { reject(e2); }
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("img load failed")); };
        img.src = url;
      });
    } catch(e) {
      sub(`[Core geometry diagram unavailable: ${e.message}]`);
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────────
  const ts = now.toISOString().replace(/[:.]/g, "-").substring(0, 19);
  doc.save(`inductor_report_${ts}.pdf`);
}

/**
 * Export the design dict as a JSON file download.
 * @param {object} design
 */
function exportJSON(design) {
  const blob = new Blob([JSON.stringify(design, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `inductor_design_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
