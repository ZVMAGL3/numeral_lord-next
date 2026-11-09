"""Supervisor safety and paired selection tests; never load a GPU model."""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from train_autonomous import (RUNS, StopRequested, Supervisor, atomic_json,
                              opponent_mix_arguments, owned_root, paired_score,
                              pid_alive, single_instance)


def args_for(root, checkpoint):
    return argparse.Namespace(run_root=str(root), checkpoint=str(checkpoint), workers=2,
        games=4, steps=1, batch_size=2, max_samples=32, simulations=4, min_simulations=1,
        think_ms=10, evaluation_games=4, evaluation_simulations=4, review_after=3,
        max_failures=2, poll_seconds=0.03, min_free_memory_gib=5, min_free_disk_gib=15,
        stall_minutes=1, job_hours=1, max_generations=1, seed=1,
        opponent_pool=[], opponent_model_family="mlp", league_ratio=0.0)


class SupervisorTests(unittest.TestCase):
    def test_opponent_mix_arguments_require_an_explicit_bounded_pool(self):
        self.assertEqual(opponent_mix_arguments([], "mlp", 0), ["--league-ratio", "0"])
        self.assertEqual(opponent_mix_arguments(["old20.pt"], "mlp", 0.4),
            ["--opponent-pool", "old20.pt", "--opponent-model-family", "mlp",
             "--league-ratio", "0.4"])
        with self.assertRaisesRegex(ValueError, "requires"):
            opponent_mix_arguments([], "mlp", 0.4)
        with self.assertRaisesRegex(ValueError, "requires"):
            opponent_mix_arguments(["old20.pt"], "mlp", 0)

    def test_selfplay_command_keeps_sixty_percent_selfplay_and_frozen_mlp_mix(self):
        RUNS.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="supervisor-test-", dir=RUNS) as folder:
            root = owned_root(folder)
            champion = root / "champion.pt"
            opponent = root / "old20.pt"
            champion.write_bytes(b"hex champion")
            opponent.write_bytes(b"frozen mlp")
            args = args_for(root, champion)
            args.games = 100
            args.workers = 8
            args.simulations = 16
            args.min_simulations = 4
            args.think_ms = 100
            args.opponent_pool = [str(opponent)]
            args.opponent_model_family = "mlp"
            args.league_ratio = 0.4
            runner = Supervisor(args)
            command = runner.selfplay_command("mixed-generation", str(champion), 20261110)
            self.assertEqual(command[command.index("--opponent-pool") + 1], str(opponent.resolve()))
            self.assertEqual(command[command.index("--opponent-model-family") + 1], "mlp")
            self.assertEqual(command[command.index("--league-ratio") + 1], "0.4")
            self.assertEqual(command[command.index("--games") + 1], "100")
            self.assertEqual(command[command.index("--model-family") + 1], "hex-graph-v1")
            self.assertEqual(command[command.index("--checkpoint") + 1], str(champion))
            self.assertEqual(runner.state["configuration"]["opponent_pool"], [str(opponent.resolve())])

    def test_restart_restores_omitted_opponent_mix_without_resetting_progress(self):
        RUNS.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="supervisor-test-", dir=RUNS) as folder:
            root = owned_root(folder)
            champion = root / "champion.pt"
            opponent = root / "old20.pt"
            champion.write_bytes(b"selected hex champion")
            opponent.write_bytes(b"frozen mlp")
            configured = args_for(root, champion)
            configured.opponent_pool = [str(opponent)]
            configured.opponent_model_family = "mlp"
            configured.league_ratio = 0.4
            first = Supervisor(configured)
            first.save(generation=5, attempt=1, champion=str(champion.resolve()),
                       consecutiveNoPromotion=2, failures=0, currentJob=None,
                       status="waiting_review")

            omitted = args_for(root, champion)
            omitted.opponent_pool = None
            omitted.opponent_model_family = None
            omitted.league_ratio = None
            restarted = Supervisor(omitted)
            command = restarted.selfplay_command("resumed-mix", restarted.state["champion"], 9)

            self.assertEqual(restarted.opponent_pool, [str(opponent.resolve())])
            self.assertEqual(restarted.args.opponent_model_family, "mlp")
            self.assertEqual(restarted.args.league_ratio, 0.4)
            self.assertEqual(command[command.index("--league-ratio") + 1], "0.4")
            self.assertEqual(command[command.index("--opponent-pool") + 1], str(opponent.resolve()))
            self.assertEqual(restarted.state["generation"], 5)
            self.assertEqual(restarted.state["champion"], str(champion.resolve()))
            self.assertEqual(restarted.state["consecutiveNoPromotion"], 2)
            self.assertEqual(restarted.state["configuration"]["opponent_pool"], [str(opponent.resolve())])

    def test_only_named_children_of_runs_can_own_state(self):
        self.assertEqual(owned_root(RUNS / "owned-test"), (RUNS / "owned-test").resolve())
        for path in (RUNS, RUNS.parent, RUNS / "a" / "nested"):
            with self.assertRaises(ValueError):
                owned_root(path)

    def test_exclusive_lock_releases_without_deleting_the_state_file(self):
        with tempfile.TemporaryDirectory() as folder:
            lock = Path(folder) / "lock"
            with single_instance(lock):
                with self.assertRaisesRegex(RuntimeError, "exclusive lock"):
                    with single_instance(lock):
                        self.fail("second supervisor acquired an active lock")
            with single_instance(lock):
                self.assertTrue(lock.exists())

    def test_paired_scores_follow_actual_candidate_seat(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for game in range(4):
                seat = game % 2 + 1
                atomic_json(root / f"game-{game}.json", {"id": game, "candidateSeat": seat,
                    "finished": True, "truncated": False, "winningTeamIds": [f"team-{seat}"]})
            result = paired_score(root, 4)
            self.assertEqual(result["scoreRate"], 1)
            self.assertEqual(result["scoreBySeat"][2]["wins"], 2)
            self.assertTrue(result["promoted"])
            atomic_json(root / "game-0.json", {"id": 0, "candidateSeat": 1,
                "finished": False, "truncated": True, "winningTeamIds": []})
            result = paired_score(root, 4)
            self.assertEqual(result["truncatedGames"], 1)
            self.assertFalse(result["promoted"])

    def test_incomplete_or_mislabelled_evaluation_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaisesRegex(ValueError, "complete"):
                paired_score(root, 4)
            for game in range(4):
                atomic_json(root / f"game-{game}.json", {"id": game, "candidateSeat": 1,
                    "finished": True, "truncated": False, "winningTeamIds": ["team-1"]})
            with self.assertRaisesRegex(ValueError, "candidate seat"):
                paired_score(root, 4)

    def test_restart_keeps_last_selected_checkpoint_and_avoids_live_child(self):
        RUNS.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="supervisor-test-", dir=RUNS) as folder:
            root = owned_root(folder)
            seed = root / "seed.pt"
            seed.write_bytes(b"read-only seed sentinel")
            runner = Supervisor(args_for(root, seed))
            runner.save(champion=str(seed), currentJob={"pid": os.getpid(), "stage": "test"})
            restarted = Supervisor(args_for(root, seed))
            self.assertEqual(restarted.state["champion"], str(seed))
            # Isolate this unit test from a real supervisor that may correctly
            # hold the experiment-wide GPU lock while waiting for review.
            with patch("train_autonomous.RUNS", root):
                with self.assertRaisesRegex(RuntimeError, "previous child PID"):
                    restarted.run()
            self.assertEqual(seed.read_bytes(), b"read-only seed sentinel")

    def test_stop_file_terminates_only_the_child_started_by_this_supervisor(self):
        RUNS.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="supervisor-test-", dir=RUNS) as folder:
            root = owned_root(folder)
            seed = root / "seed.pt"
            seed.write_bytes(b"read-only seed sentinel")
            runner = Supervisor(args_for(root, seed))
            timer = threading.Timer(0.3, lambda: runner.stop_file.write_text("stop", encoding="ascii"))
            timer.start()
            try:
                with patch("train_autonomous.resources", return_value={"freeMemoryGiB": 20, "freeDiskGiB": 100}):
                    with self.assertRaises(StopRequested):
                        runner.run_job("test", [sys.executable, "-c", "import time; time.sleep(30)"], root / "job.log")
            finally:
                timer.join()
            events = [json.loads(row) for row in (root / "events.jsonl").read_text().splitlines()]
            child_pid = next(event["pid"] for event in events if event["event"] == "job_started")
            self.assertFalse(pid_alive(child_pid))
            self.assertTrue(pid_alive(os.getpid()))
            self.assertEqual(seed.read_bytes(), b"read-only seed sentinel")
            self.assertIsNone(runner.state["currentJob"])


if __name__ == "__main__":
    unittest.main()
