#!/usr/bin/env python3
"""Compose the fictional two-window browser demo into a silent, captioned MP4."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "runtime" / "web-demo-20260929"
FONT = Path("/System/Library/Fonts/Supplemental/Arial.ttf")


def probe(path: Path) -> dict:
    result = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
        "format=duration:stream=codec_type,width,height", "-of", "json", str(path)],
        check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def main():
    phone = OUT / "phone.webm"
    dashboard = OUT / "dashboard.webm"
    timeline = json.loads((OUT / "timeline.json").read_text())
    if timeline["errors"]:
        raise SystemExit("Browser recording reported page errors")
    left, right = probe(phone), probe(dashboard)
    duration = min(float(left["format"]["duration"]), float(right["format"]["duration"]), 60.5)
    if not 60 <= duration <= 90:
        raise SystemExit("Expected a 60–90 second recording")
    if (left["streams"][0]["width"], left["streams"][0]["height"]) != (390, 844):
        raise SystemExit("Companion capture has the wrong viewport")
    if (right["streams"][0]["width"], right["streams"][0]["height"]) != (1440, 1000):
        raise SystemExit("Dashboard capture has the wrong viewport")
    if not FONT.is_file():
        raise SystemExit("System font is unavailable")

    captions = OUT / "caption-text"
    captions.mkdir(exist_ok=True)
    title = captions / "title.txt"
    title.write_text("Parse companion")
    disclaimer = captions / "disclaimer.txt"
    disclaimer.write_text("Fictional data · simulated speech")
    filters = [
        f"color=c=0xF7F3EB:s=1920x1080:r=30:d={duration:.3f}[bg]",
        f"[0:v]fps=30,scale=390:844,setsar=1,tpad=stop_mode=clone:stop_duration=10,trim=duration={duration:.3f},setpts=PTS-STARTPTS[phone]",
        f"[1:v]fps=30,scale=1320:917,setsar=1,tpad=stop_mode=clone:stop_duration=10,trim=duration={duration:.3f},setpts=PTS-STARTPTS[dash]",
        "[bg][phone]overlay=x=55:y=160:shortest=1[with_phone]",
        "[with_phone][dash]overlay=x=530:y=150:shortest=1[windows]",
    ]
    overlays = [
        "drawbox=x=0:y=0:w=1920:h=112:color=0x713F30:t=fill",
        "drawbox=x=52:y=157:w=396:h=850:color=0xB9856D:t=3",
        "drawbox=x=527:y=147:w=1326:h=923:color=0xB9856D:t=3",
        "drawbox=x=52:y=1007:w=401:h=47:color=0x713F30:t=fill",
        f"drawtext=fontfile={FONT}:textfile={title}:x=55:y=24:fontsize=33:fontcolor=white",
        f"drawtext=fontfile={FONT}:textfile={disclaimer}:x=66:y=1019:fontsize=18:fontcolor=white",
        f"drawtext=fontfile={FONT}:text='BROWSER COMPANION':x=55:y=129:fontsize=17:fontcolor=0x713F30",
        f"drawtext=fontfile={FONT}:text='CARE SPACE DASHBOARD':x=530:y=124:fontsize=17:fontcolor=0x713F30",
    ]
    events = timeline["events"]
    for index, event in enumerate(events[:-1]):
        if not event["caption"]:
            continue
        text = captions / f"caption-{index:02d}.txt"
        text.write_text(event["caption"])
        start = max(0, float(event["seconds"]))
        end = min(duration, float(events[index + 1]["seconds"]))
        if end <= start:
            continue
        overlays.append(f"drawtext=fontfile={FONT}:textfile={text}:x=530:y=43:fontsize=29:fontcolor=white:enable='between(t,{start:.3f},{end:.3f})'")
    filters.append("[windows]" + ",".join(overlays) + "[final]")
    graph = OUT / "composition.ffgraph"
    graph.write_text(";\n".join(filters) + "\n")
    output = OUT / "parse-web-companion-demo.mp4"
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning", "-i", str(phone),
        "-i", str(dashboard), "-filter_complex_script", str(graph), "-map", "[final]",
        "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-t", f"{duration:.3f}", str(output)], check=True)
    final = probe(output)
    streams = final["streams"]
    if len(streams) != 1 or streams[0]["codec_type"] != "video" or not 60 <= float(final["format"]["duration"]) <= 90:
        raise SystemExit("MP4 validation failed")
    print(json.dumps({"output": str(output), "duration_seconds": float(final["format"]["duration"]),
                      "size_bytes": output.stat().st_size, "resolution": "1920x1080", "audio": "none"}))


if __name__ == "__main__":
    main()
