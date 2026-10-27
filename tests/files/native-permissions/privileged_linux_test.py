"""Opt-in root qualification of the actual fixed program, on disposable /tmp only.

Run with an existing Python: python3 -I -B privileged_linux_test.py
No accounts, sudo policy, services, user files or server installation changes.
This qualifies the operation protocol, not a real password-authenticated SSH hop.
"""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

SOURCE = (Path(__file__).resolve().parents[3] / "src-tauri/src/file_permissions/privileged_linux.py").read_text()
NONCE = "0123456789abcdef0123456789abcdef"


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        if os.geteuid() != 0:
            self.skipTest("Explicit isolated root qualification only")
        self.directory = tempfile.TemporaryDirectory(prefix="zync-permissions-sudo-test-", dir="/tmp")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.target = self.root / "file"
        self.target.write_bytes(b"unchanged contents")
        self.target.chmod(0o400)
        self.processes = []
        self.addCleanup(self.stop)

    def stop(self):
        for process in self.processes:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)

    def start(self, source=SOURCE):
        process = subprocess.Popen([sys.executable, "-I", "-S", "-c", source, NONCE],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(process)
        ready = self.read(process)
        self.assertEqual(ready["type"], "ready", ready)
        return process

    def read(self, process):
        # Every fixture output is bounded; communicate has a timeout in cleanup.
        import select
        self.assertTrue(select.select([process.stdout], [], [], 5)[0], "protocol response timed out")
        line = process.stdout.readline(65537)
        self.assertTrue(line, "program exited before a protocol response")
        self.assertLessEqual(len(line), 65536)
        value = json.loads(line)
        self.assertEqual(value["nonce"], NONCE)
        self.assertEqual(value["protocol"], 1)
        return value

    def send(self, process, kind, **fields):
        value = {"protocol": 1, "nonce": NONCE, "type": kind, **fields}
        process.stdin.write(json.dumps(value).encode() + b"\n")
        process.stdin.flush()

    def prepare(self, path=None):
        process = self.start()
        self.send(process, "prepare", path=str(path or self.target))
        prepared = self.read(process)
        self.assertEqual(prepared["type"], "prepared", prepared)
        self.assertEqual(prepared["metadata"]["path"], str(path or self.target))
        return process, prepared

    def test_prepare_never_changes_mode_or_contents_and_eof_cancels(self):
        process, prepared = self.prepare()
        self.assertEqual(self.target.stat().st_mode & 0o7777, 0o400)
        self.assertIsInstance(prepared["metadata"]["snapshot"]["size"], str)
        process.stdin.close()
        process.stdin = None
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(json.loads(stdout)["code"], "cancelled")
        self.assertEqual(stderr, b"")
        self.assertEqual(self.target.read_bytes(), b"unchanged contents")
        self.assertEqual(self.target.stat().st_mode & 0o7777, 0o400)

    def test_mode_zero_other_owner_and_literal_path(self):
        literal = self.root / "literal'\";$(not-a-command)\nfile"
        self.target.rename(literal)
        os.chown(literal, 65534, 65534)
        literal.chmod(0)
        process, _ = self.prepare(literal)
        self.send(process, "apply", setBits=0o600, clearBits=0)
        result = self.read(process)
        self.assertEqual(result["status"], "verified", result)
        self.assertEqual(literal.stat().st_mode & 0o7777, 0o600)
        self.assertEqual(literal.stat().st_uid, 65534)
        self.assertEqual(literal.read_bytes(), b"unchanged contents")

    def test_special_bits_are_preserved_and_directory_traversal_can_be_restored(self):
        self.target.chmod(0o4600)
        process, _ = self.prepare()
        self.send(process, "apply", setBits=0o040, clearBits=0)
        self.assertEqual(self.read(process)["status"], "verified")
        self.assertEqual(self.target.stat().st_mode & 0o7777, 0o4640)
        folder = self.root / "folder"
        folder.mkdir(mode=0o400)
        process, _ = self.prepare(folder)
        self.send(process, "apply", setBits=0o100, clearBits=0)
        self.assertEqual(self.read(process)["status"], "verified")
        self.assertEqual(folder.stat().st_mode & 0o777, 0o500)

    def test_replaced_target_is_rejected_without_changing_either_object(self):
        process, _ = self.prepare()
        old = self.root / "original"
        self.target.rename(old)
        self.target.write_bytes(b"replacement")
        self.target.chmod(0o444)
        self.send(process, "apply", setBits=0o200, clearBits=0)
        self.assertEqual(self.read(process)["code"], "stale_target")
        self.assertEqual(old.stat().st_mode & 0o7777, 0o400)
        self.assertEqual(self.target.stat().st_mode & 0o7777, 0o444)

    def test_links_fifo_and_unsafe_path_components_are_refused(self):
        link = self.root / "link"
        link.symlink_to(self.target)
        ancestor = self.root / "alias"
        ancestor.symlink_to(self.root, target_is_directory=True)
        hard = self.root / "hard"
        os.link(self.target, hard)
        fifo = self.root / "fifo"
        os.mkfifo(fifo)
        for path in [link, ancestor / "file", hard, fifo, str(self.root) + "/../x", "/"]:
            with self.subTest(path=str(path)):
                process = self.start()
                self.send(process, "prepare", path=str(path))
                self.assertEqual(self.read(process)["type"], "error")
        self.assertEqual(self.target.stat().st_mode & 0o7777, 0o400)

    def test_invalid_masks_do_not_mutate(self):
        for set_bits, clear_bits in [(True, 0), (-1, 0), (0o4000, 0), (0o200, 0o200)]:
            with self.subTest(set_bits=set_bits, clear_bits=clear_bits):
                process, _ = self.prepare()
                self.send(process, "apply", setBits=set_bits, clearBits=clear_bits)
                self.assertEqual(self.read(process)["code"], "invalid_mode")
                self.assertEqual(self.target.stat().st_mode & 0o7777, 0o400)

    def test_nested_json_and_bad_nonce_are_structured_refusals(self):
        for data in [b"[" * 1500 + b"0" + b"]" * 1500 + b"\n",
                     json.dumps({"protocol": 1, "nonce": "wrong", "type": "prepare", "path": "secret-marker"}).encode() + b"\n"]:
            process = self.start()
            process.stdin.write(data)
            process.stdin.flush()
            result = self.read(process)
            self.assertEqual(result["code"], "invalid_frame")
            self.assertNotIn("secret-marker", str(result))

    def test_expiry_resets_inherited_ignored_alarm_without_mutation(self):
        # Shorten only the alarm; keep the protocol deadline later so its own
        # expiry path cannot race SIGALRM. Production has no timeout switches.
        deadline = "self.deadline = time.monotonic() + LIFETIME"
        extended_deadline = "self.deadline = time.monotonic() + 30"
        self.assertEqual(SOURCE.count(deadline), 1)
        source = "import signal\nsignal.signal(signal.SIGALRM, signal.SIG_IGN)\n" + SOURCE.replace(
            "LIFETIME = 90", "LIFETIME = 1").replace(deadline, extended_deadline)
        self.assertIn(extended_deadline, source)
        self.assertIn("LIFETIME = 1\n", source)
        process = self.start(source)
        process.wait(timeout=5)
        self.assertEqual(process.returncode, -signal.SIGALRM)
        self.assertEqual(self.target.stat().st_mode & 0o7777, 0o400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
