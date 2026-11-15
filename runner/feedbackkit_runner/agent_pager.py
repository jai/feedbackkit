"""What the runner still takes from Agent Pager's threads hub (jai/agent-pager collectors/threads), imported from the
copy `make threads-install` keeps on the Mac mini (a LaunchAgent's python may not read ~/Developer there): the builders as SSH machines, reading a thread's transcript, sending a message into an Orca chat
(`agentSession.send`, run on the builder over SSH) and starting a scan.

Follow-up: the runner gets its own Orca send and coding-thread lookup (Orca's agent-session journal on the builder), and
this adapter goes, so serving Trips and PRHub needs no Agent Pager clone.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Callable, NamedTuple

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
