"""Conservative, validation-guided updates for continuous self-play generations."""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import time
from collections import defaultdict
from pathlib import Path

import torch

from model import PolicyValueNet, atomic_json, load_checkpoint, position_batch, select_device
from train import read_samples, seat_balance_weights


def stratified_probe(samples, maximum: int = 4096):
    """Sample early/middle/late positions from each held-out game and seat."""
    if maximum < 1:
        raise ValueError("maximum probe size must be positive")
    groups = defaultdict(list)
    for sample in samples:
        groups[(sample["gameId"], sample["seat"])].append(sample)
    ordered = [groups[key] for key in sorted(groups)]
    probe = []
    seen = set()
    for fraction in (0.1, 0.5, 0.9):
        for group in ordered:
            if len(probe) >= maximum:
                return probe
            index = round(fraction * (len(group) - 1))
            identity = (group[index]["gameId"], group[index]["seat"], index)
            if identity not in seen:
                seen.add(identity)
                probe.append(group[index])
    return probe


def evaluate(model, samples, device, bootstrap_weight: float, batch_size: int = 256,
             seat2_weight: float = 1.10):
    """Return sample-weighted total/policy/value losses without retaining graphs."""
    if not samples:
        raise ValueError("validation probe is empty")
    model.eval()
    sums = [0.0, 0.0, 0.0]
    count = 0
    with torch.no_grad():
        for start in range(0, len(samples), batch_size):
            batch = samples[start:start + batch_size]
            values = weighted_losses(model, batch, device, bootstrap_weight, seat2_weight=seat2_weight)
            for index, value in enumerate(values):
                sums[index] += float(value.detach().cpu()) * len(batch)
            count += len(batch)
    return [value / count for value in sums]


def value_saturation_stats(model, samples, device, batch_size: int = 256, threshold: float = 0.999):
    """Measure whether the tanh value head is pinned at either output limit."""
    if not samples:
        raise ValueError("value saturation probe is empty")
    model.eval()
    predictions = []
    with torch.no_grad():
        for start in range(0, len(samples), batch_size):
            tensors = position_batch(samples[start:start + batch_size], device)
            _, values = model(*tensors)
            predictions.append(values.detach().float().cpu())
    values = torch.cat(predictions)
    return {
        "fractionAtTanhLimit": float((values.abs() >= threshold).float().mean()),
        "minimum": float(values.min()),
        "maximum": float(values.max()),
        "threshold": threshold,
    }


def reset_saturated_value_head(model, probe, device, seed: int, threshold: float = 0.999,
                               minimum_fraction: float = 0.95):
    """Reset only the value head when tanh saturation blocks outcome learning."""
    before = value_saturation_stats(model, probe, device, threshold=threshold)
    if before["fractionAtTanhLimit"] < minimum_fraction:
        return {"reset": False, "reason": "value predictions are not saturated", "before": before}

    # Keep the encoder and policy head warm-started. A fresh value head restores
    # outcome learning while preserving all learned move preferences. Zeroing
    # its final affine layer guarantees the first values are centered at zero;
    # random initialization alone can still saturate tanh on large board states.
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(seed + 0x5A17)
        fresh = PolicyValueNet(model.width)
    model.value_head.load_state_dict(fresh.value_head.state_dict())
    with torch.no_grad():
        model.value_head[2].weight.zero_()
        model.value_head[2].bias.zero_()
    after = value_saturation_stats(model, probe, device, threshold=threshold)
    return {"reset": True, "reason": "at least 95% of probe values were saturated",
            "before": before, "after": after}


def seat_adjusted_weights(batch, device, seat2_weight: float = 1.10):
    """Keep seat balancing, then give seat 2 a small relative training tilt."""
    if seat2_weight <= 0:
        raise ValueError("seat2_weight must be positive")
    balanced = seat_balance_weights(batch, device)
    tilt = torch.tensor([seat2_weight if sample["seat"] == 2 else 1.0 for sample in batch],
                        dtype=torch.float32, device=device)
    return balanced * tilt


def weighted_losses(model, batch, device, bootstrap_weight: float, seat2_weight: float = 1.10):
    tensors = position_batch(batch, device)
    logits, predicted_value = model(*tensors)
    target = torch.zeros_like(logits)
    values = []
    value_weights = []
    sample_weights = seat_adjusted_weights(batch, device, seat2_weight)
    for index, sample in enumerate(batch):
        target[index, :len(sample["policy"])] = torch.tensor(sample["policy"], device=device)
        values.append(sample["value"] if sample["value"] is not None else 0.0)
        value_weights.append(1.0 if sample["valueSource"] == "terminal"
                             else bootstrap_weight if sample["value"] is not None else 0.0)
    per_sample_policy = -(target * torch.log_softmax(logits, dim=-1)).sum(dim=-1)
    policy_loss = (per_sample_policy * sample_weights).sum() / sample_weights.sum().clamp_min(1)
    target_value = torch.tensor(values, dtype=torch.float32, device=device)
    value_weight = torch.tensor(value_weights, dtype=torch.float32, device=device) * sample_weights
    value_loss = ((predicted_value - target_value).square() * value_weight).sum() / value_weight.sum().clamp_min(1)
    return policy_loss + value_loss, policy_loss, value_loss


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--resume")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "xpu"])
    parser.add_argument("--steps", type=int, default=1200)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=0.0001)
    parser.add_argument("--seed", type=int, default=20261005)
    parser.add_argument("--bootstrap-weight", type=float, default=0.2)
    parser.add_argument("--eval-interval", type=int, default=100)
    parser.add_argument("--patience", type=int, default=4)
    parser.add_argument("--seat2-weight", type=float, default=1.10)
    args = parser.parse_args()
    if (args.steps < 1 or args.batch_size < 1 or args.lr <= 0 or args.eval_interval < 1
            or args.patience < 1 or args.seat2_weight <= 0 or not 0 <= args.bootstrap_weight <= 1):
        parser.error("steps, batch-size, lr, eval-interval, patience and seat2-weight must be positive; bootstrap-weight must be in [0,1]")

    torch.set_num_threads(4)
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = select_device(args.device)
    metadata_path = Path(args.metadata)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    samples = read_samples(Path(args.data), metadata["fingerprint"])
    if args.resume:
        model, _ = load_checkpoint(args.resume, device, metadata["fingerprint"])
    else:
        model = PolicyValueNet().to(device)

    # Split by game to avoid validation leakage from adjacent positions.
    game_ids = sorted({sample["gameId"] for sample in samples})
    random.shuffle(game_ids)
    validation_ids = set(game_ids[:max(1, len(game_ids) // 5)]) if len(game_ids) >= 3 else set()
    validation = [sample for sample in samples if sample["gameId"] in validation_ids]
    training = [sample for sample in samples if sample["gameId"] not in validation_ids]
    if not training:
        raise ValueError("empty training split")
    probe = stratified_probe(validation or training)
    value_head_diagnostics = reset_saturated_value_head(model, probe, device, args.seed)
    initial = evaluate(model, probe, device, args.bootstrap_weight, seat2_weight=args.seat2_weight)
    best_loss = initial[0]
    best_step = 0
    best_state = {key: tensor.detach().cpu().clone() for key, tensor in model.state_dict().items()}
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    history = [{"step": 0, "total": initial[0], "policy": initial[1], "value": initial[2]}]
    bad_checks = 0
    completed_steps = 0
    started = time.perf_counter()

    for step in range(1, args.steps + 1):
        model.train()
        batch = random.choices(training, k=min(args.batch_size, len(training)))
        optimizer.zero_grad(set_to_none=True)
        loss, policy_loss, value_loss = weighted_losses(model, batch, device, args.bootstrap_weight,
                                                         seat2_weight=args.seat2_weight)
        if not torch.isfinite(loss):
            raise RuntimeError("non-finite training loss")
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        completed_steps = step

        if step % args.eval_interval == 0 or step == args.steps:
            measured = evaluate(model, probe, device, args.bootstrap_weight, seat2_weight=args.seat2_weight)
            history.append({"step": step, "total": measured[0], "policy": measured[1], "value": measured[2]})
            print(json.dumps({"step": step, "trainingLoss": float(loss.detach().cpu()),
                              "validationLoss": measured[0], "validationPolicy": measured[1],
                              "validationValue": measured[2], "bestStep": best_step}), flush=True)
            if measured[0] < best_loss - 1e-4:
                best_loss = measured[0]
                best_step = step
                best_state = {key: tensor.detach().cpu().clone() for key, tensor in model.state_dict().items()}
                bad_checks = 0
            else:
                bad_checks += 1
                if bad_checks >= args.patience:
                    break

    if device.type == "xpu":
        torch.xpu.synchronize()
    elapsed = time.perf_counter() - started
    model.load_state_dict(best_state)
    final = evaluate(model, probe, device, args.bootstrap_weight, seat2_weight=args.seat2_weight)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    torch.save({"schemaVersion": 1, "width": model.width, "metadata": metadata,
                "model": {key: tensor.detach().cpu() for key, tensor in model.state_dict().items()},
                "training": {"trainerVersion": 3, "stepsRequested": args.steps,
                             "stepsCompleted": completed_steps, "bestStep": best_step,
                             "learningRate": args.lr, "seed": args.seed, "resume": args.resume or "",
                             "valueHeadDiagnostics": value_head_diagnostics}}, temporary)
    temporary.replace(output)

    source_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    sources = {source: sum(sample["valueSource"] == source for sample in samples)
               for source in sorted({sample["valueSource"] for sample in samples})}
    report = {"trainerVersion": 3, "trainerSha256": source_hash, "device": str(device), "torch": torch.__version__,
              "parameters": sum(parameter.numel() for parameter in model.parameters()),
              "samples": len(samples), "trainingSamples": len(training), "validationSamples": len(validation),
              "validationProbeSamples": len(probe),
              "samplesBySeat": {str(seat): sum(sample["seat"] == seat for sample in samples) for seat in (1, 2)},
              "validationGames": sorted(validation_ids), "valueSources": sources,
              "stepsRequested": args.steps, "stepsCompleted": completed_steps, "bestStep": best_step,
              "batchSize": args.batch_size, "learningRate": args.lr, "evalInterval": args.eval_interval,
              "patience": args.patience, "seat2SampleWeight": args.seat2_weight,
              "elapsedSeconds": elapsed, "initialProbeLoss": initial,
              "finalProbeLoss": final, "validationHistory": history, "probeIsHeldOut": bool(validation),
              "valueHeadDiagnostics": value_head_diagnostics,
              "checkpoint": str(output), "fingerprint": metadata["fingerprint"],
              "bootstrapWeight": args.bootstrap_weight}
    atomic_json(output.with_suffix(".metrics.json"), report)
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
