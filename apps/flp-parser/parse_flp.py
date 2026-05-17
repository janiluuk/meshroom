#!/usr/bin/env python3
"""Parse FL Studio .flp to Meshroom canonical analysis JSON (stdin path as argv[1])."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

FL_COLORS = [
    "#ff5555", "#ffaa00", "#ffff00", "#00ff00", "#00aaaa", "#5555ff", "#aa00ff", "#ff00ff",
    "#888888", "#cccccc", "#ff8080", "#80ff80", "#8080ff", "#ffff80", "#80ffff", "#ff80ff",
]


def color_from_index(index: int | None) -> str | None:
    if index is None:
        return None
    return FL_COLORS[abs(index) % len(FL_COLORS)]


def parse_with_pyflp(path: Path) -> dict:
    import pyflp  # type: ignore

    project = pyflp.parse(str(path))
    tracks = []
    plugins_summary: dict[str, dict] = {}
    warnings = []
    track_index = 0

    channels = getattr(project, "channels", None)
    if channels:
        for channel in channels:
            track_index += 1
            tid = f"t{track_index}"
            name = getattr(channel, "name", None) or f"Channel {track_index}"
            color_idx = getattr(channel, "color", None)
            plugins = []
            plugin = getattr(channel, "plugin", None)
            if plugin is not None:
                pname = getattr(plugin, "name", None) or str(plugin)
                plugins.append({"name": pname, "vendor": None, "format": "native"})
                key = pname
                if key not in plugins_summary:
                    plugins_summary[key] = {
                        "name": pname,
                        "vendor": None,
                        "format": "native",
                        "usedOnTracks": [tid],
                    }
                elif tid not in plugins_summary[key]["usedOnTracks"]:
                    plugins_summary[key]["usedOnTracks"].append(tid)

            tracks.append(
                {
                    "id": tid,
                    "name": name,
                    "type": "midi",
                    "color": color_from_index(color_idx if isinstance(color_idx, int) else None),
                    "mute": bool(getattr(channel, "muted", False)),
                    "solo": bool(getattr(channel, "solo", False)),
                    "plugins": plugins,
                    "clips": [],
                }
            )

    playlist = getattr(project, "playlist", None)
    if playlist is not None:
        items = getattr(playlist, "tracks", None) or getattr(playlist, "items", None)
        if items:
            for item in items:
                track_id = getattr(item, "track", None)
                name = getattr(item, "name", None) or "Playlist item"
                start = getattr(item, "position", None) or getattr(item, "start", None) or 0
                length = getattr(item, "length", None) or 4
                if isinstance(start, (int, float)) and track_index > 0:
                    target = tracks[min(int(track_id or 0), len(tracks) - 1)] if tracks else None
                    if target:
                        start_bar = max(1, int(start / 192) + 1)
                        end_bar = max(start_bar + 1, int((start + length) / 192) + 1)
                        target["clips"].append(
                            {
                                "name": name,
                                "startBar": start_bar,
                                "endBar": end_bar,
                                "color": target.get("color"),
                            }
                        )

    tempo = getattr(project, "tempo", None) or getattr(project, "bpm", None)
    if tempo is None:
        format_ = getattr(project, "format", None)
        if format_ is not None:
            tempo = getattr(format_, "tempo", None)

    return {
        "daw": "flstudio",
        "dawVersionHint": getattr(project, "version", None),
        "projectName": path.stem,
        "tempo": float(tempo) if tempo is not None else None,
        "timeSignature": {"numerator": 4, "denominator": 4},
        "lengthBars": None,
        "tracks": tracks,
        "pluginsSummary": list(plugins_summary.values()),
        "warnings": warnings,
    }


def parse_minimal(path: Path) -> dict:
    data = path.read_bytes()
    tempo = 120.0
    if data[:4] == b"FLhd":
        # FLhd chunk: tempo often near header; best-effort only
        pass
    warnings = [
        {
            "code": "FLP_MINIMAL_PARSE",
            "message": "PyFLP not installed; install pyflp for full FL Studio analysis.",
        }
    ]
    return {
        "daw": "flstudio",
        "projectName": path.stem,
        "tempo": tempo,
        "timeSignature": {"numerator": 4, "denominator": 4},
        "tracks": [],
        "pluginsSummary": [],
        "warnings": warnings,
    }


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: parse_flp.py <file.flp>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    raw = path.read_bytes()
    base = {
        "sourceFile": {
            "name": path.name,
            "sha256": sha256(raw).hexdigest(),
            "sizeBytes": len(raw),
        },
        "parsedAt": datetime.now(timezone.utc).isoformat(),
    }
    try:
        import pyflp  # noqa: F401

        payload = parse_with_pyflp(path)
    except Exception as exc:
        payload = parse_minimal(path)
        payload["warnings"] = payload.get("warnings", []) + [
            {"code": "PARSE_DEGRADED", "message": str(exc)}
        ]
    payload.update(base)
    json.dump(payload, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
