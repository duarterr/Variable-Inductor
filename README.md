# Variable Inductor Design Tool

An interactive console tool for designing variable inductors using E-cores with multi-bobbin 3D-printed coil formers.

## Topology

```
E-core
├── Centre leg  →  AC inductor winding  (N_ac turns)
└── Outer legs  →  Bias winding         (N_bias/2 turns each, series-aiding)
```

The inductance is controlled by the DC bias current applied to the outer-leg windings, which saturates the outer legs and varies the effective permeability seen by the AC winding.

## Air-gap Conventions

| Gap | Type | Effect |
|---|---|---|
| `lg_outer` | Additive | Models non-ideal separation between core halves (e.g. surface roughness, assembly tolerance). Does **not** reduce the outer-leg magnetic path length. |
| `lg_center` | Subtractive | Physical material removed from the centre leg, reducing its effective magnetic path length. |

## Requirements

- Python 3.10+
- Dependencies listed in `requirements.txt`:
  - `numpy`
  - `matplotlib`
  - `reportlab`
  - `scipy`
  - `svglib`

## Setup

Run the setup script to create a virtual environment and install all dependencies automatically:

```bash
python setup.py
```

Then activate the environment:

```bash
# Windows
.venv\Scripts\activate

# Linux / macOS
source .venv/bin/activate
```

## Usage

```bash
python variable_inductor.py
```

The tool presents an interactive console where you can review and override default design parameters, then runs the full design routine.

## Design Parameters

| Parameter  | Description |
|---|---|
| `L_nom_uH` | Nominal inductance at zero bias current |
| `L_min_uH` | Minimum inductance at maximum bias current |
| `f_sw_kHz` | Switching frequency |
| `I_rms_A` | RMS current |
| `I_pk_A` | Peak current |
| `B_max_T` | Maximum flux density at peak current |
| `I_bias_max_A` | Maximum bias current |
| `kw`| Coil former fill factor |
| `J_max_Acm2` | Maximum current density |
| `coil_length` | Winding span: `"full"` or `"half"` |
| `spacing_mm` | Core-to-former clearance |
| `thickness_mm` | Former wall thickness |
| `lg_outer_mm` | Outer-leg air gap |
| `kf_outer` | Fringing factor for outer-leg gaps |
| `kf_center` | Fringing factor for centre-leg gap |

## Output

The tool generates a PDF report containing:

- Design summary and selected core geometry
- Winding configuration (turns, wire gauge, fill factor)
- Magnetic operating point (flux density, permeability)
- Inductance vs. bias current curve
- BH curve of the selected core material

## 3D-Printed Coil Formers

The file [`3d_print/coil_formers.f3d`](3d_print/coil_formers.f3d) is a parametric Fusion 360 model that generates coil formers (bobbins) ready for 3D printing.

The model is driven entirely by the standard dimensions found in TDK's EE-core datasheets — no manual geometry editing is required. To adapt the former to a different core, open the file in Fusion 360, go to **Modify → Change Parameters**, and update the following user parameters:

| Parameter | Datasheet dimension | Description |
|---|---|---|
| `Core_L` | *A* (or *L*) | Total core length — long axis, across all three legs |
| `Core_W` | *B* (or *W*) | Total core width — short axis, determines leg height |
| `Core_H` | *C* (or *H*) | Core depth / stack height |
| `Center_W` | *F* | Centre-leg width |
| `Outer_Sep` | *E* | Centre-to-centre span between the inner faces of the two outer legs |
| `Window_L` | *D* | Winding window length |

These are the same parameters used in [`data/core_db.py`](data/core_db.py). Once the parameters are updated, Fusion 360 regenerates the geometry automatically.

The model supports two winding span configurations, controlled by a separate parameter:

| Configuration | Description |
|---|---|
| `"full"` | Single bobbin spanning the full window — one winding per outer leg |
| `"half"` | Window split in two — two half-width bobbins per outer leg, for bifilar or split windings |

Wall thickness and core-to-former clearance are also exposed as parameters (`thickness`, `spacing`), matching the values used in the Python design tool.

## Author

Renan R. Duarte
