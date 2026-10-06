"""Reproducible, bounded eager-mode CPU/XPU training smoke check.

This uses synthetic inputs; timings do not measure game search or model strength.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import platform
import subprocess
import sys
import time
import traceback
from pathlib import Path

import numpy as np
import torch
from torch import nn


class SmokePolicyValue(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.board = nn.Sequential(
            nn.Conv2d(20, 32, 3, padding=1), nn.ReLU(),
            nn.Conv2d(32, 32, 3, padding=1), nn.ReLU(),
            nn.AdaptiveAvgPool2d(1), nn.Flatten(),
        )
        self.context = nn.Sequential(nn.Linear(44, 64), nn.ReLU())
        self.value = nn.Sequential(nn.Linear(64, 32), nn.ReLU(), nn.Linear(32, 1), nn.Tanh())
        self.policy = nn.Sequential(nn.Linear(80, 64), nn.ReLU(), nn.Linear(64, 1))

    def forward(self, board, globals_, candidates, mask):
        context = self.context(torch.cat((self.board(board), globals_), dim=1))
        expanded = context[:, None, :].expand(-1, candidates.shape[1], -1)
        logits = self.policy(torch.cat((expanded, candidates), dim=2)).squeeze(-1)
        return logits.masked_fill(~mask, -1e9), self.value(context).squeeze(-1)


def synchronize(device: str) -> None:
    if device == "xpu":
        torch.xpu.synchronize()


def make_inputs(batch: int = 64, actions: int = 37):
    generator = torch.Generator().manual_seed(1001)
    board = torch.rand(batch, 20, 9, 9, generator=generator)
    globals_ = torch.rand(batch, 12, generator=generator)
    candidates = torch.rand(batch, actions, 16, generator=generator)
    lengths = 1 + torch.arange(batch) % actions
    mask = torch.arange(actions)[None, :] < lengths[:, None]
    weights = torch.rand(batch, actions, generator=generator) * mask
    targets = weights / weights.sum(dim=1, keepdim=True)
    values = torch.rand(batch, generator=generator) * 2 - 1
    return board, globals_, candidates, mask, targets, values


def check_device(device: str, reference, cpu_inputs, cpu_outputs):
    model = copy.deepcopy(reference).to(device)
    inputs = tuple(x.to(device) for x in cpu_inputs)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.001, foreach=False)
    board, globals_, candidates, mask, targets, values = inputs

    def loss_step():
        optimizer.zero_grad(set_to_none=True)
        logits, predicted = model(board, globals_, candidates, mask)
        policy_loss = -(targets * logits.log_softmax(dim=1)).sum(dim=1).mean()
        value_loss = (predicted - values).square().mean()
        loss = policy_loss + value_loss
        loss.backward()
        optimizer.step()
        return loss

    with torch.no_grad():
        logits, predicted = model(board, globals_, candidates, mask)
        probabilities = logits.softmax(dim=1)
        valid = mask.cpu()
        policy_error = (logits.cpu()[valid] - cpu_outputs[0][valid]).abs().max().item()
        value_error = (predicted.cpu() - cpu_outputs[1]).abs().max().item()
        invalid_probability = probabilities[~mask].sum().item()
        normalization_error = (probabilities.sum(dim=1) - 1).abs().max().item()
        if invalid_probability != 0 or normalization_error > 1e-5:
            raise AssertionError("candidate mask/normalization failed")
        if policy_error > 1e-3 or value_error > 1e-3:
            raise AssertionError("CPU/device output agreement failed")
    initial = model.policy[-1].weight.detach().clone()
    first_loss = loss_step()
    synchronize(device)
    if not torch.isfinite(first_loss).item():
        raise AssertionError("non-finite loss")
    if not (initial != model.policy[-1].weight).any().item():
        raise AssertionError("optimizer did not update policy weights")
    for _ in range(5):
        loss_step()
    synchronize(device)
    started = time.perf_counter()
    for _ in range(20):
        final_loss = loss_step()
    synchronize(device)
    seconds = time.perf_counter() - started
    return {
        "passed": True, "device": device, "dtype": "float32", "mode": "eager",
        "batch": board.shape[0], "max_candidates": candidates.shape[1],
        "candidate_lengths": [1, candidates.shape[1]],
        "invalid_probability": invalid_probability,
        "probability_normalization_max_error": normalization_error,
        "cpu_policy_max_abs_error": policy_error, "cpu_value_max_abs_error": value_error,
        "first_loss": first_loss.item(), "final_loss": final_loss.item(),
        "optimizer_updated": True, "timed_steps": 20, "seconds": seconds,
        "synthetic_training_samples_per_second": 20 * board.shape[0] / seconds,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "runs/environment-check.json")
    args = parser.parse_args()
    torch.manual_seed(1001)
    torch.set_num_threads(4)
    report = {
        "timestamp_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "python": sys.version, "executable": sys.executable, "platform": platform.platform(),
        "torch": torch.__version__, "numpy": np.__version__, "cpu_threads": torch.get_num_threads(),
        "cuda_available": torch.cuda.is_available(), "xpu_available": torch.xpu.is_available(),
        "driver_requirement_source": "https://www.intel.com/content/www/us/en/developer/articles/tool/pytorch-prerequisites-for-intel-gpu/2-8.html",
        "driver_minimum_for_torch_2_8_windows": "32.0.101.6739",
        "windows_b_series_support_status_in_torch_2_8_docs": "experimental",
        "scope": "Synthetic standard Conv/Linear FP32 forward/loss/backward/AdamW; no torch.compile, game search, or AI strength validation.",
        "checks": [],
    }
    try:
        command = "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress"
        report["windows_video_controllers"] = json.loads(subprocess.check_output(["powershell", "-NoProfile", "-Command", command], text=True, encoding="utf-8"))
    except Exception as exc:
        report["driver_query_error"] = str(exc)
    if report["xpu_available"]:
        report["xpu_count"] = torch.xpu.device_count()
        report["xpu_devices"] = [torch.xpu.get_device_name(i) for i in range(torch.xpu.device_count())]
    reference = SmokePolicyValue()
    report["parameter_count"] = sum(parameter.numel() for parameter in reference.parameters())
    inputs = make_inputs()
    with torch.no_grad():
        cpu_outputs = reference(*inputs[:4])
    for device in ("cpu", "xpu"):
        if device == "xpu" and not report["xpu_available"]:
            report["checks"].append({"device": device, "passed": False, "skipped": "XPU unavailable"})
            continue
        try:
            result = check_device(device, reference, inputs, cpu_outputs)
        except Exception:
            result = {"device": device, "passed": False, "error": traceback.format_exc()}
        report["checks"].append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {args.output}", flush=True)
    if not report["checks"][0]["passed"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
