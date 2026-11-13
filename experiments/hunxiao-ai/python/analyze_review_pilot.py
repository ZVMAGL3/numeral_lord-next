"""Summarize a review pilot from its game reports, training metrics and paired arena."""
import argparse
import json
from collections import defaultdict
from math import comb
from pathlib import Path
from statistics import median, quantiles

from review_pilot import read_json
from train_autonomous import RUNS, atomic_json, completed_games, owned_root


def game_reports(directory, *, partial=False):
    reports = []
    for path in completed_games(directory):
        try:
            reports.append(read_json(path))
        except ValueError:
            if not partial:
                raise
    return reports


def collection_summary(reports):
    groups = defaultdict(list)
    for game in reports:
        groups["all"].append(game)
        groups["selfPlay" if game["selfPlay"] else "frozenOpponent"].append(game)
    result = {}
    for key, games in groups.items():
        actions = sum(game["actions"] for game in games)
        ratios = [game["searchSimulations"] / game["actions"] for game in games if game["actions"]]
        if not ratios:
            continue
        result[key] = {
            "games": len(games),
            "naturalFinished": sum(game["finished"] and not game["truncated"] for game in games),
            "actions": actions,
            "simulationsPerCommand": sum(game["searchSimulations"] for game in games) / actions,
            "medianGameSimulationsPerCommand": median(ratios),
            "p90GameSimulationsPerCommand": quantiles(ratios, n=10, method="inclusive")[8] if len(ratios) > 1 else ratios[0],
            "medianGameMsPerCommand": median(game["elapsedMs"] / game["actions"] for game in games if game["actions"]),
        }
    return result


def inference_summary(directory):
    summary = read_json(directory / "summary.json")
    return {
        "commandsPerSecond": summary["actions"] / summary["elapsedSeconds"],
        "services": {name: {**stats, "meanBatch": stats["positions"] / stats["calls"]}
                     for name, stats in summary["inference"].items() if stats["calls"]},
    }


def paired_diagnostic(reports, seed):
    if not reports or len(reports) % 2:
        raise ValueError("paired analysis requires a complete even set")
    outcomes = defaultdict(int)
    truncated = False
    for index in range(0, len(reports), 2):
        points = 0.0
        expected_seed = (seed + index // 2) % 2**32
        for game_id in (index, index + 1):
            game = reports[game_id]
            seat = game_id % 2 + 1
            if game["id"] != game_id or game["candidateSeat"] != seat or game["seed"] != expected_seed:
                raise ValueError(f"arena pair identity mismatch: game {game_id}")
            if not game["finished"] or game["truncated"]:
                truncated = True
                continue
            winners = game["winningTeamIds"]
            points += (float(f"team-{seat}" in winners) if winners else 0.5)
        outcomes[points] += 1
    if truncated:
        return {"verifiedPairs": len(reports) // 2, "containsTruncation": True}
    favorable = sum(count for points, count in outcomes.items() if points > 1)
    unfavorable = sum(count for points, count in outcomes.items() if points < 1)
    informative = favorable + unfavorable
    return {"verifiedPairs": len(reports) // 2, "containsTruncation": False,
            "pairsByCandidatePoints": {str(points): count for points, count in sorted(outcomes.items())},
            "favorablePairs": favorable, "unfavorablePairs": unfavorable,
            "oneSidedSignP": sum(comb(informative, k) for k in range(favorable, informative + 1)) / 2**informative}


def next_question(evidence):
    if evidence["status"] != "completed":
        return ("inspect-stage-failure" if evidence["status"] == "failed"
                else "review-only-after-complete")
    arena = evidence["arena"]
    if arena["paired"]["containsTruncation"]:
        return "check-truncation-before-strength-interpretation"
    if arena["promoted"]:
        return "replicate-on-fresh-paired-seeds-before-promotion"
    if evidence["training"]["bestStep"] == 0 and arena["pairedBootstrap95"][1] < 0.5:
        return "inspect-validation-components-and-update-size-before-more-collection"
    historical_selfplay = evidence.get("baselineCollection", {}).get("selfPlay")
    pilot_selfplay = evidence["collection"].get("selfPlay")
    if (historical_selfplay and pilot_selfplay
            and pilot_selfplay["medianGameSimulationsPerCommand"] <= historical_selfplay["medianGameSimulationsPerCommand"]):
        return "check-typical-hex-search-depth-under-worker-load"
    return "consider-same-seed-control-or-target-quality-probe"


def analyze(root, baseline=None):
    plan = read_json(root / "review-plan.json")
    pilot_dir = root / "review-pilots" / plan["id"]
    pilot_path = pilot_dir / "pilot.json"
    pilot = read_json(pilot_path)
    if pilot["plan"] != plan:
        raise ValueError("active plan differs from saved pilot")
    games_name = f"{root.name}-review-{plan['id']}"
    stages = pilot["stages"]
    status = pilot["status"]
    evidence = {"planId": plan["id"], "hypothesis": plan["hypothesis"], "status": status,
                "stage": pilot.get("stage"), "lastProgressAt": pilot.get("lastProgressAt"),
                "collection": collection_summary(game_reports(RUNS / games_name, partial=status != "completed")),
                "partial": status != "completed"}
    if baseline:
        evidence["baselineCollection"] = collection_summary(game_reports(baseline))
        evidence["baselineInference"] = inference_summary(baseline)
        evidence["baselineLimit"] = "Historical games can differ in seeds, sample counts, training exposure and trajectories."
    if stages.get("selfplay", {}).get("status") == "completed":
        evidence["inference"] = inference_summary(RUNS / games_name)
    if stages.get("training", {}).get("status") == "completed":
        metrics = read_json(pilot_dir / "candidate.metrics.json")
        evidence["training"] = {**stages["training"]["result"],
            **{key: metrics[key] for key in ("stepsRequested", "trainingSamples", "validationSamples",
                "validationGames", "initialProbeLoss", "finalProbeLoss")}}
    if status == "completed":
        score = stages["evaluation"]["result"]
        reports = game_reports(RUNS / (games_name + "-evaluation"))
        if len(reports) != score["games"]:
            raise ValueError("arena reports differ from completed pilot count")
        evidence["arena"] = {**score, "paired": paired_diagnostic(reports, plan["seed"] + 50)}
    elif status == "failed":
        evidence["failure"] = pilot["review"]
    evidence["nextQuestion"] = next_question(evidence)
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-root", required=True)
    parser.add_argument("--baseline-run")
    parser.add_argument("--save", action="store_true")
    args = parser.parse_args()
    root = owned_root(args.run_root)
    result = analyze(root, owned_root(args.baseline_run) if args.baseline_run else None)
    if args.save:
        atomic_json(root / "review-evidence.json", result)
    print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
