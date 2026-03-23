"""
variable_inductor.py - Variable inductor design tool (interactive console)

Topology: E-core with multi-bobbin 3D-printed coil formers
  · Centre leg  → ac inductor winding (N_ac turns)
  · Outer legs  → bias winding (N_bias / 2 turns each, series-aiding)

Air-gap conventions
-------------------
  · Outer-leg gap (lg_outer) : ADDITIVE — represents a non-ideal separation
    between the two core halves (e.g. surface roughness, assembly tolerance).
    It does not affect the outer-leg magnetic path length.
  · Centre-leg gap (lg_center): SUBTRACTIVE — a physical material removed from
    the centre leg, reducing its effective magnetic path length.

Usage
-----
    python variable_inductor.py

Author: Renan R. Duarte
"""

import os
import datetime
import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    Image,
    HRFlowable,
    PageBreak,
)
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY

from data.core_db import (
    CORES,
    core_W,
    core_H,
    core_L,
    core_h_L,
    core_h_W,
    coil_former_W,
    coil_former_L,
)
from data.wire_db import COL_S_CU, COL_S_TOTAL, find_awg_geq, find_awg_match
from data.wire_db import R_CU
from data.material_db import MATERIALS
from scipy.optimize import brentq
from svglib.svglib import svg2rlg
import re
import tempfile


# -----------------------------------------------------------------------------
# DEFAULT VALUES
# -----------------------------------------------------------------------------

DEFAULTS = {
    # Inductance targets
    "L_nom_uH": 60.0,  # Nominal inductance (uH, @ I_bias=0)
    "L_min_uH": 60 * 0.25,  # Minimal inductance (uH, @ I_bias_max)
    # Electrical specifications
    "f_sw_kHz": 100.0,  # Switching frequency (kHz)
    "I_rms_A": 1.3,  # RMS current (A)
    "I_pk_A": 3.4,  # Peak current (A)
    "B_max_T": 0.35,  # Max flux density (T @ I_pk)
    "I_bias_max_A": 0.5,  # Max bias current (A)
    # Wire / thermal
    "kw": 0.70,  # Coil former fill factor
    "J_max_Acm2": 450.0,  # Max current density (A/cm2)
    # Mechanical
    "coil_length": "half",  # Winding span: "full" or "half"
    "spacing_mm": 0.25,  # Core-to-former clearance (mm)
    "thickness_mm": 0.75,  # Former wall thickness (mm)
    "lg_outer_mm": 0.01,  # Outer-leg air gap (mm)
    "kf_outer": 1.0,  # Fringing factor for outer-leg gaps
    "kf_center": 1.06,  # Fringing factor for centre-leg gap
}

# -----------------------------------------------------------------------------
# MAGNETICS
# -----------------------------------------------------------------------------

MU_0 = 4 * np.pi * 1e-7  # H/m


def mu_T(B: float | np.ndarray, k1: float, k2: float, k3: float) -> float | np.ndarray:
    """
    Nonlinear incremental permeability (H/m):
        μ_T(B) = 1 / (k1·exp(k2·B²) + k3)
    """
    exp_arg = np.clip(k2 * np.asarray(B, dtype=float) ** 2, -500, 500)
    return 1.0 / (k1 * np.exp(exp_arg) + k3)


def H_from_B(
    B: float | np.ndarray, k1: float, k2: float, k3: float
) -> float | np.ndarray:
    """
    Magnetic field intensity (A/m) from flux density via the BH model:
        H(B) = B / μ_T(B) = B · (k1·exp(k2·B²) + k3)
    """
    exp_arg = np.clip(k2 * np.asarray(B, dtype=float) ** 2, -500, 500)
    return np.asarray(B, dtype=float) * (k1 * np.exp(exp_arg) + k3)


def mu_r_from_B(B: float, k1: float, k2: float, k3: float) -> float:
    """Relative permeability μ_r = μ_T(B) / μ_0."""
    return mu_T(B, k1, k2, k3) / MU_0


def solve_B_dc(
    N_dc: float,
    I_dc: float,
    l_e: float,
    l_ge: float,
    k1: float,
    k2: float,
    k3: float,
    nu_e: float = 1.0,
    B_max: float = 5.0,
) -> float:
    """
    Find B_DC (T) satisfying the implicit magnetic circuit equation:

        B · [l_e·(k1·exp(k2·B²) + k3)  +  l_ge/(μ0·νe)]  =  N·I_DC
    """
    MMF = N_dc * I_dc
    R_gap = l_ge / (MU_0 * nu_e)

    if MMF <= 0:
        return 0.0

    def f(B: float) -> float:
        exp_arg = np.clip(k2 * B**2, -500, 500)
        R_core = l_e * (k1 * np.exp(exp_arg) + k3)
        return B * (R_core + R_gap) - MMF

    try:
        return brentq(f, 1e-12, B_max, xtol=1e-9, maxiter=200)
    except ValueError:
        return float("nan")


def L_vs_Ibias(
    N_ac: int,
    I_pk_A: float,
    Ae_center_m2: float,
    le_center_m: float,
    lg_center_m: float,
    Req_center: float,
    N_bias: int,
    Ae_outer_m2: float,
    Ae_h_m2: float,
    le_outer_m: float,
    le_h_m: float,
    lg_outer_m: float,
    k1: float,
    k2: float,
    k3: float,
    I_bias_max_A: float = 1.0,
    n_points: int = 200,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Compute L_ac (H) as a function of DC bias current I_bias (A).
    """
    Rg_outer = lg_outer_m / (MU_0 * Ae_outer_m2)

    I_arr = np.linspace(0.0, I_bias_max_A, n_points)
    L_arr = np.empty(n_points)
    B_arr = np.empty(n_points)

    for i, I_b in enumerate(I_arr):
        l_eq = le_h_m * (Ae_outer_m2 / Ae_h_m2) + le_outer_m
        B_b = solve_B_dc(N_bias, I_b, l_eq, lg_outer_m, k1, k2, k3)
        B_arr[i] = B_b

        mu_r_b = mu_r_from_B(B_b, k1, k2, k3) if B_b > 0 else (k1 + k3) ** -1 / MU_0

        Rc_h_nl = le_h_m / (MU_0 * mu_r_b * Ae_h_m2)
        Rc_outer_nl = (le_outer_m - lg_outer_m) / (MU_0 * mu_r_b * Ae_outer_m2)
        Req_outer_nl = Rc_h_nl + Rc_outer_nl + Rg_outer

        Req_total = Req_outer_nl / 2.0 + Req_center
        L_arr[i] = N_ac**2 / Req_total

    return I_arr, L_arr, B_arr


# -----------------------------------------------------------------------------
# CONSOLE HELPERS
# -----------------------------------------------------------------------------

W = 65  # line width


def _hdr(title):
    print("=" * W)
    print(f"{title}")
    print("=" * W)


def _sec(title):
    pad = max(0, W - 4 - len(title))
    print(f"-- {title} " + "-" * pad)


def _ask(prompt, default, cast=float, choices=None):
    """
    Print a prompt showing the default in [brackets].
    Returns default if user presses Enter; otherwise parses and validates input.

    cast    : callable to convert the string (float, int, str)
    choices : optional list/set of accepted values
    """
    hint = (
        f"[default: {default}]"
        if choices is None
        else f"(options: {choices}) [default: {default}]"
    )
    while True:
        raw = input(f"  {prompt} {hint}: ").strip()
        value = default if raw == "" else raw
        try:
            value = cast(value)
        except (ValueError, TypeError):
            print(f"    ✗  Invalid - expected {cast.__name__}.")
            continue
        if choices is not None and value not in choices:
            print(f"    ✗  Must be one of: {choices}")
            continue
        return value


def _ask_yn(prompt, default=True):
    """Yes / no prompt.  Returns bool."""
    hint = "[Y/n]" if default else "[y/N]"
    while True:
        raw = input(f"  {prompt} {hint}: ").strip().lower()
        if raw == "":
            return default
        if raw in ("y", "yes", "Y", "Yes"):
            return True
        if raw in ("n", "no", "N", "No"):
            return False
        print("    ✗  Please enter y or n.")


def _pick_core(AeAw_rec_mm4=None):
    """
    Show cores with AeAw info. If AeAw_rec_mm4 is given, mark which ones qualify.
    d[0]=Core_L, d[1]=Core_W, d[2]=Core_H, d[3]=Center_W, d[4]=Outer_Sep, d[5]=Window_L
    """
    from data.core_db import coil_former_W, coil_former_L

    names = list(CORES.keys())
    default_name = "E 40/16/12 TDK"
    default_idx = names.index(default_name) + 1

    if AeAw_rec_mm4:
        print(f"  AeAw required : {AeAw_rec_mm4:.0f} mm4")
        print("  Available cores in database (already adjusted for winding span):")

    # Column headers - use sp=0.25, th=0.75 as display defaults
    SP, TH = 0.25, 0.75
    hdr = (
        f"    {'#':>3}  {'Name':22s}  "
        f"{'Ae_c':>6}  {'Ae_o':>6}  {'Ae_h':>6}  "
        f"{'le_c':>6}  {'le_h':>6}  "
        f"{'CF_W':>6}  {'CF_L':>6}  "
        f"{'Aw':>7}  {'AeAw':>8}  {'Fit?':>4}"
    )
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))
    for i, n in enumerate(names, 1):
        # Use the verified core_db functions - same formulas as run_interactive
        Ae_c_mm2 = core_W(n, "center") * core_H(n)
        Ae_o_mm2 = core_W(n, "outer") * core_H(n)
        Ae_h_mm2 = core_h_L(n) * core_H(n)
        le_c_mm = core_L(n, "full") - core_h_L(n)
        le_h_mm = core_h_W(n)
        cfw_mm = coil_former_W(n, "half", SP, TH)
        cfl_mm = coil_former_L(n, "full", SP, TH)
        Aw_mm2 = cfw_mm * cfl_mm
        AeAw = Ae_c_mm2 * Aw_mm2
        ok_str = ("OK" if AeAw >= AeAw_rec_mm4 else "--") if AeAw_rec_mm4 else ""
        print(
            f"    [{i:>2}]  {n:22s}  "
            f"{f'{Ae_c_mm2:.0f}mm2':>6}  {f'{Ae_o_mm2:.0f}mm2':>6}  {f'{Ae_h_mm2:.0f}mm2':>6}  "
            f"{f'{le_c_mm:.1f}mm':>6}  {f'{le_h_mm:.1f}mm':>6}  "
            f"{f'{cfw_mm:.1f}mm':>6}  {f'{cfl_mm:.1f}mm':>6}  "
            f"{f'{Aw_mm2:.1f}mm2':>7}  {f'{AeAw:.0f}mm4':>8}  {ok_str:>4}"
        )
    idx = _ask(
        "Choose core number",
        default_idx,
        cast=int,
        choices=list(range(1, len(names) + 1)),
    )
    return names[idx - 1]


# -----------------------------------------------------------------------------
# INTERACTIVE DESIGN
# -----------------------------------------------------------------------------


def run_interactive():
    _hdr("VARIABLE INDUCTOR DESIGN TOOL")
    print("Press Enter to accept default values shown in [brackets]")
    print()

    # -- 1. Inductance targets -------------------------------------------------
    _sec("1 · AC winding inductance targets")

    L_nom_uH = _ask(
        "Nominal inductance L_nom (uH, @ I_bias=0)", DEFAULTS["L_nom_uH"], float
    )
    L_min_uH = _ask(
        "Minimal inductance L_min (uH, @ I_bias_max)", DEFAULTS["L_min_uH"], float
    )
    print()

    # -- 2. Electrical specifications -----------------------------------------
    _sec("2 · Electrical specifications")
    f_sw_kHz = _ask("Switching frequency f_sw (kHz)", DEFAULTS["f_sw_kHz"], float)
    I_rms_A = _ask("RMS current I_rms (A)", DEFAULTS["I_rms_A"], float)
    I_pk_A = _ask("Peak current I_pk (A)", DEFAULTS["I_pk_A"], float)
    B_max_T = _ask("Max flux density B_max (T @ I_pk)", DEFAULTS["B_max_T"], float)
    I_bias_max_A = _ask(
        "Max bias current I_bias_max (A)", DEFAULTS["I_bias_max_A"], float
    )
    print()

    # -- 3. Core material ------------------------------------------------------
    _sec("3 · Core material")
    mat_names = list(MATERIALS.keys())
    default_idx = 1  # first material in the database
    print("  Available materials in database:")

    for i_m, n in enumerate(mat_names, 1):
        e = MATERIALS[n]
        mu_str = f"mu_r={e[1]} (nominal)" if e[1] else "custom"
        print(f"    [{i_m}] {n:24s} {mu_str:12s}")
    mat_idx = _ask(
        "Choose material", default_idx, int, choices=list(range(1, len(mat_names) + 1))
    )

    print()
    print("  Brauer coefficients:")

    mat_name = mat_names[mat_idx - 1]
    desc_mat, mu_i, k1, k2, k3 = MATERIALS[mat_name]
    if k1 is None:
        k1 = _ask("BH model k1 (H/m)", None, float)
        k2 = _ask("BH model k2 (T^-2)", None, float)
        k3 = _ask("BH model k3 (H/m)", None, float)
    else:
        print(f"    k1={k1}")
        print(f"    k2={k2}")
        print(f"    k3={k3}")
        if _ask_yn("Override BH coefficients?", default=False):
            k1 = _ask("BH model k1 (H/m)", k1, float)
            k2 = _ask("BH model k2 (T^-2)", k2, float)
            k3 = _ask("BH model k3 (H/m)", k3, float)
    print()

    # -- 4. Wire / thermal -----------------------------------------------------
    _sec("4 · Wire and thermal constraints")
    kw = _ask("Maximum coil former fill factor k_w (%)", DEFAULTS["kw"], float)
    J_max_Acm2 = _ask(
        "Maximum current density J_max (A/cm2)", DEFAULTS["J_max_Acm2"], float
    )
    print()

    # -- 5. Mechanical ---------------------------------------------------------
    _sec("5 · Coil former / mechanical")
    print("  Windind span options:")

    coil_length_opts = {
        1: ("full", "One EE set - Bobbin spans full window length"),
        2: ("half", "One EI set - bobbin spans half the window length"),
    }
    for idx, (val, desc) in coil_length_opts.items():
        print(f"    [{idx}] {val:6s} {desc}")
    default_coil_idx = next(
        i for i, (v, _) in coil_length_opts.items() if v == DEFAULTS["coil_length"]
    )
    coil_length_idx = _ask(
        "Choose winding span", default_coil_idx, int, choices=list(coil_length_opts)
    )
    coil_length = coil_length_opts[coil_length_idx][0]

    spacing_mm = _ask("Core-to-former clearance (mm)", DEFAULTS["spacing_mm"], float)
    thickness_mm = _ask("Former wall thickness (mm)", DEFAULTS["thickness_mm"], float)
    lg_outer_mm = _ask(
        "Outer-legs air gap lg_outer (mm)", DEFAULTS["lg_outer_mm"], float
    )
    kf_outer = _ask(
        "Fringing factor for outer-leg gaps kf_outer", DEFAULTS["kf_outer"], float
    )
    kf_center = _ask(
        "Fringing factor for centre-leg gap kf_center", DEFAULTS["kf_center"], float
    )
    print()

    # -- SI conversions --------------------------------------------------------
    L_nom = L_nom_uH * 1e-6
    L_min = L_min_uH * 1e-6
    f_sw = f_sw_kHz * 1e3
    J_max = J_max_Acm2 * 1e4
    spacing = spacing_mm * 1e-3
    thickness = thickness_mm * 1e-3
    lg_outer = lg_outer_mm * 1e-3

    # -- 6. Core selection -----------------------------------------------------
    _sec("6 · Core selection")
    # Quick AeAw estimate for guidance (uses L_nom, standard kw/B_max/J_max defaults)
    AeAw_rec = L_nom * I_pk_A * I_rms_A / (kw * B_max_T * J_max)
    core_name = _pick_core(AeAw_rec * 1e12)

    # -- Core geometry ---------------------------------------------------------
    print("  Core geometry [computed]")
    Cc_W = core_W(core_name, "center")
    Co_W = core_W(core_name, "outer")
    C_H = core_H(core_name)
    Ch_L = core_h_L(core_name)

    Ae_center = Cc_W * C_H * 1e-6
    Ae_outer = Co_W * C_H * 1e-6
    Ae_h = Ch_L * C_H * 1e-6

    le_center = (core_L(core_name, "full") - Ch_L) * 1e-3
    le_outer = le_center
    le_h = core_h_W(core_name) * 1e-3

    CF_W = coil_former_W(core_name, "half", spacing_mm, thickness_mm) * 1e-3
    CF_L = coil_former_L(core_name, coil_length, spacing_mm, thickness_mm) * 1e-3
    Aw = CF_W * CF_L
    Rg_outer = lg_outer / (kf_outer * MU_0 * Ae_outer)

    def _mean_turn(leg_W_mm, cf_w_m):
        mW = leg_W_mm * 1e-3 + 2 * spacing + 2 * thickness + cf_w_m / 2
        mL = C_H * 1e-3 + 2 * spacing + 2 * thickness + cf_w_m / 2
        return 2 * (mW + mL)

    lt_center = _mean_turn(Cc_W, CF_W)
    lt_outer = _mean_turn(Co_W, CF_W)

    print(f"    Ae_center         : {Ae_center*1e6:.2f} mm2")
    print(f"    Ae_outer          : {Ae_outer*1e6:.2f} mm2")
    print(f"    Ae_h (horizontal) : {Ae_h*1e6:.2f} mm2")
    print(f"    le_center         : {le_center*1e3:.2f} mm")
    print(f"    le_outer          : {le_outer*1e3:.2f} mm")
    print(f"    le_h (horizontal) : {le_h*1e3:.2f} mm")
    print(f"    Aw                : {Aw*1e6:.2f} mm2")
    print(f"    lt_center         : {lt_center*1e3:.2f} mm")
    print(f"    lt_outer          : {lt_outer*1e3:.2f} mm")

    # -- Area product check ----------------------------------------------------
    AeAw_chosen = Ae_center * Aw
    ap_ok = AeAw_chosen >= AeAw_rec
    print(f"    AeAw required  : {AeAw_rec*1e12:.2f} mm4")
    print(f"    AeAw available : {AeAw_chosen*1e12:.2f} mm4")
    if not ap_ok:
        print("  Warning: core may be too small. Proceeding anyway.")

    print()

    # -- 7. AC winding - turns ----------------------------------------------
    _sec("7 · AC winding - Number of turns")
    N_ac_calc = L_nom * I_pk_A / (B_max_T * Ae_center)
    print(
        f"  Calculated N_ac : {N_ac_calc:.4f}  "
        f"(ceiling -> {int(np.ceil(N_ac_calc))})"
    )
    N_ac = _ask("Choose N_ac (integer)", int(np.ceil(N_ac_calc)), int)
    print()

    # -- 8. Ac winding - Wire -----------------------------------------------
    _sec("8 · AC winding - Wire selection")
    S_req_ac = I_rms_A / J_max
    S_skin_ac = np.pi * (7.5e-2) ** 2 / f_sw

    awg_req_row = find_awg_geq(S_req_ac, col=COL_S_CU)
    awg_skin_row = find_awg_geq(S_skin_ac, col=COL_S_CU)

    print(f"  S_req (ampacity) : {S_req_ac*1e6:.4f} mm2  ->  min AWG {awg_req_row[0]}")
    print(
        f"  S_skin (at f_sw) : {S_skin_ac*1e6:.4f} mm2  ->  max AWG {awg_skin_row[0]}"
    )

    # Default = skin limit (thinnest allowed) - use parallel conductors for current
    AWG_ac = _ask("Choose AWG for ac winding", awg_skin_row[0], int)
    awg_final_row = find_awg_match(AWG_ac)
    S_AWG_Cu = awg_final_row[COL_S_CU]
    S_AWG_total = awg_final_row[COL_S_TOTAL]
    N_cond_calc = int(np.ceil(S_req_ac / S_AWG_Cu))
    print(f"  Parallel conductors needed : {N_cond_calc}")
    N_cond = _ask("Choose number of parallel conductors", N_cond_calc, int)

    print()
    Aw_min_ac = N_ac * N_cond * S_AWG_total / kw
    kw_req_ac = Aw_min_ac / Aw
    print(f"  Aw required  : {Aw_min_ac*1e6:.2f} mm2")
    print(f"  Aw available : {Aw*1e6:.2f} mm2")
    print(f"  k_w required : {kw_req_ac*100:.2f}%  ")
    if kw_req_ac > kw:
        print("  Warning: AC winding does not fit. Proceeding anyway.")
    print()

    # -- 9. Centre-leg gap from nonlinear model --------------------------------
    _sec("9 · Centre-leg air gap  [nonlinear solver]")
    print(
        f"  Solving lg_center for L_nom = {L_nom_uH} uH  "
        f"@ I_bias=0, I_ac=I_pk={I_pk_A} A ..."
    )

    # Inner helper: full implicit AC solver
    def _solve_Bac_full(Ibias, Iac, N_b, lg_c):
        Rg_c = lg_c / (kf_center * MU_0 * Ae_center)
        Bdc = _solve_Bdc(
            Ibias, N_b, Ae_outer, le_outer, le_h, Ae_h, lg_outer, k1, k2, k3, kf_outer
        )
        mu_out = _mu_D(Bdc, k1, k2, k3)
        Req_op = (
            le_h / (mu_out * Ae_h)
            + (le_outer - lg_outer) / (mu_out * Ae_outer)
            + Rg_outer
        ) / 2.0

        def f(Bac):
            mu_c = _mu_D(Bac, k1, k2, k3)
            Rc_c = (le_center - lg_c) / (mu_c * Ae_center)
            return Bac * Ae_center * (Rc_c + Rg_c + Req_op) - N_ac * Iac

        try:
            Bac = brentq(f, 1e-12, 5.0, xtol=1e-10, maxiter=300)
        except ValueError:
            return float("nan"), float("nan")
        return Bac, N_ac * Bac * Ae_center / Iac

    # At Ibias=0, Bdc=0 -> outer Req independent of N_bias (use dummy N_b=2)
    def _f_lgc(lgc):
        _, Lac = _solve_Bac_full(0.0, I_pk_A, 2, lgc)
        if np.isnan(Lac):
            raise ValueError(f"_solve_Bac_full returned nan at lgc={lgc}")
        return Lac - L_nom

    # Verify sign change before calling brentq
    _L_lo = _solve_Bac_full(0.0, I_pk_A, 2, 1e-7)[1]
    _L_hi = _solve_Bac_full(0.0, I_pk_A, 2, 20e-3)[1]
    _sign_ok = (
        not np.isnan(_L_lo)
        and not np.isnan(_L_hi)
        and (_L_lo - L_nom) * (_L_hi - L_nom) < 0
    )

    if _sign_ok:
        lg_center = brentq(_f_lgc, 1e-7, 20e-3, xtol=1e-10)
        lg_center_mm = round(lg_center * 1e3, 4)
        _, L_nom_chk = _solve_Bac_full(0.0, I_pk_A, 2, lg_center)
        print(
            f"  lg_center      : {lg_center_mm} mm (L_nom = {L_nom_chk*1e6:.2f} uH, target {L_nom_uH} uH)"
        )
    else:
        print(
            f"  Debug: L(lgc=0.001mm)={_L_lo*1e6:.1f}uH  L(lgc=20mm)={_L_hi*1e6:.1f}uH"
        )
        print(f"  L_nom={L_nom*1e6:.1f}uH - check N_ac and core size.")
        lg_center_mm = _ask(
            "Enter lg_center manually (mm)",
            round(N_ac**2 * MU_0 * Ae_center / L_nom * 1e3, 4),
            float,
        )
        lg_center = lg_center_mm * 1e-3

    lg_center_mm = _ask("Confirm or adjust lg_center (mm)", lg_center_mm, float)
    lg_center = lg_center_mm * 1e-3
    Rg_center = lg_center / (kf_center * MU_0 * Ae_center)

    # Recompute L_nom with confirmed gap
    _, L_nom_final = _solve_Bac_full(0.0, I_pk_A, 2, lg_center)
    print(f"  L_nom (confirmed gap) : {L_nom_final*1e6:.2f} uH")
    print()

    # -- 10. Bias winding design -----------------------------------------------
    _sec("10 · Bias winding design (Both outer windings combined)")
    print(
        f"  Target: L_ac = {L_min_uH} uH  @ I_bias_max = {I_bias_max_A} A, "
        f"I_ac = I_pk = {I_pk_A} A"
    )

    # Compute mu_r needed in outer branches for L_min:
    # Req_total_min = N_ac^2 / L_min
    # Req_outer_min = 2*(Req_total_min - Req_center)
    # From Req_outer = (Rc_h + Rc_outer + Rg_outer) with Rc's using mu_D(Bdc):
    # mu_r_needed = (le_h/Ae_h + (le_outer-lg_outer)/Ae_outer) /
    #               (MU_0 * (Req_outer_min - Rg_outer))
    mu_c0 = _mu_D(0.0, k1, k2, k3)
    Rc_c0 = (le_center - lg_center) / (mu_c0 * Ae_center)
    Req_c = Rc_c0 + Rg_center

    Req_total_min = N_ac**2 / L_min
    Req_outer_min = 2.0 * (Req_total_min - Req_c)

    # Check feasibility: Req_outer_min must be > Rg_outer
    if Req_outer_min <= Rg_outer:
        print(
            f"  WARNING: L_min = {L_min_uH} uH requires Req_outer = "
            f"{Req_outer_min:.3e}, which is <= Rg_outer = {Rg_outer:.3e}."
        )
        print(f"  L_min too close to L_nom or lg_outer too large. Adjust inputs.")

    mu_r_needed = (le_h / Ae_h + (le_outer - lg_outer) / Ae_outer) / (
        MU_0 * (Req_outer_min - Rg_outer)
    )
    print(f"  mu_r required in outer core @I_bias_max : {mu_r_needed:.1f}")

    # Solve N_bias: Lac(I_bias_max, I_pk, N_bias, lg_center) = L_min
    def _f_Nbias(N_cont):
        N = max(2, int(round(N_cont)))
        _, Lac = _solve_Bac_full(I_bias_max_A, I_pk_A, N, lg_center)
        return Lac - L_min

    try:
        N_bias_cont = brentq(_f_Nbias, 2, 500, xtol=0.5)
        N_bias_calc = int(round(N_bias_cont))
        if N_bias_calc % 2 != 0:
            N_bias_calc += 1
        _, L_tgt_chk = _solve_Bac_full(I_bias_max_A, I_pk_A, N_bias_calc, lg_center)
        Bdc_chk = _solve_Bdc(
            I_bias_max_A,
            N_bias_calc,
            Ae_outer,
            le_outer,
            le_h,
            Ae_h,
            lg_outer,
            k1,
            k2,
            k3,
        )
        print(f"  N_bias calculated  : {N_bias_cont:.2f}  -> suggested: {N_bias_calc}")
        print(f"  Bdc @ I_bias_max   : {Bdc_chk*1e3:.2f} mT")
        print(f"  L_min check        : {L_tgt_chk*1e6:.2f} uH  (target {L_min_uH} uH)")
    except ValueError:
        N_bias_calc = 60
        print(f"  Warning: N_bias solver failed - Enter manually.")

    N_bias = _ask("Choose N_bias (total turns, even)", N_bias_calc, int)
    if N_bias % 2 != 0:
        N_bias += 1
        print(f"  Rounded to even: N_bias = {N_bias}")

    # Verify chosen N_bias
    _, L_bias_final = _solve_Bac_full(I_bias_max_A, I_pk_A, N_bias, lg_center)
    Bdc_final = _solve_Bdc(
        I_bias_max_A, N_bias, Ae_outer, le_outer, le_h, Ae_h, lg_outer, k1, k2, k3
    )
    print(f"  L_ac @ I_bias_max  : {L_bias_final*1e6:.2f} uH  (target {L_min_uH} uH)")
    print(f"  Bdc @ I_bias_max   : {Bdc_final*1e3:.2f} mT")
    print()

    # -- 11. Bias winding - wire (DC, no skin effect) --------------------------
    _sec("11 · Bias winding - Wire selection  (DC, no skin effect)")
    S_req_bias = I_bias_max_A / J_max
    awg_req_bias = find_awg_geq(S_req_bias, col=COL_S_CU)
    # For DC: thinnest wire that meets J_max is the natural choice
    print(
        f"  S_req (ampacity)  : {S_req_bias*1e6:.4f} mm2  ->  min AWG {awg_req_bias[0]}"
    )
    AWG_bias = _ask("Choose AWG for bias winding", awg_req_bias[0], int)
    awg_bias_row = find_awg_match(AWG_bias)
    S_bias_Cu = awg_bias_row[COL_S_CU]
    S_bias_total = awg_bias_row[COL_S_TOTAL]
    N_cond_bias_calc = int(np.ceil(S_req_bias / S_bias_Cu))
    print(f"  Parallel conductors needed : {N_cond_bias_calc}")
    N_cond_bias = _ask("Choose parallel conductors (bias)", N_cond_bias_calc, int)

    # Window check for bias winding (each outer leg: N_bias/2 turns)
    Aw_min_bias = (N_bias / 2) * N_cond_bias * S_bias_total / kw
    kw_req_bias = Aw_min_bias / Aw

    print(f"  Aw required  : {Aw_min_bias*1e6:.2f} mm2")
    print(f"  Aw available : {Aw*1e6:.2f} mm2")
    print(f"  k_w required : {kw_req_bias*100:.2f}%  ")
    if kw_req_bias > kw:
        print("  Warning: DC winding does not fit. Proceeding anyway.")
    print()

    # -- Reluctance network at I_bias=0 ----------------------------------------
    mu_out_0 = _mu_T(0.0, k1, k2, k3)  # Bdc=0 -> initial permeability
    Rc_h_0 = le_h / (mu_out_0 * Ae_h)
    Rc_o_0 = (le_outer - lg_outer) / (mu_out_0 * Ae_outer)
    Req_outer_0 = Rc_h_0 + Rc_o_0 + Rg_outer
    Req_total_0 = Req_outer_0 / 2.0 + Req_c

    # -- Reluctance network at I_bias_max --------------------------------------
    mu_out = _mu_T(Bdc_final, k1, k2, k3)
    Rc_h_nl = le_h / (mu_out * Ae_h)
    Rc_o_nl = (le_outer - lg_outer) / (mu_out * Ae_outer)
    Req_outer = Rc_h_nl + Rc_o_nl + Rg_outer
    Req_total = Req_outer / 2.0 + Req_c

    F_ac = N_ac * I_pk_A
    Phi_ac = F_ac / Req_total
    B_center = Phi_ac / Ae_center
    L_ac = N_ac**2 / Req_total

    F_bias = N_bias * I_bias_max_A
    Phi_bias = F_bias / (2.0 * Req_outer)
    B_outer = Phi_bias / Ae_outer

    # AC winding resistance
    wire_len_ac = N_ac * N_cond * lt_center
    wire_R_ac = R_CU * N_ac * lt_center / (S_AWG_Cu * N_cond)

    # DC winding resistance
    wire_len_bias = N_bias * N_cond_bias * lt_outer
    wire_R_bias = R_CU * N_bias * lt_outer / (S_bias_Cu * N_cond_bias)

    # -- Print results ---------------------------------------------------------
    _hdr("RESULTS")
    print()

    _sec("Reluctance network (at I_bias_max, using mu_T for Req, mu_D for Lac)")
    print(f"  mu_D(B=0) [centre]  : {mu_c0:.4e} H/m  (mu_r={mu_c0/MU_0:.0f})")
    print(f"  mu_T(Bdc) [outer]   : {mu_out:.4e} H/m  (mu_r={mu_out/MU_0:.0f})")
    print(f"  Bdc (outer, max)    : {Bdc_final*1e3:.2f} mT")
    print(f"  Rc_h                : {Rc_h_nl:.4e}  A.t/Wb")
    print(f"  Rc_outer            : {Rc_o_nl:.4e}  A.t/Wb")
    print(f"  Rg_outer            : {Rg_outer:.4e}  A.t/Wb  (constant)")
    print(f"  Rc_center           : {Rc_c0:.4e}  A.t/Wb")
    print(f"  Rg_center           : {Rg_center:.4e}  A.t/Wb  (constant)")
    print(f"  Req_outer           : {Req_outer:.4e}  A.t/Wb")
    print(f"  Req_center          : {Req_c:.4e}  A.t/Wb")
    print(f"  Req_total           : {Req_total:.4e}  A.t/Wb")
    print(f"  F_ac                : {F_ac:.1f}  A.t")
    print(f"  Phi_ac              : {Phi_ac*1e6:.4f} uWb")
    print(f"  B_center (pk)       : {B_center*1e3:.2f} mT")
    print(f"  L_ac (Req)          : {L_ac*1e6:.2f} uH")
    print(f"  L_ac (nonlinear)    : {L_bias_final*1e6:.2f} uH  @ I_bias_max")
    print(f"  B_outer (bias, max) : {B_outer*1e3:.2f} mT")

    print()
    _sec("Winding resistance")
    print(f"  AC winding wire length   : {wire_len_ac:.4f} m")
    print(f"  AC windinf resistance    : {wire_R_ac*1e3:.4f} mOhm")
    print(f"  Bias winding wire length : {wire_len_bias:.4f} m")
    print(f"  Bias winding resistance  : {wire_R_bias*1e3:.4f} mOhm")
    print()

    _hdr("DESIGN SUMMARY")
    rows = [
        ("Core", core_name),
        ("N_ac", f"{N_ac} turns"),
        ("N_cond_ac", f"{N_cond} x AWG {AWG_ac}"),
        ("N_bias", f"{N_bias} turns"),
        ("N_cond_bias", f"{N_cond_bias} x AWG {AWG_bias}"),
        ("lg_center", f"{lg_center_mm} mm"),
        ("lg_outer", f"{lg_outer_mm} mm"),
        ("L_nom  (@ I_bias=0)", f"{L_nom_final*1e6:.2f} uH"),
        ("L_ac   (@ I_bias_max)", f"{L_bias_final*1e6:.2f} uH"),
        ("k_w ac", f"{kw_req_ac*100:.2f}%"),
        ("k_w bias", f"{kw_req_bias*100:.2f}%"),
    ]
    for k, v in rows:
        print(f"  {k:<28}: {v}")
    print("=" * W)
    print()

    return dict(
        # targets
        L_nom_uH=L_nom_uH,
        L_min_uH=L_min_uH,
        L_nom_achieved_uH=L_nom_final * 1e6,
        L_ac_at_bias_uH=L_bias_final * 1e6,
        # material
        mat_name=mat_name,
        mu_i=mu_i,
        desc_mat=desc_mat,
        # inputs
        f_sw_kHz=f_sw_kHz,
        I_rms_A=I_rms_A,
        I_pk_A=I_pk_A,
        B_max_T=B_max_T,
        I_bias_max_A=I_bias_max_A,
        kw=kw,
        J_max_Acm2=J_max_Acm2,
        spacing_mm=spacing_mm,
        thickness_mm=thickness_mm,
        coil_length=coil_length,
        k1=k1,
        k2=k2,
        k3=k3,
        # geometry
        core=core_name,
        Ae_center_m2=Ae_center,
        Ae_outer_m2=Ae_outer,
        Ae_h_m2=Ae_h,
        Aw_m2=Aw,
        CF_W_mm=CF_W * 1e3,
        CF_L_mm=CF_L * 1e3,
        le_center_m=le_center,
        le_outer_m=le_outer,
        le_h_m=le_h,
        lt_center_mm=lt_center * 1e3,
        lt_outer_mm=lt_outer * 1e3,
        AeAw_rec_mm4=AeAw_rec * 1e12,
        AeAw_avail_mm4=AeAw_chosen * 1e12,
        # ac winding
        N_ac=N_ac,
        N_ac_calc=N_ac_calc,
        AWG=AWG_ac,
        N_cond=N_cond,
        S_AWG_Cu_mm2=S_AWG_Cu * 1e6,
        S_AWG_total_mm2=S_AWG_total * 1e6,
        kw_req=kw_req_ac,
        # gaps
        lg_center_mm=lg_center_mm,
        lg_center_calc_mm=lg_center_mm,
        lg_outer_mm=lg_outer_mm,
        lg_outer_m=lg_outer,
        kf_center=kf_center,
        kf_outer=kf_outer,
        # bias winding
        N_bias=N_bias,
        mu_r_needed=mu_r_needed,
        AWG_bias=AWG_bias,
        N_cond_bias=N_cond_bias,
        S_bias_Cu_mm2=S_bias_Cu * 1e6,
        S_bias_total_mm2=S_bias_total * 1e6,
        kw_req_bias=kw_req_bias,
        # reluctances (at I_bias=0)
        Rc_h_0=Rc_h_0,
        Rc_outer_0=Rc_o_0,
        Req_outer_0=Req_outer_0,
        Req_total_0=Req_total_0,
        # reluctances (at I_bias_max)
        Rg_center=Rg_center,
        Rg_outer=Rg_outer,
        Rc_center=Rc_c0,
        Rc_h=Rc_h_nl,
        Rc_outer=Rc_o_nl,
        Req_center=Req_c,
        Req_outer=Req_outer,
        Req_total=Req_total,
        # operating point
        F_ac=F_ac,
        Phi_ac_uWb=Phi_ac * 1e6,
        B_center_mT=B_center * 1e3,
        L_ac_uH=L_ac * 1e6,
        Bdc_max_mT=Bdc_final * 1e3,
        B_outer_mT=B_outer * 1e3,
        # resistance
        wire_len_m=wire_len_ac,
        R_winding_mOhm=wire_R_ac * 1e3,
    )


# -----------------------------------------------------------------------------
# PDF REPORT
# -----------------------------------------------------------------------------


def _styled_table(data, col_widths=None):
    """Build a styled ReportLab Table from a list-of-lists of Paragraphs."""
    style = TableStyle(
        [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2c3e50")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            (
                "ROWBACKGROUNDS",
                (0, 1),
                (-1, -1),
                [colors.HexColor("#f2f4f5"), colors.white],
            ),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#bdc3c7")),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]
    )
    t = Table(data, colWidths=col_widths)
    t.setStyle(style)
    return t


def _svg2rlg_compat(path, font_size=15, replacements=None):
    """Load an SVG, stripping browser-only features unsupported by svglib.

    Args:
        font_size: pixel size to apply to all <text> elements.
        replacements: optional dict mapping original text content to new content.
    """
    _COLOR = r"(?:rgb\([^)]+\)|rgba\([^)]+\)|#[0-9a-fA-F]+|\w+)"
    with open(path, "r", encoding="utf-8") as f:
        svg_text = f.read()

    # Replace light-dark() with the light-mode (first) color value
    svg_text = re.sub(
        rf"light-dark\(\s*({_COLOR})\s*,\s*{_COLOR}\s*\)",
        r"\1",
        svg_text,
    )
    # Remove <foreignObject>…</foreignObject> blocks (browser-only HTML content)
    svg_text = re.sub(
        r"<foreignObject\b[^>]*>.*?</foreignObject>",
        "",
        svg_text,
        flags=re.DOTALL,
    )
    # Remove <switch> wrappers so svglib processes the <text> children directly
    svg_text = re.sub(r"</?switch>", "", svg_text)

    # Process each <text> element: increase font size, add white background copy,
    # and optionally replace content with actual values.
    def _process_text(m):
        attrs, content = m.group(1), m.group(2)
        attrs = re.sub(r'font-size="[\d.]+px"', f'font-size="{font_size}px"', attrs)
        label = replacements.get(content, content) if replacements else content
        bg = (
            f'<text {attrs} stroke="white" stroke-width="8" fill="white">{label}</text>'
        )
        fg = f"<text {attrs}>{label}</text>"
        return f"<g>{bg}{fg}</g>"

    svg_text = re.sub(r"<text\s+([^>]*)>([^<]*)</text>", _process_text, svg_text)

    with tempfile.NamedTemporaryFile(
        suffix=".svg", delete=False, mode="w", encoding="utf-8"
    ) as tmp:
        tmp.write(svg_text)
        tmp_path = tmp.name
    try:
        drawing = svg2rlg(tmp_path)
    finally:
        os.unlink(tmp_path)
    return drawing


def generate_report(design, dc_plot_path, ac_plot_path, out_path):
    doc = SimpleDocTemplate(
        out_path,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=20 * mm,
        bottomMargin=20 * mm,
    )
    Wb = A4[0] - 40 * mm  # usable body width

    S = {
        "title": ParagraphStyle(
            "t",
            fontSize=16,
            fontName="Helvetica-Bold",
            spaceAfter=4,
            textColor=colors.HexColor("#2c3e50"),
        ),
        "sub": ParagraphStyle(
            "s",
            fontSize=9,
            fontName="Helvetica",
            spaceBefore=10,
            textColor=colors.HexColor("#7f8c8d"),
        ),
        "header": ParagraphStyle(
            "hdr",
            fontSize=9,
            fontName="Helvetica-Bold",
            textColor=colors.white,
            alignment=1,
        ),
        "h2": ParagraphStyle(
            "h2",
            fontSize=11,
            fontName="Helvetica-Bold",
            spaceBefore=10,
            spaceAfter=4,
            textColor=colors.HexColor("#2980b9"),
        ),
        "h3": ParagraphStyle(
            "h3",
            fontSize=9,
            fontName="Helvetica",
            spaceBefore=0,
            textColor=colors.HexColor("#7f8c8d"),
        ),
        "body": ParagraphStyle("b", fontSize=9, fontName="Helvetica"),
        "body_c": ParagraphStyle("bc", fontSize=9, fontName="Helvetica", alignment=1),
        "note": ParagraphStyle(
            "n",
            fontSize=8,
            fontName="Helvetica-Oblique",
            textColor=colors.HexColor("#7f8c8d"),
            alignment=TA_JUSTIFY,
        ),
    }

    def P(text, style="body"):
        return Paragraph(text, S[style])

    def rows_to_para(rows):
        return [
            [
                P(str(c), "header" if i == 0 else ("body_c" if j > 0 else "body"))
                for j, c in enumerate(row)
            ]
            for i, row in enumerate(rows)
        ]

    d = design
    cw4 = [Wb * 0.40, Wb * 0.22, Wb * 0.20, Wb * 0.18]

    story = []

    # -- Cover -----------------------------------------------------------------
    story.append(P("Variable Inductor Design Report", "title"))
    story.append(
        P(
            f"Core: <b>{d['core']}</b>  |  "
            f"Generated: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}",
            "sub",
        )
    )
    story.append(
        HRFlowable(
            width="100%",
            thickness=1.5,
            color=colors.HexColor("#2980b9"),
            spaceAfter=8,
        )
    )

    # -- Electrical specs ------------------------------------------------------
    story.append(P("Electrical Specifications", "h2"))
    data = rows_to_para(
        [
            ["Parameter", "Symbol", "Value", "Unit"],
            [
                "Nominal inductance (target, I_bias=0)",
                "L_nom",
                f"{d['L_nom_uH']:.1f}",
                "uH",
            ],
            [
                "Minimum inductance (target, I_bias=max)",
                "L_min",
                f"{d['L_min_uH']:.1f}",
                "uH",
            ],
            [
                "Nominal inductance (achieved)",
                "L_nom*",
                f"{d['L_nom_achieved_uH']:.2f}",
                "uH",
            ],
            [
                "Min inductance (achieved)",
                "L_min*",
                f"{d['L_ac_at_bias_uH']:.2f}",
                "uH",
            ],
            ["Switching frequency", "f_sw", f"{d['f_sw_kHz']}", "kHz"],
            ["RMS current", "I_rms", f"{d['I_rms_A']}", "A"],
            ["Peak current", "I_pk", f"{d['I_pk_A']}", "A"],
            ["Max flux density", "B_max", f"{d['B_max_T']}", "T"],
            ["Max DC bias current", "I_bias_max", f"{d['I_bias_max_A']}", "A"],
        ]
    )
    story.append(_styled_table(data, cw4))

    # -- Core material ---------------------------------------------------------
    story.append(P("Core Material", "h2"))

    story.append(
        P(
            f"Material: <b>{d['mat_name']}</b>  |  {d['desc_mat']}",
            "h3",
        )
    )

    data = rows_to_para(
        [
            ["Parameter", "Symbol", "Value", "Unit"],
            ["Initial permeability", "mu_i", f"{d['mu_i']}", "-"],
            ["BH model k1", "k1", f"{d['k1']}", "H/m"],
            ["BH model k2", "k2", f"{d['k2']}", "T^-2"],
            ["BH model k3", "k3", f"{d['k3']}", "H/m"],
        ]
    )
    story.append(_styled_table(data, cw4))

    # -- Core geometry ---------------------------------------------------------
    story.append(P("Core Geometry", "h2"))

    span = "Set of E + E cores" if d["coil_length"] == "full" else "Set of E + I cores"

    story.append(
        P(
            f"Core: <b>{d['core']}</b>  |  {span}",
            "h3",
        )
    )

    data = rows_to_para(
        [
            ["Parameter", "Symbol", "Value", "Unit"],
            [
                "Centre-leg cross-section",
                "Ae_center",
                f"{d['Ae_center_m2']*1e6:.2f}",
                "mm2",
            ],
            [
                "Outer-leg cross-section",
                "Ae_outer",
                f"{d['Ae_outer_m2']*1e6:.2f}",
                "mm2",
            ],
            ["Horizontal cross-section", "Ae_h", f"{d['Ae_h_m2']*1e6:.2f}", "mm2"],
            ["Centre-leg path", "le_center", f"{d['le_center_m']*1e3:.2f}", "mm"],
            ["Outer-leg path", "le_outer", f"{d['le_outer_m']*1e3:.2f}", "mm"],
            ["Horizontal path", "le_h", f"{d['le_h_m']*1e3:.2f}", "mm"],
            ["Coil former width", "CF_W", f"{d['CF_W_mm']:.2f}", "mm"],
            ["Coil former length", "CF_L", f"{d['CF_L_mm']:.2f}", "mm"],
            ["Window area", "Aw", f"{d['Aw_m2']*1e6:.2f}", "mm2"],
            ["AeAw required", "AeAw_req", f"{d['AeAw_rec_mm4']:.2f}", "mm4"],
            ["AeAw available", "AeAw_avail", f"{d['AeAw_avail_mm4']:.2f}", "mm4"],
        ]
    )
    story.append(_styled_table(data, cw4))

    # -- Air gaps --------------------------------------------------------------
    story.append(P("Air Gaps", "h2"))
    data = rows_to_para(
        [
            ["Parameter", "Symbol", "Value", "Unit"],
            ["Centre-leg gap", "lg_center", f"{d['lg_center_mm']}", "mm"],
            ["Outer-leg gap", "lg_outer", f"{d['lg_outer_mm']}", "mm"],
        ]
    )
    story.append(_styled_table(data, cw4))
    story.append(PageBreak())

    # -- Device drawings -------------------------------------------------------

    story.append(P("Device drawings", "h2"))

    _data_dir = os.path.join(os.path.dirname(__file__), "data")
    _svg_name = (
        "Core_Geometry_Full.svg"
        if d["coil_length"] == "full"
        else "Core_Geometry_Half.svg"
    )
    _svg_path = os.path.join(_data_dir, _svg_name)

    # Mapping from SVG label names to actual calculated values
    _svg_values = {
        "le_h": f"{d['le_h_m']*1e3:.2f} mm",
        "le_outer": f"{d['le_outer_m']*1e3:.2f} mm",
        "le_center": f"{d['le_center_m']*1e3:.2f} mm",
        "lg_center": f"{d['lg_center_mm']:.3f} mm",
        "lg_outer": f"{d['lg_outer_mm']:.3f} mm",
        "Ae_outer": f"{d['Ae_outer_m2']*1e6:.2f} mm2",
        "Ae_center": f"{d['Ae_center_m2']*1e6:.2f} mm2",
        "Ae_h": f"{d['Ae_h_m2']*1e6:.2f} mm2",
        "Aw": f"{d['Aw_m2']*1e6:.2f} mm2",
        "thickness": f"{d['thickness_mm']:.2f} mm",
        "spacing": f"{d['spacing_mm']:.2f} mm",
    }

    def _add_svg(replacements=None):
        if not os.path.exists(_svg_path):
            return
        _drawing = _svg2rlg_compat(_svg_path, font_size=15, replacements=replacements)
        if _drawing is None:
            return
        _scale = Wb / _drawing.width
        _drawing.width = Wb
        _drawing.height = _drawing.height * _scale
        _drawing.transform = (_scale, 0, 0, _scale, 0, 0)
        story.append(_drawing)

    story.append(Spacer(1, 4 * mm))
    story.append(P("Symbol reference", "note"))
    story.append(Spacer(1, 2 * mm))
    _add_svg()
    story.append(Spacer(1, 6 * mm))
    story.append(P("Calculated values", "note"))
    story.append(Spacer(1, 2 * mm))
    _add_svg(replacements=_svg_values)

    story.append(Spacer(1, 4 * mm))
    story.append(
        P(
            "<b>Note on gap conventions:</b> "
            "The outer-leg gap (lg_outer) is <i>additive</i>. It represents a non-ideal "
            "separation between the two core halves (e.g. surface roughness, assembly "
            "tolerance) and does not affect the outer-leg magnetic path length. "
            "The centre-leg gap (lg_center) is <i>subtractive</i>. It corresponds to "
            "material physically removed from the centre leg, reducing its effective "
            "magnetic path length. The values shown in the figure are nominal values, "
            "calculated based on the core geometry. For the reluctance and inductance calculations,"
            "lg_center whill be deducted from le_center ",
            "note",
        )
    )

    story.append(PageBreak())

    # -- Ac winding ------------------------------------------------------------

    story.append(P("Ac Winding (Centre Leg)", "h2"))
    data = rows_to_para(
        [
            ["Parameter", "Symbol", "Value", "Unit"],
            ["Calculated turns", "N_calc", f"{d['N_ac_calc']:.4f}", "-"],
            ["Chosen turns", "N_ac", f"{d['N_ac']}", "-"],
            ["AWG", "AWG", f"{d['AWG']}", "-"],
            ["Parallel conductors", "N_cond", f"{d['N_cond']}", "-"],
            ["Window fill factor required", "kw_req", f"{d['kw_req']*100:.2f}", "%"],
            ["Mean turn length", "lt_center", f"{d['lt_center_mm']:.2f}", "mm"],
            ["Total wire length", "l_wire", f"{d['wire_len_m']:.4f}", "m"],
            ["Winding resistance", "R_CU", f"{d['R_winding_mOhm']:.4f}", "mOhm"],
        ]
    )
    story.append(_styled_table(data, cw4))

    # -- Bias winding ----------------------------------------------------------
    story.append(P("Bias Winding (Outer Legs)", "h2"))
    data = rows_to_para(
        [
            ["Parameter", "Symbol", "Value", "Unit"],
            ["Total turns", "N_bias", f"{d['N_bias']}", "-"],
            ["Turns per outer leg", "N_bias/2", f"{d['N_bias'] // 2}", "-"],
            ["AWG", "AWG_bias", f"{d['AWG_bias']}", "-"],
            ["Parallel conductors", "N_cond_bias", f"{d['N_cond_bias']}", "-"],
            [
                "Window fill factor required (outer)",
                "kw_bias",
                f"{d['kw_req_bias']*100:.2f}",
                "%",
            ],
            ["Mean turn length (outer)", "lt_outer", f"{d['lt_outer_mm']:.2f}", "mm"],
            ["mu_r needed @ I_bias_max", "mu_r_req", f"{d['mu_r_needed']:.1f}", "-"],
        ]
    )
    story.append(_styled_table(data, cw4))

    # -- Operating point -------------------------------------------------------
    story.append(P("Operating Points", "h2"))
    data = rows_to_para(
        [
            ["Parameter", "Symbol", "Value", "Unit"],
            ["Inductance @ I_bias=0", "L_nom", f"{d['L_nom_achieved_uH']:.2f}", "uH"],
            ["Inductance @ I_bias_max", "L_min", f"{d['L_ac_at_bias_uH']:.2f}", "uH"],
            ["MMF ac winding (@ I_pk)", "F_ac", f"{d['F_ac']:.1f}", "A·t"],
            ["Flux centre leg (@ I_pk)", "Phi_ac", f"{d['Phi_ac_uWb']:.4f}", "uWb"],
            ["Flux density centre", "B_center", f"{d['B_center_mT']:.2f}", "mT"],
            ["Flux density outer", "B_outer", f"{d['B_outer_mT']:.2f}", "mT"],
            ["DC flux density outer (max)", "Bdc_max", f"{d['Bdc_max_mT']:.2f}", "mT"],
        ]
    )
    story.append(_styled_table(data, cw4))
    story.append(PageBreak())

    # -- Reluctances at I_bias=0 -----------------------------------------------
    story.append(P("Reluctance Network at I_bias=0 (A·t/Wb)", "h2"))
    data = rows_to_para(
        [
            ["Reluctance element", "Symbol", "Value", "Unit"],
            ["Horizontal (mu_i)", "Rc_h_0", f"{d['Rc_h_0']:.4e}", "A·t/Wb"],
            ["Outer core (mu_i)", "Rc_outer_0", f"{d['Rc_outer_0']:.4e}", "A·t/Wb"],
            ["Outer gap", "Rg_outer", f"{d['Rg_outer']:.4e}", "A·t/Wb"],
            ["Centre core (linear)", "Rc_center", f"{d['Rc_center']:.4e}", "A·t/Wb"],
            ["Centre gap", "Rg_center", f"{d['Rg_center']:.4e}", "A·t/Wb"],
            [
                "Equivalent outer branch",
                "Req_outer_0",
                f"{d['Req_outer_0']:.4e}",
                "A·t/Wb",
            ],
            [
                "Equivalent centre branch",
                "Req_center",
                f"{d['Req_center']:.4e}",
                "A·t/Wb",
            ],
            ["Total equivalent", "Req_total_0", f"{d['Req_total_0']:.4e}", "A·t/Wb"],
        ]
    )
    story.append(_styled_table(data, cw4))

    # -- Reluctances at I_bias_max ---------------------------------------------
    story.append(P("Reluctance Network at I_bias_max (A·t/Wb)", "h2"))
    data = rows_to_para(
        [
            ["Reluctance element", "Symbol", "Value", "Unit"],
            ["Horizontal (nonlinear)", "Rc_h", f"{d['Rc_h']:.4e}", "A·t/Wb"],
            ["Outer core (nonlinear)", "Rc_outer", f"{d['Rc_outer']:.4e}", "A·t/Wb"],
            ["Outer gap", "Rg_outer", f"{d['Rg_outer']:.4e}", "A·t/Wb"],
            ["Centre core (linear)", "Rc_center", f"{d['Rc_center']:.4e}", "A·t/Wb"],
            ["Centre gap", "Rg_center", f"{d['Rg_center']:.4e}", "A·t/Wb"],
            ["Equivalent outer branch", "Req_outer", f"{d['Req_outer']:.4e}", "A·t/Wb"],
            [
                "Equivalent centre branch",
                "Req_center",
                f"{d['Req_center']:.4e}",
                "A·t/Wb",
            ],
            ["Total equivalent", "Req_total", f"{d['Req_total']:.4e}", "A·t/Wb"],
        ]
    )
    story.append(_styled_table(data, cw4))
    story.append(PageBreak())

    # -- Plots ----------------------------------------------------------------
    story.append(P("Plots", "h2"))

    # DC analysis
    story.append(
        P(
            "DC inductance and effective DC inductance vs bias current. "
            "Solved nonlinearly via mu_T(B).",
            "note",
        )
    )
    story.append(Spacer(1, 3 * mm))
    if os.path.exists(dc_plot_path):
        img_w = Wb * 0.8
        story.append(Image(dc_plot_path, width=img_w, height=img_w * (4.5 / 8)))

    # AC analysis
    story.append(
        P(
            "AC inductance and flux density in the centre leg vs bias current, "
            "for several AC current amplitudes. Centre-leg permeability uses mu_D(B_AC).",
            "note",
        )
    )
    story.append(Spacer(1, 3 * mm))
    if os.path.exists(ac_plot_path):
        img_w = Wb * 0.8
        story.append(Image(ac_plot_path, width=img_w, height=img_w * (7 / 8)))

    doc.build(story)
    print(f"  Report saved -> {out_path}")


# -----------------------------------------------------------------------------
# DC BIAS ANALYSIS  -  Ldc and Ldc_eff vs I_bias
# -----------------------------------------------------------------------------


def _mu_T(B, k1, k2, k3):
    """Nonlinear incremental permeability μ_T(B) = 1/(k1·exp(k2·B²)+k3)."""
    return 1.0 / (k1 * np.exp(np.clip(k2 * B**2, -500, 500)) + k3)


def _solve_Bdc(
    Idc, N_bias, Ae_outer, le_outer, le_h, Ae_h, lg_outer, k1, k2, k3, kf_outer=1.0
):
    """
    Solve  N·I = B·Ae·Req_outer(B)  for B_dc.

    Req_outer(B) = Rc_h(B) + Rc_outer(B) + Rg_outer
    where Rg_outer is constant and Rc_h, Rc_outer depend on μ_T(B).
    """
    if Idc <= 0.0:
        return 0.0

    Rg_outer = lg_outer / (kf_outer * MU_0 * Ae_outer)  # constant

    def f(B):
        mu = _mu_T(B, k1, k2, k3)
        Rc_h = le_h / (mu * Ae_h)
        Rc_outer = le_outer / (mu * Ae_outer)
        Req = Rc_h + Rc_outer + Rg_outer
        return B * Ae_outer * Req - N_bias * Idc

    try:
        return brentq(f, 1e-12, 5.0, xtol=1e-10, maxiter=300)
    except ValueError:
        return float("nan")


def compute_dc_analysis(design, n_points=300):
    """
    DC bias analysis: solve Bdc(Idc), then compute Ldc and Ldc_eff.

    Ldc(Idc)     = 2 · N_bias · Bdc(Idc) · Ae_outer / Idc
    Ldc_eff(Idc) = Ldc + Idc · dLdc/dIdc   (numerical derivative)

    Returns
    -------
    I_arr    : bias current array (A)
    Bdc_arr  : DC flux density in outer leg (T)
    Ldc_arr  : DC inductance (H)
    Leff_arr : effective DC inductance (H)
    """
    N_bias = design["N_bias"]
    Ae_outer = design["Ae_outer_m2"]
    le_outer = design["le_outer_m"]
    le_h = design["le_h_m"]
    Ae_h = design["Ae_h_m2"]
    lg_outer = design["lg_outer_m"]
    k1, k2, k3 = design["k1"], design["k2"], design["k3"]
    I_max = design["I_bias_max_A"]
    kf_outer = design["kf_outer"]

    def Bdc(I):
        return _solve_Bdc(
            I, N_bias, Ae_outer, le_outer, le_h, Ae_h, lg_outer, k1, k2, k3, kf_outer
        )

    def Ldc(I):
        if I <= 0.0:
            return float("nan")
        return 2.0 * N_bias * Bdc(I) * Ae_outer / I

    # Small step for numerical derivative
    h = I_max * 1e-5

    def Ldc_eff(I):
        if I <= h:
            return float("nan")
        dL = (Ldc(I + h) - Ldc(I - h)) / (2.0 * h)
        return Ldc(I) + I * dL

    # Avoid I=0 (singularity); start from a small positive value
    I_arr = np.linspace(I_max / n_points, I_max, n_points)
    Bdc_arr = np.array([Bdc(I) for I in I_arr])
    Ldc_arr = np.array([Ldc(I) for I in I_arr])
    Leff_arr = np.array([Ldc_eff(I) for I in I_arr])

    return I_arr, Bdc_arr, Ldc_arr, Leff_arr


def plot_dc_analysis(design, save_path, n_points=300):
    """
    Plot Ldc and Ldc_eff (μH) vs I_bias (A) with Bdc (mT) on a secondary axis.
    Saves the figure to save_path and returns the figure.
    """
    I_arr, Bdc_arr, Ldc_arr, Leff_arr = compute_dc_analysis(design, n_points)

    Ldc_uH = Ldc_arr * 1e6
    Leff_uH = Leff_arr * 1e6
    Bdc_mT = Bdc_arr * 1e3

    fig, ax1 = plt.subplots(figsize=(8, 4.5))
    fig.patch.set_facecolor("white")
    ax1.set_facecolor("white")

    c1, c2, c3 = "#1f77b4", "#2ca02c", "#d62728"

    ax1.plot(I_arr, Ldc_uH, color=c1, linewidth=2.2, label=r"$L_{DC}$")
    ax1.plot(
        I_arr, Leff_uH, color=c2, linewidth=2.0, linestyle="--", label=r"$L_{DC,eff}$"
    )
    ax1.set_xlabel("Bias current $I_{DC}$ (A)", fontsize=11)
    ax1.set_ylabel("Inductance (μH)", fontsize=11)
    ax1.tick_params(axis="y")
    ax1.yaxis.set_major_formatter(ticker.FormatStrFormatter("%.0f"))
    ax1.set_xlim(0, design["I_bias_max_A"])
    ax1.set_ylim(bottom=0)

    ax2 = ax1.twinx()
    ax2.plot(
        I_arr, Bdc_mT, color=c3, linewidth=1.4, linestyle=":", label=r"$B_{DC,outer}$"
    )
    ax2.set_ylabel("$B_{DC,outer}$ (mT)", color=c3, fontsize=11)
    ax2.tick_params(axis="y", labelcolor=c3)

    # Combined legend
    lines = ax1.get_lines() + ax2.get_lines()
    labels = [l.get_label() for l in lines]
    ax1.legend(lines, labels, loc="upper right", fontsize=10)

    ax1.set_title(
        f"DC bias analysis - {design['core']}\n"
        f"N_bias={design['N_bias']}, "
        f"lg_outer={design['lg_outer_mm']} mm",
        fontsize=10,
    )
    ax1.grid(True, linestyle="--", alpha=0.35)
    fig.tight_layout()
    fig.savefig(save_path, dpi=300, bbox_inches="tight")
    plt.close(fig)
    print(f"  DC analysis plot saved -> {save_path}")
    return fig


# -----------------------------------------------------------------------------
# AC ANALYSIS  -  Lac and Bac vs I_bias per I_ac fraction
# -----------------------------------------------------------------------------


def _mu_D(B, k1, k2, k3):
    """
    Differential permeability dB/dH:
        mu_D(B) = 1 / (k1*(1 + 2*k2*B^2)*exp(k2*B^2) + k3)
    """
    ex = np.exp(np.clip(k2 * B**2, -500, 500))
    return 1.0 / (k1 * (1.0 + 2.0 * k2 * B**2) * ex + k3)


def _solve_Bac(
    Ibias,
    Iac,
    N_ac,
    N_bias,
    Ae_c,
    Ae_o,
    Ae_h,
    le_c,
    le_o,
    le_h,
    lg_c,
    lg_o,
    k1,
    k2,
    k3,
    kf_center=1.0,
    kf_outer=1.0,
):
    """
    Solve implicitly for B_ac in the centre leg:

        N_ac * Iac = B_ac * Ae_c * Req_total_ac(B_ac, Ibias)

    where:
        Req_total_ac = Rc_center(mu_D(Bac)) + Rg_center
                       + Req_outer(mu_D(Bdc)) / 2

    Centre core uses mu_D(Bac) - nonlinear in Iac.
    Outer branches use mu_D(Bdc(Ibias)) - constant for a given Ibias.
    Air-gap reluctances are constant.
    """
    if Iac <= 0.0:
        return float("nan")

    Rg_c = lg_c / (kf_center * MU_0 * Ae_c)
    Rg_o = lg_o / (kf_outer * MU_0 * Ae_o)

    Bdc = _solve_Bdc(Ibias, N_bias, Ae_o, le_o, le_h, Ae_h, lg_o, k1, k2, k3, kf_outer)
    mu_out = _mu_D(Bdc, k1, k2, k3)
    Rc_h = le_h / (mu_out * Ae_h)
    Rc_o = le_o / (mu_out * Ae_o)
    Req_outer_parallel = (Rc_h + Rc_o + Rg_o) / 2.0

    def f(Bac):
        mu_c = _mu_D(Bac, k1, k2, k3)
        Rc_c = (le_c - lg_c) / (mu_c * Ae_c)
        return Bac * Ae_c * (Rc_c + Rg_c + Req_outer_parallel) - N_ac * Iac

    try:
        return brentq(f, 1e-12, 5.0, xtol=1e-10, maxiter=300)
    except ValueError:
        return float("nan")


def compute_ac_analysis(design, Iac_fractions=None, n_points=300):
    """
    Compute Lac and Bac vs I_bias for several AC current amplitudes.

    Lac(Ibias, Iac) = N_ac^2 / Req_total_ac(Bac, Bdc)
                    = N_ac * Bac * Ae_c / Iac

    Using mu_D(Bac) for the centre leg - Req depends on Iac, so Lac has
    one curve per Iac value.

    Parameters
    ----------
    design        : dict from run_interactive()
    Iac_fractions : fractions of I_pk. Default: [0.25, 0.50, 1.00]
    n_points      : number of I_bias points

    Returns
    -------
    I_bias_arr  : shape (n_points,)
    Lac_matrix  : shape (len(Iac_fractions), n_points) - H
    Bac_matrix  : shape (len(Iac_fractions), n_points) - T
    Iac_list    : AC current values used (A)
    """
    N_ac = design["N_ac"]
    N_bias = design["N_bias"]
    Ae_c = design["Ae_center_m2"]
    Ae_o = design["Ae_outer_m2"]
    Ae_h = design["Ae_h_m2"]
    le_c = design["le_center_m"]
    le_o = design["le_outer_m"]
    le_h = design["le_h_m"]
    lg_c = design["lg_center_mm"] * 1e-3
    lg_o = design["lg_outer_m"]
    k1, k2, k3 = design["k1"], design["k2"], design["k3"]
    I_pk = design["I_pk_A"]
    I_max = design["I_bias_max_A"]
    kf_center = design["kf_center"]
    kf_outer = design["kf_outer"]

    if Iac_fractions is None:
        Iac_fractions = [0.25, 0.50, 1.00]
    Iac_list = [round(I_pk * f, 4) for f in Iac_fractions]

    I_bias_arr = np.linspace(0.0, I_max, n_points)
    Lac_matrix = np.full((len(Iac_list), n_points), float("nan"))
    Bac_matrix = np.full((len(Iac_list), n_points), float("nan"))

    for j, Iac in enumerate(Iac_list):
        for i, Ib in enumerate(I_bias_arr):
            Bac = _solve_Bac(
                Ib,
                Iac,
                N_ac,
                N_bias,
                Ae_c,
                Ae_o,
                Ae_h,
                le_c,
                le_o,
                le_h,
                lg_c,
                lg_o,
                k1,
                k2,
                k3,
                kf_center,
                kf_outer,
            )
            if not np.isnan(Bac):
                Bac_matrix[j, i] = Bac
                Lac_matrix[j, i] = N_ac * Bac * Ae_c / Iac

    return I_bias_arr, Lac_matrix, Bac_matrix, Iac_list


def plot_ac_analysis(design, save_path, Iac_fractions=None, n_points=300):
    """
    Two-panel figure:
      Top   : Lac (μH) vs I_bias - one curve per Iac
      Bottom: Bac (mT) vs I_bias - one curve per Iac
    """
    I_bias_arr, Lac_matrix, Bac_matrix, Iac_list = compute_ac_analysis(
        design, Iac_fractions=Iac_fractions, n_points=n_points
    )

    I_pk = design["I_pk_A"]
    cmap = plt.get_cmap("tab10")

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(8, 7), sharex=True)
    fig.patch.set_facecolor("white")
    for ax in (ax1, ax2):
        ax.set_facecolor("white")

    for j, Iac in enumerate(Iac_list):
        frac = Iac / I_pk
        label = f"$I_{{ac}}$ = {Iac:.2f} A  ({frac:.0%} $I_{{pk}}$)"
        color = cmap(j)
        ax1.plot(
            I_bias_arr, Lac_matrix[j] * 1e6, color=color, linewidth=2.0, label=label
        )
        ax2.plot(
            I_bias_arr, Bac_matrix[j] * 1e3, color=color, linewidth=2.0, label=label
        )

    ax1.set_ylabel("$L_{AC}$ (μH)", fontsize=11)
    ax1.set_xlim(0, design["I_bias_max_A"])
    ax1.set_ylim(bottom=0)
    ax1.yaxis.set_major_formatter(ticker.FormatStrFormatter("%.0f"))
    ax1.legend(fontsize=9, loc="upper right")
    ax1.grid(True, linestyle="--", alpha=0.35)
    ax1.set_title(
        f"AC analysis - {design['core']}  "
        f"(N_ac={design['N_ac']}, N_bias={design['N_bias']}, "
        f"lg_c={design['lg_center_mm']} mm, lg_o={design['lg_outer_mm']} mm)",
        fontsize=9,
    )

    ax2.set_xlabel("Bias current $I_{bias}$ (A)", fontsize=11)
    ax2.set_ylabel("$B_{AC,center}$ (mT)", fontsize=11)
    ax2.set_ylim(bottom=0)
    ax2.yaxis.set_major_formatter(ticker.FormatStrFormatter("%.0f"))
    ax2.legend(fontsize=9, loc="upper right")
    ax2.grid(True, linestyle="--", alpha=0.35)

    fig.tight_layout()
    fig.savefig(save_path, dpi=300, bbox_inches="tight")
    plt.close(fig)
    print(f"  AC analysis plot saved -> {save_path}")
    return fig


# -----------------------------------------------------------------------------
# ENTRY POINT
# -----------------------------------------------------------------------------

if __name__ == "__main__":
    design = run_interactive()

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs")
    os.makedirs(out_dir, exist_ok=True)

    # -- DC bias analysis -----------------------------------------------------
    _sec("DC bias analysis  (Ldc and Ldc_eff)")
    dc_plot_path = os.path.join(out_dir, "Ldc_vs_Ibias.png")
    plot_dc_analysis(design, dc_plot_path, n_points=300)

    # -- AC analysis -----------------------------------------------------------
    _sec("AC analysis  (Lac and Bac vs Ibias)")
    Iac_fractions = [0.25, 0.50, 1.00]  # fractions of I_pk for Bac curves
    I_pk = design["I_pk_A"]
    print(f"  Bac curves: {[round(I_pk*f,3) for f in Iac_fractions]} A")
    ac_plot_path = os.path.join(out_dir, "Lac_vs_Ibias.png")
    plot_ac_analysis(design, ac_plot_path, Iac_fractions=Iac_fractions, n_points=300)

    print()
    if _ask_yn("Generate PDF report?", default=True):
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        pdf_path = os.path.join(out_dir, f"inductor_report_{ts}.pdf")
        _sec("Generating PDF report")
        generate_report(design, dc_plot_path, ac_plot_path, pdf_path)
    else:
        print("  Report skipped.")

    print("\n  Done.\n")
