export type Page = "overview" | "devices" | "history" | "settings";
export type Range = "1h" | "24h" | "7d";
export type Device = {
  id: string;
  name: string;
  mac: string;
  status: "online" | "offline" | "configured";
  ph: number | null;
  calibrated: boolean;
  ph_source?: string | null;
  voltage: number | null;
  sensorError: string | null;
  cycleSeconds: number;
  lastSeen: string;
  lastSeenAt: number | null;
};
export type BleDevice = {
  id: string;
  name: string;
  mac: string;
  rssi: number;
  provisionable: boolean;
};
export type Reading = {
  timestamp: number;
  ph: number | null;
  voltage: number | null;
  deviceId: string;
  calibrated?: boolean;
  ph_source?: string | null;
  raw_adc?: number | null;
  adc_mv?: number | null;
  sensor_error?: string | null;
};
export type Settings = {
  stationName: string;
  phMin: string;
  phMax: string;
  retention: string;
};
export type Snapshot = {
  devices: Device[];
  settings: Settings;
  mqtt: {
    connected: boolean;
    error: string | null;
    host: string;
    port: number;
    subscribe: string;
    publish: string;
    tls: boolean;
  };
  network: { apName: string; apIp: string; hostname: string };
  database: string;
  serverTime: number;
};
export type BleJob = {
  id: string;
  status: "running" | "done" | "failed";
  step: number;
  devices: BleDevice[];
  error: string | null;
  device_id?: string;
};
export type PiNetwork = {
  available: boolean;
  interface: string;
  connected: boolean;
  ssid: string | null;
  ip: string | null;
  apActive: boolean;
  apSsid: string | null;
  apIp: string | null;
  uplink: string | null;
  sharedRadio: boolean;
  error: string | null;
  job: string | null;
};
export type WifiNetwork = {
  ssid: string;
  signal: number;
  channel: number;
  security: "open" | "wpa-psk" | "unsupported";
  supported: boolean;
};
export type WifiJob = {
  id: string;
  kind: "wifi_scan" | "wifi_connect";
  status: "running" | "done" | "failed";
  stage: string;
  error: string | null;
  networks?: WifiNetwork[];
  network?: PiNetwork;
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      typeof body?.detail === "string"
        ? body.detail
        : `API trả về lỗi ${response.status}`,
    );
  }
  return response.json() as Promise<T>;
}
export async function command(
  deviceId: string,
  cmd: "get_status" | "set_cycle",
  cycle?: number,
) {
  const result = await api<{ id: string }>(
    `/devices/${encodeURIComponent(deviceId)}/commands`,
    {
      method: "POST",
      body: JSON.stringify({
        cmd,
        ...(cycle === undefined ? {} : { cycle_seconds: cycle }),
      }),
    },
  );
  for (let i = 0; i < 34; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = await api<{ status: string; error: string | null }>(
      `/commands/${result.id}`,
    );
    if (status.status === "applied") return;
    if (status.status !== "pending")
      throw new Error(
        status.error === "ack_timeout"
          ? "Chưa nhận ACK từ ESP32. Kiểm tra thiết bị rồi đọc trạng thái lại."
          : status.error || "ESP32 từ chối lệnh",
      );
  }
  throw new Error("Hết thời gian chờ ESP32 xác nhận");
}
export function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function chartReadings(readings: Reading[]) {
  return readings;
}
