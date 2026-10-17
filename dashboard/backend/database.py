import json
import math
import re
import sqlite3
import threading
import time
from pathlib import Path
from ph_calibration import estimate_ph

DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
DEFAULT_SETTINGS = {"stationName": "Trạm giám sát nước", "phMin": "6.5", "phMax": "8.5", "retention": "30"}

def number(value, low, high):
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high

class Database:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, mac TEXT NOT NULL DEFAULT '',
                last_seen REAL, cycle_seconds INTEGER NOT NULL DEFAULT 10,
                ph REAL, voltage REAL, sensor_error TEXT, status TEXT NOT NULL DEFAULT 'configured',
                calibrated INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS readings (
                id INTEGER PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
                message_id TEXT NOT NULL, recorded_at REAL NOT NULL, received_at REAL NOT NULL,
                ph REAL, voltage REAL, raw_adc INTEGER, adc_mv INTEGER, sensor_error TEXT,
                UNIQUE(device_id, message_id));
            CREATE INDEX IF NOT EXISTS readings_time ON readings(device_id, recorded_at);
            CREATE TABLE IF NOT EXISTS commands (
                id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
                cmd TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                created_at REAL NOT NULL, finished_at REAL, response TEXT, error TEXT);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        # Keep old history intact. Only newly received samples get the temporary conversion.
        for table in ("devices", "readings"):
            columns = {row["name"] for row in self.db.execute(f"PRAGMA table_info({table})")}
            if "calibrated" not in columns:
                self.db.execute(f"ALTER TABLE {table} ADD COLUMN calibrated INTEGER NOT NULL DEFAULT 0")
            if "ph_source" not in columns:
                self.db.execute(f"ALTER TABLE {table} ADD COLUMN ph_source TEXT")
        with self.db:
            for key, value in DEFAULT_SETTINGS.items():
                self.db.execute("INSERT OR IGNORE INTO settings VALUES (?,?)", (key, value))
            # Commands sent before a service restart must never be reported as applied.
            self.db.execute("UPDATE commands SET status='failed',error='backend_restarted',finished_at=? WHERE status='pending'", (time.time(),))

    def settings(self):
        with self.lock:
            return {row["key"]: row["value"] for row in self.db.execute("SELECT * FROM settings")}

    def save_settings(self, values):
        with self.lock, self.db:
            for key, value in values.items():
                self.db.execute("UPDATE settings SET value=? WHERE key=?", (value, key))

    def register(self, device_id, name=None, mac=None):
        if not DEVICE_ID_RE.fullmatch(device_id):
            raise ValueError("invalid device_id")
        with self.lock, self.db:
            self.db.execute("INSERT OR IGNORE INTO devices(id,name) VALUES(?,?)", (device_id, name or device_id))
            if name is not None:
                self.db.execute("UPDATE devices SET name=? WHERE id=?", (name, device_id))
            if mac is not None:
                self.db.execute("UPDATE devices SET mac=? WHERE id=?", (mac, device_id))

    def ingest(self, topic, payload, retained=False):
        parts = topic.split("/")
        if len(parts) != 2 or parts[0] != "phwateresp32" or not DEVICE_ID_RE.fullmatch(parts[1]):
            raise ValueError("invalid telemetry topic")
        if not isinstance(payload, dict) or payload.get("device_id") != parts[1]:
            raise ValueError("topic/device_id mismatch")
        device_id, now = parts[1], time.time()
        kind = payload.get("type")
        if kind == "telemetry":
            # Never replay a retained measurement into history or make an old device online.
            if retained:
                return False
            message_id = payload.get("message_id")
            cycle = payload.get("cycle_seconds")
            timestamp = payload.get("timestamp")
            if not isinstance(message_id, str) or not 1 <= len(message_id) <= 96:
                raise ValueError("invalid message_id")
            if not number(timestamp, 1704067200, now + 300):
                raise ValueError("invalid timestamp")
            if type(cycle) is not int or not 1 <= cycle <= 86400:
                raise ValueError("invalid cycle")
            for field, low, high in (("ph", 0, 14), ("voltage", 0, 7), ("raw_adc", 0, 4095), ("adc_mv", 0, 3500)):
                if payload.get(field) is not None and not number(payload[field], low, high):
                    raise ValueError(f"invalid {field}")
            error = payload.get("sensor_error")
            if error is not None and (not isinstance(error, str) or len(error) > 96):
                raise ValueError("invalid sensor error")
            ph = payload.get("ph")
            calibrated = ph is not None and payload.get("calibrated") is True
            source = "firmware_calibrated" if calibrated else "firmware_default" if ph is not None else None
            if ph is None and error is None:
                ph = estimate_ph(payload.get("voltage"))
                if ph is not None:
                    source = "pi_default"
            self.register(device_id)
            with self.lock, self.db:
                cursor = self.db.execute("""INSERT OR IGNORE INTO readings
                    (device_id,message_id,recorded_at,received_at,ph,voltage,raw_adc,adc_mv,sensor_error,calibrated,ph_source)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)""", (device_id, message_id, timestamp, now, ph,
                        payload.get("voltage"), payload.get("raw_adc"), payload.get("adc_mv"), error, calibrated, source))
                if cursor.rowcount == 0:
                    return False
                self.db.execute("""UPDATE devices SET last_seen=?,cycle_seconds=?,ph=?,voltage=?,
                    sensor_error=?,status='online',calibrated=?,ph_source=? WHERE id=?""",
                    (now, cycle, ph, payload.get("voltage"), error, calibrated, source, device_id))
            return True
        if kind == "ack":
            command_id = payload.get("command_id")
            if not isinstance(command_id, str) or type(payload.get("ok")) is not bool:
                raise ValueError("invalid ack")
            with self.lock, self.db:
                command = self.db.execute("SELECT * FROM commands WHERE id=? AND device_id=?", (command_id, device_id)).fetchone()
                if not command or command["cmd"] != payload.get("cmd"):
                    return False
                cycle = payload.get("cycle_seconds")
                if payload["ok"] and type(cycle) is int and 1 <= cycle <= 86400:
                    self.db.execute("UPDATE devices SET cycle_seconds=? WHERE id=?", (cycle, device_id))
                self.db.execute("UPDATE commands SET status=?,finished_at=?,response=?,error=? WHERE id=?",
                    ("applied" if payload["ok"] else "failed", now, json.dumps(payload), payload.get("error"), command_id))
            return True
        if kind == "status" and payload.get("status") == "offline":
            with self.lock, self.db:
                self.db.execute("UPDATE devices SET status='offline' WHERE id=?", (device_id,))
            return True
        raise ValueError("unknown message type")

    def devices(self):
        now = time.time()
        with self.lock:
            result = []
            for row in self.db.execute("SELECT * FROM devices ORDER BY name"):
                item = dict(row)
                item["calibrated"] = bool(item["calibrated"])
                age = now - item["last_seen"] if item["last_seen"] else None
                if item["status"] == "online" and (age is None or age > max(30, item["cycle_seconds"] * 3)):
                    item["status"] = "offline"
                item.update(cycleSeconds=item.pop("cycle_seconds"), sensorError=item.pop("sensor_error"),
                            lastSeen="Chưa nhận dữ liệu" if age is None else f"{int(age)} giây trước",
                            lastSeenAt=item["last_seen"], location="Cảm biến nước")
                result.append(item)
            return result

    def create_command(self, command_id, device_id, payload):
        with self.lock, self.db:
            self.db.execute("INSERT INTO commands(id,device_id,cmd,payload,created_at) VALUES(?,?,?,?,?)",
                (command_id, device_id, payload["cmd"], json.dumps(payload), time.time()))

    def fail_command(self, command_id, error):
        with self.lock, self.db:
            self.db.execute("UPDATE commands SET status='failed',error=?,finished_at=? WHERE id=? AND status='pending'",
                            (error, time.time(), command_id))

    def command(self, command_id):
        with self.lock, self.db:
            self.db.execute("UPDATE commands SET status='timeout',error='ack_timeout',finished_at=? WHERE id=? AND status='pending' AND created_at<?",
                (time.time(), command_id, time.time() - 15))
            row = self.db.execute("SELECT * FROM commands WHERE id=?", (command_id,)).fetchone()
            return dict(row) if row else None

    def history(self, device_id, start, end, limit=100, offset=0):
        with self.lock:
            args = (device_id, start, end)
            total = self.db.execute("SELECT COUNT(*) FROM readings WHERE device_id=? AND recorded_at>=? AND recorded_at<=?", args).fetchone()[0]
            rows = self.db.execute("SELECT * FROM readings WHERE device_id=? AND recorded_at>=? AND recorded_at<=? ORDER BY recorded_at DESC,id DESC LIMIT ? OFFSET ?",
                                   (*args, limit, offset)).fetchall()
            return {"total": total, "readings": [self.reading(row) for row in rows]}

    @staticmethod
    def reading(row):
        item = dict(row)
        item["calibrated"] = bool(item["calibrated"])
        item.update(timestamp=item["recorded_at"] * 1000, deviceId=item["device_id"])
        return item

    def chart(self, device_id, start, end):
        with self.lock:
            summary = self.db.execute("SELECT COUNT(*), MIN(recorded_at), MAX(recorded_at) FROM readings WHERE device_id=? AND recorded_at>=? AND recorded_at<=?",
                                      (device_id, start, end)).fetchone()
            if summary[0] <= 300:
                rows = self.db.execute("SELECT recorded_at*1000 AS timestamp,ph,voltage,1 AS count FROM readings WHERE device_id=? AND recorded_at>=? AND recorded_at<=? ORDER BY recorded_at,id",
                                       (device_id, start, end))
                return [{**dict(row), "deviceId": device_id} for row in rows]
            bucket = max(1, (summary[2] - summary[1]) / 299)
            rows = self.db.execute("""SELECT AVG(recorded_at)*1000 AS timestamp, AVG(ph) AS ph,
                AVG(voltage) AS voltage, COUNT(*) AS count FROM readings
                WHERE device_id=? AND recorded_at>=? AND recorded_at<=?
                GROUP BY CAST((recorded_at-?)/? AS INTEGER) ORDER BY timestamp""", (device_id, start, end, summary[1], bucket))
            return [{**dict(row), "deviceId": device_id} for row in rows]

    def prune(self):
        with self.lock, self.db:
            cutoff = time.time() - int(self.settings()["retention"]) * 86400
            self.db.execute("DELETE FROM readings WHERE recorded_at<?", (cutoff,))
            self.db.execute("DELETE FROM commands WHERE created_at<?", (time.time()-30*86400,))
            self.db.execute("UPDATE commands SET status='timeout',error='ack_timeout',finished_at=? WHERE status='pending' AND created_at<?",
                            (time.time(), time.time()-15))
