"""Train the isolated hex-graph student from existing MCTS policy/value samples."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import time
from datetime import datetime, timezone
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
    """Reservoir-sample only positions from naturally completed full games."""
    if maximum < 3:
        raise ValueError("max-samples must be at least 3")
    rng = random.Random(seed)
    samples: list[dict] = []
    eligible_seen = 0
    source_seen = 0
    skipped_games: set[int] = set()
    reports: dict[int, dict | None] = {}
    with path.open(encoding="utf-8") as stream:
        for line_number, raw in enumerate(stream, 1):
            sample = json.loads(raw)
            source_seen += 1
            if sample.get("schemaVersion") != SAMPLE_SCHEMA_VERSION or sample.get("fingerprint") != fingerprint:
                raise ValueError(f"sample metadata mismatch at line {line_number}")
            if sample.get("seat") not in (1, 2):
                raise ValueError(f"invalid seat at line {line_number}")
            policy = sample.get("policy", [])
            candidates = sample.get("candidates", [])
            if (not candidates or len(policy) != len(candidates) or any(p < 0 for p in policy)
                    or abs(sum(policy) - 1) > 1e-4):
                raise ValueError(f"invalid legal policy at line {line_number}")
            game_id = sample.get("gameId")
            if not isinstance(game_id, int):
                raise ValueError(f"invalid game id at line {line_number}")
            if game_id not in reports:
                report_path = path.parent / f"game-{game_id}.json"
                if report_path.exists():
                    wrapper = json.loads(report_path.read_text(encoding="utf-8"))
                    reports[game_id] = wrapper.get("report", wrapper)
                else:
                    reports[game_id] = None
            report = reports[game_id]
            if not report or not report.get("finished") or report.get("truncated"):
                skipped_games.add(game_id)
                continue
            winners = report.get("winningTeamIds", [])
            if not isinstance(winners, list) or any(team not in {"team-1", "team-2"} for team in winners):
                raise ValueError(f"invalid terminal winners for game {game_id}")
            sample["value"] = (0.0 if not winners else
                               1.0 if f"team-{sample['seat']}" in winners else -1.0)
            sample["valueSource"] = "terminal"
            report_rounds = report.get("rounds", 10)
            winning = len(winners) == 1 and winners[0] == f"team-{sample['seat']}"
            sample["gameWeight"] = game_sample_weight(report_rounds, winning)
            if len(samples) < maximum:
                samples.append(sample)
            else:
                replacement = rng.randrange(eligible_seen + 1)
                if replacement < maximum:
                    samples[replacement] = sample
            eligible_seen += 1
    if not samples:
        raise ValueError("no naturally completed training samples")
    return samples, {
        "sourceSamples": source_seen,
        "eligibleSamples": eligible_seen,
        "eligibleGames": sum(report is not None and report.get("finished") and not report.get("truncated")
                             for report in reports.values()),
        "skippedIncompleteGames": len(skipped_games),
    }


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


def losses(model, batch: list[dict], device: torch.device, seat2_weight: float,
           policy_loss_weight: float = 1.0, value_loss_weight: float = 1.0):
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
    return policy_loss * policy_loss_weight + value_loss * value_loss_weight, policy_loss, value_loss


def evaluate(model, samples: list[dict], device: torch.device, seat2_weight: float, batch_size: int,
             policy_loss_weight: float = 1.0, value_loss_weight: float = 1.0):
    model.eval()
    sums = [0.0, 0.0, 0.0]
    count = 0
    with torch.no_grad():
        for start in range(0, len(samples), batch_size):
            batch = samples[start:start + batch_size]
            measured = losses(model, batch, device, seat2_weight, policy_loss_weight, value_loss_weight)
            for index, value in enumerate(measured):
                sums[index] += float(value.cpu()) * len(batch)
            count += len(batch)
    return [value / max(1, count) for value in sums]


def atomic_json(path: Path, data):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def model_diagnostics(model, samples: list[dict], device: torch.device):
    """Record numerical health and prove relative policy reacts to board context."""
    probe = samples[:min(64, len(samples))]
    activations: dict[str, dict[str, float]] = {}
    handles = []

    def capture(name):
        def hook(_module, _inputs, output):
            tensor = output[0] if isinstance(output, tuple) else output
            if isinstance(tensor, torch.Tensor):
                detached = tensor.detach().float()
                activations[name] = {
                    "maximumAbsolute": float(detached.abs().max().cpu()),
                    "rootMeanSquare": float(detached.square().mean().sqrt().cpu()),
                }
        return hook

    for name, module in (("stem", model.stem), ("lastBlock", model.blocks[-1]),
                         ("boardEncoder", model.board_encoder), ("policyHead", model.policy_head)):
        handles.append(module.register_forward_hook(capture(name)))
    model.eval()
    with torch.no_grad():
        logits, values = model(*position_batch(probe, device))
    for handle in handles:
        handle.remove()
    valid_logits = torch.cat([logits[index, :len(sample["candidates"])]
                              for index, sample in enumerate(probe)]).detach().float()

    board_context_delta = 0.0
    full_context_delta = 0.0
    anchor = next((sample for sample in probe if len(sample["candidates"]) >= 2), None)
    alternative = next((sample for sample in probe
                        if sample is not anchor and sample.get("gameId") != anchor.get("gameId")), None) \
        if anchor is not None else None
    if alternative is None:
        alternative = next((sample for sample in probe if sample is not anchor), None)
    if anchor is not None and alternative is not None:
        board_swapped = dict(anchor)
        board_swapped["observation"] = alternative["observation"]
        full_swapped = dict(board_swapped)
        full_swapped["global"] = alternative["global"]
        with torch.no_grad():
            triplet_logits, _ = model(*position_batch([anchor, board_swapped, full_swapped], device))
            triplet_probabilities = torch.softmax(
                triplet_logits[:, :len(anchor["candidates"])], dim=-1
            )
        board_context_delta = float(
            (triplet_probabilities[0] - triplet_probabilities[1]).abs().max().cpu()
        )
        full_context_delta = float(
            (triplet_probabilities[0] - triplet_probabilities[2]).abs().max().cpu()
        )

    model.zero_grad(set_to_none=True)
    gradient_probe = probe[:min(8, len(probe))]
    _, gradient_values = model(*position_batch(gradient_probe, device))
    wrong_targets = torch.where(gradient_values.detach() >= 0, -torch.ones_like(gradient_values),
                                torch.ones_like(gradient_values))
    (gradient_values - wrong_targets).square().mean().backward()
    value_gradient_norm = float(torch.sqrt(sum(
        parameter.grad.detach().float().square().sum()
        for parameter in model.value_head.parameters() if parameter.grad is not None
    )).cpu())
    model.zero_grad(set_to_none=True)
    return {
        "finite": bool(torch.isfinite(valid_logits).all() and torch.isfinite(values).all()),
        "logits": {"minimum": float(valid_logits.min().cpu()), "maximum": float(valid_logits.max().cpu()),
                   "standardDeviation": float(valid_logits.std(unbiased=False).cpu())},
        "values": {"minimum": float(values.min().cpu()), "maximum": float(values.max().cpu()),
                   "fractionAtTanhLimit": float((values.abs() >= 0.999).float().mean().cpu())},
        # The primary check keeps global/phase features fixed, so it cannot pass
        # merely because the side-to-move or phase changed.
        "maximumPolicyProbabilityDeltaAfterBoardOnlySwap": board_context_delta,
        "maximumPolicyProbabilityDeltaAfterFullContextSwap": full_context_delta,
        "wrongTargetValueGradientNorm": value_gradient_norm,
        "activations": activations,
    }


def save_checkpoint(path: Path, model, metadata, args, training, optimizer=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    payload = {
        "schemaVersion": CHECKPOINT_SCHEMA_VERSION,
        "architecture": ARCHITECTURE_ID,
        "width": args.width,
        "blocks": args.blocks,
        "metadata": metadata,
        "model": {key: tensor.detach().cpu() for key, tensor in model.state_dict().items()},
        "training": training,
    }
    if optimizer is not None:
        payload["optimizer"] = optimizer.state_dict()
    torch.save(payload, temporary)
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
    parser.add_argument("--policy-loss-weight", type=float, default=1.0,
                        help="scale policy imitation relative to terminal value learning")
    parser.add_argument("--value-loss-weight", type=float, default=1.0,
                        help="scale the value gradient while continuing to report the value loss")
    parser.add_argument("--eval-interval", type=int, default=25)
    parser.add_argument("--checkpoint-interval", type=int, default=100)
    args = parser.parse_args()
    if min(args.steps, args.batch_size, args.max_samples, args.width, args.blocks) < 1 or args.lr <= 0:
        parser.error("steps, batch-size, max-samples, width, blocks and lr must be positive")
    if (args.seat2_weight <= 0 or not math.isfinite(args.policy_loss_weight) or args.policy_loss_weight < 0
            or args.eval_interval < 1 or args.checkpoint_interval < 1):
        parser.error("seat2-weight, eval-interval and checkpoint-interval must be positive; policy-loss-weight must be non-negative")
    if not math.isfinite(args.value_loss_weight) or args.value_loss_weight < 0:
        parser.error("value-loss-weight must be finite and non-negative")
    if args.policy_loss_weight == 0 and args.value_loss_weight == 0:
        parser.error("at least one loss weight must be positive")

    torch.set_num_threads(2)
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = select_device(args.device)
    metadata_path = Path(args.metadata)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    samples, source_stats = read_bounded_samples(
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
    output = Path(args.output)
    latest_output = output.with_name(output.stem + ".latest" + output.suffix)
    progress_output = output.with_suffix(".progress.json")
    started_utc = utc_now()
    initial_health = model_diagnostics(model, validation, device)
    if (not initial_health["finite"] or initial_health["maximumPolicyProbabilityDeltaAfterBoardOnlySwap"] <= 1e-8
            or initial_health["wrongTargetValueGradientNorm"] <= 0):
        raise RuntimeError(f"hex model failed initial health check: {initial_health}")
    initial = evaluate(model, validation, device, args.seat2_weight, args.batch_size,
                       args.policy_loss_weight, args.value_loss_weight)
    best_loss = initial[0]
    best_step = 0
    best_state = {key: tensor.detach().cpu().clone() for key, tensor in model.state_dict().items()}
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    started = time.perf_counter()
    progress = {
        "stage": "bounded-xpu-hot-start" if not args.resume else "hex-selfplay-update",
        "status": "training", "pid": os.getpid(), "startedUtc": started_utc, "updatedUtc": utc_now(),
        "device": str(device), "output": str(output.resolve()), "latestCheckpoint": str(latest_output.resolve()),
        "fingerprint": metadata["fingerprint"], "step": 0, "stepsRequested": args.steps,
        "source": source_stats, "samplesUsed": len(samples), "trainingSamples": len(training),
        "validationSamples": len(validation), "validationGames": validation_games,
        "weights": {"seat2": args.seat2_weight, "gameLengthAndWinner": True,
                    "policyLoss": args.policy_loss_weight, "terminalValue": args.value_loss_weight},
        "initialLoss": initial, "initialHealth": initial_health,
    }
    atomic_json(progress_output, progress)

    for step in range(1, args.steps + 1):
        model.train()
        batch = random.choices(training, k=min(args.batch_size, len(training)))
        optimizer.zero_grad(set_to_none=True)
        loss, _, _ = losses(model, batch, device, args.seat2_weight, args.policy_loss_weight, args.value_loss_weight)
        if not torch.isfinite(loss):
            raise RuntimeError("non-finite training loss")
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        if step % args.eval_interval == 0 or step == args.steps:
            measured = evaluate(model, validation, device, args.seat2_weight, args.batch_size,
                                args.policy_loss_weight, args.value_loss_weight)
            if measured[0] < best_loss - 1e-4:
                best_loss = measured[0]
                best_step = step
                best_state = {key: tensor.detach().cpu().clone() for key, tensor in model.state_dict().items()}
            print(json.dumps({"step": step, "validationTotal": measured[0],
                              "validationPolicy": measured[1], "validationValue": measured[2],
                              "bestStep": best_step}), flush=True)
            progress.update({"step": step, "updatedUtc": utc_now(), "validationLoss": measured,
                             "bestStep": best_step, "bestValidationLoss": best_loss})
            atomic_json(progress_output, progress)
        if step % args.checkpoint_interval == 0 or step == args.steps:
            save_checkpoint(latest_output, model, metadata, args, {
                "kind": "latest-resumable", "steps": step, "seed": args.seed,
                "learningRate": args.lr, "sourceSamples": source_stats["sourceSamples"],
                "eligibleSamples": source_stats["eligibleSamples"], "sampleLimit": args.max_samples,
                "policyLossWeight": args.policy_loss_weight,
                "valueLossWeight": args.value_loss_weight,
                "resumedFrom": str(Path(args.resume).resolve()) if args.resume else None,
            }, optimizer)

    model.load_state_dict(best_state)
    save_checkpoint(output, model, metadata, args, {
        "kind": "validation-selected-candidate", "steps": args.steps, "bestStep": best_step,
        "seed": args.seed, "learningRate": args.lr, "sourceSamples": source_stats["sourceSamples"],
        "eligibleSamples": source_stats["eligibleSamples"], "sampleLimit": args.max_samples,
        "policyLossWeight": args.policy_loss_weight,
        "valueLossWeight": args.value_loss_weight,
        "resumedFrom": str(Path(args.resume).resolve()) if args.resume else None,
    })
    final = evaluate(model, validation, device, args.seat2_weight, args.batch_size,
                     args.policy_loss_weight, args.value_loss_weight)
    final_health = model_diagnostics(model, validation, device)
    source_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    metrics = {
        "architecture": ARCHITECTURE_ID,
        "trainerSha256": source_hash,
        "device": str(device),
        "torch": torch.__version__,
        "parameters": sum(parameter.numel() for parameter in model.parameters()),
        "samplesRead": source_stats["sourceSamples"],
        "eligibleSamplesRead": source_stats["eligibleSamples"],
        "eligibleGamesRead": source_stats["eligibleGames"],
        "skippedIncompleteGames": source_stats["skippedIncompleteGames"],
        "samplesUsed": len(samples),
        "trainingSamples": len(training),
        "validationSamples": len(validation),
        "validationGames": validation_games,
        "validationMode": "held-out-games" if validation_games else "in-sample-no-holdout",
        "stepsRequested": args.steps,
        "policyLossWeight": args.policy_loss_weight,
        "valueLossWeight": args.value_loss_weight,
        "sampleWeighting": {"seatBalance": "within each training batch", "seat2": args.seat2_weight,
                            "gameLengthAndWinner": "train.game_sample_weight", "terminalValue": args.value_loss_weight},
        "bestStep": best_step,
        "initialProbeLoss": initial,
        "finalProbeLoss": final,
        "elapsedSeconds": time.perf_counter() - started,
        "checkpoint": str(output),
        "fingerprint": metadata["fingerprint"],
        "initialHealth": initial_health,
        "finalHealth": final_health,
    }
    atomic_json(output.with_suffix(".metrics.json"), metrics)
    progress.update({"status": "complete", "step": args.steps, "updatedUtc": utc_now(),
                     "bestStep": best_step, "checkpoint": str(output.resolve()),
                     "metrics": str(output.with_suffix('.metrics.json').resolve()),
                     "finalLoss": final, "finalHealth": final_health})
    atomic_json(progress_output, progress)
    print(json.dumps(metrics, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
