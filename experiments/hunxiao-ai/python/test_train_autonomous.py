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
                              owned_root, paired_score, pid_alive, single_instance)


def args_for(root, checkpoint):
    return argparse.Namespace(run_root=str(root), checkpoint=str(checkpoint), workers=2,
        games=4, steps=1, batch_size=2, max_samples=32, simulations=4, min_simulations=1,
        think_ms=10, evaluation_games=4, evaluation_simulations=4, review_after=3,
        max_failures=2, poll_seconds=0.03, min_free_memory_gib=5, min_free_disk_gib=15,
        stall_minutes=1, job_hours=1, max_generations=1, seed=1)


class SupervisorTests(unittest.TestCase):
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
