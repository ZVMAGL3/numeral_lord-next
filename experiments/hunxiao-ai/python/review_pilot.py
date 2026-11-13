"""Run one declared development pilot while the main training loop is in review."""
import json
from pathlib import Path
import re

from train_autonomous import RUNS, atomic_json, completed_games, now, paired_score, sha256


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


class ReviewPilot:
    @classmethod
    def load(cls, supervisor):
        path = supervisor.root / "review-plan.json"
        return cls(supervisor, path) if path.exists() else None

    def __init__(self, supervisor, path):
        self.supervisor = supervisor
        self.plan_path = path
        raw = path.read_bytes()
        self.plan = json.loads(raw)
        self.plan_bytes = raw
        plan = self.plan
        if (plan["schemaVersion"] != 1 or plan["kind"] != "training-pilot"
                or not re.fullmatch(r"[a-zA-Z0-9_-]{1,48}", plan["id"])):
            raise ValueError("invalid review pilot identity")
        if (type(plan["games"]) is not int or not 8 <= plan["games"] <= 40
                or type(plan["seed"]) is not int or not 0 <= plan["seed"] < 2**32 - 100
                or type(plan["evaluationSimulations"]) is not int
                or not 1 <= plan["evaluationSimulations"] <= 64
                or plan["inferenceFlushMode"] not in {"timer", "immediate"}
                or not isinstance(plan["hypothesis"], str) or not plan["hypothesis"].strip()):
            raise ValueError("invalid bounded review pilot configuration")
        self.champion = supervisor.state["champion"]
        self.validate_boundary()
        self.name = f"{supervisor.root.name}-review-{plan['id']}"
        self.output = supervisor.root / "review-pilots" / plan["id"]
        self.state_path = self.output / "pilot.json"
        if self.state_path.exists():
            self.state = read_json(self.state_path)
            if self.state["plan"] != plan:
                raise ValueError("pilot ID already belongs to a different plan")
        else:
            self.state = {"plan": plan, "stages": {}, "status": "ready"}
        if self.state["status"] not in {"completed", "failed"} and sha256(self.champion) != plan["championSha256"]:
            raise ValueError("review pilot champion hash differs from the saved plan")

    def validate_boundary(self):
        self.supervisor.check_stop()
        if (self.supervisor.state["generation"] != self.plan["generation"]
                or not self.supervisor.review_file.exists()
                or sha256(self.supervisor.review_file) != self.plan["markerSha256"]
                or not self.plan_path.exists() or self.plan_path.read_bytes() != self.plan_bytes):
            raise ValueError("review boundary or active pilot plan changed")

    def save(self, **updates):
        self.state.update(updates, lastProgressAt=now())
        atomic_json(self.state_path, self.state)

    def stage(self, name, command, inspect, game_directory=None):
        previous = self.state["stages"].get(name)
        if previous is not None and previous["command"] != command:
            raise ValueError(f"{name} command changed after it was recorded")
        if previous is not None:
            # A process can exit after saving its final artifact but before its runner records completion.
            # Inspect the result before deciding whether that stage needs a new explicit attempt.
            if previous["status"] == "completed":
                return previous["result"]
            try:
                result = inspect()
            except (OSError, ValueError, KeyError) as error:
                raise RuntimeError(f"{name} was interrupted or failed; saved artifacts retained: {error}") from error
        else:
            self.state["stages"][name] = {"status": "running", "command": command, "startedAt": now()}
            self.save(status="running", stage=name)
            self.supervisor.save(reviewWorkflow={"status": "running", "planId": self.plan["id"],
                                                "stage": name, "statusFile": str(self.state_path)})
            self.supervisor.run_job(f"review_{name}", command, self.output / f"{name}.log",
                                    game_directory, validate=self.validate_boundary)
            result = inspect()
        self.state["stages"][name].update(status="completed", result=result, finishedAt=now())
        self.save()
        return result

    def inspect_collection(self, directory, data):
        summary = read_json(directory / "summary.json")
        metadata = read_json(directory / "metadata.json")
        games = self.plan["games"]
        settings = summary["settings"]
        expected = self.supervisor.args
        if (summary["games"] != games or summary["naturalFinished"] != games or summary["truncated"] != 0
                or not data.is_file() or data.stat().st_size == 0 or summary["samples"] <= 0
                or len(completed_games(directory)) != games
                or metadata["inferenceFlushMode"] != self.plan["inferenceFlushMode"]
                or settings["seed"] != self.plan["seed"] or settings["simulations"] != expected.simulations
                or settings["minimumSimulations"] != expected.min_simulations
                or settings["thinkMs"] != expected.think_ms or settings["workers"] != expected.workers
                or settings["checkpoint"] != self.champion
                or settings["opponentPool"] != self.supervisor.opponent_pool
                or settings["leagueRatio"] != expected.league_ratio):
            raise ValueError("collection did not produce the declared natural games and samples")
        return {"games": games, "samples": summary["samples"], "summary": str(directory / "summary.json"),
                "simulationsPerCommand": sum(game["searchSimulations"] for game in summary["reports"]) / summary["actions"]}

    @staticmethod
    def inspect_training(candidate):
        metrics = read_json(candidate.with_suffix(".metrics.json"))
        selected = candidate if metrics["bestStep"] > 0 else candidate.with_name("candidate.latest.pt")
        return {"checkpoint": str(selected), "checkpointSha256": sha256(selected),
                "bestStep": metrics["bestStep"],
                "evaluationWeights": "validation-selected" if selected == candidate else "latest-development-only"}

    def inspect_evaluation(self, directory, seed, tested):
        summary = read_json(directory / "summary.json")
        metadata = read_json(directory / "metadata.json")
        budget = self.plan["evaluationSimulations"]
        settings = summary["settings"]
        if (not settings.get("pairedSeatSeeds") or settings["seed"] != seed or settings["thinkMs"] != 0
                or settings["simulations"] != budget or settings["minimumSimulations"] != budget
                or settings["checkpoint"] != str(tested) or settings["opponentCheckpoint"] != self.champion
                or metadata["inferenceFlushMode"] != self.plan["inferenceFlushMode"]):
            raise ValueError("evaluation settings differ from the declared paired fixed budget")
        return paired_score(directory, self.supervisor.args.evaluation_games, seed)

    def run(self):
        if self.state["status"] == "completed":
            return self.state["review"]
        if self.state["status"] == "failed":
            return self.state["review"]
        sup = self.supervisor
        seed = self.plan["seed"]
        mode = self.plan["inferenceFlushMode"]
        data_dir = RUNS / self.name
        data, metadata = data_dir / "samples.jsonl", data_dir / "metadata.json"
        candidate = self.output / "candidate.pt"
        health = self.output / "health.json"
        arena = self.name + "-evaluation"
        arena_dir = RUNS / arena
        self.stage("selfplay", sup.selfplay_command(self.name, self.champion, seed,
                   games=self.plan["games"], flush_mode=mode),
                   lambda: self.inspect_collection(data_dir, data), data_dir)
        trained = self.stage("training", sup.training_command(data, metadata, candidate, self.champion, seed),
                             lambda: self.inspect_training(candidate))
        tested = Path(trained["checkpoint"])
        if sha256(tested) != trained["checkpointSha256"]:
            raise ValueError("trained checkpoint changed after verification")
        self.stage("health_check", sup.health_command(tested, data, health),
                   lambda: self.inspect_health(health, trained["checkpointSha256"]))
        score = self.stage("evaluation", sup.evaluation_command(arena, tested, self.champion, seed + 50,
                           simulations=self.plan["evaluationSimulations"], flush_mode=mode),
                           lambda: self.inspect_evaluation(arena_dir, seed + 50, tested), arena_dir)
        next_action = ("Prepare a frozen development comparison on fresh seeds before any champion change."
                       if score["promoted"] else "Use the result to select a new experiment; keep the incumbent.")
        review = {"status": "completed", "planId": self.plan["id"], "statusFile": str(self.state_path),
                  "scoreRate": score["scoreRate"], "nextAction": next_action}
        self.save(status="completed", review=review)
        return review

    @staticmethod
    def inspect_health(path, checkpoint_sha256):
        report = read_json(path)
        if not report["success"] or report["checkpointSha256"] != checkpoint_sha256:
            raise ValueError("trained checkpoint failed numerical health checks")
        return {"report": str(path), "success": True}
