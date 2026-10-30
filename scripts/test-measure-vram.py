import importlib.util
import unittest
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location("measure_vram", Path(__file__).with_name("measure-vram.py"))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class MonitorTests(unittest.TestCase):
    def test_parse_and_peak_per_uuid(self):
        first = monitor.parse_sample("GPU-a, Test GPU, 120, 8192\nGPU-b, Other, 40, 4096\n")
        second = monitor.parse_sample("GPU-b, Other, 50, 4096\nGPU-a, Test GPU, 100, 8192\n")
        summary = monitor.summarize([{"devices": first}, {"devices": second}])
        self.assertEqual({d["uuid"]: d["peak_used_mib"] for d in summary}, {"GPU-a": 120, "GPU-b": 50})
        self.assertTrue(all(d["samples"] == 2 for d in summary))

    def test_rejects_invalid_and_missing_devices(self):
        for row in ("", "GPU-a, X, N/A, 100", "GPU-a, X, 101, 100", "GPU-a, X, 1, 100\nGPU-a, X, 2, 100"):
            with self.assertRaises(ValueError):
                monitor.parse_sample(row)
        with self.assertRaisesRegex(ValueError, "GPU set changed"):
            monitor.summarize([{"devices": monitor.parse_sample("GPU-a, X, 1, 100")}, {"devices": monitor.parse_sample("GPU-b, Y, 1, 100")}])

    def test_queries_do_not_open_windows_console(self):
        with patch.object(monitor.sys, "platform", "win32"), patch.object(monitor.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True), patch.object(monitor.subprocess, "run") as run:
            run.return_value.stdout = "GPU-a, Test, 10, 100"
            self.assertEqual(monitor.query("nvidia-smi")[0]["used_mib"], 10)
            self.assertEqual(run.call_args.kwargs["creationflags"], 0x08000000)
        with patch.object(monitor.sys, "platform", "linux"), patch.object(monitor.subprocess, "run") as run:
            run.return_value.stdout = "GPU-a, Test, 10, 100"
            monitor.query("nvidia-smi")
            self.assertNotIn("creationflags", run.call_args.kwargs)

    def test_window_and_interval_without_gpu(self):
        now = [0.0]
        def sleep(seconds): now[0] += seconds
        def query(_): return monitor.parse_sample("GPU-a, X, 10, 100")
        samples = monitor.collect(2.5, 1, clock=lambda: now[0], sleeper=sleep, query_fn=query)
        self.assertEqual([s["elapsed_seconds"] for s in samples], [0, 1, 2])
        self.assertEqual(now[0], 2.5)


if __name__ == "__main__":
    unittest.main()
