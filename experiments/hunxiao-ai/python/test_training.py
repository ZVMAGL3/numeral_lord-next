import json
import tempfile
import unittest
from pathlib import Path
import torch
from model import PolicyValueNet, position_batch, load_checkpoint
from train import game_sample_weight, losses, read_samples, seat_balance_weights


def sample(count=3, value=None, source="unlabelled", seat=1, game_weight=1.0):
    return {"schemaVersion": 1, "fingerprint": "rules", "gameId": 0, "ply": 0, "seat": seat,
            "observation": [0.0] * 1620, "global": [0.0] * 12, "candidates": [[0.0] * 16 for _ in range(count)],
            "policy": [1.0 / count] * count, "value": value, "valueSource": source, "simulations": 8,
            "gameWeight": game_weight}


class TrainingContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)

    def test_padding_is_illegal_and_all_real_candidates_are_retained(self):
        model = PolicyValueNet()
        logits, value = model(*position_batch([sample(1), sample(37)], "cpu"))
        probabilities = logits.softmax(dim=-1)
        self.assertEqual(probabilities.shape, (2, 37))
        self.assertTrue(torch.equal(probabilities[0, 1:], torch.zeros(36)))
        self.assertTrue(torch.allclose(probabilities.sum(dim=-1), torch.ones(2)))
        self.assertTrue((value.abs() <= 1).all())

    def test_truncated_unlabelled_games_do_not_train_a_fake_draw(self):
        model = PolicyValueNet()
        total, _, value = losses(model, [sample()], "cpu", 0.2)
        self.assertEqual(value.item(), 0.0)
        total.backward()
        self.assertTrue(all(p.grad is None or p.grad.abs().max().item() == 0 for p in model.value_head.parameters()))

    def test_bootstrap_has_less_weight_than_a_true_terminal_label(self):
        model = PolicyValueNet()
        _, _, terminal = losses(model, [sample(value=1, source="terminal")], "cpu", 0.2)
        _, _, bootstrap = losses(model, [sample(value=1, source="teacher-bootstrap")], "cpu", 0.2)
        self.assertAlmostEqual(bootstrap.item(), terminal.item() * 0.2, places=6)

    def test_loss_weights_equalize_the_two_seats(self):
        batch = [sample(seat=1), sample(seat=1), sample(seat=1), sample(seat=2)]
        weights = seat_balance_weights(batch, "cpu")
        self.assertAlmostEqual(weights[:3].sum().item(), weights[3].item(), places=6)

    def test_game_length_and_quick_winner_change_weights_smoothly(self):
        short_winner = game_sample_weight(5, True)
        short_loser = game_sample_weight(5, False)
        medium_game = game_sample_weight(20, True)
        long_game = game_sample_weight(40, False)
        self.assertGreater(short_winner, short_loser)
        self.assertGreater(short_loser, medium_game)
        self.assertGreater(medium_game, long_game)
        self.assertGreaterEqual(game_sample_weight(1000, True), 0.35)
        self.assertLessEqual(game_sample_weight(1, True), 1.5)

    def test_policy_loss_uses_game_weights(self):
        model = PolicyValueNet()
        first = sample(game_weight=2.0)
        second = sample(game_weight=1.0)
        first["policy"] = [1.0, 0.0, 0.0]
        second["policy"] = [0.0, 1.0, 0.0]
        _, policy_loss, _ = losses(model, [first, second], "cpu", 0.2)
        logits, _ = model(*position_batch([first, second], "cpu"))
        log_probs = logits.log_softmax(dim=-1)
        expected = (2 * -log_probs[0, 0] - log_probs[1, 1]) / 3
        self.assertAlmostEqual(policy_loss.item(), expected.item(), places=6)

    def test_terminal_values_are_rebuilt_from_the_game_result_and_sample_seat(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "samples.jsonl"
            report = {"finished": True, "rounds": 5, "winningTeamIds": ["team-1"]}
            (Path(directory) / "game-0.json").write_text(json.dumps(report), encoding="utf-8")
            first = sample(value=-1, source="terminal", seat=1)
            second = sample(value=1, source="terminal", seat=2)
            path.write_text(json.dumps(first) + "\n" + json.dumps(second) + "\n", encoding="utf-8")
            loaded = read_samples(path, "rules")
            self.assertEqual([entry["value"] for entry in loaded], [1.0, -1.0])
            self.assertAlmostEqual(loaded[0]["gameWeight"], 1.5, places=6)
            self.assertAlmostEqual(loaded[1]["gameWeight"], 1.25, places=6)

    def test_mismatched_rules_and_invented_value_sources_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "samples.jsonl"
            path.write_text(json.dumps(sample()) + "\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                read_samples(path, "different rules")
            bad = sample(value=0, source="unlabelled")
            path.write_text(json.dumps(bad) + "\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                read_samples(path, "rules")

    def test_checkpoint_cannot_be_loaded_under_different_rules(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.pt"
            model = PolicyValueNet()
            torch.save({"schemaVersion": 1, "width": 256, "metadata": {"fingerprint": "rules"}, "model": model.state_dict()}, path)
            with self.assertRaisesRegex(ValueError, "fingerprint"):
                load_checkpoint(str(path), "cpu", "different")
            loaded, _ = load_checkpoint(str(path), "cpu", "rules")
            self.assertTrue(all(torch.equal(a, b) for a, b in zip(model.parameters(), loaded.parameters())))


if __name__ == "__main__":
    unittest.main()
