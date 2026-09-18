#!/usr/bin/env python3
"""Developer/installer convenience wrapper for OpenCode Universal Engineering System.

This script intentionally delegates plugin lifecycle operations to OpenCode's
official CLI. It does not copy files into user config directories.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

PACKAGE = "github:laivannha0202/opencode-agent-skill-"
ROOT = Path(__file__).resolve().parent


def run(cmd: list[str], *, cwd: Path | None = None, check: bool = True) -> int:
    print("+", " ".join(cmd))
    try:
        completed = subprocess.run(cmd, cwd=str(cwd or ROOT), check=False)
    except FileNotFoundError:
        print(f"ERROR: command not found: {cmd[0]}", file=sys.stderr)
        return 127

    if check and completed.returncode != 0:
        raise SystemExit(completed.returncode)
    return completed.returncode


def require(command: str, install_hint: str) -> None:
    if shutil.which(command) is None:
        raise SystemExit(f"ERROR: '{command}' is not installed. {install_hint}")


def opencode(*args: str) -> None:
    require("opencode", "Install OpenCode first.")
    run(["opencode", *args])


def cmd_install(_: argparse.Namespace) -> None:
    opencode("plugin", "add", PACKAGE)
    opencode("plugin", "list")


def cmd_status(_: argparse.Namespace) -> None:
    opencode("plugin", "list")
    opencode("plugin", "check")


def cmd_check(_: argparse.Namespace) -> None:
    opencode("plugin", "check")


def cmd_update(_: argparse.Namespace) -> None:
    opencode("plugin", "update", PACKAGE)
    opencode("plugin", "list")


def cmd_remove(_: argparse.Namespace) -> None:
    opencode("plugin", "remove", PACKAGE)
    opencode("plugin", "list")


def cmd_dev(_: argparse.Namespace) -> None:
    require("bun", "Install Bun to develop/test this repository.")
    run(["bun", "install"])
    run(["bun", "run", "ci"])


def cmd_ci(_: argparse.Namespace) -> None:
    require("bun", "Install Bun to run repository CI locally.")
    run(["bun", "run", "ci"])


def cmd_doctor(_: argparse.Namespace) -> None:
    print("OpenCode Universal Engineering System - doctor")
    print(f"Repository: {ROOT}")
    print(f"Package:    {PACKAGE}")
    print()

    tools = [
        ("python", sys.executable),
        ("opencode", shutil.which("opencode")),
        ("git", shutil.which("git")),
        ("bun", shutil.which("bun")),
    ]
    for name, value in tools:
        print(f"{name:8} {'OK' if value else 'MISSING'}  {value or ''}")

    print()
    if shutil.which("opencode"):
        run(["opencode", "--version"], check=False)
        run(["opencode", "plugin", "list"], check=False)
        run(["opencode", "plugin", "check"], check=False)

    if shutil.which("git") and (ROOT / ".git").exists():
        run(["git", "status", "--short", "--branch"], check=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Manage the OpenCode Universal Engineering System using "
            "OpenCode's official plugin lifecycle."
        )
    )
    sub = parser.add_subparsers(dest="command", required=True)

    actions = {
        "install": (cmd_install, "Install plugin globally through OpenCode"),
        "status": (cmd_status, "List plugins and check for updates"),
        "check": (cmd_check, "Check package plugins for updates"),
        "update": (cmd_update, "Update this plugin through OpenCode"),
        "remove": (cmd_remove, "Remove this plugin through OpenCode"),
        "dev": (cmd_dev, "Install dev dependencies and run local CI"),
        "ci": (cmd_ci, "Run validation, typecheck, and tests"),
        "doctor": (cmd_doctor, "Inspect required tools and plugin state"),
    }

    for name, (handler, help_text) in actions.items():
        item = sub.add_parser(name, help=help_text)
        item.set_defaults(handler=handler)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    args.handler(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
