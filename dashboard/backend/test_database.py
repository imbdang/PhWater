import tempfile
import time
import unittest
from pathlib import Path
from database import Database

class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(str(Path(self.temp.name)/'test.sqlite3'))
        self.message = {'type':'telemetry','device_id':'sensor001','message_id':'boot:1','timestamp':time.time(),
                        'cycle_seconds':10,'voltage':2.1,'ph':None,'raw_adc':1000,'adc_mv':1050,'calibrated':False}

    def tearDown(self):
        self.db.db.close()
        self.temp.cleanup()

    def test_duplicate_qos1_does_not_duplicate_history(self):
        self.assertTrue(self.db.ingest('phwateresp32/sensor001', self.message))
        self.assertFalse(self.db.ingest('phwateresp32/sensor001', self.message))
        rows=self.db.history('sensor001',0,time.time()+1)
        self.assertEqual(rows['total'],1)
        self.assertAlmostEqual(rows['readings'][0]['ph'],9.28)
        self.assertEqual(rows['readings'][0]['ph_source'],'pi_default')
        self.assertFalse(rows['readings'][0]['calibrated'])
        self.assertEqual(rows['readings'][0]['voltage'],2.1)

    def test_topic_identity_and_nonfinite_values_rejected(self):
        with self.assertRaises(ValueError):
            self.db.ingest('phwateresp32/other',self.message)
        with self.assertRaises(ValueError):
            self.db.ingest('phwateresp32/sensor001',{**self.message,'voltage':float('nan')})
        with self.assertRaises(ValueError):
            self.db.ingest('phwateresp32/sensor001',{**self.message,'cycle_seconds':True})
        self.assertFalse(self.db.ingest('phwateresp32/sensor001',self.message,retained=True))
        self.assertEqual(self.db.devices(),[])

    def test_ack_is_matched_by_device_and_command(self):
        self.db.ingest('phwateresp32/sensor001',self.message)
        self.db.create_command('request1','sensor001',{'cmd':'set_cycle','cycle_seconds':5})
        ack={'type':'ack','device_id':'sensor001','cmd':'get_status','command_id':'request1','ok':True,'cycle_seconds':5}
        self.assertFalse(self.db.ingest('phwateresp32/sensor001',ack))
        self.assertEqual(self.db.command('request1')['status'],'pending')
        self.assertTrue(self.db.ingest('phwateresp32/sensor001',{**ack,'cmd':'set_cycle'}))
        self.assertEqual(self.db.command('request1')['status'],'applied')
        self.assertEqual(self.db.devices()[0]['cycleSeconds'],5)

    def test_pending_commands_timeout_and_restart(self):
        self.db.register('sensor001')
        self.db.create_command('expired','sensor001',{'cmd':'get_status'})
        with self.db.db:
            self.db.db.execute('UPDATE commands SET created_at=? WHERE id=?',(time.time()-20,'expired'))
        self.assertEqual(self.db.command('expired')['status'],'timeout')
        self.db.create_command('pending','sensor001',{'cmd':'get_status'})
        other=Database(str(Path(self.temp.name)/'test.sqlite3'))
        self.assertEqual(other.command('pending')['error'],'backend_restarted')
        other.db.close()

    def test_retention_and_chart_use_stored_samples(self):
        self.db.ingest('phwateresp32/sensor001',self.message)
        self.db.ingest('phwateresp32/sensor001',{**self.message,'message_id':'boot:old','timestamp':time.time()-3*86400,'voltage':1.2})
        self.db.save_settings({'retention':'1'})
        self.db.prune()
        chart=self.db.chart('sensor001',time.time()-86400,time.time()+1)
        self.assertEqual(len(chart),1)
        self.assertEqual(chart[0]['voltage'],2.1)
        self.assertEqual(self.db.history('sensor001',0,time.time()+1)['total'],1)

    def test_last_seen_age_and_offline_will(self):
        self.db.ingest('phwateresp32/sensor001',self.message)
        with self.db.db:
            self.db.db.execute('UPDATE devices SET last_seen=?',(time.time()-40,))
        self.assertEqual(self.db.devices()[0]['status'],'offline')

        self.db.ingest('phwateresp32/sensor001',{**self.message,'message_id':'boot:2'})
        self.db.ingest('phwateresp32/sensor001',{'type':'status','device_id':'sensor001','status':'offline'})
        self.assertEqual(self.db.devices()[0]['status'],'offline')

    def test_firmware_ph_is_preserved_with_its_calibration_flag(self):
        self.db.ingest('phwateresp32/sensor001',{**self.message,'ph':6.62})
        self.assertEqual(self.db.devices()[0]['ph'],6.62)
        self.assertFalse(self.db.devices()[0]['calibrated'])
        self.assertEqual(self.db.devices()[0]['ph_source'],'firmware_default')
        self.db.ingest('phwateresp32/sensor001',{**self.message,'message_id':'boot:cal','ph':7.1,'calibrated':True})
        self.assertEqual(self.db.devices()[0]['ph'],7.1)
        self.assertTrue(self.db.devices()[0]['calibrated'])
        self.assertEqual(self.db.devices()[0]['ph_source'],'firmware_calibrated')

    def test_sensor_errors_and_missing_voltage_do_not_create_ph(self):
        self.db.ingest('phwateresp32/sensor001',{**self.message,'sensor_error':'ESP_ERR_INVALID_STATE'})
        self.assertIsNone(self.db.devices()[0]['ph'])
        self.db.ingest('phwateresp32/sensor001',{**self.message,'message_id':'boot:missing','voltage':None})
        self.assertIsNone(self.db.devices()[0]['ph'])

    def test_migration_preserves_old_null_history_and_accepts_new_estimates(self):
        self.db.ingest('phwateresp32/sensor001',self.message)
        with self.db.db:
            self.db.db.execute('UPDATE readings SET ph=NULL')
            self.db.db.execute('ALTER TABLE readings DROP COLUMN calibrated')
            self.db.db.execute('ALTER TABLE readings DROP COLUMN ph_source')
            self.db.db.execute('ALTER TABLE devices DROP COLUMN ph_source')
        other=Database(str(Path(self.temp.name)/'test.sqlite3'))
        try:
            self.assertIsNone(other.history('sensor001',0,time.time()+1)['readings'][0]['ph'])
            other.ingest('phwateresp32/sensor001',{**self.message,'message_id':'boot:new','voltage':2.566})
            self.assertAlmostEqual(other.devices()[0]['ph'],6.6238)
            self.assertEqual(other.history('sensor001',0,time.time()+1)['total'],2)
        finally:
            other.db.close()

if __name__=='__main__':
    unittest.main()
