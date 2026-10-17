import math
import unittest
from ph_calibration import estimate_ph


class DefaultCalibrationTests(unittest.TestCase):
    def test_neutral_reference_and_voltage_changes(self):
        self.assertEqual(estimate_ph(2.50), 7.0)
        self.assertAlmostEqual(estimate_ph(2.566), 6.6238)
        self.assertAlmostEqual(estimate_ph(3.0), 4.15)
        self.assertGreater(estimate_ph(2.4), estimate_ph(2.5))

    def test_missing_invalid_and_range_limits(self):
        self.assertIsNone(estimate_ph(None))
        self.assertIsNone(estimate_ph(math.nan))
        self.assertIsNone(estimate_ph(math.inf))
        self.assertEqual(estimate_ph(0.0), 14.0)
        self.assertEqual(estimate_ph(7.0), 0.0)
