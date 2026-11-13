"""Persistent, single-instance hex self-play supervisor; no ChatGPT/API dependency.

All generated files stay under the ignored runs directory. Old checkpoints are
read-only. Partial attempts are retained; recovery starts at the last selected
checkpoint rather than claiming to resume an unfinished game or optimizer step.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import random
import re
import shutil
import signal
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone


EXPERIMENT = Path(__file__).resolve().parents[1]
REPOSITORY = EXPERIMENT.parents[1]
RUNS = EXPERIMENT / "runs"


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def opponent_mix_arguments(opponent_pool, opponent_model_family, league_ratio):
    """Return explicit CLI arguments for a frozen-opponent game mix."""
    if not opponent_pool:
        if league_ratio != 0:
            raise ValueError("league-ratio requires at least one opponent-pool checkpoint")
        return ["--league-ratio", "0"]
    if not 0 < league_ratio <= 1:
        raise ValueError("opponent-pool requires league-ratio in (0, 1]")
    if opponent_model_family not in {"mlp", "hex-graph-v1", "phase-head-v1"}:
        raise ValueError("unsupported opponent model family")
    return ["--opponent-pool", "|".join(opponent_pool),
            "--opponent-model-family", opponent_model_family,
            "--league-ratio", format(league_ratio, ".12g")]


def owned_root(path, runs=RUNS):
    path, runs = Path(path).resolve(), Path(runs).resolve()
    if path == runs or path.parent != runs or not re.fullmatch(r"[a-zA-Z0-9_-]+", path.name):
        raise ValueError("run-root must be a named direct child of the experiment runs directory")
    return path


@contextmanager
def single_instance(path):
    """OS lock releases on a crash; a stale PID file cannot launch duplicates."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    stream = path.open("a+b")
    locked = False
    try:
        if path.stat().st_size == 0:
            stream.write(b" ")
            stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        locked = True
        stream.seek(0)
        stream.truncate()
        stream.write(json.dumps({"pid": os.getpid(), "startedAt": now()}).encode())
        stream.flush()
        yield
    except OSError as error:
        if not locked:
            raise RuntimeError("another supervisor holds this run's exclusive lock") from error
        raise
    finally:
        if locked:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_UN)
        stream.close()


def pid_alive(pid):
    if not isinstance(pid, int) or pid < 1:
        return False
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5  # Access denied: conservatively assume alive.
        try:
            code = ctypes.c_uint32()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def resources(path):
    if os.name == "nt":
        class Memory(ctypes.Structure):
            _fields_ = [("length", ctypes.c_uint32), ("load", ctypes.c_uint32)] + [
                (field, ctypes.c_uint64) for field in
                ("totalPhysical", "availablePhysical", "totalPage", "availablePage",
                 "totalVirtual", "availableVirtual", "extendedVirtual")]
        memory = Memory()
        memory.length = ctypes.sizeof(memory)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory)):
            raise OSError("cannot inspect available physical memory")
        available = memory.availablePhysical
    else:
        available = os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    return {"freeMemoryGiB": available / 1024 ** 3,
            "freeDiskGiB": shutil.disk_usage(path).free / 1024 ** 3}


def completed_games(path):
    return sorted((p for p in Path(path).glob("game-*.json")
                   if re.fullmatch(r"game-\d+\.json", p.name)), key=lambda p: int(p.stem[5:]))


def paired_score(directory, expected_games, seed=20261109):
    """Predeclared pilot gate: paired bootstrap; truncations cannot count as wins."""
    reports = [json.loads(path.read_text(encoding="utf-8")) for path in completed_games(directory)]
    if len(reports) != expected_games or expected_games < 4 or expected_games % 2:
        raise ValueError("evaluation does not contain the complete predeclared even game count")
    if {r["id"] for r in reports} != set(range(expected_games)):
        raise ValueError("evaluation game IDs are incomplete or duplicated")
    seats = {seat: {"games": 0, "wins": 0, "draws": 0, "truncated": 0, "points": 0.0}
             for seat in (1, 2)}
    points = {}
    for report in reports:
        seat = report["id"] % 2 + 1
        if report.get("candidateSeat") != seat:
            raise ValueError("candidate seat is not the expected alternating seat")
        row = seats[seat]
        row["games"] += 1
        if not report.get("finished") or report.get("truncated"):
            row["truncated"] += 1
            points[report["id"]] = 0.0
            continue
        winners = report.get("winningTeamIds", [])
        win = f"team-{seat}" in winners
        draw = not winners
        score = 1.0 if win else 0.5 if draw else 0.0
        row["wins"] += int(win)
        row["draws"] += int(draw)
        row["points"] += score
        points[report["id"]] = score
    pairs = [(points[i] + points[i + 1]) / 2 for i in range(0, expected_games, 2)]
    rng = random.Random(seed)
    estimates = sorted(sum(rng.choices(pairs, k=len(pairs))) / len(pairs) for _ in range(4000))
    lower, upper = estimates[99], estimates[3899]
    score = sum(pairs) / len(pairs)
    truncated = sum(row["truncated"] for row in seats.values())
    return {"games": expected_games, "scoreRate": score, "scoreBySeat": seats,
            "pairedBootstrap95": [lower, upper], "bootstrapSeed": seed,
            "truncatedGames": truncated,
            "promoted": truncated == 0 and score > 0.55 and lower > 0.5,
            "scope": "pilot comparison against previous selected hex checkpoint; not human-strength evidence"}


class StopRequested(Exception):
    pass


class ResourcePressure(Exception):
    pass


class Supervisor:
    def __init__(self, args):
        self.args = args
        self.root = owned_root(args.run_root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "progress.json"
        self.stop_file = self.root / "STOP"
        self.review_file = self.root / "REVIEW_REQUIRED.json"
        self.node = shutil.which("node")
        if not self.node:
            raise RuntimeError("Node.js is not available")
        if self.path.exists():
            self.state = json.loads(self.path.read_text(encoding="utf-8"))
            if self.state.get("schemaVersion") != 1 or self.state.get("runRoot") != str(self.root):
                raise ValueError("supervisor state identity mismatch")
        else:
            if not args.checkpoint or not Path(args.checkpoint).is_file():
                raise ValueError("a validated hex seed --checkpoint is required for a new run")
            self.state = {"schemaVersion": 1, "runRoot": str(self.root), "startedAt": now(),
                          "generation": 1, "attempt": 1,
                          "champion": str(Path(args.checkpoint).resolve()), "consecutiveNoPromotion": 0,
                          "failures": 0, "needsReview": False, "currentJob": None}

        # None means the caller omitted the new option. Restore each omitted
        # field from persisted configuration so an ordinary restart cannot
        # silently revert a frozen-opponent run to pure self-play.
        saved_configuration = self.state.get("configuration") or {}
        raw_pool = args.opponent_pool if args.opponent_pool is not None \
            else saved_configuration.get("opponent_pool", [])
        opponent_model_family = args.opponent_model_family if args.opponent_model_family is not None \
            else saved_configuration.get("opponent_model_family", "mlp")
        league_ratio = args.league_ratio if args.league_ratio is not None \
            else saved_configuration.get("league_ratio", 0.0)
        if not isinstance(raw_pool, list) or not all(isinstance(path, str) for path in raw_pool):
            raise ValueError("persisted opponent-pool must be a list of checkpoint paths")
        self.opponent_pool = []
        for checkpoint in raw_pool:
            resolved = Path(checkpoint).resolve()
            if not resolved.is_file():
                raise ValueError(f"opponent-pool checkpoint does not exist: {resolved}")
            self.opponent_pool.append(str(resolved))
        # Validate only after omitted fields have been restored.
        opponent_mix_arguments(self.opponent_pool, opponent_model_family, league_ratio)
        args.opponent_pool = self.opponent_pool
        args.opponent_model_family = opponent_model_family
        args.league_ratio = league_ratio
        self.state["configuration"] = {**vars(args), "opponent_pool": self.opponent_pool}

    def save(self, **updates):
        self.state.update(updates)
        self.state["updatedAt"] = now()
        self.state["supervisorPid"] = os.getpid()
        atomic_json(self.path, self.state)

    def event(self, kind, **values):
        record = {"timestamp": now(), "event": kind, **values}
        with (self.root / "events.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")
        print(json.dumps(record, ensure_ascii=False), flush=True)

    def check_stop(self):
        if self.stop_file.exists():
            raise StopRequested("STOP file requested an orderly supervisor stop")

    def enough_resources(self, measured):
        return (measured["freeMemoryGiB"] >= self.args.min_free_memory_gib
                and measured["freeDiskGiB"] >= self.args.min_free_disk_gib)

    def wait_resources(self):
        while True:
            self.check_stop()
            measured = resources(self.root)
            if self.enough_resources(measured):
                return
            self.save(status="waiting_resources", resources=measured)
            time.sleep(self.args.poll_seconds)

    @staticmethod
    def stop_owned_child(child):
        if child.poll() is not None:
            return
        if os.name == "nt":
            subprocess.run(["taskkill.exe", "/PID", str(child.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        else:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=15)

    def run_job(self, stage, command, log_path, game_directory=None, *, validate=None):
        self.wait_resources()
        log_path = Path(log_path)
        self.save(status=stage, currentJob={"stage": stage, "pid": None,
                  "command": command, "log": str(log_path), "startedAt": now()})
        started = last_growth = time.monotonic()
        last_size, low_memory_polls = -1, 0
        child = None
        try:
            if validate:
                validate()
            with log_path.open("xb") as stream:
                kwargs = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
                child = subprocess.Popen(command, cwd=REPOSITORY, stdin=subprocess.DEVNULL,
                                         stdout=stream, stderr=subprocess.STDOUT, **kwargs)
                self.state["currentJob"]["pid"] = child.pid
                self.save(lastProgressAt=now())
                self.event("job_started", stage=stage, pid=child.pid, log=str(log_path))
                while child.poll() is None:
                    self.check_stop()
                    if validate:
                        validate()
                    measured = resources(self.root)
                    low_memory_polls = low_memory_polls + 1 if not self.enough_resources(measured) else 0
                    if low_memory_polls >= 3:
                        raise ResourcePressure("memory/disk reserve crossed for three checks")
                    size = log_path.stat().st_size
                    if size != last_size:
                        last_size, last_growth = size, time.monotonic()
                        self.state["lastProgressAt"] = now()
                    if time.monotonic() - last_growth > self.args.stall_minutes * 60:
                        raise RuntimeError("job log stopped growing beyond its stall budget")
                    if time.monotonic() - started > self.args.job_hours * 3600:
                        raise RuntimeError("job exceeded its bounded wall-clock budget")
                    self.save(resources=measured, logBytes=size,
                              completedGames=len(completed_games(game_directory)) if game_directory else None)
                    time.sleep(self.args.poll_seconds)
                if child.returncode:
                    raise RuntimeError(f"{stage} exited with code {child.returncode}; see {log_path}")
        except BaseException:
            if child is not None:
                self.stop_owned_child(child)
            raise
        finally:
            self.save(currentJob=None, lastProgressAt=now())
        self.event("job_finished", stage=stage, elapsedSeconds=time.monotonic() - started)

    def require_review(self, reason):
        atomic_json(self.review_file, {"createdAt": now(), "reason": reason,
                    "nextAction": "Inspect this run and implement/validate a justified adjustment before removing this marker."})
        self.save(needsReview=True, status="waiting_review", lastError=reason)
        self.event("review_required", reason=reason)

    def wait_review(self):
        from review_pilot import ReviewPilot

        while self.review_file.exists() or (self.root / "review-plan.json").exists():
            self.check_stop()
            pilot = None
            try:
                pilot = ReviewPilot.load(self)
                status = pilot.run() if pilot is not None else {
                    "status": "unplanned",
                    "nextAction": "Register a bounded experiment or report the blocker.",
                }
            except (StopRequested, KeyboardInterrupt):
                raise
            except Exception as error:
                status = {"status": "failed", "error": str(error),
                          "nextAction": "Inspect the failure and register the next experiment."}
                if pilot is not None:
                    status["planId"] = pilot.plan["id"]
                    status["statusFile"] = str(pilot.state_path)
                    pilot.save(status="failed", review=status)
            previous = self.state.get("reviewWorkflow") or {}
            details = {key: value for key, value in previous.items() if key not in {"since", "notifyAfter"}}
            if details != status or self.state["status"] != "waiting_review":
                start = datetime.now(timezone.utc)
                self.save(status="waiting_review", reviewWorkflow={
                    **status, "since": start.isoformat(), "notifyAfter": (start + timedelta(minutes=30)).isoformat(),
                })
                self.event("review_waiting", **status)
            time.sleep(self.args.poll_seconds)
        if self.state.get("reviewWorkflow"):
            self.save(reviewWorkflow=None)
        if self.state.get("needsReview"):
            self.save(needsReview=False, failures=0, consecutiveNoPromotion=0)
            self.event("review_released")

    def selfplay_command(self, name, champion, seed, *, games=None, flush_mode="timer"):
        common = ["--device", "xpu", "--workers", str(self.args.workers),
                  "--max-actions", "10000", "--max-learning-rounds", "0",
                  "--seed", str(seed)]
        return [self.node, str(EXPERIMENT / "launch.mjs"), "selfplay", "--name", name,
                "--checkpoint", champion, "--model-family", "hex-graph-v1",
                "--games", str(self.args.games if games is None else games), "--simulations", str(self.args.simulations),
                "--min-simulations", str(self.args.min_simulations),
                "--think-ms", str(self.args.think_ms), "--bootstrap", "none", "--inference-flush-mode", flush_mode,
                *opponent_mix_arguments(self.opponent_pool, self.args.opponent_model_family,
                                        self.args.league_ratio),
                "--max-samples", "256", "--replay", *common]

    def training_command(self, data, metadata, candidate, champion, seed):
        return [sys.executable, "-u", str(EXPERIMENT / "python/train_hex.py"), "--data", str(data),
                "--metadata", str(metadata), "--output", str(candidate), "--resume", champion,
                "--device", "xpu", "--max-samples", str(self.args.max_samples),
                "--steps", str(self.args.steps), "--batch-size", str(self.args.batch_size),
                "--seed", str(seed), "--lr", "0.0001", "--seat2-weight", "1.10",
                "--policy-loss-weight", "1", "--eval-interval", "25", "--checkpoint-interval", "100"]

    def health_command(self, candidate, data, report):
        return [sys.executable, "-u", str(EXPERIMENT / "python/audit_hex_checkpoint.py"),
                "--checkpoint", str(candidate), "--data", str(data), "--output", str(report)]

    def evaluation_command(self, name, candidate, champion, seed, *, simulations=None, flush_mode="timer"):
        budget = str(self.args.evaluation_simulations if simulations is None else simulations)
        return [self.node, str(EXPERIMENT / "launch.mjs"), "arena", "--name", name,
                "--policy", "network", "--opponent", "network", "--checkpoint", str(candidate),
                "--opponent-checkpoint", champion, "--model-family", "hex-graph-v1",
                "--opponent-model-family", "hex-graph-v1", "--games", str(self.args.evaluation_games),
                "--simulations", budget, "--min-simulations", budget, "--think-ms", "0",
                "--inference-flush-mode", flush_mode,
                "--stochastic-arena", "--paired-seat-seeds", "--league-ratio", "0", "--replay",
                "--device", "xpu", "--workers", str(self.args.workers), "--max-actions", "10000",
                "--max-learning-rounds", "0", "--seed", str(seed)]

    def one_generation(self):
        generation, attempt = self.state["generation"], self.state["attempt"]
        name = f"{self.root.name}-g{generation:04d}-a{attempt:03d}"
        directory = RUNS / name
        # Existing partial attempts remain untouched. Never invoke the CLI over them.
        if directory.exists():
            raise FileExistsError(f"attempt already exists; preserve and allocate a fresh attempt: {directory}")
        champion = self.state["champion"]
        log_dir = self.root / f"g{generation:04d}-a{attempt:03d}"
        log_dir.mkdir()
        candidate = log_dir / "candidate.pt"
        data, metadata = directory / "samples.jsonl", directory / "metadata.json"
        seed = self.args.seed + generation * 100 + attempt
        collect = self.selfplay_command(name, champion, seed)
        self.save(generationDirectory=str(directory), candidate=str(candidate), evaluation=None)
        self.run_job("selfplay", collect, log_dir / "selfplay.log", directory)
        if not data.exists() or not metadata.exists() or len(completed_games(directory)) != self.args.games:
            raise RuntimeError("self-play did not persist the complete data/metadata/game set")
        train = self.training_command(data, metadata, candidate, champion, seed)
        self.run_job("training", train, log_dir / "train.log")
        if not candidate.exists():
            raise RuntimeError("training exited without its completed candidate checkpoint")
        health_path = log_dir / "health.json"
        health = self.health_command(candidate, data, health_path)
        self.run_job("health_check", health, log_dir / "health.log")
        health_report = json.loads(health_path.read_text(encoding="utf-8"))
        if not health_report.get("success"):
            raise RuntimeError("candidate failed numerical/context/gradient health checks")
        arena_name = name + "-evaluation"
        arena_directory = RUNS / arena_name
        arena = self.evaluation_command(arena_name, candidate, champion, seed)
        self.run_job("evaluation", arena, log_dir / "evaluation.log", arena_directory)
        score = paired_score(arena_directory, self.args.evaluation_games, seed)
        if score["promoted"]:
            champion = str(candidate)
        selection = {**score, "candidate": str(candidate), "candidateSha256": sha256(candidate),
                     "selectedCheckpoint": champion, "selectedSha256": sha256(champion),
                     "healthReport": str(health_path), "generation": generation}
        atomic_json(log_dir / "selection.json", selection)
        self.save(champion=champion, evaluation=selection, generation=generation + 1, attempt=1,
                  failures=0, status="between_generations", completedGames=self.args.games,
                  consecutiveNoPromotion=0 if score["promoted"] else self.state["consecutiveNoPromotion"] + 1)
        self.event("generation_finished", **selection)
        if self.state["consecutiveNoPromotion"] >= self.args.review_after:
            self.require_review("successive pilot generations have not demonstrated improvement; inspect before more sampling")

    def run(self):
        with single_instance(RUNS / ".autonomous-training-gpu.lock"), single_instance(self.root / "supervisor.lock"):
            if self.path.exists():
                current = json.loads(self.path.read_text(encoding="utf-8"))
                if current.get("updatedAt") != self.state.get("updatedAt"):
                    raise RuntimeError("supervisor state changed before acquiring the lock; reload before recovery")
            previous = self.state.get("currentJob") or {}
            if previous.get("pid") and pid_alive(previous["pid"]):
                # Never kill/adopt a possibly reused PID or launch a second GPU task.
                raise RuntimeError("previous child PID is still alive; inspect its identity before recovery")
            if previous and not previous.get("stage", "").startswith("review_"):
                self.state["attempt"] += 1
            self.save(currentJob=None, status="starting", lastError=None)
            self.event("supervisor_started", pid=os.getpid(), champion=self.state["champion"])
            completed = 0
            try:
                while True:
                    self.check_stop()
                    self.wait_review()
                    try:
                        self.one_generation()
                        completed += 1
                        if self.args.max_generations and completed >= self.args.max_generations:
                            self.save(status="completed_requested_generations")
                            return
                    except (StopRequested, KeyboardInterrupt):
                        raise
                    except Exception as error:
                        self.state["attempt"] += 1
                        self.state["failures"] += 1
                        self.save(status="retry_wait", lastError=str(error))
                        self.event("attempt_failed", reason=str(error), failures=self.state["failures"])
                        if self.state["failures"] >= self.args.max_failures:
                            self.require_review(f"repeated job failures: {error}")
                        else:
                            # Poll the STOP file throughout backoff rather than becoming unresponsive.
                            end = time.monotonic() + min(300, 30 * self.state["failures"])
                            while time.monotonic() < end:
                                self.check_stop()
                                time.sleep(min(self.args.poll_seconds, max(0, end - time.monotonic())))
            except (StopRequested, KeyboardInterrupt) as error:
                self.save(status="stopped", currentJob=None, lastError=str(error))
                self.event("supervisor_stopped", reason=str(error))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-root", required=True)
    parser.add_argument("--checkpoint")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--games", type=int, default=100)
    parser.add_argument("--steps", type=int, default=300)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--max-samples", type=int, default=16384)
    parser.add_argument("--simulations", type=int, default=16)
    parser.add_argument("--min-simulations", type=int, default=4)
    parser.add_argument("--think-ms", type=int, default=100)
    parser.add_argument("--opponent-pool", action="append", default=None,
                        help="repeat for frozen opponent checkpoints; all must share opponent-model-family")
    parser.add_argument("--opponent-model-family", default=None,
                        choices=["mlp", "hex-graph-v1", "phase-head-v1"])
    parser.add_argument("--league-ratio", type=float, default=None,
                        help="fraction of games against opponent-pool; remaining games are self-play")
    parser.add_argument("--evaluation-games", type=int, default=32)
    parser.add_argument("--evaluation-simulations", type=int, default=32)
    parser.add_argument("--review-after", type=int, default=5)
    parser.add_argument("--max-failures", type=int, default=3)
    parser.add_argument("--poll-seconds", type=float, default=10)
    parser.add_argument("--min-free-memory-gib", type=float, default=5)
    parser.add_argument("--min-free-disk-gib", type=float, default=15)
    parser.add_argument("--stall-minutes", type=float, default=30)
    parser.add_argument("--job-hours", type=float, default=6)
    parser.add_argument("--max-generations", type=int, default=0, help="0 keeps working until STOP/review/resource conditions")
    parser.add_argument("--seed", type=int, default=20261109)
    args = parser.parse_args()
    if not 1 <= args.workers <= 16 or not 2 <= args.games <= 1000:
        parser.error("workers must be 1..16 and games 2..1000")
    if args.evaluation_games < 4 or args.evaluation_games % 2:
        parser.error("evaluation-games must be even and at least four")
    if min(args.steps, args.batch_size, args.max_samples, args.simulations, args.min_simulations,
           args.evaluation_simulations, args.review_after, args.max_failures) < 1:
        parser.error("training/search/review limits must be positive")
    if args.min_simulations > args.simulations or args.think_ms < 0 or args.max_generations < 0:
        parser.error("invalid search/generation limits")
    if args.league_ratio is not None and not 0 <= args.league_ratio <= 1:
        parser.error("league-ratio must be in [0,1]")
    if min(args.poll_seconds, args.min_free_memory_gib, args.min_free_disk_gib,
           args.stall_minutes, args.job_hours) <= 0:
        parser.error("resource/time limits must be positive")
    Supervisor(args).run()


if __name__ == "__main__":
    main()
