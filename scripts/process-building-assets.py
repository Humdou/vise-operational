#!/usr/bin/env python3
"""Build Coalition 2045 alpha sprites and their runtime manifest."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "public/assets/buildings"
SOURCES = ASSETS / "sources"
CHROMA = Path.home() / ".codex/skills/.system/imagegen/scripts/remove_chroma_key.py"
PX = 96

BUILDINGS = {
    "hq": ((3, 3), 3.25), "power": ((2, 2), 2.4), "power2": ((2, 2), 2.8),
    "refinery": ((3, 3), 1.8), "refinery2": ((3, 3), 2.05),
    "barracks": ((2, 2), 1.45), "barracks2": ((2, 2), 2.65),
    "factory": ((3, 3), 2.25), "factory2": ((3, 3), 2.65),
    "radar": ((2, 2), 3.0), "radarcenter": ((2, 2), 2.8),
    "airport": ((3, 2), 2.55), "helipad": ((3, 2), 1.55),
    "turret": ((1, 1), 1.0), "atgun": ((1, 1), 1.0), "aa": ((1, 1), 1.4),
    "tech": ((2, 2), 2.15), "depot": ((2, 2), 1.65), "lab": ((3, 3), 2.7),
}

EFFECTS = {
    "hq": [("beacon", .50, .08, 1.0)],
    "power": [("steam", .68, .27, .7)],
    "power2": [("beacon", .50, .20, .8)],
    "refinery": [("weld", .48, .58, .9)],
    "refinery2": [("weld", .53, .48, 1.0)],
    "barracks": [("beacon", .58, .17, .7)],
    "barracks2": [("beacon", .69, .08, .8)],
    "factory": [("weld", .51, .53, 1.1)],
    "factory2": [("weld", .51, .55, 1.2)],
    "radar": [("beacon", .54, .08, .85)],
    "radarcenter": [("beacon", .51, .08, .9)],
    "airport": [("beacon", .72, .08, .9)],
    "tech": [("beacon", .61, .08, .8)],
    "lab": [("weld", .56, .48, 1.0)],
}

DOORS = {
    "hq": (.50, .79), "power": (.56, .75), "power2": (.63, .79),
    "refinery": (.36, .78), "refinery2": (.35, .78), "depot": (.58, .79),
    "barracks": (.50, .78), "barracks2": (.50, .77), "factory": (.50, .78),
    "factory2": (.50, .78), "radar": (.50, .80), "radarcenter": (.51, .80),
    "airport": (.50, .80), "helipad": (.57, .79), "tech": (.50, .79), "lab": (.46, .79),
}

TURRETS = {
    "turret": {"weapon": "turret-weapon", "mount": (.50, .49), "scale": .68},
    "atgun": {"weapon": "atgun-weapon", "mount": (.50, .49), "scale": .72},
    "aa": {"weapon": "aa-weapon", "mount": (.50, .49), "scale": .62},
}


def remove_chroma(source: Path, out: Path) -> None:
    subprocess.run([
        "python3", str(CHROMA), "--input", str(source), "--out", str(out),
        "--auto-key", "border", "--soft-matte", "--transparent-threshold", "12",
        "--opaque-threshold", "220", "--despill", "--edge-contract", "1",
    ], check=True)


def subject_bbox(img: Image.Image) -> tuple[int, int, int, int]:
    alpha = img.getchannel("A").point(lambda a: 255 if a > 10 else 0)
    box = alpha.getbbox()
    if box is None:
        raise ValueError("sprite has no opaque subject")
    return box


def pt(rect: tuple[int, int, int, int], x: float, y: float) -> list[int]:
    left, top, width, height = rect
    return [round(left + width * x), round(top + height * y)]


def process_building(name: str, footprint: tuple[int, int], height: float, tmp: Path) -> dict:
    source = SOURCES / f"{name}.png"
    keyed = tmp / f"{name}.png"
    remove_chroma(source, keyed)
    img = Image.open(keyed).convert("RGBA")
    crop = img.crop(subject_bbox(img))
    w, h = footprint
    canvas_w = (w + h) * PX + 64
    content_w = round((w + h) * PX * .84)
    scale = content_w / crop.width
    resized = crop.resize((content_w, round(crop.height * scale)), Image.Resampling.LANCZOS)
    pad = 24
    canvas_h = resized.height + pad * 2
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    left = (canvas_w - resized.width) // 2
    top = pad
    canvas.alpha_composite(resized, (left, top))
    canvas.save(ASSETS / f"{name}.png", optimize=True)

    rect = (left, top, resized.width, resized.height)
    bottom = top + resized.height
    mark_y = .72 if name not in {"radar", "radarcenter", "airport", "barracks2"} else .68
    centers = [.50] if w == 1 else [.30, .70]
    marks = []
    for cx in centers:
        marks.append({"points": [
            pt(rect, cx - .045, mark_y - .02), pt(rect, cx + .045, mark_y - .02),
            pt(rect, cx + .035, mark_y + .025), pt(rect, cx - .035, mark_y + .025),
        ], "opacity": .72})

    entry = {
        "src": f"/assets/buildings/{name}.png",
        "footprint": [w, h], "pxPerTile": PX, "ax": canvas_w // 2,
        "ay": round(bottom - (w + h) * PX / 4), "height": height,
        "teamMarks": marks,
        "effects": [
            {"kind": kind, "x": pt(rect, x, y)[0], "y": pt(rect, x, y)[1], "scale": size}
            for kind, x, y, size in EFFECTS.get(name, [])
        ],
    }
    if name in DOORS:
        entry["door"] = pt(rect, *DOORS[name])
    if name in TURRETS:
        turret = dict(TURRETS[name])
        turret["mount"] = pt(rect, *turret["mount"])
        entry["turret"] = turret
    return entry


def process_weapon(name: str, tmp: Path) -> dict:
    source = SOURCES / f"{name}.png"
    keyed = tmp / f"{name}.png"
    remove_chroma(source, keyed)
    img = Image.open(keyed).convert("RGBA")
    crop = img.crop(subject_bbox(img))
    content_w = 224
    scale = content_w / crop.width
    resized = crop.resize((content_w, round(crop.height * scale)), Image.Resampling.LANCZOS)
    side = max(256, resized.height + 32)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    left, top = (side - resized.width) // 2, (side - resized.height) // 2
    canvas.alpha_composite(resized, (left, top))
    canvas.save(ASSETS / f"{name}.png", optimize=True)
    return {"src": f"/assets/buildings/{name}.png", "pivot": [side // 2, side // 2]}


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="coalition-buildings-") as raw:
        tmp = Path(raw)
        buildings = {
            name: process_building(name, footprint, height, tmp)
            for name, (footprint, height) in BUILDINGS.items()
        }
        weapons = {
            name: process_weapon(name, tmp)
            for name in ("turret-weapon", "atgun-weapon", "aa-weapon")
        }
    manifest = {"version": 2, "style": "Coalition 2045", "buildings": buildings, "weapons": weapons}
    (ASSETS / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
