import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from ble_provision import is_project_device, provision_error, scan_project_devices, write_wifi
from config import DEVICE_UUID, PASSWORD_UUID, SERVICE_UUID, SSID_UUID


class BleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.device = SimpleNamespace(address='4C:C3:82:ED:11:6E', name='ICTU-HaiAnh')
        self.advertisement = SimpleNamespace(service_uuids=[SERVICE_UUID], local_name='ICTU-HaiAnh', rssi=-31)
        self.services = Mock()
        self.services.__iter__ = Mock(return_value=iter([SimpleNamespace(uuid=SERVICE_UUID)]))
        self.services.get_characteristic.return_value = object()
        self.client = Mock(services=self.services, is_connected=True)
        self.client.__aenter__ = AsyncMock(return_value=self.client)
        self.client.__aexit__ = AsyncMock(return_value=False)
        self.client.read_gatt_char = AsyncMock(return_value=b'ictu_haianh001')
        self.client.write_gatt_char = AsyncMock()

    async def test_scans_only_project_service_even_if_name_matches(self):
        wrong = SimpleNamespace(address='11:22:33:44:55:66', name='ICTU-HaiAnh')
        advertisement = SimpleNamespace(service_uuids=['0000180f-0000-1000-8000-00805f9b34fb'], local_name='ICTU-HaiAnh', rssi=-10)
        discovered = {'ours': (self.device, self.advertisement), 'other': (wrong, advertisement)}
        with patch('ble_provision.BleakScanner.discover', AsyncMock(return_value=discovered)) as discover:
            rows = await scan_project_devices()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['mac'], self.device.address)
        self.assertTrue(rows[0]['provisionable'])
        self.assertEqual(discover.call_args.kwargs['service_uuids'], [SERVICE_UUID])
        self.assertTrue(is_project_device(SimpleNamespace(service_uuids=[SERVICE_UUID.upper()])))

    async def test_refreshes_exact_device_and_passes_object_to_gatt_client(self):
        stages=[]
        with patch('ble_provision.BleakScanner.find_device_by_filter', AsyncMock(return_value=self.device)) as find, \
             patch('ble_provision.BleakClient', return_value=self.client) as factory:
            device_id, started = await write_wifi(self.device.address, 'Test-WiFi', 'test-password', lambda stage,step: stages.append(stage))
        predicate = find.call_args.args[0]
        self.assertTrue(predicate(self.device, self.advertisement))
        self.assertFalse(predicate(SimpleNamespace(address='11:22:33:44:55:66'), self.advertisement))
        self.assertFalse(predicate(self.device, SimpleNamespace(service_uuids=[])))
        factory.assert_called_once_with(self.device, timeout=20)
        self.client.read_gatt_char.assert_awaited_once_with(DEVICE_UUID)
        self.assertEqual(self.client.write_gatt_char.await_args_list[0].args, (SSID_UUID, b'Test-WiFi'))
        self.assertEqual(self.client.write_gatt_char.await_args_list[1].args, (PASSWORD_UUID, b'test-password'))
        self.assertEqual(device_id, 'ictu_haianh001')
        self.assertGreater(started, 0)
        self.assertEqual(stages, ['discovering','connecting','reading_id','writing_ssid','writing_password'])

    async def test_missing_advertisement_does_not_attempt_connection(self):
        with patch('ble_provision.BleakScanner.find_device_by_filter', AsyncMock(return_value=None)), \
             patch('ble_provision.BleakClient') as factory:
            with self.assertRaises(TimeoutError):
                await write_wifi(self.device.address,'Test-WiFi','test-password',lambda *args: None)
            factory.assert_not_called()

    async def test_missing_gatt_characteristic_never_sends_credentials(self):
        self.services.get_characteristic.return_value = None
        with patch('ble_provision.BleakScanner.find_device_by_filter', AsyncMock(return_value=self.device)), \
             patch('ble_provision.BleakClient', return_value=self.client):
            with self.assertRaises(ValueError):
                await write_wifi(self.device.address,'Test-WiFi','test-password',lambda *args: None)
        self.client.write_gatt_char.assert_not_awaited()

    async def test_disconnect_during_final_write_still_allows_mqtt_confirmation(self):
        async def write(uuid, value, response):
            if uuid == PASSWORD_UUID:
                self.client.is_connected = False
                raise EOFError('Disconnected')
        self.client.write_gatt_char.side_effect = write
        with patch('ble_provision.BleakScanner.find_device_by_filter', AsyncMock(return_value=self.device)), \
             patch('ble_provision.BleakClient', return_value=self.client):
            device_id, started = await write_wifi(self.device.address,'Test-WiFi','test-password',lambda *args: None)
        self.assertEqual(device_id, 'ictu_haianh001')
        self.assertGreater(started, 0)

    async def test_final_write_error_while_connected_is_reported(self):
        self.client.write_gatt_char.side_effect = [None, TimeoutError()]
        with patch('ble_provision.BleakScanner.find_device_by_filter', AsyncMock(return_value=self.device)), \
             patch('ble_provision.BleakClient', return_value=self.client):
            with self.assertRaises(TimeoutError):
                await write_wifi(self.device.address,'Test-WiFi','test-password',lambda *args: None)

    def test_blank_timeouts_have_stage_specific_ui_messages(self):
        for stage in ['discovering','connecting','reading_id','writing_ssid','writing_password','waiting_mqtt']:
            self.assertTrue(provision_error(TimeoutError(), stage).strip())
        self.assertIn('20 giây',provision_error(TimeoutError(),'connecting'))
        self.assertIn('MQTT',provision_error(TimeoutError(),'waiting_mqtt'))
        self.assertIn('RuntimeError',provision_error(RuntimeError(),'connecting'))


if __name__ == '__main__':
    unittest.main()
