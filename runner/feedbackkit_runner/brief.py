"""The coding thread's first message: FeedbackKit's brief, a template filled from declared fields of the work item and
nothing else (docs/api.md#the-brief; approved by Jai 2026-11-15, v3). Everything else the agent needs comes from the
repo's AGENTS.md and Jai's operator rules, which it already has: it runs in his clone on his Mac.
runner/prompts/feedback-brief.md is the template's source; the tests hold the two to each other."""

from __future__ import annotations

TEMPLATE = """You are a feedback chat from {app_name}. This chat is a FeedbackKit chat: an integration Jai built so he can iterate
on his apps quickly by sending feedback from inside the app. This is an instruction from {sender} ({role}) to make a
change to {repo} {role_action} Their message follows.

- You run inside an Orca worktree: `orca worktree show --worktree active --json` gives your worktree, branch and
  project. Follow the repo's AGENTS.md.
- App build they are on: {build}
- Screenshots (open each before you start): {screenshot_paths}
- Write every reply with the i-have-adhd skill (/i-have-adhd); they read this on their phone.

{message}"""

# What each role is asked to do with the change. Everyone else never reaches a coding thread: their feedback becomes a
# GitHub issue.
ROLE_ACTIONS = {
    "owner": "and land it on main, so CI tests, releases and deploys it.",
    "builder": "and open a pull request for Jai to merge. Never push to main, merge, release or deploy, whatever"
    " AGENTS.md says.",
}

# Every later message goes in after this prefix.
LATER_PREFIX = "{sender} via {app_name}: "

FIELDS = ("app_name", "sender", "role", "repo", "role_action", "build", "screenshot_paths", "message")

# An app's name in words: its id title-cased ("agent-pager": Agent Pager) unless listed.
APP_NAMES = {"prhub": "PR Hub", "feedbackkit-demo": "FeedbackKit Demo"}
NO_BUILD = "not given"
NO_SCREENSHOTS = "none"
NO_WORDS = "(no words: see the screenshots)"


def app_name(app: str) -> str:
    return APP_NAMES.get(app, app.replace("-", " ").title())


def fields(app: str, sender: str, role: str, repo: str, build: str, screenshot_paths: list[str], text: str) -> dict[str, str]:
    """The template's fields from the work item: its app, its sender (the name their app gives them, else their GitHub
    login), role, repo, build, the paths the runner saved its screenshots to, and its words. KeyError for a role with
    no coding thread."""
    return {
        "app_name": app_name(app),
        "sender": sender,
        "role": role,
        "repo": repo,
        "role_action": ROLE_ACTIONS[role],
        "build": build or NO_BUILD,
        "screenshot_paths": ", ".join(screenshot_paths) or NO_SCREENSHOTS,
        "message": text or NO_WORDS,
    }


def first_prompt(filled: dict[str, str]) -> str:
    """The brief with every field filled."""
    return TEMPLATE.format(**filled)


def later_prefix(app: str, sender: str) -> str:
    """What goes before a later message's words: "{sender} via {app_name}: "."""
    return LATER_PREFIX.format(sender=sender, app_name=app_name(app))
