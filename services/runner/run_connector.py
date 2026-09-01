from __future__ import annotations

import argparse
import json
import sys
import os
from pathlib import Path

from xiling_runner.connectors import build_execution_spec, execute_download, probe_metadata


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--mode", choices=("plan", "probe", "download"), required=True)
    parser.add_argument("--fixture-source")
    parser.add_argument("--max-bytes", type=int, default=None, help="approved volume budget; downloads past it fail inside the container")
    args = parser.parse_args()
    workspace = Path(args.workspace).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    request = json.loads(Path(args.request).read_text(encoding="utf-8"))
    if args.mode == "plan":
        result = build_execution_spec(request)
    elif args.mode == "probe":
        credentials = json.loads(sys.stdin.read() or "{}")
        network = credentials.pop("_network", {})
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE"):
            if isinstance(network.get(name), str) and len(network[name]) <= 4096:
                os.environ[name] = network[name]
        result = probe_metadata(request, credentials)
    else:
        credentials = json.loads(sys.stdin.read() or "{}")
        network = credentials.pop("_network", {})
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE"):
            if isinstance(network.get(name), str) and len(network[name]) <= 4096:
                os.environ[name] = network[name]
        result = execute_download(request, workspace, credentials, Path(args.fixture_source) if args.fixture_source else None, args.max_bytes)
    (workspace / "connector-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
