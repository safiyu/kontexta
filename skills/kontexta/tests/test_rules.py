import importlib.util
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("kxta", os.path.join(HERE, "..", "scripts", "kxta.py"))
kxta = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kxta)

TOOLS = [
    {"name": "files_search", "description": "Full-text keyword search. Returns ranked matches with excerpts."},
    {"name": "journal_write", "description": "Write one event to the journal."},
]


def block(version="3.2.0", tools=TOOLS):
    return kxta.render_rules_block(version, tools, "python3 ~/.claude/skills/kontexta/scripts/kxta.py")


class RulesBlock(unittest.TestCase):
    def test_block_uses_server_marker_so_staleness_check_sees_it(self):
        b = block("3.2.0")
        self.assertTrue(kxta.RULES_BEGIN_RE.search(b))
        self.assertEqual(kxta.RULES_BEGIN_RE.search(b).group(1), "3.2.0")
        self.assertTrue(kxta.RULES_END_RE.search(b))
        self.assertIn(kxta.FLAVOR_TAG, b)

    def test_short_desc_cuts_at_sentence_not_mid_word(self):
        self.assertEqual(kxta.short_desc("Full-text search. More detail here."), "Full-text search.")
        long = "word " * 80
        out = kxta.short_desc(long, 40)
        self.assertTrue(out.endswith("..."))
        self.assertLessEqual(len(out), 43)

    def test_append_then_rerun_is_idempotent(self):
        action, once = kxta.apply_rules_block("# Project\n", block())
        self.assertEqual(action, "created")
        action, twice = kxta.apply_rules_block(once, block())
        self.assertEqual(action, "unchanged")
        self.assertEqual(once, twice)
        self.assertEqual(once.count("BEGIN kontexta:rules"), 1)

    def test_version_bump_replaces_in_place_and_keeps_surrounding_content(self):
        _, old = kxta.apply_rules_block("# Project\n", block("3.2.0"))
        content = old + "\n## Mine\nkeep me\n"
        action, new = kxta.apply_rules_block(content, block("3.3.0"))
        self.assertEqual(action, "updated")
        self.assertIn("BEGIN kontexta:rules v3.3.0", new)
        self.assertNotIn("v3.2.0", new)
        self.assertIn("# Project", new)
        self.assertIn("keep me", new)

    def test_tool_list_change_at_same_version_still_updates(self):
        _, old = kxta.apply_rules_block("", block("3.2.0", TOOLS[:1]))
        action, _ = kxta.apply_rules_block(old, block("3.2.0", TOOLS))
        self.assertEqual(action, "updated")

    def test_duplicate_and_malformed_markers_are_refused(self):
        with self.assertRaises(RuntimeError):
            kxta.apply_rules_block(block() + "\n" + block(), block())
        with self.assertRaises(RuntimeError):
            kxta.apply_rules_block("<!-- BEGIN kontexta:rules v3.2.0 -->\nno end", block())

    def test_write_rules_refuses_symlink_and_writes_utf8(self):
        with tempfile.TemporaryDirectory() as d:
            target = os.path.join(d, "real.md")
            open(target, "w").close()
            link = os.path.join(d, "CLAUDE.md")
            try:
                os.symlink(target, link)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks unavailable")
            with self.assertRaises(RuntimeError):
                kxta.write_rules(link, block())
            plain = os.path.join(d, "AGENTS.md")
            self.assertEqual(kxta.write_rules(plain, block()), "created")
            self.assertEqual(kxta.write_rules(plain, block()), "unchanged")


if __name__ == "__main__":
    unittest.main()
