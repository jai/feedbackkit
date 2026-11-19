"""Shared fixtures for local resource tests, including the release updater's unittest check."""

import os
import unittest
from unittest import mock


def isolate_git(test: unittest.TestCase) -> None:
    """Keep temporary repositories independent of the operator's Git configuration."""
    environment = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
    environment.start()
    test.addCleanup(environment.stop)
