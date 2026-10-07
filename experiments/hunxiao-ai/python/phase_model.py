"""Shared board/value network with separate policy heads for each decision phase."""
from __future__ import annotations

from pathlib import Path

import torch
from torch import nn

from model import CANDIDATE_SIZE, GLOBAL_SIZE, OBSERVATION_SIZE, position_batch, select_device


MODEL_FAMILY = "phase-head-v1"
SCHEMA_VERSION = 1


def policy_head(width: int) -> nn.Sequential:
    return nn.Sequential(
        nn.Linear(width + CANDIDATE_SIZE, 128), nn.ReLU(), nn.Linear(128, 1),
    )


class PhasePolicyValueNet(nn.Module):
    """Both phases share position understanding and value, but learn separate policies."""

    def __init__(self, width: int = 256):
        super().__init__()
        self.width = width
        self.encoder = nn.Sequential(
            nn.Linear(OBSERVATION_SIZE + GLOBAL_SIZE, width), nn.ReLU(),
            nn.Linear(width, width), nn.ReLU(),
        )
        self.action_policy_head = policy_head(width)
        self.reinforcement_policy_head = policy_head(width)
        self.value_head = nn.Sequential(nn.Linear(width, 64), nn.ReLU(), nn.Linear(64, 1), nn.Tanh())

    def forward(self, observation, global_features, candidates, valid_mask):
        hidden = self.encoder(torch.cat((observation, global_features), dim=-1))
        expanded = hidden.unsqueeze(1).expand(-1, candidates.shape[1], -1)
        candidate_inputs = torch.cat((expanded, candidates), dim=-1)
        action_logits = self.action_policy_head(candidate_inputs).squeeze(-1)
        reinforcement_logits = self.reinforcement_policy_head(candidate_inputs).squeeze(-1)
        # Global channels are [action phase, reinforcement phase, ...].
        reinforcement_phase = global_features[:, 1].gt(0.5).unsqueeze(1)
        logits = torch.where(reinforcement_phase, reinforcement_logits, action_logits)
        logits = logits.masked_fill(~valid_mask, -1e9)
        return logits, self.value_head(hidden).squeeze(-1)


def initialize_from_mlp(path: str, device):
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if checkpoint.get("schemaVersion") != 1:
        raise ValueError("warm-start checkpoint schema mismatch")
    metadata = checkpoint.get("metadata", {})
    model = PhasePolicyValueNet(int(checkpoint["width"]))
    from model import PolicyValueNet

    source = PolicyValueNet(int(checkpoint["width"]))
    source.load_state_dict(checkpoint["model"])
    model.encoder.load_state_dict(source.encoder.state_dict())
    # Historical MLP checkpoints can contain a tanh value head saturated at +1
    # for every position. Reusing it would yield zero value gradients forever.
    # Start a fresh shared value head and let true terminal labels calibrate it.
    model.action_policy_head.load_state_dict(source.policy_head.state_dict())
    model.reinforcement_policy_head.load_state_dict(source.policy_head.state_dict())
    return model.to(device), metadata


def load_phase_checkpoint(path: str, device, expected_fingerprint: str | None = None):
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if checkpoint.get("schemaVersion") != SCHEMA_VERSION or checkpoint.get("modelFamily") != MODEL_FAMILY:
        raise ValueError("phase-head checkpoint schema/family mismatch")
    metadata = checkpoint["metadata"]
    if expected_fingerprint and metadata["fingerprint"] != expected_fingerprint:
        raise ValueError("checkpoint rules/map fingerprint mismatch")
    model = PhasePolicyValueNet(checkpoint["width"])
    model.load_state_dict(checkpoint["model"])
    return model.to(device), metadata


__all__ = ["MODEL_FAMILY", "SCHEMA_VERSION", "PhasePolicyValueNet", "initialize_from_mlp",
           "load_phase_checkpoint", "position_batch", "select_device"]
