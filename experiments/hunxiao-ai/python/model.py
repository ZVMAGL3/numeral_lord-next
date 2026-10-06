"""Small fixed-map policy/value network; all tensor dimensions are versioned."""
from __future__ import annotations

import json
from pathlib import Path
import torch
from torch import nn

SCHEMA_VERSION = 1
OBSERVATION_SIZE = 9 * 9 * 20
GLOBAL_SIZE = 12
CANDIDATE_SIZE = 16


class PolicyValueNet(nn.Module):
    def __init__(self, width: int = 256):
        super().__init__()
        self.width = width
        self.encoder = nn.Sequential(
            nn.Linear(OBSERVATION_SIZE + GLOBAL_SIZE, width), nn.ReLU(),
            nn.Linear(width, width), nn.ReLU(),
        )
        self.policy_head = nn.Sequential(
            nn.Linear(width + CANDIDATE_SIZE, 128), nn.ReLU(), nn.Linear(128, 1),
        )
        self.value_head = nn.Sequential(nn.Linear(width, 64), nn.ReLU(), nn.Linear(64, 1), nn.Tanh())

    def forward(self, observation, global_features, candidates, valid_mask):
        hidden = self.encoder(torch.cat((observation, global_features), dim=-1))
        expanded = hidden.unsqueeze(1).expand(-1, candidates.shape[1], -1)
        logits = self.policy_head(torch.cat((expanded, candidates), dim=-1)).squeeze(-1)
        logits = logits.masked_fill(~valid_mask, -1e9)
        return logits, self.value_head(hidden).squeeze(-1)


def select_device(requested: str) -> torch.device:
    if requested not in {"auto", "cpu", "xpu"}:
        raise ValueError("device must be auto, cpu or xpu")
    available = hasattr(torch, "xpu") and torch.xpu.is_available()
    if requested == "xpu" and not available:
        raise RuntimeError("XPU unavailable: check Intel GPU driver and official XPU PyTorch wheels")
    return torch.device("xpu" if available and requested != "cpu" else "cpu")


def position_batch(positions: list[dict], device):
    if not positions:
        raise ValueError("empty position batch")
    largest = max(len(p["candidates"]) for p in positions)
    if largest == 0:
        raise ValueError("terminal positions must be evaluated by the game engine")
    observation = torch.tensor([p["observation"] for p in positions], dtype=torch.float32)
    global_features = torch.tensor([p["global"] for p in positions], dtype=torch.float32)
    if observation.shape != (len(positions), OBSERVATION_SIZE) or global_features.shape != (len(positions), GLOBAL_SIZE):
        raise ValueError("observation schema mismatch")
    candidates = torch.zeros((len(positions), largest, CANDIDATE_SIZE), dtype=torch.float32)
    valid = torch.zeros((len(positions), largest), dtype=torch.bool)
    for i, p in enumerate(positions):
        count = len(p["candidates"])
        if count == 0:
            raise ValueError("one position has no legal candidates")
        candidate_tensor = torch.tensor(p["candidates"], dtype=torch.float32)
        if candidate_tensor.shape != (count, CANDIDATE_SIZE):
            raise ValueError("candidate schema mismatch")
        candidates[i, :count] = candidate_tensor
        valid[i, :count] = True
    if not torch.isfinite(observation).all() or not torch.isfinite(global_features).all() or not torch.isfinite(candidates).all():
        raise ValueError("non-finite input feature")
    return tuple(t.to(device) for t in (observation, global_features, candidates, valid))


def load_checkpoint(path: str, device, expected_fingerprint: str | None = None):
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if checkpoint.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("checkpoint schema mismatch")
    metadata = checkpoint["metadata"]
    if expected_fingerprint and metadata["fingerprint"] != expected_fingerprint:
        raise ValueError("checkpoint rules/map fingerprint mismatch")
    model = PolicyValueNet(checkpoint["width"])
    model.load_state_dict(checkpoint["model"])
    return model.to(device), metadata


def atomic_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
