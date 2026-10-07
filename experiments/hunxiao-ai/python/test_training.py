import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
import torch
from model import PolicyValueNet, position_batch, load_checkpoint
from train import game_sample_weight, losses, read_samples, seat_balance_weights
from train_v2 import (reset_saturated_value_head, seat_adjusted_weights, stratified_probe,
                      weighted_losses)


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

    def test_validation_probe_covers_each_game_and_both_seats_at_multiple_stages(self):
        samples = []
        for game_id in range(3):
            for seat in (1, 2):
                for ply in range(10):
                    item = sample(seat=seat)
                    item["gameId"] = game_id
                    item["ply"] = ply
                    samples.append(item)
        probe = stratified_probe(samples)
        groups = {(item["gameId"], item["seat"]) for item in probe}
        self.assertEqual(len(groups), 6)
        for game_id in range(3):
            for seat in (1, 2):
                selected = [item["ply"] for item in probe if item["gameId"] == game_id and item["seat"] == seat]
                self.assertGreaterEqual(len(selected), 3)
                self.assertLessEqual(min(selected), 1)
                self.assertGreaterEqual(max(selected), 8)
        self.assertLessEqual(len(stratified_probe(samples, maximum=5)), 5)

    def test_v2_gives_seat_two_a_small_weight_increase_after_balancing(self):
        batch = [sample(seat=1), sample(seat=1), sample(seat=1), sample(seat=2)]
        weights = seat_adjusted_weights(batch, "cpu", seat2_weight=1.10)
        seat_one = weights[:3].sum().item()
        seat_two = weights[3].item()
        self.assertAlmostEqual(seat_two / (seat_one + seat_two), 1.1 / 2.1, places=6)
        self.assertAlmostEqual(seat_adjusted_weights(batch, "cpu", seat2_weight=1.0)[:3].sum().item(),
                               seat_adjusted_weights(batch, "cpu", seat2_weight=1.0)[3].item(), places=6)

    def test_v3_resets_only_a_saturated_value_head_and_restores_value_gradients(self):
        model = PolicyValueNet()
        encoder_before = {key: value.detach().clone() for key, value in model.encoder.state_dict().items()}
        policy_before = {key: value.detach().clone() for key, value in model.policy_head.state_dict().items()}
        with torch.no_grad():
            model.value_head[2].weight.zero_()
            model.value_head[2].bias.fill_(12.0)

        diagnostics = reset_saturated_value_head(model, [sample()], "cpu", seed=71)
        self.assertTrue(diagnostics["reset"])
        self.assertEqual(diagnostics["before"]["fractionAtTanhLimit"], 1.0)
        self.assertLess(diagnostics["after"]["fractionAtTanhLimit"], 0.95)
        self.assertEqual(diagnostics["after"]["minimum"], 0.0)
        self.assertEqual(diagnostics["after"]["maximum"], 0.0)
        self.assertTrue(all(torch.equal(value, model.encoder.state_dict()[key])
                            for key, value in encoder_before.items()))
        self.assertTrue(all(torch.equal(value, model.policy_head.state_dict()[key])
                            for key, value in policy_before.items()))

        _, _, value_loss = weighted_losses(model, [sample(value=1.0, source="terminal")], "cpu", 0.2)
        value_loss.backward()
        self.assertGreater(model.value_head[2].bias.grad.abs().item(), 0.0)

    def test_v3_leaves_a_healthy_value_head_unchanged(self):
        model = PolicyValueNet()
        with torch.no_grad():
            model.value_head[2].weight.zero_()
            model.value_head[2].bias.fill_(0.25)
        before = {key: value.detach().clone() for key, value in model.value_head.state_dict().items()}
        diagnostics = reset_saturated_value_head(model, [sample()], "cpu", seed=72)
        self.assertFalse(diagnostics["reset"])
        self.assertTrue(all(torch.equal(value, model.value_head.state_dict()[key])
                            for key, value in before.items()))

    def test_v2_trainer_saves_the_best_held_out_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata = root / "metadata.json"
            data = root / "samples.jsonl"
            metadata.write_text(json.dumps({"fingerprint": "rules"}), encoding="utf-8")
            rows = []
            for game_id in range(2):
                winner = "team-1" if game_id == 0 else "team-2"
                (root / f"game-{game_id}.json").write_text(
                    json.dumps({"finished": True, "rounds": 5, "winningTeamIds": [winner]}),
                    encoding="utf-8")
                for ply in range(6):
                    item = sample(value=0.0, source="terminal", seat=ply % 2 + 1)
                    item["gameId"] = game_id
                    item["ply"] = ply
                    rows.append(item)
            data.write_text("\n".join(json.dumps(item) for item in rows), encoding="utf-8")
            resume = root / "resume.pt"
            saturated = PolicyValueNet()
            with torch.no_grad():
                saturated.value_head[2].weight.zero_()
                saturated.value_head[2].bias.fill_(12.0)
            torch.save({"schemaVersion": 1, "width": saturated.width, "metadata": {"fingerprint": "rules"},
                        "model": saturated.state_dict()}, resume)
            checkpoint = root / "model.pt"
            trainer = Path(__file__).with_name("train_v2.py")
            result = subprocess.run([sys.executable, str(trainer), "--data", str(data), "--metadata", str(metadata),
                                     "--output", str(checkpoint), "--resume", str(resume), "--device", "cpu", "--steps", "2",
                                     "--batch-size", "4", "--eval-interval", "1", "--patience", "2", "--seed", "42"],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            report = json.loads(checkpoint.with_suffix(".metrics.json").read_text(encoding="utf-8"))
            self.assertTrue(checkpoint.exists())
            self.assertEqual(report["trainerVersion"], 3)
            self.assertEqual(report["seat2SampleWeight"], 1.10)
            self.assertTrue(report["valueHeadDiagnostics"]["reset"])
            self.assertEqual(report["valueHeadDiagnostics"]["before"]["fractionAtTanhLimit"], 1.0)
            self.assertEqual(report["valueHeadDiagnostics"]["after"]["fractionAtTanhLimit"], 0.0)
            self.assertLessEqual(report["finalProbeLoss"][0], report["initialProbeLoss"][0] + 1e-7)

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
