#!/usr/bin/env python3
"""List Bittensor subnets as JSON for the AgentForge watcher (source "sdk").

Prints one JSON line: [{"netuid": 1, "name": "...", "registered_block": 123}, ...].
Needs the bittensor SDK (pip install bittensor). Read-only: no wallet or keys are used.
"""
import argparse
import json
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--network", default="finney")
    ap.add_argument("--endpoint", default="")
    args = ap.parse_args()
    try:
        import bittensor as bt
    except ImportError:
        print("bittensor SDK not installed (pip install bittensor)", file=sys.stderr)
        return 2
    st = bt.subtensor(network=args.endpoint or args.network)
    out = []
    if hasattr(st, "all_subnets"):  # SDK >= 9 (dynamic TAO)
        for s in st.all_subnets() or []:
            name = getattr(s, "subnet_name", None)
            if not name and getattr(s, "subnet_identity", None):
                name = getattr(s.subnet_identity, "subnet_name", None)
            out.append({"netuid": int(s.netuid), "name": str(name or f"Subnet {s.netuid}"),
                        "registered_block": int(getattr(s, "network_registered_at", 0) or 0)})
    else:
        for netuid in st.get_subnets() or []:
            out.append({"netuid": int(netuid), "name": f"Subnet {netuid}", "registered_block": 0})
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
