"""Project BLE transport. Scanning stops before opening a GATT connection."""
import logging
import time

from bleak import BleakClient, BleakScanner

from config import DEVICE_UUID, PASSWORD_UUID, SERVICE_UUID, SSID_UUID
from database import DEVICE_ID_RE

log = logging.getLogger("ph.ble")


def is_project_device(advertisement):
    return SERVICE_UUID in {uuid.lower() for uuid in advertisement.service_uuids}


async def scan_project_devices():
    discovered = await BleakScanner.discover(
        timeout=6, return_adv=True, service_uuids=[SERVICE_UUID]
    )
    devices = [
        {
            "id": device.address,
            "mac": device.address,
            "name": advertisement.local_name or device.name or "ESP32",
            "rssi": advertisement.rssi,
            "provisionable": True,
        }
        for device, advertisement in discovered.values()
        if is_project_device(advertisement)
    ]
    return sorted(devices, key=lambda device: -device["rssi"])


def provision_error(error, stage):
    """TimeoutError often has an empty message; always provide useful UI text."""
    if isinstance(error, TimeoutError):
        return {
            "discovering": "Không tìm thấy ESP32 đang phát BLE. Bật lại chế độ cấu hình và quét lại.",
            "connecting": "Pi không kết nối được BLE với ESP32 trong 20 giây. Đưa thiết bị gần Pi, đóng kết nối BLE từ điện thoại rồi thử lại.",
            "reading_id": "Đã kết nối BLE nhưng không đọc được ID của ESP32. Bật lại chế độ cấu hình rồi thử lại.",
            "writing_ssid": "Không ghi được SSID qua BLE. Kết nối bị gián đoạn; hãy quét và thử lại.",
            "writing_password": "Chưa xác nhận được lần gửi Wi-Fi. Bật lại chế độ cấu hình rồi thử lại.",
            "waiting_mqtt": "Đã gửi Wi-Fi qua BLE nhưng chưa nhận MQTT. Kiểm tra Wi-Fi, Internet và broker.",
        }.get(stage, "Thao tác Bluetooth trên Pi đã hết thời gian chờ. Hãy thử lại.")
    return str(error).strip() or f"Lỗi Bluetooth ({type(error).__name__}). Hãy quét và thử lại."


async def write_wifi(mac, ssid, password, on_stage):
    on_stage("discovering", 0)
    # Refresh advertisements for this MAC, and pass the actual BLEDevice to the
    # client. Passing a string makes Bleak start a second, implicit discovery.
    device = await BleakScanner.find_device_by_filter(
        lambda device, advertisement: device.address.upper() == mac.upper()
        and is_project_device(advertisement),
        timeout=8,
        service_uuids=[SERVICE_UUID],
    )
    if device is None:
        raise TimeoutError()

    on_stage("connecting", 0)
    async with BleakClient(device, timeout=20) as client:
        if not any(service.uuid.lower() == SERVICE_UUID for service in client.services):
            raise ValueError("Thiết bị không có service provision của dự án")
        for characteristic in (DEVICE_UUID, SSID_UUID, PASSWORD_UUID):
            if client.services.get_characteristic(characteristic) is None:
                raise ValueError("Firmware ESP32 thiếu characteristic provision cần thiết")

        on_stage("reading_id", 0)
        device_id = (await client.read_gatt_char(DEVICE_UUID)).decode().strip("\x00")
        if not DEVICE_ID_RE.fullmatch(device_id):
            raise ValueError("Device ID BLE không hợp lệ")

        on_stage("writing_ssid", 1)
        await client.write_gatt_char(SSID_UUID, ssid.encode(), response=True)
        on_stage("writing_password", 1)
        started = time.time()
        try:
            await client.write_gatt_char(PASSWORD_UUID, password.encode(), response=True)
        except Exception as error:
            # Firmware can close BLE immediately after consuming the password,
            # before BlueZ receives the write response. MQTT is the final proof.
            if client.is_connected:
                raise
            log.info("BLE closed during final Wi-Fi write device=%s error_type=%s; awaiting MQTT", device_id, type(error).__name__)

    return device_id, started
