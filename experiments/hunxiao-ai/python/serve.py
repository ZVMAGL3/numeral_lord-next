"""Persistent JSON-lines inference process; only protocol records go to stdout."""
import argparse
import json
import sys
import torch
from model import load_checkpoint, position_batch, select_device


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--fingerprint", required=True)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "xpu"])
    args = parser.parse_args()
    torch.set_num_threads(2)
    device = select_device(args.device)
    model, _ = load_checkpoint(args.checkpoint, device, args.fingerprint)
    model.eval()
    print(json.dumps({"ready": True, "device": str(device), "torch": torch.__version__}), flush=True)
    for raw in sys.stdin:
        request = json.loads(raw)
        try:
            positions = request["positions"]
            with torch.inference_mode():
                logits, values = model(*position_batch(positions, device))
                priors = torch.softmax(logits, dim=-1).cpu().tolist()
                values = values.cpu().tolist()
            results = [{"priors": prior[:len(position["candidates"])], "value": value}
                       for position, prior, value in zip(positions, priors, values)]
            print(json.dumps({"id": request["id"], "results": results}), flush=True)
        except Exception as error:
            print(json.dumps({"id": request.get("id"), "error": str(error)}), flush=True)


if __name__ == "__main__":
    main()
