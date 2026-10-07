"""Small structural and protocol tests for the isolated hex network."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import torch

from hex_model import (
    ARCHITECTURE_ID,
    CHECKPOINT_SCHEMA_VERSION,
    HEX_NEIGHBOUR_INDEX,
    HEX_NEIGHBOUR_MASK,
    HexPolicyValueNet,
    load_checkpoint,
    position_batch,
)


def make_candidate(source: tuple[int, int] | None, target: tuple[int, int] | None):
    result = [0.0] * 16
    result[0] = 1.0
    for offset, coordinate in ((5, source), (7, target)):
        if coordinate is not None:
            column, row = coordinate
            result[offset] = column / 8
            result[offset + 1] = row / 8
    return result


def make_position(candidate_count: int):
    candidates = [make_candidate((3, 3), (4, 3))]
    if candidate_count > 1:
        candidates.append(make_candidate((3, 3), (2, 3)))
    return {"observation": [0.0] * (9 * 9 * 20), "global": [0.0] * 12,
            "candidates": candidates}


class HexModelTests(unittest.TestCase):
    def test_neighbour_table_matches_even_and_odd_row_hex_layout(self):
        even_center = 4 * 9 + 4
        odd_center = 3 * 9 + 4
        self.assertEqual(HEX_NEIGHBOUR_INDEX[even_center].tolist(), [31, 32, 41, 50, 49, 39])
        self.assertEqual(HEX_NEIGHBOUR_INDEX[odd_center].tolist(), [21, 22, 32, 40, 39, 30])

    def test_board_edges_mask_nonexistent_neighbours(self):
        corner = 0
        self.assertEqual(int(HEX_NEIGHBOUR_MASK[corner].sum()), 3)

    def test_forward_masks_padding_and_backpropagates(self):
        positions = [make_position(2), make_position(1)]
        tensors = position_batch(positions, torch.device("cpu"))
        model = HexPolicyValueNet(width=16, blocks=1)
        logits, values = model(*tensors)
        self.assertEqual(tuple(logits.shape), (2, 2))
        self.assertEqual(tuple(values.shape), (2,))
        self.assertEqual(float(logits[1, 1].detach()), -1e9)
        self.assertTrue(torch.isfinite(values).all())
        (logits[0, 0] + values.square().sum()).backward()
        self.assertTrue(all(parameter.grad is None or torch.isfinite(parameter.grad).all()
                            for parameter in model.parameters()))

    def test_checkpoint_round_trip_and_architecture_guard(self):
        model = HexPolicyValueNet(width=16, blocks=1)
        checkpoint = {
            "schemaVersion": CHECKPOINT_SCHEMA_VERSION,
            "architecture": ARCHITECTURE_ID,
            "width": 16,
            "blocks": 1,
            "metadata": {"fingerprint": "rules"},
            "model": model.state_dict(),
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "hex.pt"
            torch.save(checkpoint, path)
            loaded, _ = load_checkpoint(str(path), torch.device("cpu"), "rules")
            self.assertEqual(loaded.width, 16)
            with self.assertRaisesRegex(ValueError, "fingerprint"):
                load_checkpoint(str(path), torch.device("cpu"), "other-rules")


if __name__ == "__main__":
    unittest.main()
