"""Bounded, read-only numerical audit for a hex-graph-v1 checkpoint."""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

import torch

from hex_model import load_checkpoint
from train_hex import atomic_json, model_diagnostics


def read_prefix(path: Path, fingerprint: str, prefix_lines: int, stride: int,
                maximum: int) -> tuple[list[dict], int, set[int]]:
    positions: list[dict] = []
    games: set[int] = set()
    lines_read = 0
    with path.open(encoding="utf-8") as stream:
        for line_number, raw in enumerate(stream, 1):
            if line_number > prefix_lines or len(positions) >= maximum:
                break
            lines_read = line_number
            if (line_number - 1) % stride:
                continue
            sample = json.loads(raw)
            if sample.get("schemaVersion") != 1 or sample.get("fingerprint") != fingerprint:
                raise ValueError(f"sample metadata mismatch at line {line_number}")
            if not sample.get("candidates") or len(sample.get("policy", [])) != len(sample["candidates"]):
                raise ValueError(f"invalid legal policy at line {line_number}")
            positions.append(sample)
            games.add(sample.get("gameId"))
    if len(positions) < 2:
        raise ValueError("audit requires at least two bounded positions")
    return positions, lines_read, games


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--prefix-lines", type=int, default=4096)
    parser.add_argument("--stride", type=int, default=32)
    parser.add_argument("--max-positions", type=int, default=128)
    args = parser.parse_args()
    if min(args.prefix_lines, args.stride, args.max_positions) < 1:
        parser.error("prefix-lines, stride and max-positions must be positive")
    checkpoint_path = Path(args.checkpoint)
    data_path = Path(args.data)
    output_path = Path(args.output)
    if output_path.exists():
        raise FileExistsError(f"refusing to overwrite audit report: {output_path}")

    started = time.perf_counter()
    device = torch.device("cpu")
    model, metadata = load_checkpoint(str(checkpoint_path), device)
    positions, lines_read, games = read_prefix(
        data_path, metadata["fingerprint"], args.prefix_lines, args.stride, args.max_positions
    )
    health = model_diagnostics(model, positions, device)
    checks = {
        "finite": health["finite"],
        "boardContextSensitive": health["maximumPolicyProbabilityDeltaAfterBoardOnlySwap"] > 1e-8,
        "valueGradientPresent": health["wrongTargetValueGradientNorm"] > 0,
        "valueNotCollapsedAtTanhLimit": health["values"]["fractionAtTanhLimit"] < 0.95,
        "activationsFiniteAndBounded": all(
            stats["maximumAbsolute"] < 1e4 for stats in health["activations"].values()
        ),
    }
    report = {
        "success": all(checks.values()),
        "trainingPerformed": False,
        "device": "cpu",
        "checkpoint": str(checkpoint_path.resolve()),
        "checkpointSha256": hashlib.sha256(checkpoint_path.read_bytes()).hexdigest(),
        "data": str(data_path.resolve()),
        "fingerprint": metadata["fingerprint"],
        "prefixLinesRequested": args.prefix_lines,
        "linesRead": lines_read,
        "stride": args.stride,
        "positions": len(positions),
        "games": len(games),
        "checks": checks,
        "health": health,
        "elapsedSeconds": time.perf_counter() - started,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(output_path, report)
    print(json.dumps({"report": str(output_path.resolve()), "success": report["success"],
                      "positions": len(positions), "games": len(games),
                      "elapsedSeconds": report["elapsedSeconds"]}), flush=True)
    if not report["success"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
