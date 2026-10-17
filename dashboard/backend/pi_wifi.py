"""Pi uplink via NetworkManager D-Bus; never activate a client on the AP interface."""
import asyncio
import copy
import logging
import os
import time
import uuid
from pathlib import Path

from dbus_fast import BusType, Message, MessageType, Variant
from dbus_fast.aio import MessageBus

NM = "org.freedesktop.NetworkManager"
ROOT = "/org/freedesktop/NetworkManager"
DEVICE = NM + ".Device"
WIRELESS = DEVICE + ".Wireless"
PROFILE = NM + ".Settings.Connection"
ACTIVE = NM + ".Connection.Active"
WIFI_INTERFACE = os.getenv("PH_WIFI_INTERFACE", "wlan1")
AP_INTERFACE = os.getenv("PH_AP_INTERFACE", "wlan0")
PROFILE_NAME = "ph-dashboard-uplink"


class WifiError(Exception):
    pass


def validate_credentials(ssid, password):
    if not 1 <= len(ssid.encode()) <= 32 or "\x00" in ssid:
        raise WifiError("Tên Wi-Fi phải từ 1 đến 32 byte.")
    if password and (not 8 <= len(password.encode()) <= 63 or "\x00" in password):
        raise WifiError("Mật khẩu Wi-Fi phải từ 8 đến 63 byte.")


def same_radio(first, second):
    a, b = (Path("/sys/class/net") / name / "phy80211" for name in (first, second))
    return a.exists() and b.exists() and a.resolve() == b.resolve()


def network_row(values, shared):
    ssid = bytes(values["Ssid"]).decode("utf-8", errors="replace")
    frequency = values["Frequency"]
    if not ssid or (shared and not 2412 <= frequency <= 2484):
        return None
    security_flags = values["WpaFlags"] | values["RsnFlags"]
    security = "wpa-psk" if security_flags & 0x100 else "unsupported" if values["Flags"] & 1 or security_flags else "open"
    channel = 14 if frequency == 2484 else (frequency - 2407) // 5 if frequency < 2500 else (frequency - 5000) // 5
    return {"ssid": ssid, "signal": values["Strength"], "channel": channel,
            "frequency": frequency, "security": security, "supported": security != "unsupported"}


def connection_settings(ssid, password, network):
    wireless = {"ssid": Variant("ay", ssid.encode()), "mode": Variant("s", "infrastructure"),
                "band": Variant("s", "bg" if network["frequency"] < 2500 else "a"),
                "channel": Variant("u", network["channel"]), "assigned-mac-address": Variant("s", "preserve")}
    settings = {
        "connection": {"id": Variant("s", PROFILE_NAME), "uuid": Variant("s", str(uuid.uuid4())),
                       "type": Variant("s", "802-11-wireless"), "interface-name": Variant("s", WIFI_INTERFACE),
                       "autoconnect": Variant("b", False), "autoconnect-priority": Variant("i", 100),
                       "autoconnect-retries": Variant("i", 0)},
        "802-11-wireless": wireless,
        "ipv4": {"method": Variant("s", "auto"), "route-metric": Variant("x", 600)},
        "ipv6": {"method": Variant("s", "disabled")},
    }
    if network["security"] == "wpa-psk":
        if not password:
            raise WifiError("Mạng này cần mật khẩu Wi-Fi.")
        settings["802-11-wireless-security"] = {"key-mgmt": Variant("s", "wpa-psk"),
                                              "psk": Variant("s", password), "psk-flags": Variant("u", 0)}
    elif network["security"] != "open":
        raise WifiError("Chỉ hỗ trợ Wi-Fi mở hoặc WPA/WPA2 Personal.")
    return settings


class PiWifi:
    async def __aenter__(self):
        self.bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        return self

    async def __aexit__(self, *_):
        self.bus.disconnect()

    async def call(self, path, interface, member, signature="", body=None):
        reply = await asyncio.wait_for(self.bus.call(Message(destination=NM, path=path, interface=interface,
                                                            member=member, signature=signature, body=body or [])), 12)
        if reply.message_type == MessageType.ERROR:
            # Do not expose D-Bus arguments or secrets in errors/logs.
            logging.getLogger("ph.wifi").warning("NetworkManager rejected member=%s error=%s", member, reply.error_name)
            raise WifiError("NetworkManager từ chối thao tác (" + reply.error_name.rsplit(".", 1)[-1] + ").")
        return reply.body

    async def props(self, path, interface):
        values = (await self.call(path, "org.freedesktop.DBus.Properties", "GetAll", "s", [interface]))[0]
        return {key: value.value for key, value in values.items()}

    async def device(self, name):
        for path in (await self.call(ROOT, NM, "GetDevices"))[0]:
            properties = await self.props(path, DEVICE)
            if properties["Interface"] == name and properties["DeviceType"] == 2:
                return path, properties
        raise WifiError("Chưa có interface Wi-Fi client " + name + ". Kiểm tra dịch vụ ph-wifi-interface.")

    async def client(self):
        if WIFI_INTERFACE == AP_INTERFACE:
            raise WifiError("Wi-Fi client không được dùng interface đang phát AP.")
        path, properties = await self.device(WIFI_INTERFACE)
        wireless = await self.props(path, WIRELESS)
        if wireless["Mode"] == 3:
            raise WifiError("Interface client đang phát AP; không đổi nó sang client.")
        return path, properties

    async def status(self):
        result = {"available": False, "interface": WIFI_INTERFACE, "connected": False, "ssid": None, "ip": None,
                  "apActive": False, "apSsid": None, "apIp": None, "uplink": None,
                  "sharedRadio": same_radio(AP_INTERFACE, WIFI_INTERFACE), "error": None}
        try:
            path, dev = await self.client()
            result["available"] = dev["State"] >= 30
            result["connected"] = dev["State"] == 100
            wireless = await self.props(path, WIRELESS)
            if wireless["ActiveAccessPoint"] != "/":
                point = await self.props(wireless["ActiveAccessPoint"], NM + ".AccessPoint")
                result["ssid"] = bytes(point["Ssid"]).decode("utf-8", errors="replace")
            if dev["Ip4Config"] != "/":
                ip = await self.props(dev["Ip4Config"], NM + ".IP4Config")
                result["ip"] = next((row["address"].value for row in ip["AddressData"]), None)
        except WifiError as error:
            result["error"] = str(error)
        try:
            ap_path, ap = await self.device(AP_INTERFACE)
            result["apActive"] = ap["State"] == 100 and (await self.props(ap_path, WIRELESS))["Mode"] == 3
            if ap["ActiveConnection"] != "/":
                active = await self.props(ap["ActiveConnection"], ACTIVE)
                settings = (await self.call(active["Connection"], PROFILE, "GetSettings"))[0]
                result["apSsid"] = bytes(settings["802-11-wireless"]["ssid"].value).decode("utf-8", errors="replace")
            if ap["Ip4Config"] != "/":
                ip = await self.props(ap["Ip4Config"], NM + ".IP4Config")
                result["apIp"] = next((row["address"].value for row in ip["AddressData"]), None)
        except WifiError:
            pass
        manager = await self.props(ROOT, NM)
        if manager["PrimaryConnection"] != "/":
            primary = await self.props(manager["PrimaryConnection"], ACTIVE)
            result["uplink"] = "Wi-Fi" if primary["Type"] == "802-11-wireless" else "Ethernet" if primary["Type"] == "802-3-ethernet" else primary["Type"]
        return result

    async def scan(self):
        path, _ = await self.client()
        last_scan = (await self.props(path, WIRELESS))["LastScan"]
        try:
            await self.call(path, WIRELESS, "RequestScan", "a{sv}", [{}])
        except WifiError:
            # NM throttles scans; a concurrently running scan can still produce fresh results.
            pass
        for _ in range(20):
            await asyncio.sleep(0.5)
            if (await self.props(path, WIRELESS))["LastScan"] > last_scan:
                break
        else:
            raise WifiError("Quét Wi-Fi chưa hoàn tất. Đợi vài giây rồi quét lại.")
        networks = {}
        shared = same_radio(AP_INTERFACE, WIFI_INTERFACE)
        for point in (await self.call(path, WIRELESS, "GetAllAccessPoints"))[0]:
            row = network_row(await self.props(point, NM + ".AccessPoint"), shared)
            if row and (row["ssid"] not in networks or row["signal"] > networks[row["ssid"]]["signal"]):
                networks[row["ssid"]] = {**row, "path": point}
        return sorted(networks.values(), key=lambda row: -row["signal"])

    async def wait_connected(self, path, timeout=65, active=None):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            dev = await self.props(path, DEVICE)
            if dev["State"] == 100 and (active is None or dev["ActiveConnection"] == active):
                return
            if dev["State"] in (30, 120):
                raise WifiError("Kết nối thất bại. Kiểm tra mật khẩu và tín hiệu Wi-Fi (mã " + str(dev["StateReason"][1]) + ").")
            await asyncio.sleep(1)
        raise WifiError("Hết thời gian kết nối Wi-Fi. Kiểm tra mật khẩu hoặc DHCP của router.")

    async def activate(self, profile, device):
        active = (await self.call(ROOT, NM, "ActivateConnection", "ooo", [profile, device, "/"]))[0]
        await asyncio.sleep(0.5)
        await self.wait_connected(device, active=active)

    async def profile_settings(self, path):
        settings = (await self.call(path, PROFILE, "GetSettings"))[0]
        if "802-11-wireless-security" in settings:
            secrets = (await self.call(path, PROFILE, "GetSecrets", "s", ["802-11-wireless-security"]))[0]
            settings["802-11-wireless-security"].update(secrets.get("802-11-wireless-security", {}))
        return settings

    async def connect(self, ssid, password, stage):
        validate_credentials(ssid, password)
        client_path, client = await self.client()
        ap_path, ap = await self.device(AP_INTERFACE)
        if ap["State"] != 100 or (await self.props(ap_path, WIRELESS))["Mode"] != 3:
            raise WifiError("AP chưa hoạt động; khôi phục AP trước khi đổi Wi-Fi client.")
        stage("scanning")
        network = next((row for row in await self.scan() if row["ssid"] == ssid), None)
        if not network:
            raise WifiError("Không thấy Wi-Fi này. Pi dùng chung radio với AP nên cần mạng 2.4 GHz đang phát SSID.")
        settings = connection_settings(ssid, password, network)
        ap_profile = (await self.props(ap["ActiveConnection"], ACTIVE))["Connection"]
        original_ap = await self.profile_settings(ap_profile)
        previous = (await self.props(client["ActiveConnection"], ACTIVE))["Connection"] if client["ActiveConnection"] != "/" else None
        shared = same_radio(AP_INTERFACE, WIFI_INTERFACE)
        channel_change = shared and original_ap["802-11-wireless"].get("channel", Variant("u", 0)).value != network["channel"]
        candidate = None
        try:
            candidate = (await self.call(ROOT + "/Settings", NM + ".Settings", "AddConnection", "a{sa{sv}}", [settings]))[0]
            if channel_change:
                stage("aligning_ap")
                if client["ActiveConnection"] != "/":
                    await self.call(ROOT, NM, "DeactivateConnection", "o", [client["ActiveConnection"]])
                updated = copy.deepcopy(original_ap)
                updated["802-11-wireless"]["channel"] = Variant("u", network["channel"])
                await self.call(ap_profile, PROFILE, "Update", "a{sa{sv}}", [updated])
                await self.call(ROOT, NM, "DeactivateConnection", "o", [ap["ActiveConnection"]])
                await self.activate(ap_profile, ap_path)
            stage("connecting")
            await self.activate(candidate, client_path)
            if (await self.props(ap_path, DEVICE))["State"] != 100:
                await self.activate(ap_profile, ap_path)
            result = await self.status()
            if not result["connected"] or result["ssid"] != ssid or not result["ip"] or not result["apActive"]:
                raise WifiError("Chưa xác nhận được IP Wi-Fi và AP hoạt động cùng lúc.")
            settings["connection"]["autoconnect"] = Variant("b", True)
            await self.call(candidate, PROFILE, "Update", "a{sa{sv}}", [settings])
        except (Exception, asyncio.CancelledError):
            if candidate is None:
                raise
            stage("restoring")
            await self.call(candidate, PROFILE, "Delete")
            if channel_change:
                await self.call(ap_profile, PROFILE, "Update", "a{sa{sv}}", [original_ap])
                current_ap = await self.props(ap_path, DEVICE)
                if current_ap["ActiveConnection"] != "/":
                    await self.call(ROOT, NM, "DeactivateConnection", "o", [current_ap["ActiveConnection"]])
            await self.activate(ap_profile, ap_path)
            if previous:
                await self.activate(previous, client_path)
            raise
        # Keep one successful dashboard profile. Unrelated manually configured profiles stay intact.
        for profile in (await self.call(ROOT + "/Settings", NM + ".Settings", "ListConnections"))[0]:
            old = (await self.call(profile, PROFILE, "GetSettings"))[0]
            if profile != candidate and old["connection"]["id"].value == PROFILE_NAME:
                await self.call(profile, PROFILE, "Delete")
        return result
