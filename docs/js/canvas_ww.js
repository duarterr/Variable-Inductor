/**
 * canvas_ww.js - Winding window cross-section renderer on HTML5 Canvas
 *
 * Ported from variable_inductor.py draw_winding_window().
 * Matches the Python/matplotlib output: axes with ticks at [0, CF_W] and
 * [0, CF_L], "Width (mm)" / "Height (mm)" axis labels, hidden spines.
 *
 * Layout (physical pixels):
 *   TITLE_PX  — optional title row
 *   TOP_PAD   — top breathing room
 *   scene     — drawing area (core + former + conductors)
 *   BOTTOM_PX — X-axis ticks + "Width (mm)" label
 *   LEFT_PX   — Y-axis ticks + "Height (mm)" label (left of scene)
 *   RIGHT_PAD — small right margin
 */

function drawWindingWindow(
  canvasId, CF_W_mm, CF_L_mm, S_total_m2,
  N_turns, N_cond, thickness_mm, spacing_mm, title = "", dpr = 1
) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const d_mm = Math.sqrt(4 * S_total_m2 / Math.PI) * 1e3;

  if (d_mm <= 0 || CF_W_mm <= 0 || CF_L_mm <= 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#999";
    ctx.font = `${12 * dpr}px sans-serif`;
    ctx.fillText("Invalid geometry", 10, 20 * dpr);
    return;
  }

  // Conductor packing
  const max_rows     = Math.max(Math.floor(CF_L_mm / d_mm), 1);
  const total_needed = N_turns * N_cond;
  const cols_needed  = Math.max(Math.ceil(total_needed / max_rows), 1);

  // Scene bounding box in mm-space (mirrors Python ax.set_xlim / set_ylim)
  const x_core    = -(thickness_mm + spacing_mm + thickness_mm);
  const right_mm  = Math.max(CF_W_mm, d_mm / 2 + cols_needed * d_mm);
  const top_mm    = CF_L_mm + thickness_mm;       // ax.set_ylim upper
  const bottom_mm = -thickness_mm;                // ax.set_ylim lower

  const scene_w_mm = right_mm - x_core;
  const scene_h_mm = top_mm   - bottom_mm;

  // Fixed pixel margins (in physical pixels = logical * dpr)
  const TITLE_PX  = title ? Math.round(20 * dpr) : Math.round(4 * dpr);
  const TOP_PAD   = Math.round(6 * dpr);
  const LEFT_PX   = Math.round(46 * dpr);   // Y-axis ticks + rotated label
  const BOTTOM_PX = Math.round(36 * dpr);   // X-axis ticks + label
  const RIGHT_PAD = Math.round(8 * dpr);

  // Available scene area
  const scene_px_w = canvas.width  - LEFT_PX - RIGHT_PAD;
  const scene_px_h = canvas.height - TITLE_PX - TOP_PAD - BOTTOM_PX;

  const scale = Math.min(scene_px_w / scene_w_mm, scene_px_h / scene_h_mm);

  // Scene origin in canvas pixels: where (x_core, top_mm) maps to
  const ox = LEFT_PX;
  const oy = TITLE_PX + TOP_PAD;

  // mm -> canvas pixel
  function px(x_mm, y_mm) {
    return [
      ox + (x_mm - x_core) * scale,
      oy + (top_mm - y_mm) * scale,   // Y flipped
    ];
  }
  function pxW(w_mm) { return w_mm * scale; }
  function pxH(h_mm) { return h_mm * scale; }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // ── Title ------------------------------------------------------------------
  if (title) {
    ctx.fillStyle = "#2c3e50";
    ctx.font = `bold ${Math.round(11 * dpr)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(title, canvas.width / 2, Math.round(4 * dpr));
    ctx.textAlign = "left";
  }

  // ── 1. Window background ---------------------------------------------------
  {
    const [cx, cy] = px(0, CF_L_mm);
    ctx.fillStyle = "#EEEEEE";
    ctx.fillRect(cx, cy, pxW(CF_W_mm), pxH(CF_L_mm));
  }

  // ── 2. Core block (black) --------------------------------------------------
  {
    const [cx, cy] = px(x_core, CF_L_mm + thickness_mm);
    ctx.fillStyle = "#111111";
    ctx.fillRect(cx, cy, pxW(thickness_mm), pxH(CF_L_mm + 2 * thickness_mm));

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

  // ── 3. Spacing (white) ----------------------------------------------------
  {
    const x_spacing = -(thickness_mm + spacing_mm);
    const [cx, cy] = px(x_spacing, CF_L_mm + thickness_mm);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(cx, cy, pxW(spacing_mm), pxH(CF_L_mm + 2 * thickness_mm));
  }

  // ── 4. Former borders (dark grey) -----------------------------------------
  ctx.fillStyle = "#4D4D4D";
  {
    const [cx, cy] = px(-thickness_mm, CF_L_mm + thickness_mm);
    ctx.fillRect(cx, cy, pxW(thickness_mm), pxH(CF_L_mm + 2 * thickness_mm));
  }
  {
    const [cx, cy] = px(0, 0);
    ctx.fillRect(cx, cy, pxW(CF_W_mm), pxH(thickness_mm));
  }
  {
    const [cx, cy] = px(0, CF_L_mm + thickness_mm);
    ctx.fillRect(cx, cy, pxW(CF_W_mm), pxH(thickness_mm));
  }

  // ── 5. Conductors (column by column) --------------------------------------
  let count = 0;
  const r_px = pxW(d_mm) / 2;

  for (let col = 0; col < cols_needed; col++) {
    if (count >= total_needed) break;
    const remaining    = total_needed - count;
    const cond_in_col  = Math.min(remaining, max_rows);
    const y_pitch      = cond_in_col > 1 ? (CF_L_mm - d_mm) / (cond_in_col - 1) : 0;

    for (let row = 0; row < cond_in_col; row++) {
      const x_mm = d_mm / 2 + col * d_mm;
      const y_mm = cond_in_col > 1 ? d_mm / 2 + row * y_pitch : CF_L_mm / 2;
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

  // ── 6. Axes (matching Python: ticks at [0, CF_W] and [0, CF_L], no spines)
  const tickLen  = Math.round(4 * dpr);
  const tickFont = Math.round(Math.max(8, Math.min(10, 9 * dpr)) * dpr / dpr) * dpr;
  ctx.strokeStyle = "#555";
  ctx.fillStyle   = "#555";
  ctx.lineWidth   = 0.8 * dpr;
  ctx.font        = `${tickFont}px sans-serif`;

  // X ticks at 0 and CF_W_mm
  const xTicks = [0, CF_W_mm];
  for (const xv of xTicks) {
    const [tx] = px(xv, bottom_mm);
    const [, ty] = px(xv, bottom_mm);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx, ty + tickLen);
    ctx.stroke();

    ctx.textAlign     = "center";
    ctx.textBaseline  = "top";
    ctx.fillText(xv.toFixed(1), tx, ty + tickLen + Math.round(2 * dpr));
  }

  // X axis label: "Width (mm)"
  {
    const [x0] = px(0,       bottom_mm);
    const [x1] = px(CF_W_mm, bottom_mm);
    const [, yBase] = px(0, bottom_mm);
    ctx.textAlign    = "center";
    ctx.textBaseline = "top";
    ctx.font = `${tickFont}px sans-serif`;
    ctx.fillText("Width (mm)", (x0 + x1) / 2, yBase + tickLen + Math.round(14 * dpr));
  }

  // Y ticks at 0 and CF_L_mm
  // Ticks are drawn at the left scene boundary (ox), not at px(0,yv).x,
  // so they land in the white LEFT_PX margin and remain readable.
  const yTicks = [0, CF_L_mm];
  for (const yv of yTicks) {
    const [, ty] = px(0, yv);   // only need the y coordinate
    ctx.beginPath();
    ctx.moveTo(ox, ty);
    ctx.lineTo(ox - tickLen, ty);
    ctx.stroke();

    ctx.textAlign    = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(yv.toFixed(1), ox - tickLen - Math.round(3 * dpr), ty);
  }

  // Y axis label: "Height (mm)" (rotated, left of tick labels)
  {
    const [, y0] = px(0,       0      );
    const [, y1] = px(0,       CF_L_mm);
    const xLabel = Math.round(10 * dpr);
    ctx.save();
    ctx.translate(xLabel, (y0 + y1) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${tickFont}px sans-serif`;
    ctx.fillText("Height (mm)", 0, 0);
    ctx.restore();
  }
}
