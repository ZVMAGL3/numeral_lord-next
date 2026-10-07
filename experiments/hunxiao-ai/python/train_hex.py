"""Train the isolated hex-graph student from existing MCTS policy/value samples."""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import time
from collections import defaultdict
from pathlib import Path

import torch

from hex_model import (
    ARCHITECTURE_ID,
    CHECKPOINT_SCHEMA_VERSION,
    HexPolicyValueNet,
    load_checkpoint,
    position_batch,
)
from model import select_device
from train import game_sample_weight


SAMPLE_SCHEMA_VERSION = 1


def read_bounded_samples(path: Path, fingerprint: str, maximum: int, seed: int):
    """Reservoir-sample a bounded subset, then restore terminal values from reports."""
    if maximum < 3:
        raise ValueError("max-samples must be at least 3")
    rng = random.Random(seed)
    samples: list[dict] = []
    seen = 0
    with path.open(encoding="utf-8") as stream:
        for line_number, raw in enumerate(stream, 1):
            sample = json.loads(raw)
            if sample.get("schemaVersion") != SAMPLE_SCHEMA_VERSION or sample.get("fingerprint") != fingerprint:
                raise ValueError(f"sample metadata mismatch at line {line_number}")
            if sample.get("seat") not in (1, 2):
                raise ValueError(f"invalid seat at line {line_number}")
            policy = sample.get("policy", [])
            candidates = sample.get("candidates", [])
            if (not candidates or len(policy) != len(candidates) or any(p < 0 for p in policy)
                    or abs(sum(policy) - 1) > 1e-4):
                raise ValueError(f"invalid legal policy at line {line_number}")
            if len(samples) < maximum:
                samples.append(sample)
            else:
                replacement = rng.randrange(seen + 1)
                if replacement < maximum:
                    samples[replacement] = sample
            seen += 1
    if not samples:
        raise ValueError("no training samples")

    reports: dict[int, dict | None] = {}
    for sample in samples:
        game_id = sample.get("gameId")
        if game_id not in reports:
            report_path = path.parent / f"game-{game_id}.json"
            if report_path.exists():
                wrapper = json.loads(report_path.read_text(encoding="utf-8"))
                reports[game_id] = wrapper.get("report", wrapper)
            else:
                reports[game_id] = None
        report = reports[game_id]
        if report and report.get("finished"):
            winners = report.get("winningTeamIds", [])
            winning_seat = None
            if len(winners) == 1 and winners[0] in {"team-1", "team-2"}:
                winning_seat = int(winners[0].split("-")[1])
            sample["value"] = (0.0 if not winners else
                               1.0 if f"team-{sample['seat']}" in winners else -1.0)
            sample["valueSource"] = "terminal"
        report_rounds = report.get("rounds", 10) if report else 10
        winners = report.get("winningTeamIds", []) if report else []
        winning = len(winners) == 1 and winners[0] == f"team-{sample['seat']}"
        sample["gameWeight"] = game_sample_weight(report_rounds, winning)
    return samples, seen


def split_games(samples: list[dict], seed: int):
    game_ids = sorted({sample["gameId"] for sample in samples})
    random.Random(seed).shuffle(game_ids)
    validation_ids = set(game_ids[:max(1, len(game_ids) // 5)]) if len(game_ids) >= 2 else set()
    training = [sample for sample in samples if sample["gameId"] not in validation_ids]
    validation = [sample for sample in samples if sample["gameId"] in validation_ids]
    return training, validation or training, sorted(validation_ids)


def sample_weights(batch: list[dict], device: torch.device, seat2_weight: float):
    counts = {seat: sum(sample["seat"] == seat for sample in batch) for seat in (1, 2)}
    active = [seat for seat, count in counts.items() if count]
    seat_weights = torch.tensor(
        [len(batch) / (len(active) * counts[sample["seat"]]) for sample in batch],
        dtype=torch.float32, device=device,
    )
    seat_tilt = torch.tensor(
        [seat2_weight if sample["seat"] == 2 else 1.0 for sample in batch],
        dtype=torch.float32, device=device,
    )
    game_weights = torch.tensor(
        [sample.get("gameWeight", 1.0) for sample in batch], dtype=torch.float32, device=device
    )
    return seat_weights * seat_tilt * game_weights


def losses(model, batch: list[dict], device: torch.device, seat2_weight: float):
    logits, predicted_value = model(*position_batch(batch, device))
    policy_target = torch.zeros_like(logits)
    values: list[float] = []
    value_weights: list[float] = []
    for index, sample in enumerate(batch):
        policy_target[index, :len(sample["policy"])] = torch.tensor(sample["policy"], device=device)
        values.append(sample["value"] if sample.get("value") is not None else 0.0)
        value_weights.append(1.0 if sample.get("valueSource") == "terminal"
                             else 0.2 if sample.get("value") is not None else 0.0)
    weights = sample_weights(batch, device, seat2_weight)
    policy_per_sample = -(policy_target * torch.log_softmax(logits, dim=-1)).sum(dim=-1)
    policy_loss = (policy_per_sample * weights).sum() / weights.sum().clamp_min(1)
    value_target = torch.tensor(values, dtype=torch.float32, device=device)
    value_weight = torch.tensor(value_weights, dtype=torch.float32, device=device) * weights
    value_loss = ((predicted_value - value_target).square() * value_weight).sum() / value_weight.sum().clamp_min(1)
    return policy_loss + value_loss, policy_loss, value_loss


def evaluate(model, samples: list[dict], device: torch.device, seat2_weight: float, batch_size: int):
    model.eval()
    sums = [0.0, 0.0, 0.0]
    count = 0
    with torch.no_grad():
        for start in range(0, len(samples), batch_size):
            batch = samples[start:start + batch_size]
            measured = losses(model, batch, device, seat2_weight)
            for index, value in enumerate(measured):
                sums[index] += float(value.cpu()) * len(batch)
            count += len(batch)
    return [value / max(1, count) for value in sums]


def atomic_json(path: Path, data):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "xpu"])
    parser.add_argument("--max-samples", type=int, default=4096)
    parser.add_argument("--steps", type=int, default=300)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--width", type=int, default=48)
    parser.add_argument("--blocks", type=int, default=3)
    parser.add_argument("--resume", help="continue from a compatible hex-graph checkpoint")
    parser.add_argument("--lr", type=float, default=0.0003)
    parser.add_argument("--seed", type=int, default=20261007)
    parser.add_argument("--seat2-weight", type=float, default=1.10)
    args = parser.parse_args()
    if min(args.steps, args.batch_size, args.max_samples, args.width, args.blocks) < 1 or args.lr <= 0:
        parser.error("steps, batch-size, max-samples, width, blocks and lr must be positive")
    if args.seat2_weight <= 0:
        parser.error("seat2-weight must be positive")

    torch.set_num_threads(2)
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = select_device(args.device)
    metadata_path = Path(args.metadata)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    samples, total_source_samples = read_bounded_samples(
        Path(args.data), metadata["fingerprint"], args.max_samples, args.seed
    )
    training, validation, validation_games = split_games(samples, args.seed)
    if args.resume:
        model, _ = load_checkpoint(args.resume, device, metadata["fingerprint"])
        # The checkpoint defines the architecture; CLI defaults must not
        # silently create a mismatched model when resuming.
        args.width = model.width
        args.blocks = model.block_count
    else:
        model = HexPolicyValueNet(args.width, args.blocks).to(device)
    initial = evaluate(model, validation, device, args.seat2_weight, args.batch_size)
    best_loss = initial[0]
    best_step = 0
    best_state = {key: tensor.detach().cpu().clone() for key, tensor in model.state_dict().items()}
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    started = time.perf_counter()

    for step in range(1, args.steps + 1):
        model.train()
        batch = random.choices(training, k=min(args.batch_size, len(training)))
        optimizer.zero_grad(set_to_none=True)
        loss, _, _ = losses(model, batch, device, args.seat2_weight)
        if not torch.isfinite(loss):
            raise RuntimeError("non-finite training loss")
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        if step % 25 == 0 or step == args.steps:
            measured = evaluate(model, validation, device, args.seat2_weight, args.batch_size)
            if measured[0] < best_loss - 1e-4:
                best_loss = measured[0]
                best_step = step
                best_state = {key: tensor.detach().cpu().clone() for key, tensor in model.state_dict().items()}
            print(json.dumps({"step": step, "validationTotal": measured[0],
                              "validationPolicy": measured[1], "validationValue": measured[2],
                              "bestStep": best_step}), flush=True)

    model.load_state_dict(best_state)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    torch.save({
        "schemaVersion": CHECKPOINT_SCHEMA_VERSION,
        "architecture": ARCHITECTURE_ID,
        "width": args.width,
        "blocks": args.blocks,
        "metadata": metadata,
        "model": {key: tensor.detach().cpu() for key, tensor in model.state_dict().items()},
        "training": {"steps": args.steps, "bestStep": best_step, "seed": args.seed,
                     "learningRate": args.lr, "sourceSamples": total_source_samples,
                     "sampleLimit": args.max_samples,
                     "resumedFrom": str(Path(args.resume).resolve()) if args.resume else None},
    }, temporary)
    temporary.replace(output)
    final = evaluate(model, validation, device, args.seat2_weight, args.batch_size)
    source_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    metrics = {
        "architecture": ARCHITECTURE_ID,
        "trainerSha256": source_hash,
        "device": str(device),
        "torch": torch.__version__,
        "parameters": sum(parameter.numel() for parameter in model.parameters()),
        "samplesRead": total_source_samples,
        "samplesUsed": len(samples),
        "trainingSamples": len(training),
        "validationSamples": len(validation),
        "validationGames": validation_games,
        "validationMode": "held-out-games" if validation_games else "in-sample-no-holdout",
        "stepsRequested": args.steps,
        "bestStep": best_step,
        "initialProbeLoss": initial,
        "finalProbeLoss": final,
        "elapsedSeconds": time.perf_counter() - started,
        "checkpoint": str(output),
        "fingerprint": metadata["fingerprint"],
    }
    atomic_json(output.with_suffix(".metrics.json"), metrics)
    print(json.dumps(metrics, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
