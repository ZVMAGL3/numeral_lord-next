"""Train phase-specialized policies against shared, true game-outcome values."""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import time
from pathlib import Path

import torch

from model import atomic_json, position_batch, select_device
from phase_model import MODEL_FAMILY, SCHEMA_VERSION, PhasePolicyValueNet, initialize_from_mlp
from train import read_samples, seat_balance_weights
from train_v2 import stratified_probe


def sample_weights(batch, device, seat2_weight: float):
    if seat2_weight <= 0:
        raise ValueError("seat2_weight must be positive")
    balanced = seat_balance_weights(batch, device)
    tilt = torch.tensor([seat2_weight if sample["seat"] == 2 else 1.0 for sample in batch],
                        dtype=torch.float32, device=device)
    return balanced * tilt


def phases(batch, device):
    # The feature contract is fixed: phase_action, phase_reinforcement.
    action = torch.tensor([sample["global"][0] > 0.5 for sample in batch], dtype=torch.bool, device=device)
    reinforcement = torch.tensor([sample["global"][1] > 0.5 for sample in batch], dtype=torch.bool, device=device)
    if torch.any(action == reinforcement):
        raise ValueError("each sample must belong to exactly one decision phase")
    return action, reinforcement


def weighted_losses(model, batch, device, bootstrap_weight: float, seat2_weight: float = 1.10):
    tensors = position_batch(batch, device)
    logits, predicted_value = model(*tensors)
    target = torch.zeros_like(logits)
    values, value_weights = [], []
    sample_weight = sample_weights(batch, device, seat2_weight)
    for index, sample in enumerate(batch):
        target[index, :len(sample["policy"])] = torch.tensor(sample["policy"], device=device)
        values.append(sample["value"] if sample["value"] is not None else 0.0)
        value_weights.append(1.0 if sample["valueSource"] == "terminal"
                             else bootstrap_weight if sample["value"] is not None else 0.0)
    per_sample_policy = -(target * torch.log_softmax(logits, dim=-1)).sum(dim=-1)
    phase_masks = phases(batch, device)
    # Equalize the two policy objectives without rewarding any action class.
    phase_losses = []
    for mask in phase_masks:
        if torch.any(mask):
            weights = sample_weight * mask.float()
            phase_losses.append((per_sample_policy * weights).sum() / weights.sum().clamp_min(1))
    policy_loss = torch.stack(phase_losses).mean()
    target_value = torch.tensor(values, dtype=torch.float32, device=device)
    value_weight = torch.tensor(value_weights, dtype=torch.float32, device=device) * sample_weight
    value_loss = ((predicted_value - target_value).square() * value_weight).sum() / value_weight.sum().clamp_min(1)
    return policy_loss + value_loss, policy_loss, value_loss


def evaluate(model, samples, device, bootstrap_weight: float, seat2_weight: float):
    if not samples:
        raise ValueError("validation probe is empty")
    model.eval()
    sums = [0.0, 0.0, 0.0]
    count = 0
    with torch.no_grad():
        for start in range(0, len(samples), 256):
            batch = samples[start:start + 256]
            losses = weighted_losses(model, batch, device, bootstrap_weight, seat2_weight)
            for index, value in enumerate(losses):
                sums[index] += float(value.detach().cpu()) * len(batch)
            count += len(batch)
    return [value / count for value in sums]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--resume", required=True, help="compatible MLP checkpoint used to initialize shared layers and both policy heads")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "xpu"])
    parser.add_argument("--steps", type=int, default=1200)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=0.0001)
    parser.add_argument("--seed", type=int, default=20261018)
    parser.add_argument("--bootstrap-weight", type=float, default=0.2)
    parser.add_argument("--seat2-weight", type=float, default=1.10)
    parser.add_argument("--eval-interval", type=int, default=100)
    parser.add_argument("--patience", type=int, default=4)
    args = parser.parse_args()
    if (args.steps < 1 or args.batch_size < 1 or args.lr <= 0 or args.eval_interval < 1
            or args.patience < 1 or args.seat2_weight <= 0 or not 0 <= args.bootstrap_weight <= 1):
        parser.error("steps, batch-size, lr, eval-interval, patience and seat2-weight must be positive; bootstrap-weight must be in [0,1]")

    torch.set_num_threads(4)
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = select_device(args.device)
    metadata = json.loads(Path(args.metadata).read_text(encoding="utf-8"))
    samples = read_samples(Path(args.data), metadata["fingerprint"])
    model, source_metadata = initialize_from_mlp(args.resume, device)
    if source_metadata.get("fingerprint") != metadata["fingerprint"]:
        raise ValueError("warm-start checkpoint and samples use different map/rules")

    game_ids = sorted({sample["gameId"] for sample in samples})
    random.shuffle(game_ids)
    validation_ids = set(game_ids[:max(1, len(game_ids) // 5)]) if len(game_ids) >= 3 else set()
    validation = [sample for sample in samples if sample["gameId"] in validation_ids]
    training = [sample for sample in samples if sample["gameId"] not in validation_ids]
    if not training:
        raise ValueError("empty training split")
    probe = stratified_probe(validation or training)
    initial = evaluate(model, probe, device, args.bootstrap_weight, args.seat2_weight)
    best_loss, best_step = initial[0], 0
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
        loss, policy_loss, value_loss = weighted_losses(model, batch, device, args.bootstrap_weight, args.seat2_weight)
        if not torch.isfinite(loss):
            raise RuntimeError("non-finite loss")
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        completed_steps = step
        if step % args.eval_interval == 0 or step == args.steps:
            measured = evaluate(model, probe, device, args.bootstrap_weight, args.seat2_weight)
            history.append({"step": step, "total": measured[0], "policy": measured[1], "value": measured[2]})
            print(json.dumps({"step": step, "trainingLoss": float(loss.detach().cpu()),
                              "validationLoss": measured[0], "validationPolicy": measured[1],
                              "validationValue": measured[2], "bestStep": best_step}), flush=True)
            if measured[0] < best_loss - 1e-4:
                best_loss, best_step = measured[0], step
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
    final = evaluate(model, probe, device, args.bootstrap_weight, args.seat2_weight)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    torch.save({"schemaVersion": SCHEMA_VERSION, "modelFamily": MODEL_FAMILY, "width": model.width,
                "metadata": metadata, "model": {key: tensor.detach().cpu() for key, tensor in model.state_dict().items()},
                "training": {"stepsRequested": args.steps, "stepsCompleted": completed_steps,
                             "bestStep": best_step, "seed": args.seed, "resume": args.resume}}, temporary)
    temporary.replace(output)
    report = {"modelFamily": MODEL_FAMILY, "device": str(device), "torch": torch.__version__,
              "parameters": sum(parameter.numel() for parameter in model.parameters()),
              "samples": len(samples), "trainingSamples": len(training), "validationSamples": len(validation),
              "validationProbeSamples": len(probe), "samplesBySeat": {str(seat): sum(s["seat"] == seat for s in samples) for seat in (1, 2)},
              "samplesByPhase": {"action": sum(s["global"][0] > 0.5 for s in samples),
                                 "reinforcement": sum(s["global"][1] > 0.5 for s in samples)},
              "validationGames": sorted(validation_ids), "valueSources": {"terminal": sum(s["valueSource"] == "terminal" for s in samples)},
              "stepsRequested": args.steps, "stepsCompleted": completed_steps, "bestStep": best_step,
              "batchSize": args.batch_size, "learningRate": args.lr, "seat2SampleWeight": args.seat2_weight,
              "phasePolicyLoss": "equal mean of present phase losses", "elapsedSeconds": elapsed,
              "initialProbeLoss": initial, "finalProbeLoss": final, "validationHistory": history,
              "probeIsHeldOut": bool(validation), "checkpoint": str(output),
              "fingerprint": metadata["fingerprint"], "bootstrapWeight": args.bootstrap_weight}
    report["trainerSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    atomic_json(output.with_suffix(".metrics.json"), report)
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
