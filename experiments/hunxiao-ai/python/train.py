"""Train search policy targets and separately marked terminal/bootstrap values."""
from __future__ import annotations
import argparse
import json
import math
import random
import time
from pathlib import Path
import torch
from model import PolicyValueNet, SCHEMA_VERSION, atomic_json, load_checkpoint, position_batch, select_device

TARGET_GAME_ROUNDS = 10
MIN_GAME_WEIGHT = 0.35
SHORT_WIN_BONUS = 0.5


def game_sample_weight(rounds: int, winner: bool) -> float:
    """Softly downweight long matches and favor the winner of a quick decisive game."""
    if not isinstance(rounds, int) or rounds < 1:
        rounds = TARGET_GAME_ROUNDS
    length_weight = max(MIN_GAME_WEIGHT, min(1.25, math.sqrt(TARGET_GAME_ROUNDS / rounds)))
    quickness = max(0.0, (TARGET_GAME_ROUNDS - rounds) / TARGET_GAME_ROUNDS)
    winner_weight = 1.0 + SHORT_WIN_BONUS * quickness if winner else 1.0
    return min(1.5, length_weight * winner_weight)


def read_samples(path: Path, fingerprint: str):
    samples = []
    reports = {}
    with path.open(encoding="utf-8") as stream:
        for line_number, raw in enumerate(stream, 1):
            sample = json.loads(raw)
            if sample.get("schemaVersion") != SCHEMA_VERSION or sample.get("fingerprint") != fingerprint:
                raise ValueError(f"sample metadata mismatch at line {line_number}")
            if sample.get("seat") not in (1, 2):
                raise ValueError(f"invalid seat at line {line_number}")
            policy = sample["policy"]
            if len(policy) != len(sample["candidates"]) or not policy or any(p < 0 for p in policy) or abs(sum(policy) - 1) > 1e-4:
                raise ValueError(f"invalid legal policy at line {line_number}")
            value = sample["value"]
            if value is not None and not -1 <= value <= 1:
                raise ValueError(f"invalid value label at line {line_number}")
            source = sample["valueSource"]
            if source not in {"terminal", "teacher-bootstrap", "network-bootstrap", "unlabelled"}:
                raise ValueError(f"unknown value source at line {line_number}")
            if (value is None) != (source == "unlabelled"):
                raise ValueError(f"value source/label mismatch at line {line_number}")
            # Terminal targets can be reconstructed from the recorded result and
            # each sample's own seat. This also protects against stale or
            # misaligned perspective labels in older reservoirs.
            game_id = sample.get("gameId")
            if game_id not in reports:
                report_path = path.parent / f"game-{game_id}.json"
                if report_path.exists():
                    wrapper = json.loads(report_path.read_text(encoding="utf-8"))
                    reports[game_id] = wrapper.get("report", wrapper)
                else:
                    reports[game_id] = None
            report = reports[game_id]
            winning_seat = None
            if report and report.get("finished"):
                winners = report.get("winningTeamIds", [])
                if len(winners) == 1 and winners[0] in {"team-1", "team-2"}:
                    winning_seat = int(winners[0].split("-")[1])
                sample["value"] = (0.0 if not winners else
                                   1.0 if f"team-{sample['seat']}" in winners else -1.0)
                sample["valueSource"] = "terminal"
            sample["gameWeight"] = game_sample_weight(
                report.get("rounds", TARGET_GAME_ROUNDS) if report else TARGET_GAME_ROUNDS,
                winning_seat == sample["seat"],
            )
            samples.append(sample)
    if not samples:
        raise ValueError("no training samples")
    return samples


def seat_balance_weights(batch, device):
    counts = {seat: sum(sample["seat"] == seat for sample in batch) for seat in (1, 2)}
    active = [seat for seat, count in counts.items() if count]
    weights = [len(batch) / (len(active) * counts[sample["seat"]]) for sample in batch]
    return torch.tensor(weights, dtype=torch.float32, device=device)


def losses(model, batch, device, bootstrap_weight: float):
    tensors = position_batch(batch, device)
    logits, predicted_value = model(*tensors)
    target = torch.zeros_like(logits)
    values, weights = [], []
    seat_weights = seat_balance_weights(batch, device)
    game_weights = torch.tensor([sample.get("gameWeight", 1.0) for sample in batch], dtype=torch.float32, device=device)
    sample_weights = seat_weights * game_weights
    per_sample_policy = []
    for i, sample in enumerate(batch):
        target[i, :len(sample["policy"])] = torch.tensor(sample["policy"], device=device)
        values.append(sample["value"] if sample["value"] is not None else 0.0)
        weights.append(1.0 if sample["valueSource"] == "terminal" else bootstrap_weight if sample["value"] is not None else 0.0)
    per_sample_policy = -(target * torch.log_softmax(logits, dim=-1)).sum(dim=-1)
    policy_loss = (per_sample_policy * sample_weights).sum() / sample_weights.sum().clamp_min(1)
    target_value = torch.tensor(values, dtype=torch.float32, device=device)
    value_weight = torch.tensor(weights, dtype=torch.float32, device=device) * sample_weights
    value_loss = ((predicted_value - target_value).square() * value_weight).sum() / value_weight.sum().clamp_min(1)
    return policy_loss + value_loss, policy_loss, value_loss


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--resume")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "xpu"])
    parser.add_argument("--steps", type=int, default=400)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=0.001)
    parser.add_argument("--seed", type=int, default=20261005)
    parser.add_argument("--bootstrap-weight", type=float, default=0.2)
    args = parser.parse_args()
    if args.steps < 1 or args.batch_size < 1 or not 0 <= args.bootstrap_weight <= 1:
        parser.error("steps/batch-size must be positive; bootstrap-weight must be in [0,1]")
    torch.set_num_threads(4)
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = select_device(args.device)
    metadata = json.loads(Path(args.metadata).read_text(encoding="utf-8"))
    samples = read_samples(Path(args.data), metadata["fingerprint"])
    if args.resume:
        model, _ = load_checkpoint(args.resume, device, metadata["fingerprint"])
    else:
        model = PolicyValueNet().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    # Split by game, never by random positions from the same trajectory.
    ids = sorted({sample["gameId"] for sample in samples})
    random.shuffle(ids)
    validation_ids = set(ids[:max(1, len(ids) // 5)]) if len(ids) >= 3 else set()
    validation = [sample for sample in samples if sample["gameId"] in validation_ids]
    training = [sample for sample in samples if sample["gameId"] not in validation_ids]
    if not training:
        raise ValueError("empty training split")
    model.eval()
    probe = (validation or training)[:min(128, len(validation or training))]
    with torch.no_grad():
        initial = [float(t.detach().cpu()) for t in losses(model, probe, device, args.bootstrap_weight)]
    model.train()
    started = time.perf_counter()
    for step in range(args.steps):
        batch = random.choices(training, k=min(args.batch_size, len(training)))
        optimizer.zero_grad(set_to_none=True)
        loss, policy_loss, value_loss = losses(model, batch, device, args.bootstrap_weight)
        if not torch.isfinite(loss):
            raise RuntimeError("non-finite training loss")
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0, error_if_nonfinite=True)
        optimizer.step()
        if step == 0 or (step + 1) % 100 == 0 or step + 1 == args.steps:
            print(json.dumps({"step": step + 1, "loss": float(loss.detach().cpu()),
                              "policy": float(policy_loss.detach().cpu()), "value": float(value_loss.detach().cpu())}), flush=True)
    if device.type == "xpu":
        torch.xpu.synchronize()
    elapsed = time.perf_counter() - started
    model.eval()
    with torch.no_grad():
        final = [float(t.detach().cpu()) for t in losses(model, probe, device, args.bootstrap_weight)]
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    torch.save({"schemaVersion": SCHEMA_VERSION, "width": model.width, "metadata": metadata,
                "model": {key: tensor.detach().cpu() for key, tensor in model.state_dict().items()},
                "training": {"steps": args.steps, "seed": args.seed, "resume": args.resume or ""}}, temporary)
    temporary.replace(output)
    sources = {source: sum(s["valueSource"] == source for s in samples)
               for source in sorted({s["valueSource"] for s in samples})}
    report = {"device": str(device), "torch": torch.__version__, "parameters": sum(p.numel() for p in model.parameters()),
              "samples": len(samples), "trainingSamples": len(training), "validationSamples": len(validation),
              "samplesBySeat": {str(seat): sum(sample["seat"] == seat for sample in samples) for seat in (1, 2)},
              "gameWeighting": {"targetRounds": TARGET_GAME_ROUNDS, "minimumLongGameWeight": MIN_GAME_WEIGHT,
                                "maximumShortWinBonus": SHORT_WIN_BONUS,
                                "meanSampleWeight": sum(s["gameWeight"] for s in samples) / len(samples)},
              "validationGames": sorted(validation_ids), "valueSources": sources, "steps": args.steps,
              "batchSize": args.batch_size, "elapsedSeconds": elapsed, "initialProbeLoss": initial,
              "finalProbeLoss": final, "probeIsHeldOut": bool(validation), "checkpoint": str(output),
              "fingerprint": metadata["fingerprint"], "bootstrapWeight": args.bootstrap_weight}
    atomic_json(output.with_suffix(".metrics.json"), report)
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
