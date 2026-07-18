"""Fail-closed identity and behavior checks for approved optional research stacks."""

from __future__ import annotations

import json
import os
import platform
from importlib.metadata import version

import numpy as np
import pyproj
import torch
from rasterio.io import MemoryFile
from rasterio.transform import from_origin


EXPECTED_VERSIONS = {
    "cryptography": "48.0.1",
    "narwhals": "2.24.0",
    "numpy": "2.5.1",
    "pandas": "3.0.3",
    "pyproj": "3.7.2",
    "rasterio": "1.5.0",
    "scikit-learn": "1.9.0",
    "scipy": "1.18.0",
}


def verify_versions(stack: str) -> None:
    expected = dict(EXPECTED_VERSIONS)
    expected["torch"] = "2.13.0+cpu" if stack == "linux-cpu" else "2.13.0"
    observed = {name: version(name) for name in expected}
    if observed != expected:
        raise RuntimeError(f"optional stack identity mismatch: expected {expected}, observed {observed}")


def verify_platform(stack: str) -> dict[str, object]:
    system = platform.system()
    machine = platform.machine().lower()
    if stack == "linux-cpu":
        if system != "Linux" or machine not in {"x86_64", "amd64"}:
            raise RuntimeError(f"linux-cpu lock requires Linux x86-64, observed {system} {machine}")
        if torch.version.cuda is not None or torch.cuda.is_available():
            raise RuntimeError("linux-cpu lock unexpectedly exposes a CUDA runtime")
        return {"system": system, "machine": machine, "torch_backend": "cpu"}

    if stack != "macos-arm64":
        raise RuntimeError("CC_OPTIONAL_STACK must be linux-cpu or macos-arm64")
    if system != "Darwin" or machine not in {"arm64", "aarch64"}:
        raise RuntimeError(f"macos-arm64 lock requires macOS ARM64, observed {system} {machine}")
    if torch.version.cuda is not None:
        raise RuntimeError("macos-arm64 lock unexpectedly exposes a CUDA runtime")
    if not torch.backends.mps.is_built():
        raise RuntimeError("macos-arm64 Torch wheel was not built with MPS support")
    mps_available = torch.backends.mps.is_available()
    if os.environ.get("CC_REQUIRE_MPS") == "1" and not mps_available:
        raise RuntimeError("MPS execution was required but is unavailable")
    if mps_available:
        values = torch.arange(4, dtype=torch.float32, device="mps")
        if float(torch.sum(values * values).cpu()) != 14.0:
            raise RuntimeError("MPS arithmetic canary failed")
    return {
        "system": system,
        "machine": machine,
        "torch_backend": "mps" if mps_available else "cpu-fallback",
        "mps_built": True,
    }


def verify_geo_wheels() -> None:
    crs = pyproj.CRS.from_epsg(26910)
    if not crs.is_projected or not all(axis.unit_name.lower() == "metre" for axis in crs.axis_info):
        raise RuntimeError("pyproj failed the projected-metre CRS canary")

    values = np.arange(9, dtype=np.float32).reshape(3, 3)
    with MemoryFile() as memory:
        with memory.open(
            driver="GTiff",
            height=3,
            width=3,
            count=1,
            dtype="float32",
            crs="EPSG:26910",
            transform=from_origin(500_000, 4_200_000, 2, 2),
        ) as dataset:
            dataset.write(values, 1)
        with memory.open() as dataset:
            if dataset.crs is None or dataset.crs.to_epsg() != 26910:
                raise RuntimeError("rasterio CRS round-trip failed")
            if not np.array_equal(dataset.read()[0], values):
                raise RuntimeError("rasterio value round-trip failed")


def main() -> None:
    stack = os.environ.get("CC_OPTIONAL_STACK", "")
    verify_versions(stack)
    platform_evidence = verify_platform(stack)
    verify_geo_wheels()
    print(json.dumps({"status": "ok", "stack": stack, **platform_evidence}, sort_keys=True))


if __name__ == "__main__":
    main()
