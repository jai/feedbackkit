"""What the runner still takes from Agent Pager's threads hub (jai/agent-pager collectors/threads), imported from the
copy `make threads-install` keeps on the Mac mini (a LaunchAgent's python may not read ~/Developer there): the builders as SSH machines, reading a thread's transcript, sending a message into an Orca chat
(`agentSession.send`, run on the builder over SSH) and starting a scan.

Follow-up: the runner gets its own Orca send and coding-thread lookup (Orca's agent-session journal on the builder), and
this adapter goes, so serving Trips and PRHub needs no Agent Pager clone.
"""

from __future__ import annotations

import hashlib
import sys
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple

from .runner import CheckQueue, ConversationReader, Deliver, Machine

THREADS_DIR = Path.home() / "Library" / "Application Support" / "agent-pager-threads"


class AgentPager(NamedTuple):
    machines: dict[str, Machine]
    reader: ConversationReader
    deliver: Deliver
    check_queue: CheckQueue
    kick: Callable[[], str]


def load(threads_dir: Path = THREADS_DIR) -> AgentPager:
    """Agent Pager's installed hub; ImportError when it is not there."""
    sys.path.insert(0, str(threads_dir))
    from hub.conversation_server import MachineReader
    from hub.fleet_scan import FLEET_BY_ID
    from hub.reply_delivery import deliver_on_machine
    from hub.scan_kick import kickstart_scan

    return AgentPager(dict(FLEET_BY_ID), MachineReader(), deliver_on_machine, deliver_on_machine, kickstart_scan)


def file_hash(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return "missing"


class HubWatch:
    """Whether Agent Pager's installed hub changed under the runner: the files of the modules it imported from
    `threads_dir`, each hashed when first seen (at start, or when a module is imported later). `changed` is true once
    a file differs and has held still for one check, so a reinstall still writing files is not read half-done. The
    runner then restarts itself onto the new hub (service.py)."""

    def __init__(self, threads_dir: Path = THREADS_DIR, modules: Callable[[], list[object]] | None = None) -> None:
        self.root = threads_dir.resolve()
        self.modules = modules or (lambda: list(sys.modules.values()))
        self.known: dict[Path, str] = {}
        self.last: tuple[tuple[Path, str], ...] | None = None
        self.seen()

    def seen(self) -> list[Path]:
        """The imported hub files; a file not seen before is hashed now."""
        files = set()
        for module in self.modules():
            name = getattr(module, "__file__", None)
            if isinstance(name, str) and (path := Path(name).resolve()).is_relative_to(self.root):
                files.add(path)
                self.known.setdefault(path, file_hash(path))
        return sorted(files)

    def changed(self) -> list[Path]:
        """The imported hub files that differ from what was imported and held still since the last check; empty while
        nothing differs or the files are still changing."""
        self.seen()
        now = tuple(
            (path, digest) for path, known in sorted(self.known.items()) if (digest := file_hash(path)) != known
        )
        settled = bool(now) and now == self.last
        self.last = now or None
        return [path for path, _ in now] if settled else []
