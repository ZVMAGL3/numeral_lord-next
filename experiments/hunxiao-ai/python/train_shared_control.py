"""Matched control: shared policy head and a freshly calibrated value head."""
from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path

import torch

from model import PolicyValueNet, atomic_json, select_device
from phase_model import MODEL_FAMILY, PhasePolicyValueNet
from train import read_samples
from train_phase import evaluate, weighted_losses
from train_v2 import stratified_probe


def initialize_control(path: str, device):
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if checkpoint.get("schemaVersion") != 1:
        raise ValueError("warm-start checkpoint schema mismatch")
    # Recreate the phase model's fresh value initialization exactly so the only
    # architectural difference in the matched comparison is policy-head sharing.
    phase_template = PhasePolicyValueNet(checkpoint["width"])
    source = PolicyValueNet(checkpoint["width"])
    source.load_state_dict(checkpoint["model"])
    control = PolicyValueNet(checkpoint["width"])
    control.encoder.load_state_dict(source.encoder.state_dict())
    control.policy_head.load_state_dict(source.policy_head.state_dict())
    control.value_head.load_state_dict(phase_template.value_head.state_dict())
    return control.to(device), checkpoint.get("metadata", {})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--resume", required=True)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "xpu"])
    parser.add_argument("--steps", type=int, default=1200)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=0.0001)
    parser.add_argument("--seed", type=int, default=20261019)
    parser.add_argument("--eval-interval", type=int, default=100)
    parser.add_argument("--patience", type=int, default=8)
    parser.add_argument("--seat2-weight", type=float, default=1.10)
    args = parser.parse_args()
    if min(args.steps, args.batch_size, args.eval_interval, args.patience) < 1 or args.lr <= 0:
        parser.error("steps, batch-size, eval-interval, patience and learning rate must be positive")

    torch.set_num_threads(4)
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = select_device(args.device)
    metadata = json.loads(Path(args.metadata).read_text(encoding="utf-8"))
    samples = read_samples(Path(args.data), metadata["fingerprint"])
    model, source_metadata = initialize_control(args.resume, device)
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
    initial = evaluate(model, probe, device, 0.2, args.seat2_weight)
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
        loss, policy_loss, value_loss = weighted_losses(model, batch, device, 0.2, args.seat2_weight)
        if not torch.isfinite(loss):
            raise RuntimeError("non-finite loss")
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        completed_steps = step
        if step % args.eval_interval == 0 or step == args.steps:
            measured = evaluate(model, probe, device, 0.2, args.seat2_weight)
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
    final = evaluate(model, probe, device, 0.2, args.seat2_weight)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    torch.save({"schemaVersion": 1, "modelFamily": "mlp", "width": model.width, "metadata": metadata,
                "model": {key: tensor.detach().cpu() for key, tensor in model.state_dict().items()},
                "training": {"matchedControlFor": MODEL_FAMILY, "stepsRequested": args.steps,
                             "stepsCompleted": completed_steps, "bestStep": best_step,
                             "seed": args.seed, "resume": args.resume}}, temporary)
    temporary.replace(output)
    report = {"modelFamily": "mlp-shared-policy-reset-value-control", "samples": len(samples),
              "trainingSamples": len(training), "validationSamples": len(validation),
              "validationProbeSamples": len(probe), "stepsRequested": args.steps,
              "stepsCompleted": completed_steps, "bestStep": best_step, "batchSize": args.batch_size,
              "learningRate": args.lr, "seat2SampleWeight": args.seat2_weight,
              "phasePolicyLoss": "equal mean of present phase losses", "elapsedSeconds": elapsed,
              "initialProbeLoss": initial, "finalProbeLoss": final, "validationHistory": history,
              "validationGames": sorted(validation_ids), "probeIsHeldOut": bool(validation),
              "checkpoint": str(output), "fingerprint": metadata["fingerprint"]}
    atomic_json(output.with_suffix(".metrics.json"), report)
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
