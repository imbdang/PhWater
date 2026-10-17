import unittest
from unittest.mock import AsyncMock, patch

from dbus_fast import Variant
import pi_wifi
from pi_wifi import PiWifi, WifiError, connection_settings, network_row, validate_credentials


class WifiValidationTests(unittest.TestCase):
    def test_byte_limits_and_open_network(self):
        validate_credentials("ImBdang", "12345678")
        validate_credentials("Open", "")
        for ssid, password in [("", "12345678"), ("ấ" * 11, "12345678"), ("A", "short"), ("A", "x" * 64)]:
            with self.assertRaises(WifiError):
                validate_credentials(ssid, password)

    def test_scan_filters_shared_radio_band_and_security(self):
        point = {"Ssid": b"ImBdang", "Frequency": 2457, "Strength": 99, "Flags": 1,
                 "WpaFlags": 0x100, "RsnFlags": 0x100}
        self.assertEqual(network_row(point, True)["channel"], 10)
        self.assertEqual(network_row(point, True)["security"], "wpa-psk")
        self.assertIsNone(network_row({**point, "Frequency": 5805}, True))
        self.assertEqual(network_row({**point, "Frequency": 5805}, False)["channel"], 161)
        self.assertFalse(network_row({**point, "WpaFlags": 0, "RsnFlags": 0x200}, True)["supported"])
        self.assertEqual(network_row({**point, "Flags": 0, "WpaFlags": 0, "RsnFlags": 0}, True)["security"], "open")

    def test_profile_never_uses_ap_and_does_not_autoconnect_before_success(self):
        network = {"frequency": 2457, "channel": 10, "security": "wpa-psk"}
        settings = connection_settings("ImBdang", "12345678", network)
        self.assertNotEqual(settings["connection"]["interface-name"].value, pi_wifi.AP_INTERFACE)
        self.assertFalse(settings["connection"]["autoconnect"].value)
        self.assertEqual(settings["802-11-wireless-security"]["psk-flags"].value, 0)
        with self.assertRaises(WifiError):
            connection_settings("ImBdang", "", network)


class WifiConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_ap_interface_before_any_mutation(self):
        wifi = PiWifi()
        wifi.device = AsyncMock()
        with patch.object(pi_wifi, "WIFI_INTERFACE", pi_wifi.AP_INTERFACE):
            with self.assertRaisesRegex(WifiError, "interface đang phát AP"):
                await wifi.client()
        wifi.device.assert_not_awaited()
        wifi.device.return_value = ("/client", {})
        wifi.props = AsyncMock(return_value={"Mode": 3})
        with self.assertRaisesRegex(WifiError, "đang phát AP"):
            await wifi.client()

    def configured_wifi(self, ap_channel=11):
        wifi = PiWifi()
        wifi.client = AsyncMock(return_value=("/client", {"ActiveConnection": "/old-active"}))
        wifi.device = AsyncMock(return_value=("/ap", {"State": 100, "ActiveConnection": "/ap-active"}))
        async def props(path, _):
            return {"Mode": 3} if path == "/ap" and _ == pi_wifi.WIRELESS else (
                {"State": 100, "ActiveConnection": "/ap-active"} if path == "/ap" else
                {"Connection": "/ap-profile" if path == "/ap-active" else "/old-profile"})
        wifi.props = AsyncMock(side_effect=props)
        wifi.scan = AsyncMock(return_value=[{"ssid": "ImBdang", "frequency": 2457, "channel": 10, "security": "wpa-psk"}])
        wifi.profile_settings = AsyncMock(return_value={"802-11-wireless": {"channel": Variant("u", ap_channel)},
                                                      "802-11-wireless-security": {"psk": Variant("s", "ap-secret")}})
        async def call(_, __, member, *args):
            if member == "AddConnection":
                return ["/candidate"]
            if member == "ListConnections":
                return [["/candidate", "/old-dashboard", "/unrelated"]]
            if member == "GetSettings":
                return [{"connection": {"id": Variant("s", pi_wifi.PROFILE_NAME if _ != "/unrelated" else "unrelated")}}]
            return []
        wifi.call = AsyncMock(side_effect=call)
        wifi.activate = AsyncMock()
        wifi.status = AsyncMock(return_value={"connected": True, "apActive": True, "ssid": "ImBdang", "ip": "192.168.1.28"})
        return wifi

    async def test_failure_restores_ap_channel_and_previous_uplink(self):
        wifi = self.configured_wifi()
        async def activate(profile, _):
            if profile == "/candidate":
                raise WifiError("bad credentials")
        wifi.activate.side_effect = activate
        stages = []
        with patch.object(pi_wifi, "same_radio", return_value=True):
            with self.assertRaisesRegex(WifiError, "bad credentials"):
                await wifi.connect("ImBdang", "12345678", stages.append)
        self.assertIn("restoring", stages)
        updates = [call.args[4][0] for call in wifi.call.await_args_list if call.args[2] == "Update"]
        self.assertEqual([row["802-11-wireless"]["channel"].value for row in updates], [10, 11])
        self.assertEqual(updates[-1]["802-11-wireless-security"]["psk"].value, "ap-secret")
        wifi.activate.assert_any_await("/ap-profile", "/ap")
        wifi.activate.assert_any_await("/old-profile", "/client")
        wifi.call.assert_any_await("/candidate", pi_wifi.PROFILE, "Delete")

    async def test_success_same_channel_keeps_ap_running_and_only_replaces_own_profiles(self):
        wifi = self.configured_wifi(ap_channel=10)
        with patch.object(pi_wifi, "same_radio", return_value=True):
            result = await wifi.connect("ImBdang", "12345678", lambda _: None)
        self.assertTrue(result["connected"])
        wifi.activate.assert_awaited_once_with("/candidate", "/client")
        deletes = [call.args[0] for call in wifi.call.await_args_list if call.args[2] == "Delete"]
        self.assertEqual(deletes, ["/old-dashboard"])
        update = next(call.args[4][0] for call in wifi.call.await_args_list if call.args[2] == "Update")
        self.assertTrue(update["connection"]["autoconnect"].value)

    async def test_wifi_connected_requires_device_activation_not_profile_save(self):
        wifi = PiWifi()
        wifi.props = AsyncMock(return_value={"State": 120, "StateReason": [120, 7]})
        with self.assertRaisesRegex(WifiError, "Kết nối thất bại"):
            await wifi.wait_connected("/client")

    async def test_old_active_connection_does_not_confirm_new_request(self):
        wifi = PiWifi()
        wifi.props = AsyncMock(side_effect=[
            {"State": 100, "ActiveConnection": "/old"},
            {"State": 100, "ActiveConnection": "/new"},
        ])
        with patch.object(pi_wifi.asyncio, "sleep", new=AsyncMock()):
            await wifi.wait_connected("/client", active="/new")
        self.assertEqual(wifi.props.await_count, 2)

    async def test_invalid_candidate_leaves_current_ap_and_uplink_untouched(self):
        wifi = self.configured_wifi()
        async def call(_, __, member, *args):
            if member == "AddConnection":
                raise WifiError("invalid profile")
        wifi.call.side_effect = call
        with patch.object(pi_wifi, "same_radio", return_value=True):
            with self.assertRaisesRegex(WifiError, "invalid profile"):
                await wifi.connect("ImBdang", "12345678", lambda _: None)
        wifi.activate.assert_not_awaited()
        self.assertEqual(wifi.call.await_count, 1)


if __name__ == "__main__":
    unittest.main()
