"""Disposable Linux runtime regressions; never uses SSH, sudo or real host paths."""
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[2] / "src-tauri/src/folder_sizes/remote_scan.py"
spec = importlib.util.spec_from_file_location("folder_scan", SOURCE)
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class RemoteScanTests(unittest.TestCase):
    """Keep real protocol/process tests separate from injected filesystem faults."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="zync-folder-size-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def request(self, **limits):
        meta = self.root.lstat()
        budgets = dict(entries=100000, depth=64, pendingFolders=4096,
                       pendingBytes=1048576, pathBytes=32768, seconds=30)
        budgets.update(limits)
        return dict(nonce="fixture", path=str(self.root), canonical=str(self.root.resolve()),
                    home=os.path.realpath(os.getcwd()), limits=budgets,
                    snapshot=[meta.st_mode, meta.st_size, meta.st_uid, meta.st_gid, int(meta.st_mtime)])

    def execute(self, request, source=None, cancel=False):
        """Hold stdin open until the result; EOF is cancellation, not submission."""
        process = subprocess.Popen([sys.executable, "-I", "-S", "-c", source or SOURCE.read_text()],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            process.stdin.write(json.dumps(request).encode() + b"\n")
            process.stdin.flush()
            if cancel:
                process.stdin.close()
            self.assertTrue(select.select([process.stdout], [], [], 5)[0], "response deadline")
            output = process.stdout.read(8193)
            process.wait(timeout=5)
            errors = process.stderr.read()
            self.assertLessEqual(len(output), 8192)
            return process.returncode, json.loads(output) if output else None, errors
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

    def run_scan(self, **limits):
        """Run the shipped program against only this test's temporary directory."""
        code, value, errors = self.execute(self.request(**limits))
        self.assertEqual((code, errors), (0, b""))
        self.assertEqual(value["status"], "report")
        return value["report"]

    def test_empty_folder_is_zero_without_directory_allocation(self):
        report = self.run_scan()
        self.assertTrue(report["complete"])
        self.assertEqual((report["bytes"], report["entries"]), ("0", 0))

    def test_logical_sizes_hidden_files_hardlinks_and_no_content_reads(self):
        hidden = self.root / ".hidden"
        hidden.write_bytes(b"1234567")
        os.link(hidden, self.root / "hard-link")
        hidden.chmod(0)  # Metadata remains readable; content need not be.
        sparse = self.root / "sparse"
        with sparse.open("wb") as handle:
            handle.truncate(3 * 1024 * 1024)
        (self.root / "empty").mkdir()
        os.symlink(self.root, self.root / "cycle")
        os.mkfifo(self.root / "fifo")  # Opening this would hang.
        report = self.run_scan()
        self.assertTrue(report["complete"])
        self.assertEqual(report["bytes"], str(3 * 1024 * 1024 + 14))
        self.assertEqual((report["entries"], report["files"], report["folders"], report["skipped"]), (6, 3, 1, 2))

    def test_literal_shell_characters_and_unicode_paths(self):
        self.root = self.root / "-literal'\n$(never-run); ☃"
        self.root.mkdir()
        (self.root / "file'\n☃").write_bytes(b"123")
        self.assertEqual(self.run_scan()["bytes"], "3")

    def test_namespace_and_metadata_mismatch_are_not_zero_success(self):
        for key, value in [("home", "/different-home"), ("canonical", "/different-root"), ("snapshot", [0] * 5)]:
            request = self.request()
            request[key] = value
            code, frame, _ = self.execute(request)
            self.assertEqual(code, 0)
            self.assertEqual(frame["status"], "mismatch")
            self.assertNotIn("report", frame)

    def test_symlink_root_is_rejected(self):
        original = self.root
        self.root = self.root / "alias"
        os.symlink(original, self.root)
        self.assertEqual(self.execute(self.request())[1]["status"], "mismatch")

    def test_entry_limit_preserves_partial_bytes(self):
        for index in range(8):
            (self.root / str(index)).write_bytes(b"123")
        report = self.run_scan(entries=3)
        self.assertFalse(report["complete"])
        self.assertEqual((report["reason"], report["entries"], report["bytes"]), ("entries", 3, "9"))

    def test_depth_path_pending_and_memory_limits(self):
        for index in range(4):
            (self.root / str(index)).mkdir()
        for budgets, reason in [({"depth": 0}, "depth"), ({"pathBytes": 1}, "path"),
                                ({"pendingFolders": 1}, "pending"), ({"pendingBytes": 1}, "memory")]:
            report = self.run_scan(**budgets)
            self.assertFalse(report["complete"])
            self.assertEqual(report["reason"], reason)

    def test_metadata_failure_is_skipped_not_a_directory_abort(self):
        (self.root / "valid").write_bytes(b"1234567")
        valid_scandir = os.scandir
        class BadEntry:
            name = "bad"
            def stat(self, **_):
                raise PermissionError()
        class Cursor:
            def __enter__(self):
                self.actual = valid_scandir(self.fd)
                return iter([BadEntry(), *self.actual])
            def __exit__(self, *_):
                self.actual.close()
            def __init__(self, fd):
                self.fd = fd
        with mock.patch.object(scanner.os, "scandir", Cursor), mock.patch.object(scanner.signal, "alarm"), \
                mock.patch.object(scanner.select, "select", return_value=([], [], [])):
            report = scanner.scan(self.request())
        self.assertEqual((report["errors"], report["files"], report["bytes"]), (1, 1, "7"))
        self.assertFalse(report["complete"])

    def test_eof_cancels_without_emitting_a_false_complete_result(self):
        code, frame, _ = self.execute(self.request(), cancel=True)
        self.assertEqual(code, 0)
        self.assertIsNone(frame)

    def test_time_budget_is_a_partial_result(self):
        report = self.run_scan(seconds=0)
        self.assertFalse(report["complete"])
        self.assertEqual(report["reason"], "time")

    def test_independent_alarm_survives_a_stalled_scan(self):
        wrapper = ("import time\nnamespace={'__name__':'fixture'}\nexec(" + repr(SOURCE.read_text())
                   + ",namespace)\nnamespace['alive']=lambda deadline: time.sleep(10)\nnamespace['main']()")
        started = time.monotonic()
        code, frame, _ = self.execute(self.request(seconds=1), wrapper)
        self.assertEqual(code, -signal.SIGALRM)
        self.assertIsNone(frame)
        self.assertLess(time.monotonic() - started, 5)


if __name__ == "__main__":
    if sys.platform != "linux":
        raise SystemExit("Linux runtime qualification must run on Linux/WSL")
    unittest.main()
