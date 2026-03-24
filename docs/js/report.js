/**
 * report.js - PDF report generation with jsPDF + AutoTable
 *
 * Ported from variable_inductor.py generate_report().
 * Captures Plotly charts as PNG images and embeds them.
 *
 * Depends on: jsPDF (window.jspdf.jsPDF), jsPDF-AutoTable plugin, Plotly
 *
 * Page order:
 *   1. Cover + Electrical specs + Core material + Core geometry + Air gaps + SVG diagrams
 *   2. [break] Main winding + Bias winding
 *   3. [break] Winding cross-sections
 *   4. [break] Operating points + Reluctance networks
 *   5. [break] Plots
 */

async function generatePDF(design, dcDivId = "plot-dc", acDivId = "plot-ac") {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  const PAGE_W = 210;
  const MARGIN = 18;
  const CONTENT = PAGE_W - 2 * MARGIN;
  let y = MARGIN;

  const ACCENT = [41, 128, 185];
  const DARK = [44, 62, 80];
  const GREY_LIGHT = [242, 244, 245];
  const WHITE = [255, 255, 255];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function addPage() { doc.addPage(); y = MARGIN; }
  function checkY(needed) { if (y + needed > 297 - MARGIN) addPage(); }
  function setColor(rgb) { doc.setTextColor(rgb[0], rgb[1], rgb[2]); }

  function title(text) {
    checkY(12);
    doc.setFont("helvetica", "bold"); doc.setFontSize(16); setColor(DARK);
    doc.text(text, MARGIN, y); y += 7;
  }
  function h2(text) {
    checkY(10);
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); setColor(ACCENT);
    doc.text(text, MARGIN, y); y += 6;
  }
  function sub(text) {
    checkY(6);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8);
    setColor([127, 140, 141]);
    doc.text(text, MARGIN, y); y += 5;
  }
  function hr() {
    checkY(4);
    doc.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, y, MARGIN + CONTENT, y); y += 4;
  }
  function note(text) {
    checkY(8);
    doc.setFont("helvetica", "italic"); doc.setFontSize(8);
    setColor([127, 140, 141]);
    const lines = doc.splitTextToSize(text, CONTENT);
    doc.text(lines, MARGIN, y); y += lines.length * 4 + 2;
  }
  function caption(text) {
    checkY(6);
    doc.setFont("helvetica", "italic"); doc.setFontSize(7);
    setColor([127, 140, 141]);
    doc.text(text, MARGIN + CONTENT / 2, y, { align: "center" }); y += 5;
  }

  function table(head, rows) {
    checkY(20);
    doc.autoTable({
      head: [head], body: rows,
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      tableWidth: CONTENT,
      styles: {
        fontSize: 8,
        cellPadding: { top: 2, bottom: 2, left: 3, right: 3 },
        valign: "middle",
      },
      headStyles: { fillColor: DARK, textColor: WHITE, fontStyle: "bold", halign: "center" },
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

  // Capture a Plotly div as PNG and embed it
  async function addPlotImage(divId, captionText, aspectH) {
    const el = document.getElementById(divId);
    if (!el || !el._fullLayout) return;
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

  // Embed an SVG diagram as PNG in the PDF, with optional label substitutions.
  //
  // svgUrl:      path to the SVG file (relative to the page)
  // containerId: id of the DOM wrapper that injectSvg used (DOM/cache fallback)
  // panelTitle:  section heading text
  // replacements:{ "key": "value" } — replaces <text>key</text> in SVG source
  //
  // Rendering pipeline:
  //   SVG text (string-replaced) → base64 data URL → <img> → canvas → PNG → PDF
  //
  // Fallback chain for obtaining SVG text:
  //   1. fetch() + string replacement  (works on HTTP servers)
  //   2. window._svgData[containerId]  (cached by injectSvg when fetch succeeded)
  //   3. XMLSerializer on live DOM SVG (already has <text> replacements from injectSvg)
  async function addSvgImage(svgUrl, containerId, panelTitle, replacements = null, widthFrac = 0.95) {
    h2(panelTitle);
    checkY(10);

    // ── Get SVG text ─────────────────────────────────────────────────────────
    let svgText = null;

    try {
      const r = await fetch(svgUrl);
      if (r.ok) {
        let raw = await r.text();
        raw = raw.replace(/<\?xml[^?]*\?>\s*/i, "");
        raw = raw.replace(/<!DOCTYPE[^>]*>\s*/i, "");
        // Remove draw.io content attr (huge base64 XML, not needed for rendering)
        raw = raw.replace(/\s+content="[^"]*"/, "");
        // Force light-mode colors: replace light-dark(light, dark) → light value.
        // Without this, canvas may resolve to the dark value (white lines on white bg).
        raw = raw.replace(/light-dark\(([^,)]+),\s*[^)]+\)/g, "$1");
        // Also lock color-scheme to light in the root style
        raw = raw.replace(/color-scheme:\s*light\s+dark/g, "color-scheme: light");
        if (replacements) {
          for (const [key, val] of Object.entries(replacements)) {
            // Canvas drawImage skips <foreignObject> (security); SVG <switch>
            // falls back to <text>.  Replace BOTH so every renderer works.
            raw = raw.split(`>${key}</text>`).join(`>${val}</text>`);
            raw = raw.split(`>${key}</div></div></div></foreignObject>`)
                     .join(`>${val}</div></div></div></foreignObject>`);
          }
        }
        svgText = raw;
      }
    } catch (_) { /* fetch blocked (e.g. file:// protocol) */ }

    if (!svgText && window._svgData?.[containerId]) {
      svgText = window._svgData[containerId];
    }

    if (!svgText) {
      const el = document.getElementById(containerId)?.querySelector("svg");
      if (el) {
        const clone = el.cloneNode(true);
        clone.removeAttribute("content");
        svgText = new XMLSerializer().serializeToString(clone);
      }
    }

    if (!svgText) { sub(`[${panelTitle}: SVG not available]`); return; }

    // ── Render to canvas → PNG → PDF ─────────────────────────────────────────
    try {
      const bytes = new TextEncoder().encode(svgText);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const dataUrl = `data:image/svg+xml;base64,${btoa(binary)}`;

      await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          try {
            const W = img.naturalWidth  || 1060;
            const H = img.naturalHeight || 322;
            const pdfW = CONTENT * widthFrac;
            const pdfH = pdfW * (H / W);
            const cv  = document.createElement("canvas");
            cv.width  = W * 2;
            cv.height = H * 2;
            const cx  = cv.getContext("2d");
            cx.fillStyle = "#fff";
            cx.fillRect(0, 0, cv.width, cv.height);
            cx.scale(2, 2);
            cx.drawImage(img, 0, 0, W, H);
            const png = cv.toDataURL("image/png");
            checkY(pdfH + 8);
            doc.addImage(png, "PNG", MARGIN + (CONTENT - pdfW) / 2, y, pdfW, pdfH);
            y += pdfH + 6;
            resolve();
          } catch (e2) { reject(e2); }
        };
        img.onerror = () => reject(new Error("SVG render failed"));
        img.src = dataUrl;
      });
    } catch (e) {
      sub(`[${panelTitle}: ${e.message}]`);
    }
  }

  // Capture a canvas element and embed it as PNG, side by side with another
  // xOffset: left edge in mm from MARGIN; imgW: width in mm
  function addCanvasImage(canvasId, xOffset, imgW) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return 0;
    try {
      const png = canvas.toDataURL("image/png");
      const natW = canvas.width || 220;
      const natH = canvas.height || 260;
      const imgH = imgW * (natH / natW);
      checkY(imgH + 4);
      doc.addImage(png, "PNG", xOffset, y, imgW, imgH);
      return imgH;
    } catch (e) {
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // PAGE 1 - Cover + specs + geometry + air gaps + SVG diagrams
  // ---------------------------------------------------------------------------

  title("Variable Inductor Design Report");
  const now = new Date();
  const dateStr = now.toISOString().replace("T", " ").substring(0, 16);
  sub(`Core: ${design.core}  |  Generated: ${dateStr}`);
  hr();

  h2("Electrical Specifications");
  table(
    ["Parameter", "Symbol", "Value", "Unit"],
    [
      ["Main winding nominal inductance (I_bias=0)", "L_main_nom", `${design.L_main_nom_uH.toFixed(1)}`, "uH"],
      ["Main winding minimum inductance (I_bias_max)", "L_main_min", `${design.L_main_min_uH.toFixed(1)}`, "uH"],
      ["Nominal inductance (achieved)", "L_main_nom*", `${design.L_nom_achieved_uH.toFixed(2)}`, "uH"],
      ["Minimum inductance (achieved)", "L_main_min*", `${design.L_ac_at_bias_uH.toFixed(2)}`, "uH"],
      ["Switching frequency", "f_sw", `${design.f_sw_kHz}`, "kHz"],
      ["Main winding RMS current", "I_main_rms", `${design.I_main_rms_A}`, "A"],
      ["Main winding peak current", "I_main_pk", `${design.I_main_pk_A}`, "A"],
      ["Max flux density", "B_main_max", `${design.B_main_max_T}`, "T"],
      ["Bias winding max DC current", "I_bias_max", `${design.I_bias_max_A}`, "A"],
    ]
  );

  h2("Core Material");
  sub(`Material: ${design.mat_name}  |  ${design.desc_mat}`);
  table(
    ["Parameter", "Symbol", "Value", "Unit"],
    [
      ["Initial permeability", "mu_i", `${design.mu_i}`, "-"],
      ["BH model k1", "k1", `${design.k1}`, "H/m"],
      ["BH model k2", "k2", `${design.k2}`, "T^-2"],
      ["BH model k3", "k3", `${design.k3}`, "H/m"],
    ]
  );

  h2("Core Geometry");
  const span = design.coil_length === "full" ? "Set of E+E cores" : "Set of E+I cores";
  sub(`Core: ${design.core}  |  ${span}`);
  table(
    ["Parameter", "Symbol", "Value", "Unit"],
    [
      ["Centre-leg cross-section", "Ae_center", `${(design.Ae_center_m2 * 1e6).toFixed(2)}`, "mm2"],
      ["Outer-leg cross-section", "Ae_outer", `${(design.Ae_outer_m2 * 1e6).toFixed(2)}`, "mm2"],
      ["Horizontal cross-section", "Ae_h", `${(design.Ae_h_m2 * 1e6).toFixed(2)}`, "mm2"],
      ["Centre-leg path", "le_center", `${(design.le_center_m * 1e3).toFixed(2)}`, "mm"],
      ["Outer-leg path", "le_outer", `${(design.le_outer_m * 1e3).toFixed(2)}`, "mm"],
      ["Horizontal path", "le_h", `${(design.le_h_m * 1e3).toFixed(2)}`, "mm"],
      ["Coil former width", "CF_W", `${design.CF_W_mm.toFixed(2)}`, "mm"],
      ["Coil former length", "CF_L", `${design.CF_L_mm.toFixed(2)}`, "mm"],
      ["Window area", "Aw", `${(design.Aw_m2 * 1e6).toFixed(2)}`, "mm2"],
      ["AeAw required", "AeAw_req", `${design.AeAw_rec_mm4.toFixed(2)}`, "mm4"],
      ["AeAw available", "AeAw_avail", `${design.AeAw_avail_mm4.toFixed(2)}`, "mm4"],
    ]
  );

  h2("Air Gaps");
  table(
    ["Parameter", "Symbol", "Value", "Unit"],
    [
      ["Centre-leg gap", "lg_center", `${design.lg_center_mm.toFixed(4)}`, "mm"],
      ["Outer-leg gap", "lg_outer", `${design.lg_outer_mm.toFixed(4)}`, "mm"],
    ]
  );

  // SVG file and substitution map (mirrors index.html injectSvg logic)
  const svgFile = design.coil_length === "full"
    ? "assets/Core_Geometry_Full.svg"
    : "assets/Core_Geometry_Half.svg";
  const svgValues = {
    "le_center":  `${(design.le_center_m  * 1e3).toFixed(2)} mm`,
    "le_outer":   `${(design.le_outer_m   * 1e3).toFixed(2)} mm`,
    "le_h":       `${(design.le_h_m       * 1e3).toFixed(2)} mm`,
    "lg_center":  `${design.lg_center_mm.toFixed(3)} mm`,
    "lg_outer":   `${design.lg_outer_mm.toFixed(3)} mm`,
    "Ae_outer":   `${(design.Ae_outer_m2  * 1e6).toFixed(2)} mm2`,
    "Ae_center":  `${(design.Ae_center_m2 * 1e6).toFixed(2)} mm2`,
    "Ae_h":       `${(design.Ae_h_m2      * 1e6).toFixed(2)} mm2`,
    "Aw":         `${(design.Aw_m2        * 1e6).toFixed(2)} mm2`,
    "thickness":  `${design.thickness_mm.toFixed(2)} mm`,
    "spacing":    `${design.spacing_mm.toFixed(2)} mm`,
  };

  // SVG diagrams - same page, right after air gaps
  await addSvgImage(svgFile, "svg-core-ref",    "Core Geometry - Symbol reference", null);
  await addSvgImage(svgFile, "svg-core-values", "Core Geometry - Calculated values", svgValues);

  // ---------------------------------------------------------------------------
  // PAGE 2 - Windings
  // ---------------------------------------------------------------------------
  addPage();

  h2("Main Winding (Centre Leg)");
  table(
    ["Parameter", "Symbol", "Value", "Unit"],
    [
      ["Calculated turns", "N_main_calc", `${design.N_main_calc.toFixed(4)}`, "-"],
      ["Chosen turns", "N_main", `${design.N_main}`, "-"],
      ["AWG", "AWG_main", `${design.AWG_main}`, "-"],
      ["Parallel conductors", "N_cond_main", `${design.N_cond_main}`, "-"],
      ["Window fill factor", "kw_req_main", `${(design.kw_req_main * 100).toFixed(2)}`, "%"],
      ["Mean turn length", "lt_center", `${design.lt_center_mm.toFixed(2)}`, "mm"],
      ["Total wire length", "l_main", `${design.wire_len_main_m.toFixed(4)}`, "m"],
      ["Winding resistance", "R_main", `${design.R_main_winding_mOhm.toFixed(4)}`, "mOhm"],
    ]
  );

  h2("Bias Winding (Outer Legs)");
  table(
    ["Parameter", "Symbol", "Value", "Unit"],
    [
      ["Turns per outer bobbin", "N_bias", `${design.N_bias}`, "-"],
      ["Total turns (both legs)", "2xN_bias", `${design.N_bias * 2}`, "-"],
      ["AWG", "AWG_bias", `${design.AWG_bias}`, "-"],
      ["Parallel conductors", "N_cond_bias", `${design.N_cond_bias}`, "-"],
      ["Window fill factor", "kw_bias", `${(design.kw_req_bias * 100).toFixed(2)}`, "%"],
      ["Mean turn length (outer)", "lt_outer", `${design.lt_outer_mm.toFixed(2)}`, "mm"],
      ["Wire length per leg", "l_bias/leg", `${design.wire_len_bias_per_leg_m.toFixed(4)}`, "m"],
      ["Wire length total", "l_bias", `${design.wire_len_bias_m.toFixed(4)}`, "m"],
      ["Resistance per leg", "R_bias/leg", `${design.R_bias_per_leg_mOhm.toFixed(4)}`, "mOhm"],
      ["Total resistance", "R_bias", `${design.R_bias_winding_mOhm.toFixed(4)}`, "mOhm"],
      ["mu_r needed @ I_bias_max", "mu_r_req", `${isNaN(design.mu_r_needed) ? "-" : design.mu_r_needed.toFixed(1)}`, "-"],
    ]
  );

  // ---------------------------------------------------------------------------
  // PAGE 3 - Winding cross-sections (canvas images, side by side)
  // ---------------------------------------------------------------------------
  addPage();

  h2("Winding Cross-Sections");

  const colW = (CONTENT - 10) / 2;   // width for each image
  const xMain = MARGIN;
  const xBias = MARGIN + colW + 10;

  // Labels above images
  const lblMain = `Main winding - ${design.N_main}T x ${design.N_cond_main} x AWG${design.AWG_main}`;
  const lblBias = `Bias/leg - ${design.N_bias}T x ${design.N_cond_bias} x AWG${design.AWG_bias}`;

  doc.setFont("helvetica", "bold"); doc.setFontSize(8); setColor(DARK);
  checkY(6);
  doc.text(lblMain, xMain + colW / 2, y, { align: "center" });
  doc.text(lblBias, xBias + colW / 2, y, { align: "center" });
  y += 5;

  // Capture both canvases at the same y; advance by the taller of the two
  const hMain = addCanvasImage("canvas-main", xMain, colW);
  const hBias = addCanvasImage("canvas-bias", xBias, colW);
  y += Math.max(hMain, hBias) + 4;

  // kw annotation below
  doc.setFont("helvetica", "italic"); doc.setFontSize(7); setColor([127, 140, 141]);
  checkY(6);
  doc.text(
    `kw main = ${(design.kw_req_main * 100).toFixed(1)}%   |   kw bias = ${(design.kw_req_bias * 100).toFixed(1)}%`,
    MARGIN + CONTENT / 2, y, { align: "center" }
  );
  y += 6;

  // ---------------------------------------------------------------------------
  // PAGE 4 - Operating points + Reluctance networks
  // ---------------------------------------------------------------------------
  addPage();

  h2("Operating Points");
  table(
    ["Parameter", "Symbol", "Value", "Unit"],
    [
      ["Main inductance (I_bias=0)", "L_main_nom", `${design.L_nom_achieved_uH.toFixed(2)}`, "uH"],
      ["Main inductance (I_bias_max)", "L_main_min", `${design.L_ac_at_bias_uH.toFixed(2)}`, "uH"],
      ["MMF main winding (I_main_pk)", "F_main", `${design.F_main.toFixed(1)}`, "At"],
      ["Flux centre leg (I_main_pk)", "Phi_main", `${design.Phi_main_uWb.toFixed(4)}`, "uWb"],
      ["B centre leg (I_main_pk)", "B_center", `${design.B_center_mT.toFixed(2)}`, "mT"],
      ["B outer leg (linear)", "B_outer", `${design.B_outer_mT.toFixed(2)}`, "mT"],
      ["Bdc outer (nonlinear, max)", "Bdc_max", `${design.Bdc_max_mT.toFixed(2)}`, "mT"],
    ]
  );

  h2("Reluctance Network at I_bias=0 (At/Wb)");
  table(
    ["Reluctance element", "Symbol", "Value", "Unit"],
    [
      ["Horizontal (mu_i)", "Rc_h_0", `${design.Rc_h_0.toExponential(4)}`, "At/Wb"],
      ["Outer core (mu_i)", "Rc_outer_0", `${design.Rc_outer_0.toExponential(4)}`, "At/Wb"],
      ["Outer gap", "Rg_outer", `${design.Rg_outer.toExponential(4)}`, "At/Wb"],
      ["Centre core (linear)", "Rc_center", `${design.Rc_center.toExponential(4)}`, "At/Wb"],
      ["Centre gap", "Rg_center", `${design.Rg_center.toExponential(4)}`, "At/Wb"],
      ["Equiv. outer branch", "Req_outer_0", `${design.Req_outer_0.toExponential(4)}`, "At/Wb"],
      ["Equiv. centre branch", "Req_center", `${design.Req_center.toExponential(4)}`, "At/Wb"],
      ["Total equivalent", "Req_total_0", `${design.Req_total_0.toExponential(4)}`, "At/Wb"],
    ]
  );

  h2("Reluctance Network at I_bias_max (At/Wb)");
  table(
    ["Reluctance element", "Symbol", "Value", "Unit"],
    [
      ["Horizontal (nonlinear)", "Rc_h", `${design.Rc_h.toExponential(4)}`, "At/Wb"],
      ["Outer core (nonlinear)", "Rc_outer", `${design.Rc_outer.toExponential(4)}`, "At/Wb"],
      ["Outer gap", "Rg_outer", `${design.Rg_outer.toExponential(4)}`, "At/Wb"],
      ["Centre core (linear)", "Rc_center", `${design.Rc_center.toExponential(4)}`, "At/Wb"],
      ["Centre gap", "Rg_center", `${design.Rg_center.toExponential(4)}`, "At/Wb"],
      ["Equiv. outer branch", "Req_outer", `${design.Req_outer.toExponential(4)}`, "At/Wb"],
      ["Equiv. centre branch", "Req_center", `${design.Req_center.toExponential(4)}`, "At/Wb"],
      ["Total equivalent", "Req_total", `${design.Req_total.toExponential(4)}`, "At/Wb"],
    ]
  );

  // ---------------------------------------------------------------------------
  // PAGE 5 - Plots
  // ---------------------------------------------------------------------------
  addPage();

  h2("Plots");

  await addPlotImage(
    dcDivId,
    "DC inductance and effective DC inductance vs bias current. Solved nonlinearly via mu_T(B).",
    4.5 / 8
  );

  await addPlotImage(
    acDivId,
    "AC inductance and flux density in the centre leg vs bias current, for several AC current amplitudes.",
    7 / 8
  );

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------
  const ts = now.toISOString().replace(/[:.]/g, "-").substring(0, 19);
  doc.save(`inductor_report_${ts}.pdf`);
}

/**
 * Export the design dict as a JSON file download.
 */
function exportJSON(design) {
  const blob = new Blob([JSON.stringify(design, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inductor_design_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
