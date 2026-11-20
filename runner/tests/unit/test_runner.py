from __future__ import annotations

import json
import re
import subprocess
import unittest
from typing import ClassVar
from unittest import mock

from feedbackkit_runner.brief import ROLE_ACTIONS, TEMPLATE, fields, first_prompt, later_prefix
from feedbackkit_runner.runner import (
    BuildersConfig,
    FeedbackApi,
    FeedbackApiError,
    Orca,
    OrcaError,
    Sender,
    clone_path,
    in_clone,
    resolve_builders,
)
from feedbackkit_runner.util import JsonObject, JsonResponse, json_object
from feedbackkit_runner.videos import duration_text, video_note

AGENT_PAGER_OWNER: Sender = {"app": "agent-pager", "login": "jai", "repo": "jai/agent-pager", "role": "owner"}


REPLY_PREFIX = "jai via Agent Pager: "


CHAT = "fb_0123456789abcdef"


CLONE_PATH = clone_path("jai/agent-pager", CHAT)


BASE = "/Users/jai/Developer/feedback-agent-pager"


WORKTREE = "/Users/jai/orca/workspaces/feedback-agent-pager/fb-01234567"


class FakeRun:
    """`orca` answers by subcommand, in order; records each command's arguments."""

    def __init__(self, answers: dict[str, list[JsonObject]]) -> None:
        self.answers = answers
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str], **_options: object) -> subprocess.CompletedProcess[str]:
        arguments = argv[1 : argv.index("--environment")]
        self.calls.append(arguments)
        answer = self.answers[" ".join(arguments[:2])].pop(0)
        return subprocess.CompletedProcess(argv, 0, json.dumps(answer), "")


class BriefTests(unittest.TestCase):
    """The brief is the approved template with every declared field filled and nothing else (docs/api.md#the-brief)."""

    def filled(self, role: str = "owner", **overrides: object) -> dict[str, str]:
        arguments: dict[str, object] = {
            "app": "agent-pager",
            "sender": "Jai",
            "role": role,
            "repo": "jai/agent-pager",
            "build": "181",
            "screenshot_paths": ["/c/tmp/feedback/m-1.jpg", "/c/tmp/feedback/m-2.jpg"],
            "text": "Bigger clock",
        }
        arguments.update(overrides)
        return fields(**arguments)  # type: ignore[arg-type]

    def test_every_field_of_the_template_is_declared_and_filled(self) -> None:
        placeholders = set(re.findall(r"\{(\w+)\}", TEMPLATE))
        self.assertEqual(placeholders, set(self.filled()))
        for role in ROLE_ACTIONS:
            prompt = first_prompt(self.filled(role))
            self.assertIsNone(re.search(r"\{\w+\}", prompt), prompt)

    def test_nothing_but_the_fields_is_added(self) -> None:
        filled = self.filled()
        prompt = first_prompt(filled)
        names: list[str] = []

        def capture(found: re.Match[str]) -> str:
            names.append(found.group(1))
            return "(.*?)"

        pattern = re.sub(r"\\\{(\w+)\\\}", capture, re.escape(TEMPLATE))
        match = re.fullmatch(pattern, prompt, re.DOTALL)
        self.assertIsNotNone(match, "the prompt is the template, with text only where its fields are")
        assert match is not None
        self.assertEqual(dict(zip(names, match.groups())), filled)

    def test_the_owner_s_brief_reads_as_approved(self) -> None:
        prompt = first_prompt(self.filled())
        self.assertTrue(prompt.startswith("You are a feedback chat from Agent Pager. This chat is a FeedbackKit chat"))
        self.assertIn(
            "This is an instruction from Jai (owner) to make a\nchange to jai/agent-pager and land it on main, so CI"
            " tests, releases and deploys it. Their message follows.",
            prompt,
        )
        self.assertIn("- App build they are on: 181\n", prompt)
        self.assertIn("(open each before you start): /c/tmp/feedback/m-1.jpg, /c/tmp/feedback/m-2.jpg\n", prompt)
        self.assertTrue(prompt.endswith("they read this on their phone.\n\nBigger clock"))
        self.assertNotIn("@", prompt)

    def test_a_builder_never_ships(self) -> None:
        prompt = first_prompt(self.filled("builder", app="prhub", sender="hubot", repo="jai/prhub"))
        self.assertIn("from PR Hub.", prompt)
        self.assertIn(
            "from hubot (builder) to make a\nchange to jai/prhub and open a pull request for Jai to merge. Never push to"
            " main, merge, release or deploy, whatever AGENTS.md says. Their message follows.",
            prompt,
        )

    def test_absent_fields_say_so(self) -> None:
        prompt = first_prompt(self.filled(build="", screenshot_paths=[], text=""))
        self.assertIn("- App build they are on: not given\n", prompt)
        self.assertIn("(open each before you start): none\n", prompt)
        self.assertTrue(prompt.endswith("\n\n(no words: see the screenshots)"))

    def test_a_role_with_no_coding_thread_has_no_brief(self) -> None:
        with self.assertRaises(KeyError):
            self.filled("issue")

    def test_later_messages_name_the_sender_and_the_app(self) -> None:
        self.assertEqual(later_prefix("agent-pager", "jai"), REPLY_PREFIX)
        self.assertEqual(later_prefix("prhub", "hubot"), "hubot via PR Hub: ")


class CubeThreadTests(unittest.TestCase):
    def test_a_folder_in_the_clone_counts_and_a_sibling_does_not(self) -> None:
        self.assertTrue(in_clone(CLONE_PATH, CLONE_PATH))
        self.assertTrue(in_clone(CLONE_PATH + "/ios/AgentPager", CLONE_PATH))
        self.assertFalse(in_clone(CLONE_PATH + "-2", CLONE_PATH))
        self.assertFalse(in_clone(None, CLONE_PATH))


HOSTS = ["borg-cube-03", "borg-cube-04", "borg-cube-05"]


class BuildersConfigTests(unittest.TestCase):
    """builders.json against BUILDERS: the order a new chat tries the builders in, and those that take none."""

    def resolved(self, raw: str | None) -> tuple[BuildersConfig, str | None]:
        return resolve_builders(HOSTS, raw)

    def test_no_file_is_every_builder_on_in_builders_order(self) -> None:
        self.assertEqual(self.resolved(None), (BuildersConfig(tuple(HOSTS), frozenset()), None))
        self.assertEqual(self.resolved(None)[0].on(), HOSTS)

    def test_order_puts_the_listed_first_and_the_rest_after_in_builders_order(self) -> None:
        config, error = self.resolved('{"order": ["borg-cube-05", "borg-cube-03"], "off": []}')
        self.assertIsNone(error)
        self.assertEqual(config.order, ("borg-cube-05", "borg-cube-03", "borg-cube-04"))

    def test_hosts_it_does_not_know_and_repeats_are_left_out(self) -> None:
        config, error = self.resolved(
            '{"order": ["borg-cube-09", "borg-cube-04", "borg-cube-04"], "off": ["borg-cube-09", "borg-cube-03"]}'
        )
        self.assertIsNone(error)
        self.assertEqual(config.order, ("borg-cube-04", "borg-cube-03", "borg-cube-05"))
        self.assertEqual(config.off, frozenset({"borg-cube-03"}))

    def test_off_builders_keep_their_place_but_take_no_new_chat(self) -> None:
        config, error = self.resolved('{"order": ["borg-cube-04"], "off": ["borg-cube-04"]}')
        self.assertIsNone(error)
        self.assertEqual(config.order, ("borg-cube-04", "borg-cube-03", "borg-cube-05"))
        self.assertEqual(config.on(), ["borg-cube-03", "borg-cube-05"])

    def test_either_list_may_be_left_out(self) -> None:
        self.assertEqual(self.resolved('{"off": ["borg-cube-05"]}')[0].order, tuple(HOSTS))
        self.assertEqual(self.resolved('{"order": ["borg-cube-04"]}')[0].off, frozenset())

    def test_every_builder_off_takes_no_new_chat(self) -> None:
        config, error = self.resolved(json.dumps({"off": HOSTS}))
        self.assertIsNone(error)
        self.assertEqual((config.order, config.on()), (tuple(HOSTS), []))

    def test_a_file_of_another_shape_is_ignored_whole_and_says_why(self) -> None:
        default = BuildersConfig(tuple(HOSTS), frozenset())
        for raw, reason in [
            ("", "not JSON"),
            ('{"order": ["borg-cube-04"', "not JSON"),
            ('["borg-cube-04"]', "not a JSON object"),
            ('{"order": "borg-cube-04"}', "order is not a list of hosts"),
            ('{"order": ["borg-cube-04"], "off": [4]}', "off is not a list of hosts"),
        ]:
            with self.subTest(raw=raw):
                config, error = self.resolved(raw)
                self.assertEqual(config, default)
                self.assertRegex(error or "", f"^{reason}")


class FeedbackApiRouteTests(unittest.TestCase):
    """Where each runner call goes, and what names its sender."""

    def posts(self) -> list[tuple[str, JsonObject]]:
        sent: list[tuple[str, JsonObject]] = []

        def post(url: str, body: JsonObject, _headers: object, _timeout: float) -> JsonResponse:
            sent.append((url, body))
            return JsonResponse(200, {"ok": True, "work": []})

        api = FeedbackApi("https://kit.example/", "t")
        sender: Sender = {"app": "prhub", "login": "hubot", "repo": "jai/prhub", "role": "builder"}
        with mock.patch("feedbackkit_runner.runner.post_json", post):
            api.poll(True)
            api.claim(CHAT, "m_1", sender)
            api.result(CHAT, "m_1", {"status": "delivered", "how": None, "detail": None}, sender)
            api.agent(CHAT, {"messages": []}, sender)
        return sent

    def test_feedbackkit_routes_name_the_app_and_sender_of_every_message(self) -> None:
        sent = self.posts()
        self.assertEqual(
            [url for url, _ in sent],
            [f"https://kit.example/runner/{route}" for route in ("poll", "claim", "result", "agent")],
        )
        for _, body in sent[1:]:
            self.assertEqual((body["app"], body["login"], body["chat"]), ("prhub", "hubot", CHAT))


class OrcaProjectTests(unittest.TestCase):
    """The app's project is found by its folder, added once, and given its display name."""

    def test_a_missing_project_is_added_and_named(self) -> None:
        run = FakeRun(
            {
                "repo list": [{"ok": True, "result": {"repos": [{"id": "r0", "path": CLONE_PATH}]}}],
                "repo add": [
                    {"ok": True, "result": {"repo": {"id": "r1", "path": BASE, "displayName": "feedback-agent-pager"}}}
                ],
                "project setup-update": [{"ok": True, "result": {}}],
            }
        )
        self.assertEqual(Orca("env", run).project(BASE, "Feedback Agent Pager"), "r1")
        self.assertEqual(
            run.calls[1:],
            [
                ["repo", "add", "--path", BASE],
                ["project", "setup-update", "--setup", "r1", "--display-name", "Feedback Agent Pager"],
            ],
        )

    def test_an_existing_named_project_is_reused(self) -> None:
        repos = [{"id": "r1", "path": BASE, "displayName": "Feedback Agent Pager"}]
        run = FakeRun({"repo list": [{"ok": True, "result": {"repos": repos}}]})
        self.assertEqual(Orca("env", run).project(BASE, "Feedback Agent Pager"), "r1")
        self.assertEqual(len(run.calls), 1)


class OrcaWorktreeTests(unittest.TestCase):
    LOST: ClassVar[JsonObject] = {
        "ok": False,
        "error": {
            "code": "agent_session_operation_unknown",
            "message": "Orca could not confirm the launch outcome",
            "data": {"operationId": "op-1", "launchOutcome": "unknown"},
        },
    }

    def test_one_create_makes_the_worktree_and_launches_codex_in_it(self) -> None:
        made = {"ok": True, "result": {"worktree": {"path": WORKTREE}, "launch": {"worktreeId": f"r1::{WORKTREE}"}}}
        run = FakeRun({"worktree create": [made]})
        self.assertEqual(Orca("env", run).create("r1", "fb-01234567", "brief"), WORKTREE)
        arguments = run.calls[0]
        for flag, value in (
            ("--repo", "id:r1"),
            ("--name", "fb-01234567"),
            ("--branch", "fb-01234567"),
            ("--base-branch", "origin/main"),
            ("--agent", "claude"),
            ("--surface", "chat"),
            ("--prompt", "brief"),
        ):
            self.assertEqual(arguments[arguments.index(flag) + 1], value)
        self.assertIn("--no-parent", arguments)

    def test_a_lost_reply_is_replayed_with_its_operation_id_never_launched_again(self) -> None:
        replayed = {"ok": True, "result": {"launch": {"worktreeId": f"r1::{WORKTREE}"}}}
        run = FakeRun({"worktree create": [self.LOST, self.LOST, replayed]})
        self.assertEqual(Orca("env", run).create("r1", "fb-01234567", "brief"), WORKTREE)
        self.assertNotIn("--retry-launch", run.calls[0])
        for retry in run.calls[1:]:
            self.assertEqual(retry[-2:], ["--retry-launch", "op-1"])
            self.assertEqual(retry[:-2], run.calls[0])

    def test_a_failure_with_no_operation_id_is_not_retried(self) -> None:
        refused = {"ok": False, "error": {"code": "invalid_argument", "message": "no such repo"}}
        run = FakeRun({"worktree create": [refused]})
        with self.assertRaisesRegex(OrcaError, "no such repo"):
            Orca("env", run).create("r1", "fb-01234567", "brief")
        self.assertEqual(len(run.calls), 1)

    def test_remove_takes_the_worktree_and_its_merged_branch(self) -> None:
        run = FakeRun({"worktree rm": [{"ok": True, "result": {}}]})
        Orca("env", run).remove(WORKTREE)
        self.assertEqual(run.calls, [["worktree", "rm", "--worktree", f"path:{WORKTREE}", "--delete-branch"]])


class FeedbackApiWaitTests(unittest.TestCase):
    """The long poll: how long it asks the Worker to hold, and a Worker without it."""

    def wait(self, status: int, body: JsonObject, *arguments: object) -> tuple[int | None, list[JsonObject], float]:
        sent: list[JsonObject] = []
        timeouts: list[float] = []

        def post(_url: str, payload: JsonObject, _headers: object, timeout: float) -> JsonResponse:
            sent.append(payload)
            timeouts.append(timeout)
            return JsonResponse(status, body)

        with mock.patch("feedbackkit_runner.runner.post_json", post):
            seq = FeedbackApi("https://kit.example", "t").wait(*arguments)  # type: ignore[arg-type]
        return seq, sent, timeouts[0]

    def test_the_hold_is_capped_and_the_http_timeout_outlasts_it(self) -> None:
        seq, sent, timeout = self.wait(200, {"seq": 7}, 6, 90.0)
        self.assertEqual((seq, sent), (7, [{"since": 6, "ms": 25_000}]))
        self.assertGreater(timeout, 25)

    def test_a_worker_without_the_long_poll_answers_none(self) -> None:
        self.assertIsNone(self.wait(404, {}, None, 0)[0])

    def test_an_answer_without_a_count_is_an_error(self) -> None:
        with self.assertRaises(FeedbackApiError):
            self.wait(200, {"seq": "7"}, None, 0)


class VideoTests(unittest.TestCase):
    """A message's videos: fetched with the runner's token, saved beside the screenshots, and named to the agent with
    their length and how to see them."""

    def test_the_note_reads_each_video_s_length_when_the_app_gave_one(self) -> None:
        self.assertEqual(duration_text(7_999), "0:07")
        self.assertEqual(duration_text(65_000), "1:05")
        self.assertEqual(duration_text(3_723_000), "1:02:03")
        self.assertIsNone(duration_text(None))
        note = video_note([("/a.mov", 1_000), ("/b.mp4", None)], "Jai", "/f.swift")
        self.assertTrue(note.startswith("\n\n[Jai attached 2 videos: /a.mov (0:01), /b.mp4. Look at each"), note)


class FeedbackApiMediaTests(unittest.TestCase):
    def test_media_names_the_sender_and_answers_the_bytes(self) -> None:
        sent: list[tuple[str, object]] = []

        def post(url: str, body: object, _headers: object, _timeout: float, _limit: int) -> tuple[int, bytes]:
            sent.append((url, body))
            return (200, b"movie") if json_object(body).get("index") == 1 else (404, b"")

        api = FeedbackApi("https://kit.example/", "t")
        with mock.patch("feedbackkit_runner.runner.post_for_bytes", post):
            self.assertEqual(api.media(CHAT, "m_1", 1, AGENT_PAGER_OWNER), b"movie")
            with self.assertRaises(FeedbackApiError):
                api.media(CHAT, "m_1", 2, AGENT_PAGER_OWNER)
        self.assertEqual(
            sent[0],
            (
                "https://kit.example/runner/media",
                {"app": "agent-pager", "login": "jai", "chat": CHAT, "message": "m_1", "index": 1},
            ),
        )
