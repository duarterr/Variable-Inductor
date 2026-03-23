"""
material_db.py — Ferrite core material database

BH nonlinear permeability model:
    mu_T(B) = 1 / (k1·exp(k2·B²) + k3)          [incremental / chord]
    mu_D(B) = 1 / (k1·(1+2·k2·B²)·exp(k2·B²) + k3)  [differential]

Coefficients k1, k2, k3 are fitted to the manufacturer BH curve.
Units: k1 [H/m], k2 [T⁻²], k3 [H/m].

Reference permeability mu_i is the initial (small-signal) relative permeability
as specified in the datasheet.
"""

# ── Database ──────────────────────────────────────────────────────────────────
# Each entry: (description, mu_i, k1 [H/m], k2 [T⁻²], k3 [H/m])

MATERIALS: dict[str, tuple] = {
    #  name          description                    mu_i    k1       k2      k3
    "N87 (TDK)": ("TDK EPCOS N87, MnZn, ~100 kHz", 2200, 0.062, 42.995, 302.904),
    "N97 (TDK)": ("TDK EPCOS N97, MnZn, ~100 kHz", 2300, 1.05, 28.0, 120.0),
    "N49 (TDK)": ("TDK EPCOS N49, MnZn, ~200 kHz", 1500, 1.4, 35.0, 90.0),
    "PC95 (TDK)": ("TDK PC95,      MnZn, ~100 kHz", 3300, 0.85, 22.0, 140.0),
    "3C95 (Ferroxcube)": ("Ferroxcube 3C95, MnZn", 3000, 0.9, 24.0, 135.0),
    "User-defined": ("User-defined coefficients", None, None, None, None),
}

# Column indices
COL_DESC = 0
COL_MU_I = 1
COL_K1 = 2
COL_K2 = 3
COL_K3 = 4


def list_materials() -> list[str]:
    """Return list of material names."""
    return list(MATERIALS.keys())


def get_material(name: str) -> tuple:
    """Return (description, mu_i, k1, k2, k3) for the given material name."""
    if name not in MATERIALS:
        raise ValueError(
            f"Material '{name}' not found. Available: {list(MATERIALS.keys())}"
        )
    return MATERIALS[name]
