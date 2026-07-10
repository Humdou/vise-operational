#!/usr/bin/env python3
"""Fail fast when a Coalition 2045 sprite or manifest anchor is invalid."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "public/assets/buildings"
EXPECTED = {
    "hq", "power", "power2", "refinery", "refinery2", "barracks", "barracks2",
    "factory", "factory2", "radar", "radarcenter", "airport", "helipad",
    "turret", "atgun", "aa", "tech", "depot", "lab",
}
MAX_BYTES = 10 * 1024 * 1024


def check_point(label: str, point: list[int], width: int, height: int) -> None:
    assert len(point) == 2, f"{label}: point invalide"
    assert 0 <= point[0] < width and 0 <= point[1] < height, f"{label}: point hors canvas {point}"


def load_alpha(path: Path) -> Image.Image:
    assert path.exists(), f"asset manquant : {path.name}"
    image = Image.open(path)
    assert image.mode == "RGBA", f"{path.name}: mode {image.mode}, RGBA requis"
    w, h = image.size
    assert 96 <= w <= 800 and 96 <= h <= 1000, f"{path.name}: dimensions anormales {w}x{h}"
    alpha = image.getchannel("A")
    assert alpha.getbbox(), f"{path.name}: sprite vide"
    for point in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        assert alpha.getpixel(point) == 0, f"{path.name}: coin non transparent {point}"
    return image


def main() -> None:
    manifest = json.loads((ASSETS / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["version"] == 2, "version de manifeste invalide"
    assert set(manifest["buildings"]) == EXPECTED, "liste des 19 bâtiments incomplète"
    total = 0
    for name, data in manifest["buildings"].items():
        path = ROOT / "public" / data["src"].removeprefix("/")
        image = load_alpha(path)
        total += path.stat().st_size
        w, h = image.size
        assert data["footprint"] in ([1, 1], [2, 2], [3, 2], [3, 3]), f"{name}: emprise invalide"
        assert data["pxPerTile"] == 96, f"{name}: échelle différente de 96"
        check_point(f"{name}.anchor", [data["ax"], data["ay"]], w, h)
        assert .5 <= data["height"] <= 4, f"{name}: hauteur invalide"
        assert data.get("teamMarks"), f"{name}: aucun panneau d'équipe"
        for mark in data["teamMarks"]:
            assert len(mark["points"]) >= 3, f"{name}: masque équipe incomplet"
            for point in mark["points"]: check_point(f"{name}.teamMark", point, w, h)
        for effect in data.get("effects", []):
            check_point(f"{name}.{effect['kind']}", [effect["x"], effect["y"]], w, h)
        if "door" in data: check_point(f"{name}.door", data["door"], w, h)
        if "turret" in data:
            assert data["turret"]["weapon"] in manifest["weapons"], f"{name}: arme inconnue"
            check_point(f"{name}.turret", data["turret"]["mount"], w, h)
    for name, data in manifest["weapons"].items():
        path = ROOT / "public" / data["src"].removeprefix("/")
        image = load_alpha(path)
        total += path.stat().st_size
        check_point(f"{name}.pivot", data["pivot"], *image.size)
    assert total <= MAX_BYTES, f"budget dépassé : {total / 1024 / 1024:.2f} MiB"
    print(f"Coalition 2045: 19 bâtiments + 3 armes valides, {total / 1024 / 1024:.2f} MiB")


if __name__ == "__main__":
    main()
