"""FeedbackKit's runner (runner/README.md): take feedback from the FeedbackKit Worker, which keeps every app's, to a
Claude chat on a builder Mac, through Orca, and bring the agent's words back. Each chat is one app's, one sender's and
one repo's.

A long-running process on Jais-Mac-mini as jai (service.py), started and kept alive by launchd. It only reaches out: it
polls FeedbackKit, runs `orca` against each builder's paired Orca and reaches the builders over SSH. A chat starts on the
first builder in BUILDERS whose Orca answers and stays there. Each app has one Orca project on each builder, a clone at
~/Developer/feedback-<app> added on the app's first chat; a chat's first message makes a worktree of it (fb-<id>, off
origin/main) with Claude launched in it, in one `orca worktree create`. Each later message goes into the same Orca chat,
as an Agent Pager thread reply does, and waits while that builder is down. The agent's words come from its transcript,
read with Agent Pager's scanner as its Agents tab reads it, and go back to the Worker. A message is journalled the
moment its claim succeeds and is never delivered twice. A chat quiet for a day, with every message delivered and its
work pushed, has its worktree removed through Orca.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
import subprocess
import time
from pathlib import Path
from typing import Callable, Literal, NamedTuple, Protocol, TypedDict

from .brief import app_name, fields, first_prompt, later_prefix
from .github import GitHub
from .util import IMAGE_EXTENSIONS, HttpJsonError, JsonObject, image_note, json_object, post_json, write_private_json

STATE_DIR = Path.home() / "Library" / "Application Support" / "feedbackkit-runner"
STATE_FILE = "state.json"
# Agent Pager's threads hub keeps each builder's last scan (last-good-<host>.json) here: where a chat's thread is found.
SCAN_DIR = Path.home() / "Library" / "Application Support" / "agent-pager-threads" / "state"
# The runner's state from when it was Agent Pager's hub.feedback_runner, in SCAN_DIR: moved into STATE_FILE once.
OLD_STATE_FILE = "feedback-runner-featurekit.json"
# The builder Macs in the order a new chat tries them: (fleet id, name the agent and Jai read, Orca environment paired on
# the Mac mini).
BUILDERS = (
    ("borg-cube-03", "Borg Cube 03", "34629f5a-b830-4ee8-a3b8-a731a92bd021"),
    ("borg-cube-04", "Borg Cube 04", "564e1156-4425-493e-812a-2da638992675"),
)
ORCA = "/Applications/Orca.app/Contents/Resources/bin/orca"
CLONES = "/Users/jai/Developer"
AGENT = "claude"
MODEL = "claude-opus-5-5"
EFFORT = "high"
# A chat's thread: Orca's Claude chats, and the Codex chats started while the runner launched Codex (2026-11-12 to 15).
AGENT_APPS = ("orca-codex", "orca-claude")
REPO = re.compile(r"^[\w.-]+/[\w.-]+$")
LOGIN = re.compile(r"^[A-Za-z0-9-]{1,39}$")
# An app id names its project's folder, so it is a plain slug.
APP = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
HTTP_TIMEOUT_SECONDS = 30
# The longest the Worker holds a `/runner/wait` (worker/src/runner-wake.ts WAIT_MS).
WAIT_SECONDS = 25
ORCA_TIMEOUT_SECONDS = 60
# `orca worktree create` checks out the repo and starts the agent before it answers.
CREATE_TIMEOUT_SECONDS = 300
# Times a lost `worktree create` reply is asked again with its operation id; Orca replays it, never launches twice.
LAUNCH_RETRIES = 2
UNKNOWN_LAUNCH = "agent_session_operation_unknown"
SSH_TIMEOUT_SECONDS = 180
# A reply waits for the next scan to list the chat's thread; past this, the chat is lost and the reply fails.
THREAD_WAIT_SECONDS = 600
# Orca can take a few seconds to show an agent it just started or told; until then it counts as working.
STARTING_SECONDS = 60
# The agent's side is sent again this often even when unchanged, so one lost send heals.
RESEND_SECONDS = 60
# A chat's worktree goes once its agent is idle, every message is delivered and its work is pushed, for this long.
TIDY_AFTER_SECONDS = 86400
TIDIED = "This chat was tidied away after a day with nothing left to do. Start new feedback instead."
JOURNAL_KEPT_SECONDS = 14 * 86400
MAX_AGENT_MESSAGES = 500
# What a chat shipped (shipped_probe.py): looked for every 5 minutes while its worktree lives, then hourly until each
# commit is in a release, its checks have finished and no pull request is open.
SHIPPED_EVERY_SECONDS = 300
SHIPPED_TIDIED_EVERY_SECONDS = 3600
PROBE = Path(__file__).with_name("shipped_probe.py")
# Each chat's newest messages in status.json.
STATUS_MESSAGES = 10
READ_PAGES = 5
DETAIL_MAX = 200
ACTIVITIES = {
    "Bash": "Running a command",
    "Edit": "Editing",
    "Write": "Editing",
    "MultiEdit": "Editing",
    "Read": "Reading the code",
    "Grep": "Reading the code",
    "Glob": "Reading the code",
    "Agent": "Working with a helper",
    "Task": "Working with a helper",
}
LOG = logging.getLogger("feedback-runner")


class Machine(Protocol):
    """A builder Mac: Agent Pager's fleet_scan.Machine, or a test's stand-in."""

    @property
    def id(self) -> str: ...

    def command(self, argv: list[str]) -> list[str]: ...


class _OutcomeFields(TypedDict):
    status: str
    how: str | None
    detail: str | None


class Outcome(_OutcomeFields, total=False):
    """What delivering a message did: Agent Pager's target_machine.Outcome."""

    queued_id: str


class DeliveryJob(TypedDict):
    """A message for a thread: Agent Pager's target_machine.DeliveryJob."""

    app: str
    session_id: str
    cwd: str | None
    text: str


class QueueJob(TypedDict):
    """A check on a message Orca queued: Agent Pager's target_machine.QueueJob."""

    app: str
    session_id: str
    queue: str
    queued_id: str


# A row of a builder's last scan: its app, session_id, cwd, _transcript, id and last_message_at.
RawRow = JsonObject


class Sender(TypedDict):
    """Whose chat it is: the app, the sender's GitHub login, the repo the agent changes, and whether it ships
    (`owner`) or opens a pull request (`builder`)."""

    app: str
    login: str
    repo: str
    role: str


class _JournalFields(TypedDict):
    claimed_at: float
    outcome: Outcome | None
    posted: bool


class JournalEntry(_JournalFields, total=False):
    """A message claimed here: when, what delivering it did (None until it ends), whether the Worker has that, and
    whose chat it is."""

    sender: Sender
    queue: QueueJob


# Where a chat's agent works: a worktree of its app's feedback project, or (chats started before 2026-11-14) a full clone
# of its own, which the runner leaves for Jai to remove.
Layout = Literal["worktree", "clone"]


class _ChatFields(TypedDict):
    host: str
    # The folder the agent works in: its worktree, or its full clone (layout "clone").
    clone: str
    layout: Layout
    launched_at: float
    cursor: str | None
    messages: list[JsonObject]
    posted: str | None
    removed: bool


class ChatState(_ChatFields, total=False):
    """A chat this runner watches: where it runs, how far its transcript was read, what was last sent of it, and whose
    it is."""

    sender: Sender

    last_activity: float
    told_at: float
    posted_at: float
    # For status.json (the menu bar app): the chat's title from its claims, its coding thread once a scan found it, and
    # what its agent was doing at the last look.
    title: str
    thread: JsonObject
    working: bool
    activity: str | None
    # What its feedback shipped, as last sent (`{commits, prs}`), when it was looked for, the commits found on main so
    # far (kept after the worktree goes) and the worktree's branch.
    shipped: JsonObject
    shipped_at: float
    shipped_shas: list[str]
    branch: str


class _RunnerFields(TypedDict):
    chats: dict[str, ChatState]
    journal: dict[str, JournalEntry]


class RunnerState(_RunnerFields, total=False):
    """The runner's own state file. `echoes`: a test app's chats' replies so far, each chat's whole agent side."""

    echoes: dict[str, list[JsonObject]]


class Completed(Protocol):
    """What the runner reads of a finished `orca` run: subprocess.CompletedProcess, or a test's stand-in."""

    @property
    def stdout(self) -> str: ...

    @property
    def stderr(self) -> str: ...


class ConversationReader(Protocol):
    """Reads a thread's messages on its machine: conversation_server.MachineReader, or a test's stand-in."""

    def read(
        self,
        machine: Machine,
        app: str,
        path: str,
        limit: int,
        after: str | None = None,
        before: str | None = None,
    ) -> JsonObject: ...


Deliver = Callable[[Machine, DeliveryJob], Outcome]
CheckQueue = Callable[[Machine, QueueJob], Outcome]


class FeedbackApiError(Exception):
    pass


class FeedbackApi:
    """FeedbackKit's `/runner/*` routes, with the runner's token. Every message but a poll names its app and sender."""

    def __init__(self, url: str, token: str) -> None:
        self.url = url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {token}", "User-Agent": "feedbackkit-runner"}

    def _post(
        self, route: str, body: JsonObject, refused: tuple[int, ...] = (), timeout: float = HTTP_TIMEOUT_SECONDS
    ) -> JsonObject | None:
        try:
            answer = post_json(f"{self.url}/runner/{route}", body, self.headers, timeout)
        except HttpJsonError as failure:
            raise FeedbackApiError(failure.reason) from failure
        if answer.status in refused:
            return None
        if answer.status != 200:
            raise FeedbackApiError(f"{route} answered {answer.status:d}")
        return answer.body

    def poll(self, orca: bool, detail: str | None = None) -> list[JsonObject]:
        """Pending work. `detail` says why no builder's Orca answered; the app's Feedback list shows the builder offline."""
        body: JsonObject = {"orca": orca, "detail": detail[:DETAIL_MAX] if detail else None}
        work = json_object(self._post("poll", body)).get("work") or []
        return [item for item in work if isinstance(item, dict)] if isinstance(work, list) else []

    def whose(self, sender: Sender | None) -> JsonObject:
        """The app and sender a message names."""
        return {"app": sender["app"], "login": sender["login"]} if sender else {}

    def claim(self, chat: str, message: str, sender: Sender | None = None) -> JsonObject | None:
        """What to deliver; None when it is not pending any more."""
        return self._post("claim", {**self.whose(sender), "chat": chat, "message": message}, refused=(404, 409))

    def result(self, chat: str, message: str, outcome: Outcome, sender: Sender | None = None) -> None:
        self._post(
            "result",
            {
                **self.whose(sender),
                "chat": chat,
                "message": message,
                "status": outcome["status"],
                "detail": outcome.get("detail"),
            },
            refused=(404, 409),
        )

    def agent(self, chat: str, side: JsonObject, sender: Sender | None = None) -> bool:
        """False when the Worker has no such chat."""
        return self._post("agent", {**side, **self.whose(sender), "chat": chat}, refused=(404,)) is not None

    def wait(self, since: int | None, seconds: float = WAIT_SECONDS) -> int | None:
        """The long poll: the Worker's wake count, at once when it is past `since` (or `since` is None), else when a
        message wakes it or after `seconds` (at most WAIT_SECONDS) unchanged. None when the Worker has no
        `/runner/wait` yet."""
        held = max(0, min(int(seconds * 1000), WAIT_SECONDS * 1000))
        answer = self._post(
            "wait", {"since": since, "ms": held}, refused=(404,), timeout=held / 1000 + HTTP_TIMEOUT_SECONDS
        )
        if answer is None:
            return None
        seq = answer.get("seq")
        if not isinstance(seq, int) or isinstance(seq, bool):
            raise FeedbackApiError("wait answered no seq")
        return seq


class OrcaError(RuntimeError):
    """An `orca` command that gave no result. `operation` is the launch's id when Orca could not say whether an agent
    launch happened: the same command again with `--retry-launch <operation>` replays it rather than launching twice."""

    def __init__(self, message: str, operation: str | None = None) -> None:
        super().__init__(message)
        self.operation = operation


class Orca:
    """The `orca` CLI on this Mac, against one builder's runtime."""

    def __init__(self, environment: str, run: Callable[..., Completed] = subprocess.run) -> None:
        self.environment = environment
        self.run = run

    def call(self, *arguments: str, timeout: float = ORCA_TIMEOUT_SECONDS) -> JsonObject:
        """The command's `result`; OrcaError saying why when it gave none."""
        try:
            done = self.run(
                [ORCA, *arguments, "--environment", self.environment, "--json"],
                capture_output=True,
                text=True,
                timeout=timeout,
                stdin=subprocess.DEVNULL,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as failure:
            raise OrcaError(f"orca {arguments[0]}: {type(failure).__name__}") from failure
        try:
            answer = json.loads(done.stdout)
        except ValueError:
            answer = None
        if not isinstance(answer, dict) or answer.get("ok") is not True:
            error = json_object(answer.get("error")) if isinstance(answer, dict) else {}
            message = error.get("message")
            data = json_object(error.get("data"))
            operation = data.get("operationId") if error.get("code") == UNKNOWN_LAUNCH else None
            raise OrcaError(
                "orca {}: {}".format(" ".join(arguments[:2]), message or last_line(done.stderr)),
                operation if isinstance(operation, str) and operation else None,
            )
        return json_object(answer.get("result"))

    def project(self, path: str, name: str) -> str:
        """The repo id of the Orca project at this folder, added the first time and given this display name."""
        repos = self.call("repo", "list").get("repos")
        found = (
            next(
                (json_object(repo) for repo in repos if isinstance(repo, dict) and repo.get("path") == path),
                None,
            )
            if isinstance(repos, list)
            else None
        )
        if found is None:
            found = json_object(self.call("repo", "add", "--path", path).get("repo"))
        repo_id = found.get("id")
        if not isinstance(repo_id, str) or not repo_id:
            raise OrcaError(f"orca repo add: no project id for {path}")
        if found.get("displayName") != name:
            self.call("project", "setup-update", "--setup", repo_id, "--display-name", name)
        return repo_id

    def create(self, project: str, name: str, prompt: str) -> str:
        """A worktree of the project on a new branch `name` off origin/main, with Claude launched in it as a chat and
        told `prompt`; its path. A lost reply is asked again with its operation id, which Orca replays."""
        arguments = (
            "worktree",
            "create",
            "--repo",
            f"id:{project}",
            "--name",
            name,
            "--branch",
            name,
            "--base-branch",
            "origin/main",
            "--no-parent",
            "--agent",
            AGENT,
            "--model",
            MODEL,
            "--effort",
            EFFORT,
            "--surface",
            "chat",
            "--prompt",
            prompt,
        )
        operation: str | None = None
        for attempt in range(LAUNCH_RETRIES + 1):
            retry = ("--retry-launch", operation) if operation else ()
            try:
                result = self.call(*arguments, *retry, timeout=CREATE_TIMEOUT_SECONDS)
                break
            except OrcaError as failure:
                operation = operation or failure.operation
                if operation is None or attempt == LAUNCH_RETRIES:
                    raise
        path = json_object(result.get("worktree")).get("path")
        if not isinstance(path, str):
            worktree_id = json_object(result.get("launch")).get("worktreeId")
            path = worktree_id.split("::", 1)[-1] if isinstance(worktree_id, str) and "::" in worktree_id else None
        if not path:
            raise OrcaError("orca worktree create: no worktree path in its answer")
        return path

    def remove(self, path: str) -> None:
        """The worktree out of Orca and git, with its branch when Orca can tell it is merged."""
        self.call("worktree", "rm", "--worktree", f"path:{path}", "--delete-branch")

    def agents(self) -> dict[str, JsonObject]:
        """Each Orca workspace's first agent, by its folder: Orca's live view of whether it is working."""
        worktrees = self.call("worktree", "ps").get("worktrees") or []
        found: dict[str, JsonObject] = {}
        for worktree in worktrees if isinstance(worktrees, list) else []:
            agents = worktree.get("agents") if isinstance(worktree, dict) else None
            path = worktree.get("path") if isinstance(worktree, dict) else None
            if isinstance(agents, list) and agents and isinstance(agents[0], dict) and isinstance(path, str):
                found[path] = agents[0]
        return found


class Cube:
    """A builder Mac over SSH: its clones and worktrees, the files saved into them, and its last scan."""

    def __init__(self, machine: Machine, state_dir: Path) -> None:
        self.machine = machine
        self.state_dir = state_dir

    def sh(self, script: str, *arguments: str, stdin: bytes | None = None) -> str:
        """The script's output; RuntimeError with its last line when it fails."""
        command = self.machine.command(["/bin/sh", "-c", script, "sh", *arguments])
        try:
            done = subprocess.run(
                command,
                input=stdin if stdin is not None else b"",
                capture_output=True,
                timeout=SSH_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as failure:
            raise RuntimeError(f"{self.machine.id} did not answer: {type(failure).__name__}") from failure
        if done.returncode != 0:
            raise RuntimeError(last_line(done.stderr.decode("utf-8", "replace")) or f"exit {done.returncode:d}")
        return done.stdout.decode("utf-8", "replace")

    def clone(self, path: str, repo: str) -> None:
        """The repo cloned at `path` unless it is there, with Jai's identity, and fetched."""
        self.sh(
            'set -e; [ -d "$1/.git" ] || git clone -q "$2" "$1"; cd "$1"; git fetch -q origin; '
            'git config user.name "Jai Govindani"; '
            "git config user.email jai.g@ewa-services.com",
            path,
            f"git@github.com:{repo}.git",
        )

    def save_images(self, folder: str, message: str, images: object) -> list[str]:
        """Each screenshot (the claim's `images`, a list) into `folder`, under a checkout's tmp/ (gitignored); the
        paths the agent is told."""
        if not isinstance(images, list):
            if images:
                raise RuntimeError("the screenshots are not usable images")
            images = []
        paths = []
        for index, image in enumerate(images):
            extension = IMAGE_EXTENSIONS.get(str(image.get("media_type"))) if isinstance(image, dict) else None
            data = image.get("data") if isinstance(image, dict) else None
            if extension is None or not isinstance(data, str):
                raise RuntimeError("the screenshots are not usable images")
            path = f"{folder}/{message}-{index + 1:d}.{extension}"
            self.sh('mkdir -p "$1" && cat > "$2"', folder, path, stdin=base64.b64decode(data, validate=True))
            paths.append(path)
        return paths

    def check_pushed(self, folder: str) -> bool:
        """False when the checkout is gone already (nothing in it can be lost); RuntimeError saying what is left when it
        has uncommitted changes, or commits on no branch of origin (a worktree's branch has no upstream, so `@{u}`
        would say nothing)."""
        return "gone" not in self.sh(
            'set -e; [ -d "$1" ] || { echo gone; exit 0; }; cd "$1"; git fetch -q origin; '
            'changes=$(git status --porcelain); [ -z "$changes" ] || '
            '{ echo "uncommitted changes" >&2; exit 1; }; unpushed=$(git log --oneline HEAD --not --remotes=origin); '
            '[ -z "$unpushed" ] || { echo "unpushed commits" >&2; exit 1; }',
            folder,
        )

    def shipped(self, worktree: str, project: str, shas: list[str], branch: str | None) -> JsonObject:
        """The commits the chat landed and its branch, found on this builder by shipped_probe.py (git only);
        RuntimeError when git failed."""
        answer = self.sh(
            'PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; exec python3 - "$@"',
            worktree,
            project,
            ",".join(shas),
            branch or "",
            stdin=PROBE.read_bytes(),
        )
        try:
            return json_object(json.loads(answer))
        except ValueError as failure:
            raise RuntimeError(f"shipped answered no JSON: {failure}") from failure

    def remove_folder(self, folder: str) -> None:
        """A folder of the runner's own (a chat's first screenshots); gone already is fine."""
        self.sh('rm -rf "$1"', folder)

    def thread(self, clone: str) -> RawRow | None:
        """The newest Orca Codex or Claude thread the last scan found in this clone. The scan names a thread by the folder its
        last message ran in, which is the clone or a folder in it once the agent has changed into one."""
        try:
            threads = json.loads((self.state_dir / (f"last-good-{self.machine.id}.json")).read_text("utf-8"))["threads"]
        except (OSError, ValueError, KeyError, TypeError):
            return None
        rows: list[RawRow] = [
            row
            for row in threads
            if isinstance(row, dict)
            and in_clone(row.get("cwd"), clone)
            and row.get("app") in AGENT_APPS
            and isinstance(row.get("_transcript"), str)
        ]
        return max(rows, key=lambda row: row.get("last_message_at") or "") if rows else None


def sender_of(item: JsonObject) -> Sender | None:
    """Whose a FeedbackKit work item or claim is; None when it does not say, or says something unusable."""
    app, login, repo, role = (item.get(key) for key in ("app", "login", "repo", "role"))
    if not (isinstance(app, str) and APP.match(app) and isinstance(login, str) and LOGIN.match(login)):
        return None
    if not (isinstance(repo, str) and REPO.match(repo) and role in ("owner", "builder")):
        return None
    return {"app": app, "login": login, "repo": repo, "role": str(role)}


def name_of(item: JsonObject) -> str | None:
    """How the sender's app names them ("Jai"), when the work item says: at most 60 characters on one line."""
    name = item.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 60 or "\n" in name or "\r" in name:
        return None
    return name.strip()


def clone_path(repo: str, chat: str) -> str:
    """A chat's own full clone, as chats started before 2026-11-14 have: ~/Developer/<repo name>_fb-<8 hex of its id>."""
    return f"{CLONES}/{repo.split('/')[-1]}_fb-{chat[3:11]}"


def project_path(app: str) -> str:
    """The app's feedback project on a builder: one clone every chat of the app makes its worktree from."""
    return f"{CLONES}/feedback-{app}"


def project_name(app: str) -> str:
    """The project's name in Orca: "Feedback Agent Pager", "Feedback PR Hub"."""
    return "Feedback " + app_name(app)


def worktree_name(chat: str) -> str:
    """The chat's worktree and branch: fb-<8 hex of its id>."""
    return f"fb-{chat[3:11]}"


def first_screenshots(app: str, chat: str) -> str:
    """Where a chat's first screenshots go: its worktree does not exist until the agent is launched in it."""
    return f"{project_path(app)}/tmp/feedback/{worktree_name(chat)}"


def in_clone(cwd: object, clone: str) -> bool:
    """The clone itself or a folder inside it; not a sibling whose name only starts the same."""
    return isinstance(cwd, str) and (cwd == clone or cwd.startswith(clone.rstrip("/") + "/"))


class Builder(NamedTuple):
    host: str
    name: str
    orca: Orca
    cube: Cube


class Runner:
    def __init__(
        self,
        api: FeedbackApi,
        builders: list[Builder],
        reader: ConversationReader,
        state_path: Path,
        deliver: Deliver,
        clock: Callable[[], float] = time.time,
        kick: Callable[[], str] = lambda: "skipped",
        check_queue: CheckQueue | None = None,
        github: GitHub | None = None,
    ) -> None:
        """`deliver` and `check_queue` are Agent Pager's reply_delivery.deliver_on_machine, `kick` its
        scan_kick.kickstart_scan (agent_pager.py); a test's stand-ins otherwise."""
        self.api = api
        self.builders = {builder.host: builder for builder in builders}
        self.first_host = builders[0].host
        self.reader = reader
        self.state_path = state_path
        self.deliver = deliver
        self.clock = clock
        self.kick = kick
        self.check_queue = check_queue or deliver
        self.github = github or GitHub()
        self.state: RunnerState
        try:
            self.state = json.loads(state_path.read_text("utf-8"))  # the runner's own file, as save() wrote it
        except FileNotFoundError:
            self.state = {"chats": {}, "journal": {}}
        for known in self.state["chats"].values():
            known.setdefault("host", self.first_host)  # chats from before the fallback all ran on Cube 03
            known.setdefault("layout", "clone")  # chats from before worktrees each had a full clone
        self.waiting: set[str] = set()
        # Chats with a message the Worker still holds or the runner has not reported: not tidied.
        self.owed: set[str] = set()
        # Each builder's agents at the last full tick, and why each down one did not answer: what a fast tick uses.
        self.last_agents: dict[str, dict[str, JsonObject] | None] | None = None
        self.last_down: list[str] = []
        # The last poll (when, whether the Worker answered, why not) and its work: for status().
        self.last_poll: JsonObject | None = None
        self.last_work: list[JsonObject] = []

    def save(self) -> None:
        write_private_json(self.state_path, self.state)

    def tick(self, fast: bool = False, between: Callable[[], None] | None = None) -> list[str]:
        """One poll: report what is owed, take what is pending, look at each chat's agent, tidy what is done. The
        builder is online while any builder's Orca answers; None in `agents` is a builder whose Orca did not.

        A fast tick, run as the Worker wakes the runner for a new message, only polls and takes, with the builders'
        agents from the last full tick: the message reaches its thread in about a second. The full tick still runs
        every 15 s (service.py). Reading every chat's agent can take half a minute, so a full tick calls `between`
        after each chat: there the service runs a fast tick if a message woke it meanwhile."""
        lines: list[str] = []
        if fast and self.last_agents is not None:
            return self.take_pending(self.last_agents, self.last_down, lines)
        agents: dict[str, dict[str, JsonObject] | None] = {}
        down: list[str] = []
        for builder in self.builders.values():
            found = _agents_or_failure(builder.orca)
            if isinstance(found, RuntimeError):
                agents[builder.host] = None
                down.append(f"{builder.name}: {found}")
                lines.append(f"FEEDBACK_ORCA_DOWN host={builder.host} {found}")
            else:
                agents[builder.host] = found
        self.last_agents, self.last_down = agents, down
        self.post_owed()
        self.waiting, self.owed = set(), set()
        self.take_pending(agents, down, lines)
        if any(found is not None for found in agents.values()):
            for chat in list(self.state["chats"]):
                if chat not in self.state["chats"]:
                    continue
                line = self.look(chat, agents)
                if line:
                    lines.append(line)
                if between:
                    between()
        self.prune()
        self.save()
        return lines

    def take_pending(
        self, agents: dict[str, dict[str, JsonObject] | None], down: list[str], lines: list[str]
    ) -> list[str]:
        """Poll and take: a full tick's first half, and all of a fast one. It adds to what is waiting and owed, so a fast
        tick in the middle of a full one leaves the full one's view whole."""
        online = any(found is not None for found in agents.values())
        try:
            work = self.api.poll(online, None if online else "; ".join(down))
        except FeedbackApiError as failure:
            self.last_poll = {"at": self.clock(), "ok": False, "error": str(failure)[:DETAIL_MAX]}
            raise
        self.last_poll = {"at": self.clock(), "ok": True, "error": None}
        self.last_work = work
        self.owed |= {str(item.get("chat")) for item in work}
        # A test app's messages need no builder: they are answered while every builder is down too.
        for item in sorted(work, key=_arrival):
            line = self.echo(item) if item.get("echo") else self.take(item, agents) if online else None
            if line:
                lines.append(line)
        if online:
            self.owed |= {key.split("/", 1)[0] for key, entry in self.state["journal"].items() if not entry["posted"]}
        self.save()
        return lines

    def post_owed(self) -> None:
        """Report terminal outcomes, checking Orca's own queue without sending the message again."""
        for key, entry in self.state["journal"].items():
            if entry.get("posted"):
                continue
            outcome: Outcome = entry.get("outcome") or {
                "status": "failed",
                "how": None,
                "detail": "The builder stopped while passing this on. Check the chat before sending again.",
            }
            chat, message = key.split("/", 1)
            if outcome["status"] == "queued":
                outcome = self.check_queued(chat, entry, outcome)
                if outcome["status"] != "delivered":
                    continue
                entry["outcome"] = outcome
                self.save()
            self.post_result(chat, message, entry, outcome)

    def check_queued(self, chat: str, entry: JournalEntry, outcome: Outcome) -> Outcome:
        """Old journals have only the queue id: recover its target from the chat's thread, then keep it."""
        known = self.state["chats"].get(chat)
        builder = self.builders.get(known["host"]) if known else None
        if builder is None:
            return outcome
        job = entry.get("queue")
        if job is None:
            thread = builder.cube.thread(known["clone"]) if known else None
            queued_id = outcome.get("queued_id")
            if thread is None or not queued_id:
                return outcome
            job = {"app": thread["app"], "session_id": thread["session_id"], "queue": "check", "queued_id": queued_id}
            entry["queue"] = job
            self.save()
        checked = self.check_queue(builder.cube.machine, job)
        # An unavailable queue is no proof the message was taken. Keep it and check next time; polling still goes on.
        return checked if checked["status"] == "delivered" else outcome

    def post_result(self, chat: str, message: str, entry: JournalEntry, outcome: Outcome) -> None:
        """FeedbackKit accepts delivered or failed; queued messages stay in the journal until Orca takes them."""
        if outcome["status"] == "queued":
            return
        if outcome["status"] != "delivered":
            outcome = {"status": "failed", "how": outcome.get("how"), "detail": outcome.get("detail")}
        try:
            self.api.result(chat, message, outcome, entry.get("sender") or self.sender(chat))
            entry["outcome"], entry["posted"] = outcome, True
        except FeedbackApiError as failure:
            LOG.warning(
                json.dumps({"event": "feedback_result_post_failed", "chat": chat, "reason": str(failure)[:200]})
            )

    def sender(self, chat: str) -> Sender | None:
        """Whose a chat this runner watches is."""
        known = self.state["chats"].get(chat)
        return known.get("sender") if known else None

    def host_of(self, chat: str, clone: str, first: bool, agents: dict[str, dict[str, JsonObject] | None]) -> str:
        """Where the chat runs: where it started; a new chat on the first builder that answers; a chat this runner has
        no record of where the last scan found its clone, else the first builder."""
        known = self.state["chats"].get(chat)
        if known:
            return known["host"]
        if first:
            return next(host for host in self.builders if agents[host] is not None)
        return next((host for host, builder in self.builders.items() if builder.cube.thread(clone)), self.first_host)

    def take(self, item: JsonObject, agents: dict[str, dict[str, JsonObject] | None]) -> str | None:
        chat, message = str(item.get("chat")), str(item.get("message"))
        key = f"{chat}/{message}"
        if key in self.state["journal"]:
            return None
        known = self.state["chats"].get(chat)
        sender = sender_of(item)
        if sender is None:
            return f"FEEDBACK chat={chat} message={message} outcome=skipped reason=no-sender"
        clone = known["clone"] if known else clone_path(sender["repo"], chat)
        host = self.host_of(chat, clone, bool(item.get("first")), agents)
        if agents.get(host) is None:
            self.waiting.add(chat)
            return None
        builder = self.builders[host]
        if not item.get("first"):
            thread = builder.cube.thread(clone)
            if thread is None and known and self.clock() - known["launched_at"] < THREAD_WAIT_SECONDS:
                return None
        claimed = self.api.claim(chat, message, sender)
        if claimed is None:
            return f"FEEDBACK chat={chat} message={message} outcome=skipped reason=not-pending"
        self.state["journal"][key] = {"claimed_at": self.clock(), "outcome": None, "posted": False, "sender": sender}
        self.save()
        outcome: Outcome
        try:
            who = name_of(item) or sender["login"]
            if claimed.get("first"):
                outcome = self.start(builder, chat, message, claimed, sender, who)
            else:
                outcome = self.tell(builder, chat, message, clone, claimed, sender, who)
        except (RuntimeError, ValueError) as failure:
            outcome = {"status": "failed", "how": None, "detail": str(failure)[:300]}
        entry = self.state["journal"][key]
        entry["outcome"] = outcome
        self.save()
        self.post_result(chat, message, entry, outcome)
        return "FEEDBACK chat={} message={} first={} outcome={} detail={}".format(
            chat,
            message,
            bool(claimed.get("first")),
            outcome["status"],
            outcome.get("detail") or "-",
        )

    def echo(self, item: JsonObject) -> str | None:
        """A test app's message (docs/api.md#the-test-app), answered here: the reply `echo: <text>`, then delivered.
        No coding agent, worktree, issue or brief. Claimed and journalled as any message is, so it is answered once."""
        chat, message = str(item.get("chat")), str(item.get("message"))
        key = f"{chat}/{message}"
        if key in self.state["journal"]:
            return None
        sender = sender_of(item)
        if sender is None:
            return f"FEEDBACK chat={chat} message={message} outcome=skipped reason=no-sender"
        claimed = self.api.claim(chat, message, sender)
        if claimed is None:
            return f"FEEDBACK chat={chat} message={message} outcome=skipped reason=not-pending"
        entry: JournalEntry = {"claimed_at": self.clock(), "outcome": None, "posted": False, "sender": sender}
        self.state["journal"][key] = entry
        self.save()
        replies = self.state.setdefault("echoes", {}).setdefault(chat, [])
        replies.append({
            "id": f"echo-{message}",
            "text": f"echo: {claimed.get('text') or ''}",
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.clock())),
        })
        del replies[:-MAX_AGENT_MESSAGES]
        side: JsonObject = {"messages": replies, "isWorking": False, "activity": None, "thread": None}
        outcome: Outcome
        try:
            answered = self.api.agent(chat, side, sender)
            outcome = (
                {"status": "delivered", "how": "echo", "detail": None}
                if answered
                else {"status": "failed", "how": "echo", "detail": "The chat is gone."}
            )
        except FeedbackApiError as failure:
            outcome = {"status": "failed", "how": "echo", "detail": str(failure)[:300]}
        entry["outcome"] = outcome
        self.save()
        self.post_result(chat, message, entry, outcome)
        return f"FEEDBACK chat={chat} message={message} echo=true outcome={outcome['status']}"

    def start(
        self, builder: Builder, chat: str, message: str, claimed: JsonObject, sender: Sender, who: str = ""
    ) -> Outcome:
        """The app's feedback project on the builder (cloned, fetched and added to Orca the first time), the
        screenshots under its tmp/, and one `orca worktree create` that makes the chat's worktree and launches Claude.
        `who` is how the sender's app names them, else their login."""
        base, name = project_path(sender["app"]), worktree_name(chat)
        builder.cube.clone(base, sender["repo"])
        project = builder.orca.project(base, project_name(sender["app"]))
        paths = builder.cube.save_images(first_screenshots(sender["app"], chat), message, claimed.get("images") or [])
        prompt = first_prompt(
            fields(
                sender["app"],
                who or sender["login"],
                sender["role"],
                sender["repo"],
                str(claimed.get("build") or ""),
                paths,
                str(claimed.get("text") or ""),
            )
        )
        worktree = builder.orca.create(project, name, prompt)
        now = self.clock()
        self.state["chats"][chat] = {
            "host": builder.host,
            "clone": worktree,
            "layout": "worktree",
            "launched_at": now,
            "last_activity": now,
            "told_at": now,
            "cursor": None,
            "messages": [],
            "posted": None,
            "removed": False,
            "sender": sender,
            "title": str(claimed.get("title") or ""),
        }
        self.kick()
        return {"status": "delivered", "how": "orca_launch", "detail": None}

    def tell(
        self,
        builder: Builder,
        chat: str,
        message: str,
        clone: str,
        claimed: JsonObject,
        sender: Sender,
        who: str = "",
    ) -> Outcome:
        """Into the chat's Orca chat, as a thread reply goes. A full clone tidied away before worktrees is made again;
        a worktree tidied away is not, as Orca stopped its chat with it."""
        known = self.state["chats"].setdefault(
            chat,
            {
                "host": builder.host,
                "clone": clone,
                "layout": "clone",
                "launched_at": self.clock(),
                "cursor": None,
                "messages": [],
                "posted": None,
                "removed": False,
                "sender": sender,
            },
        )
        if claimed.get("title") and not known.get("title"):
            known["title"] = str(claimed["title"])  # chats from before titles were kept get theirs here
        if known.get("removed") and known["layout"] == "worktree":
            return {"status": "failed", "how": None, "detail": TIDIED}
        thread = builder.cube.thread(clone)
        if thread is None:
            return {
                "status": "failed",
                "how": None,
                "detail": f"The agent's chat is not on {builder.name} any more. Start new feedback instead.",
            }
        if known.get("removed"):
            builder.cube.clone(clone, sender["repo"])
            known["removed"] = False
        paths = builder.cube.save_images(f"{clone}/tmp/feedback", message, claimed.get("images") or [])
        text = (
            later_prefix(sender["app"], who or sender["login"])
            + str(claimed.get("text") or "")
            + (image_note(paths, who or sender["login"]) if paths else "")
        )
        job: DeliveryJob = {"app": thread["app"], "session_id": thread["session_id"], "cwd": clone, "text": text}
        outcome = self.deliver(builder.cube.machine, job)
        queued_id = outcome.get("queued_id")
        if outcome["status"] == "queued" and queued_id:
            self.state["journal"][f"{chat}/{message}"]["queue"] = {
                "app": thread["app"],
                "session_id": thread["session_id"],
                "queue": "check",
                "queued_id": queued_id,
            }
        known["last_activity"] = known["told_at"] = self.clock()
        return outcome

    def look(self, chat: str, agents: dict[str, dict[str, JsonObject] | None]) -> str | None:
        """The agent's side from Orca's live state and its transcript, sent when it changed; then tidy if done. While
        the chat's builder is down, a reply to it waits and the side says so."""
        known = self.state["chats"][chat]
        if known.get("removed"):
            return self.look_tidied(chat, known, agents)
        builder = self.builders.get(known["host"])
        if builder is None:
            return None
        thread = builder.cube.thread(known["clone"])
        where: JsonObject | None = {"host": builder.host, "id": thread["id"]} if thread else None
        now = self.clock()
        live = agents.get(builder.host)
        if live is None:
            waiting = chat in self.waiting
            side: JsonObject = {
                "messages": known["messages"],
                "isWorking": waiting,
                "activity": f"Waiting for {builder.name} to come back" if waiting else None,
                "thread": where,
            }
            return self.post_side(chat, known, with_shipped(side, known), now)
        agent = live.get(known["clone"]) or {}
        working = agent.get("state") == "working" or now - known.get("told_at", 0) < STARTING_SECONDS
        if thread is not None:
            try:
                self.read_messages(builder, known, thread)
            except RuntimeError as failure:
                return f"FEEDBACK_READ_FAILED chat={chat} {failure}"
        if working:
            known["last_activity"] = self.clock()
        shipped_line = self.refresh_shipped(builder, chat, known)
        side = {
            "messages": known["messages"],
            "isWorking": working,
            "activity": ACTIVITIES.get(str(agent.get("toolName")), "Working") if working else None,
            "thread": where,
        }
        dropped = self.post_side(chat, known, with_shipped(side, known), now)
        if dropped:
            return dropped
        quiet = self.clock() - known.get("last_activity", known["launched_at"])
        if not working and chat not in self.owed and quiet > TIDY_AFTER_SECONDS:
            return self.tidy(builder, chat, known)
        return shipped_line

    def look_tidied(self, chat: str, known: ChatState, agents: dict[str, dict[str, JsonObject] | None]) -> str | None:
        """A tidied chat: what it shipped, looked for hourly from its app's project clone while anything is still to
        come (a release, a check, an open pull request), and sent with its last words."""
        builder = self.builders.get(known["host"])
        if builder is None or agents.get(builder.host) is None or not unsettled(known):
            return None
        line = self.refresh_shipped(builder, chat, known)
        side: JsonObject = {
            "messages": known["messages"],
            "isWorking": False,
            "activity": None,
            "thread": known.get("thread"),
        }
        return self.post_side(chat, known, with_shipped(side, known), self.clock()) or line

    def refresh_shipped(self, builder: Builder, chat: str, known: ChatState) -> str | None:
        """What the chat shipped, when it is time to look again; a log line when the builder could not say, and the
        last answer kept."""
        every = SHIPPED_TIDIED_EVERY_SECONDS if known.get("removed") else SHIPPED_EVERY_SECONDS
        sender = known.get("sender")
        if sender is None or self.clock() - known.get("shipped_at", 0) < every:
            return None
        known["shipped_at"] = self.clock()
        # A chat from before worktrees had its own clone; once it is gone, its commits are asked about in the project.
        project = project_path(sender["app"])
        try:
            found = builder.cube.shipped(known["clone"], project, known.get("shipped_shas", []), known.get("branch"))
            listed = found.get("commits")
            commits = [one for one in listed if isinstance(one, dict) and one.get("sha")] if isinstance(listed, list) else []
            branch = found.get("branch") if isinstance(found.get("branch"), str) else known.get("branch")
            known["shipped"] = self.github.shipped(sender["repo"], commits, branch or None)
        except RuntimeError as failure:
            return f"FEEDBACK_SHIPPED_FAILED chat={chat} {str(failure)[:200]}"
        known["shipped_shas"] = [str(one["sha"]) for one in commits]
        if branch:
            known["branch"] = branch
        return None

    def tidy(self, builder: Builder, chat: str, known: ChatState) -> str:
        """A quiet chat's worktree out of Orca and git once its work is pushed; else kept, and asked again in a day.
        A full clone from before worktrees is left for Jai: removing its folder would leave its Orca project behind."""
        folder = known["clone"]
        if known["layout"] == "clone":
            known["last_activity"] = self.clock()
            return f"FEEDBACK_CLONE_KEPT chat={chat} clone={folder} reason=a full clone from before worktrees; Jai removes it"
        try:
            there = builder.cube.check_pushed(folder)
            if there:
                builder.orca.remove(folder)
        except RuntimeError as failure:
            known["last_activity"] = self.clock()
            return f"FEEDBACK_WORKTREE_KEPT chat={chat} worktree={folder} reason={failure}"
        known["removed"] = True
        done = "FEEDBACK_WORKTREE_REMOVED" if there else "FEEDBACK_WORKTREE_GONE"
        sender = known.get("sender")
        if sender:
            try:
                builder.cube.remove_folder(first_screenshots(sender["app"], chat))
            except RuntimeError as failure:
                return f"{done} chat={chat} worktree={folder} screenshots-kept={failure}"
        return f"{done} chat={chat} worktree={folder}"

    def post_side(self, chat: str, known: ChatState, side: JsonObject, now: float) -> str | None:
        """Sends the agent's side when it changed, or a minute after the last send; a chat the Worker does not have
        is dropped, with a log line."""
        known["working"], known["activity"] = bool(side.get("isWorking")), _text_or_none(side.get("activity"))
        if isinstance(side.get("thread"), dict):
            known["thread"] = json_object(side["thread"])
        digest = hashlib.sha256(json.dumps(side, sort_keys=True).encode("utf-8")).hexdigest()
        if digest != known.get("posted") or now - known.get("posted_at", 0) > RESEND_SECONDS:
            if not self.api.agent(chat, side, known.get("sender")):
                del self.state["chats"][chat]
                return f"FEEDBACK_CHAT_DROPPED chat={chat} the Worker has no such chat; no longer watched"
            known["posted"], known["posted_at"] = digest, now
        return None

    def read_messages(self, builder: Builder, known: ChatState, thread: RawRow) -> None:
        """The agent's words since the last read, page by page, oldest first."""
        cursor = known.get("cursor") or "0.0.0"
        for _ in range(READ_PAGES):
            answer = self.reader.read(builder.cube.machine, thread["app"], thread["_transcript"], 200, after=cursor)
            next_cursor, messages = answer.get("cursor"), answer.get("messages")
            if not isinstance(next_cursor, str) or not isinstance(messages, list):
                raise RuntimeError("read output unreadable: no cursor or messages")
            cursor = next_cursor
            known["messages"] += [
                {"id": item["id"], "text": item["text"], "at": item.get("at")}
                for item in messages
                if item.get("role") == "assistant" and item.get("text")
            ]
            if len(messages) < 200:
                break
        known["messages"] = known["messages"][-MAX_AGENT_MESSAGES:]
        known["cursor"] = cursor

    def prune(self) -> None:
        now = self.clock()
        self.state["journal"] = {
            key: entry
            for key, entry in self.state["journal"].items()
            if not entry.get("posted") or now - entry["claimed_at"] < JOURNAL_KEPT_SECONDS
        }
        journalled = {key.split("/", 1)[0] for key in self.state["journal"]}
        if "echoes" in self.state:
            self.state["echoes"] = {chat: replies for chat, replies in self.state["echoes"].items() if chat in journalled}

    def status(self) -> JsonObject:
        """What the runner knows, for status.json (docs: runner/README.md#statusjson): the last poll, each builder, and
        each chat with its thread and its messages' states. A message's state is the runner's view: `pending` (in the
        last poll's work), `delivering` (claimed, no outcome yet), `queued` (Orca holds it), `delivered` or `failed`,
        and `posted` says whether the Worker has the outcome."""
        builders = [
            {
                "host": host,
                "name": builder.name,
                "up": self.last_agents is not None and self.last_agents.get(host) is not None,
                "detail": next((down for down in self.last_down if down.startswith(builder.name + ":")), None),
            }
            for host, builder in self.builders.items()
        ]
        messages: dict[str, list[JsonObject]] = {}
        for key, entry in self.state["journal"].items():
            chat, message = key.split("/", 1)
            outcome = entry.get("outcome")
            messages.setdefault(chat, []).append(
                {
                    "id": message,
                    "state": outcome["status"] if outcome else "delivering",
                    "detail": outcome.get("detail") if outcome else None,
                    "at": entry["claimed_at"],
                    "posted": bool(entry.get("posted")),
                }
            )
        journalled = set(self.state["journal"])
        for item in self.last_work:
            chat, message = str(item.get("chat")), str(item.get("message"))
            if f"{chat}/{message}" not in journalled:
                at = _arrival(item) / 1000 or None
                messages.setdefault(chat, []).append(
                    {"id": message, "state": "pending", "detail": None, "at": at, "posted": False}
                )
        chats: list[JsonObject] = []
        for chat in set(self.state["chats"]) | set(messages):
            known = self.state["chats"].get(chat)
            sender = (known.get("sender") if known else None) or next(
                (sender_of(item) for item in self.last_work if item.get("chat") == chat), None
            )
            mine = sorted(messages.get(chat, []), key=lambda one: float(str(one.get("at") or 0)))
            chats.append(
                {
                    "chat": chat,
                    "app": sender["app"] if sender else None,
                    "login": sender["login"] if sender else None,
                    "title": known.get("title") if known else None,
                    "host": known["host"] if known else None,
                    "thread": known.get("thread") if known else None,
                    "worktree": known["clone"] if known else None,
                    "removed": bool(known.get("removed")) if known else False,
                    "working": bool(known.get("working")) if known else False,
                    "activity": known.get("activity") if known else None,
                    "last_activity": (known.get("last_activity") or known["launched_at"]) if known else None,
                    "messages": mine[-STATUS_MESSAGES:],
                }
            )
        chats.sort(key=lambda one: -max([float(str(one.get("last_activity") or 0))] + _ats(one)))
        return {"poll": self.last_poll, "builders": builders, "chats": chats}


def with_shipped(side: JsonObject, known: ChatState) -> JsonObject:
    """The side with what the chat shipped, once the runner has looked; without it the Worker keeps none."""
    return {**side, "shipped": known["shipped"]} if "shipped" in known else side


def unsettled(known: ChatState) -> bool:
    """Whether what a tidied chat shipped can still change: a commit in no release or with checks running, or a pull
    request open or with checks running. Never looked for: worth one look."""
    shipped = known.get("shipped")
    if shipped is None:
        return True
    commits = [one for one in shipped.get("commits") or [] if isinstance(one, dict)]
    prs = [one for one in shipped.get("prs") or [] if isinstance(one, dict)]
    return any(one.get("release") is None or one.get("ci") == "pending" for one in commits) or any(
        one.get("state") == "open" or one.get("ci") == "pending" for one in prs
    )


def _ats(chat: JsonObject) -> list[float]:
    found = chat.get("messages")
    return [float(str(one.get("at") or 0)) for one in found if isinstance(one, dict)] if isinstance(found, list) else []


def _text_or_none(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _agents_or_failure(orca: Orca) -> dict[str, JsonObject] | RuntimeError:
    """The builder's Orca agents, or why its Orca did not answer."""
    try:
        return orca.agents()
    except RuntimeError as failure:
        return failure


def _arrival(item: JsonObject) -> float:
    """When the Worker took a message in, to take them in order; 0 for none."""
    at = item.get("at")
    return float(at) if isinstance(at, (int, float)) else 0.0


def last_line(text: str) -> str:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    return lines[-1] if lines else ""


def migrate(old_dir: Path, state_dir: Path) -> str | None:
    """Once: Agent Pager's hub.feedback_runner state (OLD_STATE_FILE in its state folder) becomes this runner's
    STATE_FILE as it is, so running chats keep their coding threads and claimed messages their journal; the old file is
    renamed `.migrated`. Nothing happens when STATE_FILE is there already: it is never overwritten."""
    old, path = old_dir / OLD_STATE_FILE, state_dir / STATE_FILE
    if path.exists() or not old.exists():
        return None
    moved: RunnerState = json.loads(old.read_text("utf-8"))
    if not isinstance(moved.get("chats"), dict) or not isinstance(moved.get("journal"), dict):
        raise ValueError(f"{old} is not the runner's state")
    write_private_json(path, moved)
    old.rename(old.with_name(OLD_STATE_FILE + ".migrated"))
    return "FEEDBACK_STATE_MIGRATED chats={:d} journal={:d}".format(len(moved["chats"]), len(moved["journal"]))