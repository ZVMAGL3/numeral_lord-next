"""Compare flush modes in eight real Hex workers from identical starts."""
import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path

from analyze_review_pilot import collection_summary, game_reports, inference_summary
from review_pilot import read_json
from train_autonomous import RUNS, StopRequested, Supervisor, atomic_json, now, owned_root, sha256, single_instance


def run(root, plan_path):
    plan = read_json(plan_path)
    target = root / "review-pilots" / plan["afterPilot"] / "pilot.json"
    if read_json(target)["status"] != "completed":
        raise ValueError("the preceding training pilot is not complete")
    progress = read_json(root / "progress.json")
    args = argparse.Namespace(**progress["configuration"])
    configuration = vars(args).copy()
    if (args.workers != 8 or args.simulations != 16 or args.min_simulations != 4 or args.think_ms != 100):
        raise ValueError("worker comparison expects 8 workers and the saved 4–16/100 ms collection budget")
    supervisor = Supervisor(args)
    output = root / "worker-flush-comparison"
    result_path = output / "result.json"
    marker = root / "REVIEW_REQUIRED.json"
    champion = progress["champion"]

    def validate():
        if (root / "STOP").exists():
            raise StopRequested("STOP requested during worker comparison")
        if sha256(marker) != plan["markerSha256"]:
            raise ValueError("review marker changed")

    with single_instance(RUNS / ".autonomous-training-gpu.lock"), single_instance(root / "supervisor.lock"):
        validate()
        progress = read_json(root / "progress.json")
        if (progress.get("currentJob") or progress["status"] != "stopped" or progress["generation"] != plan["generation"]
                or progress["configuration"] != configuration
                or progress["champion"] != champion or sha256(champion) != plan["championSha256"]):
            raise ValueError("stop the idle supervisor at the review boundary before running the comparison")
        if result_path.exists():
            if read_json(result_path)["status"] == "completed":
                return
            raise ValueError("a prior comparison attempt exists; inspect its saved output")
        output.mkdir(parents=True, exist_ok=True)
        supervisor.state = progress
        supervisor.opponent_pool = []
        supervisor.args.league_ratio = 0
        state = {"status": "running", "plan": plan, "arms": {}, "startedAt": now()}
        atomic_json(result_path, state)
        try:
            for mode in ("timer", "immediate"):
                name = f"{root.name}-worker-flush-{mode}"
                directory = RUNS / name
                command = supervisor.selfplay_command(name, champion, plan["seed"], games=8, flush_mode=mode)
                state["runningArm"] = {"mode": mode, "command": command, "startedAt": now()}
                atomic_json(result_path, state)
                supervisor.save(reviewWorkflow={"status": "running", "planId": "worker-flush-comparison",
                                                "stage": mode, "statusFile": str(result_path)})
                supervisor.run_job(f"review_worker_{mode}", command,
                    output / f"{mode}.log", directory, validate=validate)
                reports = game_reports(directory)
                metadata = read_json(directory / "metadata.json")
                if (len(reports) != 8 or metadata["inferenceFlushMode"] != mode or metadata["workerCount"] != 8
                        or not all(game["id"] == index and game["seed"] == plan["seed"] + index
                                   and game["selfPlay"] and game["finished"] and not game["truncated"]
                                   for index, game in enumerate(reports))):
                    raise ValueError(f"{mode} did not complete all eight natural games")
                state["arms"][mode] = {"collection": collection_summary(reports),
                                       "inference": inference_summary(directory), "directory": str(directory)}
                atomic_json(result_path, state)
            state.update(status="completed", runningArm=None)
        except StopRequested as error:
            state.update(status="stopped", error=str(error))
        except BaseException as error:
            state.update(status="failed", error=str(error))
            raise
        finally:
            atomic_json(result_path, {**state, "finishedAt": now()})
            completed = datetime.now(timezone.utc)
            supervisor.save(status="stopped" if state["status"] == "stopped" else "waiting_review",
                            currentJob=None, reviewWorkflow={
                "status": state["status"], "nextAction": "Review the real-worker batching and search results.",
                "statusFile": str(result_path), "since": completed.isoformat(),
                "notifyAfter": (completed + timedelta(minutes=30)).isoformat(),
            })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-root", required=True)
    parser.add_argument("--plan", required=True)
    args = parser.parse_args()
    run(owned_root(args.run_root), Path(args.plan))


if __name__ == "__main__":
    main()
