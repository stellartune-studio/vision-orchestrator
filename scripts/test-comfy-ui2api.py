import sys
sys.dont_write_bytecode = True
import importlib.util
import json
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location("converter", Path(__file__).with_name("comfy-ui2api.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
class ConverterDefaults(unittest.TestCase):
    def test_ambiguous_raw_widget_values_refused(self):
        with self.assertRaisesRegex(ValueError, "incomplete widget mapping"):
            m.convert({"nodes": [{"id": 1, "type": "FixtureSampler", "inputs": [], "widgets_values": [20, 4]}]})
    def test_saved_16_normalized_graphs_preserve_existing_api(self):
        root = Path(__file__).resolve().parent.parent / "runtime"
        sources = list((root / "user/default/workflows").glob("*.json"))
        self.assertEqual(len(sources), 16)
        for source in sources:
            with self.subTest(source=source.name):
                self.assertEqual(m.convert(json.loads(source.read_text(encoding="utf-8-sig"))).prompt, json.loads((root / "workflows-api" / source.name).read_text()))
if __name__ == "__main__": unittest.main()
