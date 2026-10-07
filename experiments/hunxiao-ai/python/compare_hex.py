"""Matched short training comparison of the legacy MLP and hex-graph student."""
from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path

import torch

from hex_model import ARCHITECTURE_ID, CHECKPOINT_SCHEMA_VERSION, HexPolicyValueNet, position_batch as hex_batch
from model import PolicyValueNet, position_batch as mlp_batch, select_device
from train_hex import read_bounded_samples, sample_weights, split_games


def losses(model, family: str, batch: list[dict], device: torch.device, seat2_weight: float):
    tensors = hex_batch(batch, device) if family == ARCHITECTURE_ID else mlp_batch(batch, device)
    logits, predicted_value = model(*tensors)
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


def evaluate(model, family: str, samples: list[dict], device: torch.device,
             seat2_weight: float, batch_size: int):
    model.eval()
    sums = [0.0, 0.0, 0.0]
    count = 0
    with torch.no_grad():
        for start in range(0, len(samples), batch_size):
            batch = samples[start:start + batch_size]
            measured = losses(model, family, batch, device, seat2_weight)
            for index, value in enumerate(measured):
                sums[index] += float(value.cpu()) * len(batch)
            count += len(batch)
    return [value / max(1, count) for value in sums]


def fit(model, family: str, batches: list[list[dict]], validation: list[dict], device: torch.device,
        args, output: Path, metadata: dict):
    initial = evaluate(model, family, validation, device, args.seat2_weight, args.batch_size)
    best_loss = initial[0]
    best_step = 0
    best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    started = time.perf_counter()
    for step, batch in enumerate(batches, 1):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        loss, _, _ = losses(model, family, batch, device, args.seat2_weight)
        if not torch.isfinite(loss):
            raise RuntimeError(f"{family} produced non-finite loss")
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
        optimizer.step()
        if step % 25 == 0 or step == len(batches):
            measured = evaluate(model, family, validation, device, args.seat2_weight, args.batch_size)
            if measured[0] < best_loss - 1e-4:
                best_loss = measured[0]
                best_step = step
                best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
    model.load_state_dict(best_state)
    output.parent.mkdir(parents=True, exist_ok=True)
    architecture = family
    width = model.width
    blocks = model.block_count if family == ARCHITECTURE_ID else None
    checkpoint = {"schemaVersion": CHECKPOINT_SCHEMA_VERSION if blocks is not None else 1,
                  "architecture": architecture, "width": width, "metadata": metadata,
                  "model": {key: value.detach().cpu() for key, value in model.state_dict().items()},
                  "training": {"steps": len(batches), "bestStep": best_step, "seed": args.seed,
                               "learningRate": args.lr, "validationProtocol": "same-game-split-all-held-out-samples"}}
    if blocks is not None:
        checkpoint["blocks"] = blocks
    torch.save(checkpoint, output)
    return {"architecture": family, "parameters": sum(parameter.numel() for parameter in model.parameters()),
            "initialLoss": initial, "finalLoss": evaluate(model, family, validation, device,
            args.seat2_weight, args.batch_size), "bestStep": best_step,
            "elapsedSeconds": time.perf_counter() - started, "checkpoint": str(output)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--device", default="cpu", choices=["auto", "cpu", "xpu"])
    parser.add_argument("--max-samples", type=int, default=4096)
    parser.add_argument("--steps", type=int, default=75)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--lr", type=float, default=0.0003)
    parser.add_argument("--seed", type=int, default=20261007)
    parser.add_argument("--seat2-weight", type=float, default=1.10)
    args = parser.parse_args()
    if min(args.max_samples, args.steps, args.batch_size) < 1 or args.lr <= 0:
        parser.error("max-samples, steps, batch-size and lr must be positive")
    torch.set_num_threads(2)
    metadata = json.loads(Path(args.metadata).read_text(encoding="utf-8"))
    samples, total_source_samples = read_bounded_samples(
        Path(args.data), metadata["fingerprint"], args.max_samples, args.seed
    )
    training, validation, validation_games = split_games(samples, args.seed)
    data_rng = random.Random(args.seed + 1)
    batches = [[training[index] for index in
                (data_rng.randrange(len(training)) for _ in range(min(args.batch_size, len(training))))]
               for _ in range(args.steps)]
    device = select_device(args.device)
    torch.manual_seed(args.seed)
    mlp = PolicyValueNet(width=96).to(device)
    torch.manual_seed(args.seed)
    hexnet = HexPolicyValueNet(width=48, blocks=3).to(device)
    output_dir = Path(args.output_dir)
    results = {
        "protocol": "same samples, game split, batches, loss weights, optimizer and update count",
        "samplesRead": total_source_samples,
        "samplesUsed": len(samples),
        "trainingSamples": len(training),
        "validationSamples": len(validation),
        "validationGames": validation_games,
        "device": str(device),
        "steps": args.steps,
        "batchSize": args.batch_size,
        "seed": args.seed,
        "models": [
            fit(mlp, "mlp", batches, validation, device, args,
                output_dir / "matched-mlp.pt", metadata),
            fit(hexnet, ARCHITECTURE_ID, batches, validation, device, args,
                output_dir / "matched-hex-graph.pt", metadata),
        ],
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "matched-comparison.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(results, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
