"""
core_db.py — Core database and geometry helpers

Column layout per core entry (all in mm):
    [Core_L, Core_W, Core_H, Center_W, Outer_Sep, Window_L]

    Core_L    : total core LENGTH  (axis along the legs)
    Core_W    : total core WIDTH   (axis across all legs — = 2×leg_length)
    Core_H    : core HEIGHT/depth  (into page)
    Center_W  : centre-leg width
    Outer_Sep : centre-to-centre distance between the two outer legs' inner faces
                (= Core_L_total span across the window)
    Window_L  : winding window length

NOTE on SMath column mapping (1-based indices in the original .sm):
    Col_Core_W=2 -> Core_L (confusingly named; it is the long dimension)
    Col_Core_L=3 -> Core_W (the cross dimension)
    Col_Core_H=4 -> Core_H
    Col_Center_W=5 -> Center_W
    Col_Outer_Sep=6 -> Outer_Sep
    Col_Window_L=7 -> Window_L

    The Python dict uses clear names, not the confusing SMath column names.
"""

# ── Column index constants (0-based, for internal use) ───────────────────────
COL_CORE_L = 0  # total length (long axis)
COL_CORE_W = 1  # total width  (cross axis, = Col_Core_L in SMath)
COL_CORE_H = 2
COL_CENTER_W = 3
COL_OUTER_SEP = 4
COL_WINDOW_L = 5

# ── Database ──────────────────────────────────────────────────────────────────
#                      Core_L  Core_W  Core_H  Center_W  Outer_Sep  Window_L
CORES: dict[str, list[float]] = {
    "E 30/15/7 TDK": [30.0, 15.2, 7.3, 7.2, 19.5, 9.7],
    "E 32/16/19 TDK": [32.0, 16.4, 9.5, 9.5, 22.7, 11.2],
    "E 40/16/12 TDK": [40.6, 16.5, 12.5, 12.5, 28.6, 10.5],
    # EFD 25/13/9 — Center_W ajustado para equivalência com núcleo E:
    #   Ae real = Center_W_efd × h_central = 11.4 × 5.2 = 59.28 mm²
    #   Center_W_eq = Ae_real / Core_H = 59.28 / 9.1 ≈ 6.51 mm
    "EFD 25/13/9 (CUSTOM)": [25.0, 12.5, 9.1, 6.51, 18.7, 9.3],
}


# ── Geometry helpers — all reproduce SMath formulas exactly ───────────────────


def core_W(core_name: str, leg: str = "center") -> float:
    """
    Width (mm) of the requested leg, matching SMath Core_W(Row, Leg).

    SMath formula:
        center -> el(Col_Center_W)
        other  -> (el(Col_Core_W) - el(Col_Outer_Sep)) / 2
                 = (Core_L - Outer_Sep) / 2          [outer leg width]
    """
    d = CORES[core_name]
    if leg == "center":
        return d[COL_CENTER_W]
    elif leg in ("outer", "half"):
        return (d[COL_CORE_L] - d[COL_OUTER_SEP]) / 2
    else:
        raise ValueError(f"core_W: unknown leg '{leg}'. Use 'center' or 'outer'.")


def core_H(core_name: str) -> float:
    """Core height / depth (mm)."""
    return CORES[core_name][COL_CORE_H]


def core_L(core_name: str, length: str = "full") -> float:
    """
    Magnetic path length along the vertical legs (mm).
    SMath Core_L(Row, Length):
        full  -> 2 * el(Col_Core_L)   [= 2 * Core_W, the cross dimension]
        other -> el(Col_Core_L)        [= Core_W]
    """
    d = CORES[core_name]
    if length == "full":
        return 2 * d[COL_CORE_W]
    else:
        return d[COL_CORE_W]


def core_h_L(core_name: str) -> float:
    """
    Yoke (horizontal leg) length (mm).
    SMath: Core_h_L = el(Col_Core_L) - el(Col_Window_L)
                    = Core_W - Window_L
    """
    d = CORES[core_name]
    return d[COL_CORE_W] - d[COL_WINDOW_L]


def core_h_W(core_name: str) -> float:
    """
    Yoke effective magnetic path width (mm) = le_h.
    SMath: Core_h_W = el(Col_Core_W) - (el(Col_Core_W) - el(Col_Outer_Sep)) / 2
                    = Core_L - (Core_L - Outer_Sep) / 2
                    = Core_L/2 + Outer_Sep/2
                    = Outer_Sep + Core_h_L      [numerically equivalent]
    """
    d = CORES[core_name]
    return d[COL_CORE_L] - (d[COL_CORE_L] - d[COL_OUTER_SEP]) / 2


def coil_former_W(
    core_name: str,
    winding: str,
    spacing_mm: float,
    thickness_mm: float,
) -> float:
    """
    Coil former width (mm). SMath Coil_Former_W(Row, Width, Spacing, Thickness):

        Width == 'full':
            (Outer_Sep - Center_W) / 2 - 2*Spacing - Thickness
        Width == 'half'  (else branch):
            ((Outer_Sep - Center_W) / 2 - 3*Spacing - 2*Thickness) / 2
    """
    d = CORES[core_name]
    slot_W = (d[COL_OUTER_SEP] - d[COL_CENTER_W]) / 2
    if winding == "full":
        return slot_W - 2 * spacing_mm - thickness_mm
    elif winding == "half":
        return (slot_W - 3 * spacing_mm - 2 * thickness_mm) / 2
    else:
        raise ValueError(f"coil_former_W: unknown winding '{winding}'.")


def coil_former_L(
    core_name: str,
    coil_length: str,
    spacing_mm: float,
    thickness_mm: float,
) -> float:
    """
    Coil former length (mm). SMath Coil_Former_L(Row, Length, Spacing, Thickness):

        Length == 'full':
            2 * (Window_L - Spacing - Thickness)
        else:
            Window_L - 2*Spacing - 2*Thickness
    """
    d = CORES[core_name]
    win_L = d[COL_WINDOW_L]
    if coil_length == "full":
        return 2 * (win_L - spacing_mm - thickness_mm)
    else:
        return win_L - 2 * spacing_mm - 2 * thickness_mm
