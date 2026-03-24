/**
 * canvas_ww.js — Winding window cross-section renderer on HTML5 Canvas
 *
 * Ported from variable_inductor.py draw_winding_window().
 *
 * Visual layout (left → right):
 *   [core block] [spacing] [former wall] [winding window] [former wall top/bottom]
 *
 * Conductors are packed column by column.
 * Circles are green (#3498db) if inside the window, red (#e74c3c) if outside.
 */

/**
 * Draw a coil-former winding window cross-section on a canvas element.
 *
 * @param {string} canvasId     ID of the <canvas> element
 * @param {number} CF_W_mm      Coil former internal width (mm)
 * @param {number} CF_L_mm      Coil former internal length/height (mm)
 * @param {number} S_total_m2   Total wire cross-section area (m²) — copper + insulation
 * @param {number} N_turns      Number of turns
 * @param {number} N_cond       Number of parallel conductors per turn
 * @param {number} thickness_mm Former wall thickness (mm)
 * @param {number} spacing_mm   Core-to-former clearance (mm)
 * @param {string} title        Optional title text drawn above the canvas
 */
function drawWindingWindow(
  canvasId, CF_W_mm, CF_L_mm, S_total_m2,
  N_turns, N_cond, thickness_mm, spacing_mm, title = "", dpr = 1
) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  // Wire diameter (mm)
  const d_mm = Math.sqrt(4 * S_total_m2 / Math.PI) * 1e3;

  if (d_mm <= 0 || CF_W_mm <= 0 || CF_L_mm <= 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#999";
    ctx.font = `${12 * dpr}px sans-serif`;
    ctx.fillText("Invalid geometry", 10, 20);
    return;
  }

  // Window capacity
  const max_rows    = Math.max(Math.floor(CF_L_mm / d_mm), 1);
  const total_needed = N_turns * N_cond;
  const cols_needed  = Math.max(Math.ceil(total_needed / max_rows), 1);

  // Scene bounding box in mm-space
  const x_core    = -(thickness_mm + spacing_mm + thickness_mm);
  const right_mm  = Math.max(CF_W_mm, d_mm / 2 + cols_needed * d_mm);
  const top_mm    = CF_L_mm + thickness_mm;
  const bottom_mm = -thickness_mm;

  const scene_w_mm = right_mm  - x_core;
  const scene_h_mm = top_mm - bottom_mm;

  // Padding in canvas pixels (scales with DPR for physical pixel sharpness)
  const TITLE_PX    = title ? Math.round(22 * dpr) : Math.round(4 * dpr);
  const PADDING_PX  = Math.round(8 * dpr);

  // Scale to fit canvas
  const canvas_inner_w = canvas.width  - 2 * PADDING_PX;
  const canvas_inner_h = canvas.height - TITLE_PX - 2 * PADDING_PX;

  const scale = Math.min(
    canvas_inner_w / scene_w_mm,
    canvas_inner_h / scene_h_mm
  );

  // mm → canvas pixel transform
  // scene origin (x_core, bottom_mm) maps to canvas (PADDING_PX, TITLE_PX + PADDING_PX)
  function px(x_mm, y_mm) {
    return [
      PADDING_PX + (x_mm - x_core) * scale,
      TITLE_PX + PADDING_PX + (top_mm - y_mm) * scale,  // flip Y
    ];
  }

  function pxW(w_mm) { return w_mm * scale; }
  function pxH(h_mm) { return h_mm * scale; }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // ── Title ────────────────────────────────────────────────────────────────
  if (title) {
    ctx.fillStyle = "#2c3e50";
    ctx.font = `bold ${Math.round(11 * dpr)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(title, canvas.width / 2, 14);
    ctx.textAlign = "left";
  }

  // ── 1. Window background (light grey) ────────────────────────────────────
  {
    const [cx, cy] = px(0, CF_L_mm);
    ctx.fillStyle = "#EEEEEE";
    ctx.fillRect(cx, cy, pxW(CF_W_mm), pxH(CF_L_mm));
  }

  // ── 2. Core block (black) ─────────────────────────────────────────────────
  {
    const [cx, cy] = px(x_core, CF_L_mm + thickness_mm);
    ctx.fillStyle = "#111111";
    ctx.fillRect(cx, cy, pxW(thickness_mm), pxH(CF_L_mm + 2 * thickness_mm));

    // "Core" label (white, rotated)
    const cx_mid = cx + pxW(thickness_mm) / 2;
    const cy_mid = cy + pxH(CF_L_mm + 2 * thickness_mm) / 2;
    ctx.save();
    ctx.translate(cx_mid, cy_mid);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "white";
    ctx.font = `bold ${Math.round(Math.max(7, Math.min(10, pxW(thickness_mm) * 0.7 / dpr)) * dpr)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Core", 0, 0);
    ctx.restore();
  }

  // ── 3. Spacing (white) ────────────────────────────────────────────────────
  {
    const x_spacing = -(thickness_mm + spacing_mm);
    const [cx, cy] = px(x_spacing, CF_L_mm + thickness_mm);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(cx, cy, pxW(spacing_mm), pxH(CF_L_mm + 2 * thickness_mm));
  }

  // ── 4. Former borders (dark grey) ─────────────────────────────────────────
  ctx.fillStyle = "#4D4D4D";
  // Left wall
  {
    const [cx, cy] = px(-thickness_mm, CF_L_mm + thickness_mm);
    ctx.fillRect(cx, cy, pxW(thickness_mm), pxH(CF_L_mm + 2 * thickness_mm));
  }
  // Bottom flange
  {
    const [cx, cy] = px(0, 0);
    ctx.fillRect(cx, cy, pxW(CF_W_mm), pxH(thickness_mm));
  }
  // Top flange
  {
    const [cx, cy] = px(0, CF_L_mm + thickness_mm);
    ctx.fillRect(cx, cy, pxW(CF_W_mm), pxH(thickness_mm));
  }

  // ── 5. Conductors (column by column) ─────────────────────────────────────
  let count = 0;
  const r_px = pxW(d_mm) / 2;

  for (let col = 0; col < cols_needed; col++) {
    if (count >= total_needed) break;

    const remaining       = total_needed - count;
    const cond_in_col     = Math.min(remaining, max_rows);
    const y_pitch         = cond_in_col > 1
                              ? (CF_L_mm - d_mm) / (cond_in_col - 1)
                              : 0;

    for (let row = 0; row < cond_in_col; row++) {
      const x_mm = d_mm / 2 + col * d_mm;
      const y_mm = cond_in_col > 1
                     ? d_mm / 2 + row * y_pitch
                     : CF_L_mm / 2;

      const outside = (x_mm + d_mm / 2) > CF_W_mm;

      const [cx, cy] = px(x_mm, y_mm);

      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(r_px, 0.8), 0, 2 * Math.PI);
      ctx.fillStyle   = outside ? "#e74c3c" : "#3498db";
      ctx.strokeStyle = outside ? "#c0392b" : "#1a252f";
      ctx.lineWidth   = 0.4;
      ctx.fill();
      ctx.stroke();

      count++;
    }
  }

  // ── 6. Dimension ticks ────────────────────────────────────────────────────
  ctx.strokeStyle = "#888";
  ctx.lineWidth = 0.5 * dpr;
  ctx.fillStyle = "#555";
  // Font: 8–10 logical pixels regardless of DPR or scale
  const tickFontPx = Math.round(Math.max(8, Math.min(10, scale / dpr * 1.2)) * dpr);
  ctx.font = `${tickFontPx}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  // Width label at bottom
  {
    const [x0] = px(0, bottom_mm);
    const [x1] = px(CF_W_mm, bottom_mm);
    const [, y0] = px(0, bottom_mm);
    ctx.fillText(`${CF_W_mm.toFixed(1)} mm`, (x0 + x1) / 2, y0 + 2);
  }

  // Height label on right
  {
    ctx.save();
    ctx.textBaseline = "bottom";
    const [xR] = px(right_mm, CF_L_mm);
    const [, y0] = px(right_mm, 0);
    const [, y1] = px(right_mm, CF_L_mm);
    ctx.translate(xR + 2, (y0 + y1) / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(`${CF_L_mm.toFixed(1)} mm`, 0, 0);
    ctx.restore();
  }
}
