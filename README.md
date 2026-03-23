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

| Parameter | Default | Description |
|---|---|---|
| `L_nom_uH` | 260 µH | Nominal inductance at zero bias current |
| `L_min_uH` | 65 µH | Minimum inductance at maximum bias current |
| `f_sw_kHz` | 100 kHz | Switching frequency |
| `I_rms_A` | 4.5 A | RMS current |
| `I_pk_A` | 5.0 A | Peak current |
| `B_max_T` | 0.35 T | Maximum flux density at peak current |
| `I_bias_max_A` | 1.0 A | Maximum bias current |
| `kw` | 0.70 | Coil former fill factor |
| `J_max_Acm2` | 450 A/cm² | Maximum current density |
| `coil_length` | `"full"` | Winding span: `"full"` or `"half"` |
| `spacing_mm` | 0.25 mm | Core-to-former clearance |
| `thickness_mm` | 0.75 mm | Former wall thickness |
| `lg_outer_mm` | 0.1 mm | Outer-leg air gap |
| `kf_outer` | 1.00 | Fringing factor for outer-leg gaps |
| `kf_center` | 1.06 | Fringing factor for centre-leg gap |

## Output

The tool generates a PDF report containing:

- Design summary and selected core geometry
- Winding configuration (turns, wire gauge, fill factor)
- Magnetic operating point (flux density, permeability)
- Inductance vs. bias current curve
- BH curve of the selected core material

## Author

Renan R. Duarte
