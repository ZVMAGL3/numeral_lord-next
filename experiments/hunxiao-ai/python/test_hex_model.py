"""Small structural and protocol tests for the isolated hex network."""
from __future__ import annotations

import tempfile
import unittest
import json
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
from train_hex import model_diagnostics, read_bounded_samples, sample_weights, split_games


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
    def test_sample_weights_apply_seat_tilt_and_game_weight(self):
        batch = [
            {"seat": 1, "gameWeight": 0.5},
            {"seat": 2, "gameWeight": 2.0},
        ]
        weights = sample_weights(batch, torch.device("cpu"), seat2_weight=1.1)
        self.assertTrue(torch.allclose(weights, torch.tensor([0.5, 2.2])))

    def test_bounded_reader_excludes_truncated_games_and_restores_terminal_value(self):
        position = make_position(1)
        base = {"schemaVersion": 1, "fingerprint": "rules", "seat": 1,
                "policy": [1.0], **position}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [
                {**base, "gameId": 1, "seat": 1},
                {**base, "gameId": 1, "seat": 2},
                {**base, "gameId": 1, "seat": 1},
                {**base, "gameId": 2, "seat": 1},
            ]
            (root / "samples.jsonl").write_text(
                "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
            )
            (root / "game-1.json").write_text(json.dumps({
                "finished": True, "truncated": False, "winningTeamIds": ["team-1"], "rounds": 8
            }), encoding="utf-8")
            (root / "game-2.json").write_text(json.dumps({
                "finished": False, "truncated": True, "winningTeamIds": []
            }), encoding="utf-8")
            samples, stats = read_bounded_samples(root / "samples.jsonl", "rules", 3, 7)
        self.assertEqual(len(samples), 3)
        self.assertEqual(stats["sourceSamples"], 4)
        self.assertEqual(stats["eligibleSamples"], 3)
        self.assertEqual(stats["skippedIncompleteGames"], 1)
        self.assertEqual([sample["value"] for sample in samples], [1.0, -1.0, 1.0])
        self.assertTrue(all(sample["valueSource"] == "terminal" for sample in samples))

    def test_health_probe_changes_only_board_for_primary_context_check(self):
        first = make_position(2)
        first.update({"gameId": 1})
        second = make_position(2)
        second.update({"gameId": 2})
        second["observation"] = [1.0] * (9 * 9 * 20)
        second["global"] = [1.0] * 12
        model = HexPolicyValueNet(width=16, blocks=1)
        health = model_diagnostics(model, [first, second], torch.device("cpu"))
        self.assertTrue(health["finite"])
        self.assertGreater(health["maximumPolicyProbabilityDeltaAfterBoardOnlySwap"], 0)
        self.assertGreater(health["wrongTargetValueGradientNorm"], 0)

    def test_two_game_split_keeps_validation_game_out_of_training(self):
        samples = [{"gameId": 10, "seat": 1}, {"gameId": 11, "seat": 2}]
        training, validation, validation_games = split_games(samples, seed=3)
        self.assertEqual(len(training), 1)
        self.assertEqual(len(validation), 1)
        self.assertEqual(len(validation_games), 1)
        self.assertEqual(validation_games[0], validation[0]["gameId"])
        self.assertNotEqual(training[0]["gameId"], validation[0]["gameId"])

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
