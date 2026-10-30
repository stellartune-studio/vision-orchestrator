#!/usr/bin/env python3
"""Sample device-wide VRAM usage using nvidia-smi; does not run a workload."""
import argparse
import csv
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def parse_sample(output):
    rows = list(csv.reader(output.splitlines(), skipinitialspace=True))
    if not rows:
        raise ValueError("nvidia-smi returned no GPUs")
    result = []
    seen = set()
    for row in rows:
        if len(row) != 4:
            raise ValueError("unexpected nvidia-smi output")
        uuid, name, used, total = (value.strip() for value in row)
        if not uuid or not name or uuid in seen:
            raise ValueError("missing or duplicate GPU identity")
        used, total = int(used), int(total)
        if used < 0 or total <= 0 or used > total:
            raise ValueError("invalid GPU memory values")
        seen.add(uuid)
        result.append({"uuid": uuid, "name": name, "used_mib": used, "total_mib": total})
    return result


def query(executable):
    # Repeated nvidia-smi calls must not create a console window on Windows.
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
    result = subprocess.run([executable, "--query-gpu=uuid,name,memory.used,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10, check=True, **options)
    return parse_sample(result.stdout)


def collect(duration, interval, executable="nvidia-smi", clock=time.monotonic, sleeper=time.sleep, query_fn=query):
    if duration <= 0 or interval <= 0:
        raise ValueError("duration and interval must be positive")
    started = clock()
    samples = []
    while True:
        elapsed = clock() - started
        if samples and elapsed >= duration:
            break
        devices = query_fn(executable)
        samples.append({"elapsed_seconds": round(elapsed, 3), "devices": devices})
        remaining = duration - (clock() - started)
        if remaining <= 0:
            break
        sleeper(min(interval, remaining))
    return samples


def summarize(samples):
    devices = {}
    for sample in samples:
        for device in sample["devices"]:
            uuid = device["uuid"]
            prior = devices.get(uuid)
            if prior and (prior["name"] != device["name"] or prior["total_mib"] != device["total_mib"]):
                raise ValueError("GPU identity changed during sampling")
            if not prior:
                devices[uuid] = {"uuid": uuid, "name": device["name"], "total_mib": device["total_mib"], "peak_used_mib": device["used_mib"], "samples": 1}
            else:
                prior["peak_used_mib"] = max(prior["peak_used_mib"], device["used_mib"])
                prior["samples"] += 1
    if any(d["samples"] != len(samples) for d in devices.values()):
        raise ValueError("GPU set changed during sampling")
    return list(devices.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration", type=float, required=True, help="sampling window in seconds")
    parser.add_argument("--interval", type=float, default=1.0, help="delay between samples in seconds (default: 1)")
    parser.add_argument("--output", required=True, help="new JSON result path; existing files are never overwritten")
    parser.add_argument("--context", required=True, help="non-secret workload and settings description")
    parser.add_argument("--nvidia-smi", default="nvidia-smi", help="nvidia-smi executable")
    args = parser.parse_args()
    import math
    if not all(math.isfinite(n) and n > 0 for n in (args.duration, args.interval)):
        parser.error("duration and interval must be finite positive numbers")
    started_at = datetime.now(timezone.utc).isoformat()
    try:
        samples = collect(args.duration, args.interval, args.nvidia_smi)
        result = {"scope": "device-wide", "unit": "MiB", "started_at_utc": started_at, "requested_duration_seconds": args.duration, "requested_interval_seconds": args.interval, "context": args.context, "sample_count": len(samples), "devices": summarize(samples), "samples": samples}
        with Path(args.output).open("x", encoding="utf-8") as file:
            json.dump(result, file, indent=2, ensure_ascii=False)
            file.write("\n")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"VRAM sampling failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"output": args.output, "sample_count": len(samples), "devices": result["devices"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
