"""Temporary conversion for legacy ESP32 telemetry without pH.

Same defaults as src/01_application/hsm/sensor/ph_calibration.h. Firmware-provided
pH always wins. No conversion when the sensor reports an error.
"""
import math

PH_REFERENCE_VOLTAGE = 2.50
PH_REFERENCE_VALUE = 7.00
PH_SLOPE_PER_VOLT = -5.70


def estimate_ph(voltage):
    if voltage is None or not math.isfinite(voltage):
        return None
    return min(14.0, max(0.0, PH_REFERENCE_VALUE + PH_SLOPE_PER_VOLT * (voltage - PH_REFERENCE_VOLTAGE)))
