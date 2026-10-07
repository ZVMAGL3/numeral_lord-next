"""Tests for separate action/reinforcement policy heads with shared value."""
import unittest
import tempfile
from pathlib import Path

import torch

from model import CANDIDATE_SIZE, GLOBAL_SIZE, OBSERVATION_SIZE, PolicyValueNet
from phase_model import PhasePolicyValueNet, initialize_from_mlp


class PhasePolicyValueNetTests(unittest.TestCase):
    def setUp(self):
        self.model = PhasePolicyValueNet(width=32)
        self.observation = torch.zeros(2, OBSERVATION_SIZE)
        self.global_features = torch.zeros(2, GLOBAL_SIZE)
        self.global_features[0, 0] = 1
        self.global_features[1, 1] = 1
        self.candidates = torch.randn(2, 5, CANDIDATE_SIZE)
        self.valid = torch.ones(2, 5, dtype=torch.bool)

    def test_output_has_one_policy_and_shared_value_for_each_phase(self):
        logits, values = self.model(self.observation, self.global_features, self.candidates, self.valid)
        self.assertEqual(tuple(logits.shape), (2, 5))
        self.assertEqual(tuple(values.shape), (2,))
        self.assertTrue(torch.allclose(torch.softmax(logits, dim=-1).sum(dim=-1), torch.ones(2)))

    def test_reinforcement_policy_loss_updates_its_head_and_shared_encoder(self):
        logits, values = self.model(self.observation[1:], self.global_features[1:], self.candidates[1:], self.valid[1:])
        loss = torch.nn.functional.cross_entropy(logits, torch.tensor([0])) + values.square().mean()
        loss.backward()
        self.assertEqual(self.model.action_policy_head[0].weight.grad.abs().max().item(), 0.0)
        self.assertIsNotNone(self.model.reinforcement_policy_head[0].weight.grad)
        self.assertIsNotNone(self.model.encoder[0].weight.grad)
        self.assertIsNotNone(self.model.value_head[0].weight.grad)

    def test_mlp_warm_start_resets_value_head_instead_of_copying_saturated_output(self):
        source = PolicyValueNet(width=32)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.pt"
            torch.save({"schemaVersion": 1, "width": 32, "metadata": {"fingerprint": "test"},
                        "model": source.state_dict()}, path)
            phase, _ = initialize_from_mlp(str(path), torch.device("cpu"))
        self.assertTrue(torch.equal(phase.encoder[0].weight, source.encoder[0].weight))
        self.assertTrue(torch.equal(phase.action_policy_head[0].weight, source.policy_head[0].weight))
        self.assertFalse(torch.equal(phase.value_head[0].weight, source.value_head[0].weight))
        _, values = phase(self.observation, self.global_features, self.candidates, self.valid)
        self.assertLess(float(values.detach().abs().max()), 0.999)


if __name__ == "__main__":
    unittest.main()
