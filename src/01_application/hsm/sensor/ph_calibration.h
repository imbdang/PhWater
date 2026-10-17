#pragma once
#include <math.h>
#include <stdbool.h>

/* Temporary PH-4502C conversion. Replace these after measuring buffer solutions.
 * PO voltage is BEFORE the divider (m_sensor_read already restores that voltage).
 * Keep dashboard/backend/ph_calibration.py in sync for older firmware fallback. */
#define APP_PH_REFERENCE_VOLTAGE 2.50f
#define APP_PH_REFERENCE_VALUE   7.00f
#define APP_PH_SLOPE_PER_VOLT   (-5.70f)
#define APP_PH_CALIBRATED        false

static inline float app_ph_from_voltage(float po_voltage)
{
    if (!isfinite(po_voltage)) return NAN;
    float ph = APP_PH_REFERENCE_VALUE + APP_PH_SLOPE_PER_VOLT * (po_voltage - APP_PH_REFERENCE_VOLTAGE);
    return fminf(14.0f, fmaxf(0.0f, ph));
}
