"""Hex-neighbour policy/value network for the fixed 9x9 Hunxiao map.

This is an isolated architecture experiment. It consumes the existing sample
schema, but its checkpoints are intentionally incompatible with model.py.
"""
from __future__ import annotations

import math
from pathlib import Path

import torch
from torch import nn


ARCHITECTURE_ID = "hex-graph-v1"
CHECKPOINT_SCHEMA_VERSION = 1
BOARD_COLUMNS = 9
BOARD_ROWS = 9
CELL_COUNT = BOARD_COLUMNS * BOARD_ROWS
OBSERVATION_CHANNELS = 20
OBSERVATION_SIZE = CELL_COUNT * OBSERVATION_CHANNELS
GLOBAL_SIZE = 12
CANDIDATE_SIZE = 16


def _build_neighbour_table() -> tuple[torch.Tensor, torch.Tensor]:
    """Return row-major six-neighbour indices for the engine's even-row shift."""
    # Direction order matches game-core/src/hex.ts:
    # northwest, northeast, east, southeast, southwest, west.
    even_offsets = ((0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 0))
    odd_offsets = ((-1, -1), (0, -1), (1, 0), (0, 1), (-1, 1), (-1, 0))
    rows: list[list[int]] = []
    masks: list[list[bool]] = []
    for row in range(BOARD_ROWS):
        offsets = even_offsets if row % 2 == 0 else odd_offsets
        for column in range(BOARD_COLUMNS):
            neighbours: list[int] = []
            valid: list[bool] = []
            for delta_column, delta_row in offsets:
                target_column = column + delta_column
                target_row = row + delta_row
                inside = (0 <= target_column < BOARD_COLUMNS and 0 <= target_row < BOARD_ROWS)
                neighbours.append(target_row * BOARD_COLUMNS + target_column if inside else 0)
                valid.append(inside)
            rows.append(neighbours)
            masks.append(valid)
    return torch.tensor(rows, dtype=torch.long), torch.tensor(masks, dtype=torch.bool)


HEX_NEIGHBOUR_INDEX, HEX_NEIGHBOUR_MASK = _build_neighbour_table()


class HexResidualBlock(nn.Module):
    """Direction-aware message passing followed by a per-cell residual MLP."""

    def __init__(self, width: int):
        super().__init__()
        self.norm_neighbours = nn.LayerNorm(width)
        self.self_projection = nn.Linear(width, width, bias=False)
        self.direction_weights = nn.Parameter(torch.empty(6, width, width))
        self.message_bias = nn.Parameter(torch.zeros(width))
        self.norm_mlp = nn.LayerNorm(width)
        self.mlp = nn.Sequential(
            nn.Linear(width, 2 * width), nn.GELU(), nn.Linear(2 * width, width)
        )
        nn.init.xavier_uniform_(self.direction_weights)

    def forward(self, cells: torch.Tensor) -> torch.Tensor:
        batch, count, width = cells.shape
        normalized = self.norm_neighbours(cells)
        indices = HEX_NEIGHBOUR_INDEX.to(cells.device)
        mask = HEX_NEIGHBOUR_MASK.to(cells.device)
        neighbours = normalized[:, indices, :]
        neighbours = neighbours * mask[None, :, :, None]
        messages = torch.einsum("bnki,kio->bno", neighbours, self.direction_weights)
        cells = cells + torch.nn.functional.gelu(
            self.self_projection(normalized) + messages / math.sqrt(6.0) + self.message_bias
        )
        cells = cells + self.mlp(self.norm_mlp(cells))
        return cells


def _gather_cell(cells: torch.Tensor, coordinates: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Gather per-cell embeddings using normalized [column,row] candidate fields."""
    columns = coordinates[..., 0]
    rows = coordinates[..., 1]
    valid = (columns >= 0) & (rows >= 0)
    column_index = torch.round(columns.clamp(0, 1) * (BOARD_COLUMNS - 1)).long()
    row_index = torch.round(rows.clamp(0, 1) * (BOARD_ROWS - 1)).long()
    flat_index = row_index * BOARD_COLUMNS + column_index
    gathered = cells.gather(1, flat_index.unsqueeze(-1).expand(-1, -1, cells.shape[-1]))
    return gathered * valid.unsqueeze(-1), valid


class HexPolicyValueNet(nn.Module):
    def __init__(self, width: int = 48, blocks: int = 3):
        super().__init__()
        if width < 8 or blocks < 1:
            raise ValueError("width must be >= 8 and blocks must be >= 1")
        self.width = width
        self.block_count = blocks
        self.stem = nn.Linear(OBSERVATION_CHANNELS, width)
        self.blocks = nn.ModuleList(HexResidualBlock(width) for _ in range(blocks))
        self.global_context = nn.ModuleList(
            nn.Sequential(
                nn.Linear(width * 2 + GLOBAL_SIZE, width), nn.GELU(), nn.Linear(width, width)
            ) for _ in range(blocks)
        )
        self.board_encoder = nn.Sequential(
            nn.Linear(width * 2 + GLOBAL_SIZE, width), nn.GELU(), nn.LayerNorm(width)
        )
        self.policy_head = nn.Sequential(
            nn.Linear(width * 4 + CANDIDATE_SIZE, 128), nn.GELU(),
            nn.Linear(128, 64), nn.GELU(), nn.Linear(64, 1)
        )
        self.value_head = nn.Sequential(
            nn.Linear(width, 64), nn.GELU(), nn.Linear(64, 1), nn.Tanh()
        )

    def forward(self, observation: torch.Tensor, global_features: torch.Tensor,
                candidates: torch.Tensor, valid_mask: torch.Tensor):
        batch = observation.shape[0]
        cells = observation.permute(0, 2, 3, 1).reshape(batch, CELL_COUNT, OBSERVATION_CHANNELS)
        cells = torch.nn.functional.gelu(self.stem(cells))
        for block, context_layer in zip(self.blocks, self.global_context):
            cells = block(cells)
            pooled = torch.cat((cells.mean(dim=1), cells.amax(dim=1), global_features), dim=-1)
            cells = cells + context_layer(pooled).unsqueeze(1)

        pooled = torch.cat((cells.mean(dim=1), cells.amax(dim=1), global_features), dim=-1)
        board = self.board_encoder(pooled)
        source, _ = _gather_cell(cells, candidates[..., 5:7])
        target, _ = _gather_cell(cells, candidates[..., 7:9])
        board_per_candidate = board.unsqueeze(1).expand(-1, candidates.shape[1], -1)
        policy_features = torch.cat((
            board_per_candidate, source, target, target - source, candidates
        ), dim=-1)
        logits = self.policy_head(policy_features).squeeze(-1)
        logits = logits.masked_fill(~valid_mask, -1e9)
        return logits, self.value_head(board).squeeze(-1)


def position_batch(positions: list[dict], device: torch.device):
    if not positions:
        raise ValueError("empty position batch")
    largest = max(len(position["candidates"]) for position in positions)
    if largest < 1:
        raise ValueError("terminal positions must be resolved by the game engine")
    observation = torch.tensor(
        [position["observation"] for position in positions], dtype=torch.float32
    )
    if observation.shape != (len(positions), OBSERVATION_SIZE):
        raise ValueError("observation schema mismatch")
    observation = observation.reshape(len(positions), BOARD_ROWS, BOARD_COLUMNS, OBSERVATION_CHANNELS)
    observation = observation.permute(0, 3, 1, 2).contiguous()
    global_features = torch.tensor([position["global"] for position in positions], dtype=torch.float32)
    if global_features.shape != (len(positions), GLOBAL_SIZE):
        raise ValueError("global feature schema mismatch")
    candidates = torch.zeros((len(positions), largest, CANDIDATE_SIZE), dtype=torch.float32)
    valid = torch.zeros((len(positions), largest), dtype=torch.bool)
    for index, position in enumerate(positions):
        count = len(position["candidates"])
        candidate_tensor = torch.tensor(position["candidates"], dtype=torch.float32)
        if candidate_tensor.shape != (count, CANDIDATE_SIZE) or count == 0:
            raise ValueError("candidate schema mismatch")
        candidates[index, :count] = candidate_tensor
        valid[index, :count] = True
    if not all(torch.isfinite(tensor).all() for tensor in (observation, global_features, candidates)):
        raise ValueError("non-finite input feature")
    return tuple(tensor.to(device) for tensor in (observation, global_features, candidates, valid))


def load_checkpoint(path: str, device: torch.device, expected_fingerprint: str | None = None):
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if checkpoint.get("schemaVersion") != CHECKPOINT_SCHEMA_VERSION:
        raise ValueError("hex checkpoint schema mismatch")
    if checkpoint.get("architecture") != ARCHITECTURE_ID:
        raise ValueError("checkpoint is not a hex-graph-v1 model")
    metadata = checkpoint["metadata"]
    if expected_fingerprint and metadata.get("fingerprint") != expected_fingerprint:
        raise ValueError("checkpoint rules/map fingerprint mismatch")
    model = HexPolicyValueNet(checkpoint["width"], checkpoint["blocks"])
    model.load_state_dict(checkpoint["model"])
    return model.to(device), metadata
