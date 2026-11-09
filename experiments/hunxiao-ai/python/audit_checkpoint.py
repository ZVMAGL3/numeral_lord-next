"""Read-only CPU diagnostics for the baseline MLP policy/value checkpoint.

Context swaps deliberately hold candidate features fixed while substituting
other observed boards. Those combinations need not be legal positions: they
are sensitivity probes, never gameplay evaluations or training examples.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import time
from collections import Counter
from pathlib import Path

import torch
from torch import nn

from model import (CANDIDATE_SIZE, GLOBAL_SIZE, OBSERVATION_SIZE,
                   PolicyValueNet, SCHEMA_VERSION)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def phase_of(sample: dict) -> str:
    action = sample["global"][0] > 0.5
    reinforcement = sample["global"][1] > 0.5
    return "action" if action and not reinforcement else "reinforcement" if reinforcement and not action else "other"


def load_prefix(path: Path, prefix_lines: int, stride: int, maximum: int):
    selected, line_numbers = [], []
    prefix_games, fingerprints = set(), set()
    phase_counts: Counter = Counter()
    digest = hashlib.sha256()
    scanned_lines = scanned_bytes = 0
    with path.open("rb") as stream:
        for index, raw in enumerate(stream):
            if index >= prefix_lines:
                break
            digest.update(raw)
            scanned_lines += 1
            scanned_bytes += len(raw)
            sample = json.loads(raw)
            if sample.get("schemaVersion") != SCHEMA_VERSION:
                raise ValueError(f"sample schema mismatch at line {index + 1}")
            prefix_games.add(str(sample["gameId"]))
            fingerprints.add(sample["fingerprint"])
            phase_counts[phase_of(sample)] += 1
            if index % stride == 0 and len(selected) < maximum:
                selected.append(sample)
                line_numbers.append(index + 1)
    if not selected:
        raise ValueError("data prefix contains no selected samples")
    if len(fingerprints) != 1:
        raise ValueError("data prefix contains more than one rules/map fingerprint")
    details = {
        "path": str(path.resolve()), "fileBytes": path.stat().st_size,
        "prefixLinesRequested": prefix_lines, "prefixLinesRead": scanned_lines,
        "prefixBytesRead": scanned_bytes, "prefixSha256": digest.hexdigest(),
        "hashScope": "Exact raw bytes of the scanned prefix, including line endings; not the entire dataset.",
        "stride": stride, "maximumSelectedPositions": maximum,
        "selectedPositions": len(selected), "selectedOneBasedLineNumbers": line_numbers,
        "prefixUniqueGames": len(prefix_games),
        "selectedUniqueGames": len({str(sample["gameId"]) for sample in selected}),
        "prefixPositionsByPhase": dict(phase_counts),
        "selectedPositionsByPhase": dict(Counter(phase_of(sample) for sample in selected)),
        "fingerprint": next(iter(fingerprints)),
    }
    return selected, line_numbers, details


def context_tensors(rows: list[dict], dtype):
    observation = torch.tensor([row["observation"] for row in rows], dtype=dtype, device="cpu")
    global_features = torch.tensor([row["global"] for row in rows], dtype=dtype, device="cpu")
    if observation.shape != (len(rows), OBSERVATION_SIZE) or global_features.shape != (len(rows), GLOBAL_SIZE):
        raise ValueError("observation/global feature dimensions do not match the baseline MLP")
    if not torch.isfinite(observation).all() or not torch.isfinite(global_features).all():
        raise ValueError("non-finite observation/global feature")
    return observation, global_features


def candidate_tensor(row: dict, dtype):
    candidates = torch.tensor(row["candidates"], dtype=dtype, device="cpu")
    if candidates.ndim != 2 or candidates.shape[0] < 1 or candidates.shape[1] != CANDIDATE_SIZE:
        raise ValueError("invalid legal candidate dimensions")
    if not torch.isfinite(candidates).all():
        raise ValueError("non-finite candidate feature")
    return candidates


def tensor_range(tensor):
    return {"minimum": float(tensor.min()), "maximum": float(tensor.max()),
            "absoluteMaximum": float(tensor.abs().max()), "mean": float(tensor.mean())}


def gate_summary(records: list[dict]):
    if not records:
        return {"positions": 0}
    patterns = set().union(*(record["patterns"] for record in records))
    return {
        "positions": len(records),
        "meanCandidateSensitiveGatesOf128": statistics.mean(record["varying"] for record in records),
        "allCandidatesShareSameGateMaskFraction": sum(record["varying"] == 0 for record in records) / len(records),
        "uniqueGatePatternsAcrossAllCandidatesAndPositions": len(patterns),
        "activeGatesMinimum": min(record["activeMin"] for record in records),
        "activeGatesMaximum": max(record["activeMax"] for record in records),
    }


def observed_position_stats(model, rows: list[dict], threshold: float = 0.999):
    observation, global_features = context_tensors(rows, torch.float32)
    hidden = model.encoder(torch.cat((observation, global_features), dim=-1))
    pre_tanh = model.value_head[:-1](hidden).squeeze(-1)
    values = model.value_head(hidden).squeeze(-1)
    first_layer = model.policy_head[0]
    if not isinstance(first_layer, nn.Linear) or first_layer.out_features != 128:
        raise ValueError("policy gate diagnostic expects the baseline 128-neuron first policy layer")
    board_terms = nn.functional.linear(hidden, first_layer.weight[:, :model.width], first_layer.bias)
    logits_min, logits_max = math.inf, -math.inf
    candidate_abs_max = 0.0
    magnitude_ratios, gate_records = [], []
    candidate_counts = []
    for index, row in enumerate(rows):
        candidates = candidate_tensor(row, torch.float32)
        count = candidates.shape[0]
        candidate_counts.append(count)
        candidate_abs_max = max(candidate_abs_max, float(candidates.abs().max()))
        inputs = torch.cat((hidden[index].expand(count, -1), candidates), dim=-1)
        first_activation = first_layer(inputs)
        gates = first_activation.gt(0)
        logits = model.policy_head(inputs).squeeze(-1)
        logits_min = min(logits_min, float(logits.min()))
        logits_max = max(logits_max, float(logits.max()))
        candidate_terms = nn.functional.linear(candidates, first_layer.weight[:, model.width:])
        magnitude_ratios.append(float(board_terms[index].abs().mean()
                                      / candidate_terms.abs().mean().clamp_min(1e-12)))
        gate_records.append({
            "phase": phase_of(row), "varying": int((gates.any(0) != gates.all(0)).sum()),
            "activeMin": int(gates.sum(-1).min()), "activeMax": int(gates.sum(-1).max()),
            "patterns": {bytes(int(value) for value in pattern) for pattern in gates.tolist()},
        })
    return {
        "dtype": "float32", "positions": len(rows),
        "inputAbsoluteMaxima": {"observation": float(observation.abs().max()),
                                "global": float(global_features.abs().max()), "candidate": candidate_abs_max},
        "encoderActivation": tensor_range(hidden), "preTanhValue": tensor_range(pre_tanh),
        "value": {**tensor_range(values), "saturationThreshold": threshold,
                  "fractionAbsAtLeastThreshold": float((values.abs() >= threshold).float().mean()),
                  "fractionExactlyPlusOne": float((values == 1).float().mean()),
                  "fractionExactlyMinusOne": float((values == -1).float().mean()),
                  "meanTanhDerivativeOneMinusValueSquared": float((1 - values.square()).mean())},
        "policyLogits": {"minimum": logits_min, "maximum": logits_max,
                         "absoluteMaximum": max(abs(logits_min), abs(logits_max))},
        "policyBoardToCandidateFirstLinearMeanMagnitudeRatio": statistics.mean(magnitude_ratios),
        "candidateCounts": {"minimum": min(candidate_counts), "maximum": max(candidate_counts)},
        "policyGates": {phase: gate_summary(gate_records if phase == "all" else
                                             [record for record in gate_records if record["phase"] == phase])
                        for phase in ("all", "action", "reinforcement", "other")},
    }


def context_swap_stats(model, rows, line_numbers, dtype, candidate_sets, maximum_contexts):
    model.to(dtype=dtype)
    observation, global_features = context_tensors(rows, dtype)
    hidden = model.encoder(torch.cat((observation, global_features), dim=-1))
    result = {}
    for phase in ("action", "reinforcement"):
        indices = [index for index, row in enumerate(rows)
                   if phase_of(row) == phase and len(row["candidates"]) > 1][:maximum_contexts]
        if not indices:
            result[phase] = {"contexts": 0, "skipped": "no same-phase observations with multiple candidates"}
            continue
        tests = []
        for base in indices[:candidate_sets]:
            candidates = candidate_tensor(rows[base], dtype)
            count = candidates.shape[0]
            reference = probability_min = probability_max = None
            maximum_delta, maximum_abs_logit = 0.0, 0.0
            patterns = set()
            # Bound temporary tensors even when a position has many candidates.
            for offset in range(0, len(indices), 16):
                chunk = indices[offset:offset + 16]
                board = hidden[chunk].unsqueeze(1).expand(-1, count, -1)
                repeated_candidates = candidates.unsqueeze(0).expand(len(chunk), -1, -1)
                inputs = torch.cat((board, repeated_candidates), dim=-1)
                logits = model.policy_head(inputs).squeeze(-1)
                probabilities = logits.softmax(-1)
                if reference is None:
                    reference = probabilities[0].clone()
                    probability_min, probability_max = probabilities.amin(0), probabilities.amax(0)
                else:
                    probability_min = torch.minimum(probability_min, probabilities.amin(0))
                    probability_max = torch.maximum(probability_max, probabilities.amax(0))
                maximum_delta = max(maximum_delta, float((probabilities - reference).abs().max()))
                maximum_abs_logit = max(maximum_abs_logit, float(logits.abs().max()))
                gates = model.policy_head[0](inputs).gt(0).reshape(-1, 128)
                patterns.update(bytes(int(value) for value in mask) for mask in gates.tolist())
            tests.append({
                "candidateSourceOneBasedLine": line_numbers[base], "candidateCount": count,
                "maxAbsolutePriorDifferenceFromFirstContext": maximum_delta,
                "maxPairwisePriorDifferenceAcrossContexts": float((probability_max - probability_min).max()),
                "maximumAbsoluteLogit": maximum_abs_logit,
                "uniqueGatePatternsAcrossSwappedContextsAndCandidates": len(patterns),
            })
        result[phase] = {
            "contexts": len(indices), "uniqueContextGames": len({str(rows[index]["gameId"]) for index in indices}),
            "contextSourceOneBasedLines": [line_numbers[index] for index in indices],
            "fixedCandidateSets": len(tests),
            "maxAbsolutePriorDifferenceFromFirstContext": max(test["maxAbsolutePriorDifferenceFromFirstContext"] for test in tests),
            "maxPairwisePriorDifferenceAcrossContexts": max(test["maxPairwisePriorDifferenceAcrossContexts"] for test in tests),
            "maximumAbsoluteLogit": max(test["maximumAbsoluteLogit"] for test in tests), "tests": tests,
        }
    return result


def audit_checkpoint(path, rows, line_numbers, fingerprint, args):
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if (checkpoint.get("schemaVersion") != SCHEMA_VERSION
            or checkpoint.get("modelFamily", "mlp") != "mlp" or "architecture" in checkpoint):
        raise ValueError(f"{path}: this diagnostic currently supports only the baseline MLP checkpoint family")
    if checkpoint["metadata"]["fingerprint"] != fingerprint:
        raise ValueError(f"{path}: checkpoint and data rules/map fingerprints differ")
    model = PolicyValueNet(checkpoint["width"])
    model.load_state_dict(checkpoint["model"])
    model.cpu().float().eval()
    with torch.no_grad():
        observed = observed_position_stats(model, rows)
        swaps = {name: context_swap_stats(model, rows, line_numbers, dtype, args.candidate_sets,
                                          args.max_contexts_per_phase)
                 for name, dtype in (("float32", torch.float32), ("float64", torch.float64))}
    return {
        "path": str(path.resolve()), "fileBytes": path.stat().st_size, "sha256": sha256_file(path),
        "family": "mlp", "width": model.width,
        "parameters": sum(parameter.numel() for parameter in model.parameters()),
        "fingerprint": fingerprint, "observedPositions": observed, "contextSwapProbes": swaps,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True, nargs="+", type=Path)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--prefix-lines", type=int, default=4096)
    parser.add_argument("--stride", type=int, default=32)
    parser.add_argument("--max-positions", type=int, default=256)
    parser.add_argument("--candidate-sets", type=int, default=8)
    parser.add_argument("--max-contexts-per-phase", type=int, default=128)
    args = parser.parse_args()
    if not 1 <= args.prefix_lines <= 1000000 or args.stride < 1:
        parser.error("prefix-lines must be in [1, 1000000] and stride must be positive")
    if not 1 <= args.max_positions <= 2048 or not 1 <= args.candidate_sets <= 64 or not 1 <= args.max_contexts_per_phase <= 256:
        parser.error("max-positions must be in [1, 2048], candidate-sets in [1, 64], max-contexts-per-phase in [1, 256]")
    if args.output.exists():
        parser.error("output already exists; use a new path to preserve previous diagnostic reports")
    if args.output.resolve() in {args.data.resolve(), Path(__file__).resolve(), *(path.resolve() for path in args.checkpoint)}:
        parser.error("output must not replace an input checkpoint, dataset or script")
    torch.set_num_threads(2)
    started = time.perf_counter()
    rows, line_numbers, source = load_prefix(args.data, args.prefix_lines, args.stride, args.max_positions)
    reports = [audit_checkpoint(path, rows, line_numbers, source["fingerprint"], args) for path in args.checkpoint]
    report = {
        "schemaVersion": 1, "diagnostic": "baseline-mlp-checkpoint-health-v1",
        "method": {
            "device": "cpu", "trainingPerformed": False, "xpuInitializedByScript": False,
            "torch": torch.__version__, "scriptSha256": sha256_file(Path(__file__)),
            "selection": "Read at most prefix-lines JSONL lines; select zero-based indices divisible by stride, capped by max-positions.",
            "contextSwap": "Hold one selected position's complete candidate feature list fixed; substitute other selected observation/global contexts within the same phase. Compare priors to the first context and report the maximum pairwise probability range.",
            "counterfactualWarning": "Swapped inputs may not be legal game states. They measure sensitivity only and must not become training examples or gameplay-strength evidence. Candidate features still contain local dynamic board information.",
            "precisionComparison": "float32 matches baseline model precision; float64 casts the same checkpoint weights to help distinguish meaningful context dependence from cancellation around large common logits.",
            "gateInterpretation": "For a Linear([board,candidate])->ReLU->Linear head, a common fixed ReLU mask makes the board contribution an action-independent logit offset, which softmax cancels. Conclusions apply only to the bounded samples tested.",
            "candidateSetsPerPhaseRequested": args.candidate_sets,
            "maximumContextsPerPhase": args.max_contexts_per_phase,
        },
        "source": source, "checkpoints": reports, "elapsedSeconds": time.perf_counter() - started,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"report": str(args.output.resolve()), "checkpoints": len(reports),
                      "selectedPositions": len(rows), "selectedGames": source["selectedUniqueGames"],
                      "device": "cpu", "trainingPerformed": False, "elapsedSeconds": report["elapsedSeconds"]}))


if __name__ == "__main__":
    main()
