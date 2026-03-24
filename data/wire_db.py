"""
wire_db.py — AWG wire database, copper resistivity, and lookup helpers

Each entry: [AWG_number, S_Cu (m²), S_total (m²)]

    S_Cu    : bare copper cross-section area
    S_total : total wire cross-section (copper + insulation)

Data covers AWG 41 (thinnest) -> AWG 10 (thickest).
"""

# Copper resistivity at 20 °C (Ω·m)
R_CU = 1.72e-8

# ── Database ──────────────────────────────────────────────────────────────────
#          AWG    S_Cu (m²)     S_total (m²)
AWG_DATA: list[list] = [
    [41, 4.00e-9, 7.00e-9],
    [40, 5.00e-9, 8.60e-9],
    [39, 6.30e-9, 1.06e-8],
    [38, 8.00e-9, 1.30e-8],
    [37, 1.00e-8, 1.60e-8],
    [36, 1.27e-8, 1.97e-8],
    [35, 1.60e-8, 2.43e-8],
    [34, 2.01e-8, 3.00e-8],
    [33, 2.54e-8, 3.71e-8],
    [32, 3.20e-8, 4.59e-8],
    [31, 4.04e-8, 5.68e-8],
    [30, 5.09e-8, 7.04e-8],
    [29, 6.42e-8, 8.72e-8],
    [28, 8.10e-8, 1.083e-7],
    [27, 1.021e-7, 1.344e-7],
    [26, 1.287e-7, 1.671e-7],
    [25, 1.624e-7, 2.078e-7],
    [24, 2.047e-7, 2.586e-7],
    [23, 2.582e-7, 3.221e-7],
    [22, 3.255e-7, 4.013e-7],
    [21, 4.105e-7, 5.004e-7],
    [20, 5.176e-7, 6.244e-7],
    [19, 6.527e-7, 7.794e-7],
    [18, 8.231e-7, 9.735e-7],
    [17, 1.0379e-6, 1.2164e-6],
    [16, 1.3088e-6, 1.5207e-6],
    [15, 1.6504e-6, 1.9021e-6],
    [14, 2.0811e-6, 2.380e-6],
    [13, 2.6243e-6, 2.9793e-6],
    [12, 3.3092e-6, 3.7309e-6],
    [11, 4.1729e-6, 4.6738e-6],
    [10, 5.2620e-6, 5.8572e-6],
]

# Column index constants
COL_AWG = 0
COL_S_CU = 1
COL_S_TOTAL = 2


# ── Lookup helpers ────────────────────────────────────────────────────────────


def find_awg_geq(s_target_m2: float, col: int = COL_S_CU) -> list:
    """
    Return the FIRST AWG row (scanning from thinnest wire AWG 41 toward
    thickest AWG 10) whose area in `col` is >= s_target_m2.

    This matches SMath FindRowGeq which stops at the first qualifying row —
    i.e. it returns the THINNEST wire that still meets the requirement.

    col: COL_S_CU (default) or COL_S_TOTAL

    If no wire qualifies, returns the thickest available wire (AWG 10).
    """
    for row in AWG_DATA:  # AWG 41 -> 10 (thinnest first)
        if row[col] >= s_target_m2:
            return row
    return AWG_DATA[-1]  # fallback: AWG 10 (thickest)


def find_awg_match(awg_number: int) -> list:
    """
    Return the AWG row for a specific AWG number.
    Raises ValueError if the AWG number is not in the database.
    """
    for row in AWG_DATA:
        if row[COL_AWG] == awg_number:
            return row
    available = [r[COL_AWG] for r in AWG_DATA]
    raise ValueError(
        f"AWG {awg_number} not found in database. " f"Available: {available}"
    )
