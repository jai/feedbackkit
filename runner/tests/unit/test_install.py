from __future__ import annotations

import unittest

import install


class PlanTests(unittest.TestCase):
    def test_only_a_new_or_changed_plist_registers_the_job(self) -> None:
        self.assertEqual(install.plan(plist_changed=True, files_changed=True, is_loaded=False), "bootstrap")
        self.assertEqual(install.plan(plist_changed=True, files_changed=True, is_loaded=True), "reload")
        self.assertEqual(install.plan(plist_changed=False, files_changed=True, is_loaded=True), "kickstart")
        self.assertEqual(install.plan(plist_changed=False, files_changed=False, is_loaded=True), "none")
