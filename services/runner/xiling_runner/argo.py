from __future__ import annotations

import csv
import json
import platform
from pathlib import Path

import matplotlib
import matplotlib.pyplot as plt
import netCDF4
import numpy as np
import pandas as pd
import xarray as xr
from rocrate.rocrate import ROCrate

from .analysis import sha256


def create_argo_fixture(path: Path) -> Path:
    profiles = 8
    pressure = np.arange(0.0, 201.0, 10.0)
    latitude = np.array([13.5, 16.0, 18.5, 21.0, 23.0, 25.0, 27.0, 29.0])
    longitude = np.array([133.0, 136.0, 139.0, 142.0, 144.0, 146.0, 148.0, 149.5])
    times = pd.date_range("2023-07-05", periods=profiles, freq="7D")
    mixed_layers = np.array([30.0, 35.0, 40.0, 45.0, 50.0, 55.0, 60.0, 65.0])
    temperature = np.empty((profiles, pressure.size), dtype=np.float64)
    salinity = np.empty_like(temperature)

    for index, mld in enumerate(mixed_layers):
        surface = 29.4 + index * 0.08
        temperature[index] = np.where(
            pressure <= mld,
            surface - pressure * 0.002,
            surface - mld * 0.002 - (pressure - mld) * 0.028,
        )
        salinity[index] = 34.25 + index * 0.015 + pressure * 0.0018

    dataset = xr.Dataset(
        data_vars={
            "PRES": (("N_PROF", "N_LEVELS"), np.repeat(pressure[None, :], profiles, axis=0), {"units": "dbar"}),
            "TEMP": (("N_PROF", "N_LEVELS"), temperature, {"units": "degree_Celsius"}),
            "PSAL": (("N_PROF", "N_LEVELS"), salinity, {"units": "1e-3"}),
            "LATITUDE": (("N_PROF",), latitude, {"units": "degree_north"}),
            "LONGITUDE": (("N_PROF",), longitude, {"units": "degree_east"}),
            "JULD": (("N_PROF",), times.values, {"standard_name": "time"}),
            "POSITION_QC": (("N_PROF",), np.full(profiles, b"1", dtype="S1")),
        },
        coords={"N_PROF": np.arange(profiles), "N_LEVELS": np.arange(pressure.size)},
        attrs={
            "title": "Xi Ling OS synthetic Argo profiles",
            "Conventions": "Argo-3.1 CF-1.10",
            "source": "deterministic synthetic fixture; not observational evidence",
        },
    )
    dataset.to_netcdf(path)
    return path


def inspect_argo_dataset(path: Path) -> dict[str, object]:
    with xr.open_dataset(path) as dataset:
        return {
            "title": dataset.attrs.get("title", ""),
            "conventions": dataset.attrs.get("Conventions", ""),
            "dimensions": {name: int(size) for name, size in dataset.sizes.items()},
            "variables": {
                name: {"units": variable.attrs.get("units", "1"), "dimensions": list(variable.dims)}
                for name, variable in dataset.data_vars.items()
            },
            "bounds": {
                "west": float(dataset.LONGITUDE.min()),
                "east": float(dataset.LONGITUDE.max()),
                "south": float(dataset.LATITUDE.min()),
                "north": float(dataset.LATITUDE.max()),
                "minDepth": float(dataset.PRES.min()),
                "maxDepth": float(dataset.PRES.max()),
                "start": str(dataset.JULD.min().values)[:10],
                "end": str(dataset.JULD.max().values)[:10],
            },
            "byteSize": path.stat().st_size,
            "sha256": sha256(path),
        }


def _mixed_layer_depth(pressure: np.ndarray, temperature: np.ndarray) -> float:
    if not len(pressure) or not len(temperature):
        return float("nan")
    reference = temperature[0]
    candidates = np.flatnonzero(temperature <= reference - 0.2)
    return float(pressure[candidates[0]]) if candidates.size else float(pressure[-1])


def run_argo_analysis(input_path: Path, plan: dict[str, object], output_dir: Path) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    region = plan["region"]
    depth = plan["depth"]
    time = plan["time"]
    assert isinstance(region, dict) and isinstance(depth, dict) and isinstance(time, dict)

    with xr.open_dataset(input_path) as dataset:
        qc = dataset.POSITION_QC.values.astype("U1") == "1"
        dates = pd.to_datetime(dataset.JULD.values)
        selected = (
            qc
            & (dataset.LONGITUDE.values >= float(region["west"]))
            & (dataset.LONGITUDE.values <= float(region["east"]))
            & (dataset.LATITUDE.values >= float(region["south"]))
            & (dataset.LATITUDE.values <= float(region["north"]))
            & (dates >= pd.Timestamp(str(time["start"])))
            & (dates <= pd.Timestamp(str(time["end"])))
        )
        indexes = np.flatnonzero(selected)
        if indexes.size == 0:
            raise ValueError("slice plan selected no Argo profiles")

        rows: list[dict[str, object]] = []
        profile_curves: list[tuple[np.ndarray, np.ndarray]] = []
        for index in indexes:
            pressure = dataset.PRES.values[index]
            temperature = dataset.TEMP.values[index]
            mask = (pressure >= float(depth["min"])) & (pressure <= float(depth["max"])) & np.isfinite(temperature)
            pressure = pressure[mask]
            temperature = temperature[mask]
            mld = _mixed_layer_depth(pressure, temperature)
            heat_content = float(np.trapezoid(np.maximum(temperature - 26.0, 0.0) * 1025.0 * 3990.0, pressure))
            rows.append(
                {
                    "profile": int(index),
                    "time": str(dates[index].date()),
                    "latitude": float(dataset.LATITUDE.values[index]),
                    "longitude": float(dataset.LONGITUDE.values[index]),
                    "mld_m": mld,
                    "upper_ocean_heat_j_m2": heat_content,
                }
            )
            profile_curves.append((temperature, pressure))

    summary_path = output_dir / "argo-profile-summary.csv"
    with summary_path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0].keys()), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

    map_path = output_dir / "argo-mld-map.png"
    figure, axis = plt.subplots(figsize=(7.2, 4.8))
    scatter = axis.scatter(
        [float(row["longitude"]) for row in rows],
        [float(row["latitude"]) for row in rows],
        c=[float(row["mld_m"]) for row in rows],
        cmap="viridis_r",
        s=90,
        edgecolors="white",
    )
    axis.set(xlabel="Longitude (°E)", ylabel="Latitude (°N)", title="Argo mixed-layer depth")
    axis.grid(alpha=0.2)
    figure.colorbar(scatter, ax=axis, label="MLD (m)")
    figure.tight_layout()
    figure.savefig(map_path, dpi=130)
    plt.close(figure)

    section_path = output_dir / "argo-temperature-profiles.png"
    figure, axis = plt.subplots(figsize=(6, 5))
    for temperature, pressure in profile_curves:
        axis.plot(temperature, pressure, alpha=0.75)
    axis.invert_yaxis()
    axis.set(xlabel="Temperature (°C)", ylabel="Pressure (dbar)", title="Selected Argo temperature profiles")
    axis.grid(alpha=0.2)
    figure.tight_layout()
    figure.savefig(section_path, dpi=130)
    plt.close(figure)

    plan_path = output_dir / "slice-plan.json"
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    environment_path = output_dir / "environment.json"
    environment = {
        "python": platform.python_version(),
        "xarray": xr.__version__,
        "numpy": np.__version__,
        "matplotlib": matplotlib.__version__,
        "netCDF4": netCDF4.__version__,
    }
    environment_path.write_text(json.dumps(environment, indent=2) + "\n", encoding="utf-8")

    checks = [
        {"id": "profile-count", "passed": len(rows) >= 4, "detail": f"selected {len(rows)} profiles"},
        {"id": "position-qc", "passed": bool(np.all(qc[indexes])), "detail": "all selected POSITION_QC values are 1"},
        {"id": "finite-metrics", "passed": all(np.isfinite(float(row["mld_m"])) and np.isfinite(float(row["upper_ocean_heat_j_m2"])) for row in rows), "detail": "MLD and heat content are finite"},
    ]
    review = {
        "verdict": "accepted" if all(check["passed"] for check in checks) else "rejected",
        "checks": checks,
        "limitations": ["deterministic synthetic fixture is not real observational evidence"],
    }
    review_path = output_dir / "reviewer-report.json"
    review_path.write_text(json.dumps(review, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    artifacts = [summary_path, map_path, section_path, plan_path, environment_path, review_path]
    manifest = {
        "input": {"path": input_path.name, "sha256": sha256(input_path)},
        "outputs": [{"path": artifact.name, "sha256": sha256(artifact)} for artifact in artifacts],
        "operation": "QC-filtered Argo slice, mixed-layer depth and upper-ocean heat content",
        "reviewVerdict": review["verdict"],
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    crate = ROCrate()
    crate.name = "Xi Ling OS Argo reproduction package"
    crate.description = "Approved slice plan, deterministic input, analysis artifacts, environment and reviewer report."
    crate.add_file(str(input_path), properties={"name": input_path.name, "sha256": sha256(input_path)})
    for artifact in [*artifacts, manifest_path]:
        crate.add_file(str(artifact), properties={"name": artifact.name, "sha256": sha256(artifact)})
    crate_dir = output_dir / "ro-crate"
    crate.write(crate_dir)
    return {**manifest, "review": review, "roCrate": str(crate_dir / "ro-crate-metadata.json")}
