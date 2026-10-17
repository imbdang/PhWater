import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Bluetooth,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Cpu,
  Database,
  Droplet,
  History,
  LayoutDashboard,
  LoaderCircle,
  Menu,
  Radio,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Wifi,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PhChart } from "@/components/Chart";
import { ProvisionDialog } from "@/components/ProvisionDialog";
import { PiWifiPanel } from "@/components/PiWifiPanel";
import {
  api,
  command,
  localDate,
  type BleDevice,
  type BleJob,
  type Device,
  type Page,
  type Range,
  type Reading,
  type Settings,
  type Snapshot,
} from "@/lib/api";

const navigation: { id: Page; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Tổng quan", icon: LayoutDashboard },
  { id: "devices", label: "Thiết bị", icon: Cpu },
  { id: "history", label: "Lịch sử dữ liệu", icon: History },
  { id: "settings", label: "Cài đặt", icon: Settings2 },
];
const subtitles: Record<Page, string> = {
  overview: "Theo dõi cảm biến nước, ngay tại trạm của bạn.",
  devices: "Kết nối ESP32 qua BLE và điều khiển chu kỳ gửi MQTT.",
  history: "Số đo thật được lưu trên Raspberry Pi theo thời gian.",
  settings: "Kết nối Wi-Fi cho Pi, cấu hình trạm và lịch sử.",
};
function initialPage(): Page {
  return (
    navigation.find((n) => n.id === window.location.hash.slice(1))?.id ||
    "overview"
  );
}
function Badge({
  children,
  tone = "green",
}: {
  children: React.ReactNode;
  tone?: "green" | "amber" | "gray" | "blue";
}) {
  return (
    <span className={`badge badge-${tone}`}>
      <i />
      {children}
    </span>
  );
}
function DeviceStatus({ device }: { device: Device }) {
  return (
    <Badge
      tone={
        device.status === "online"
          ? "green"
          : device.status === "configured"
            ? "blue"
            : "gray"
      }
    >
      {device.status === "online"
        ? "Trực tuyến"
        : device.status === "configured"
          ? "Chờ dữ liệu"
          : "Ngoại tuyến"}
    </Badge>
  );
}
function SectionHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
const format = (value: number | null | undefined, digits = 3) =>
  value == null ? "—" : value.toFixed(digits);
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Có lỗi xảy ra";
}

export default function App() {
  const [page, setPage] = useState<Page>(initialPage);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [toast, setToast] = useState("");
  const [selectedBle, setSelectedBle] = useState<BleDevice | null>(null);
  const [scanRequested, setScanRequested] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const devices = snapshot?.devices || [];
  useEffect(() => {
    const handler = () => setPage(initialPage());
    window.addEventListener("hashchange", handler);
    return () => {
      window.removeEventListener("hashchange", handler);
      clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    document.title = `${navigation.find((n) => n.id === page)?.label} · pH Monitor`;
  }, [page]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const data = await api<Snapshot>("/snapshot", {
          signal: controller.signal,
        });
        setSnapshot(data);
        setConnectionError("");
      } catch (error) {
        if (!controller.signal.aborted) setConnectionError(errorMessage(error));
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 2500);
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  function navigate(next: Page) {
    setPage(next);
    window.location.hash = next;
    setMobileMenu(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function notify(message: string) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 6000);
  }
  function startScan() {
    navigate("devices");
    setScanRequested((n) => n + 1);
  }
  return (
    <div className="app-shell">
      {mobileMenu && (
        <button
          className="mobile-overlay"
          aria-label="Đóng menu"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside
        className={`sidebar ${mobileMenu ? "open" : ""}`}
        aria-label="Điều hướng chính"
      >
        <a
          className="brand"
          href="#overview"
          onClick={() => navigate("overview")}
        >
          <span className="brand-mark">
            <Droplet size={23} />
          </span>
          <div>
            pH<span>Monitor</span>
            <small>WATER, UNDER CONTROL.</small>
          </div>
        </a>
        <div className="workspace-label">KHÔNG GIAN CỦA BẠN</div>
        <nav>
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              onClick={() => navigate(id)}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === "devices" && <small>{devices.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-add">
          <div className="add-icon">
            <Bluetooth size={22} />
          </div>
          <h3>Kết nối một cảm biến mới</h3>
          <p>Đưa ESP32 vào chế độ cấu hình và để Pi tìm thiết bị.</p>
          <button onClick={startScan}>
            Quét BLE <ArrowRight size={16} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <div className="station-card">
            <div className="station-chip">
              <Cpu size={20} />
            </div>
            <div>
              <strong>Raspberry Pi 4</strong>
              <span>
                <i />
                {snapshot && !connectionError
                  ? "Trạm đang hoạt động"
                  : "Đang kết nối trạm"}
              </span>
            </div>
          </div>
          <div className="sidebar-meta">
            <span>LOCAL WORKSPACE</span>
            <span>v1.0</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <Button
              variant="ghost"
              size="icon"
              className="mobile-menu-button"
              aria-label="Mở menu"
              onClick={() => setMobileMenu(true)}
            >
              <Menu size={22} />
            </Button>
            <span>
              {snapshot?.settings.stationName || "Trạm giám sát nước"}
            </span>
            <ChevronRight size={14} />
            <strong>{navigation.find((n) => n.id === page)?.label}</strong>
          </div>
          <div className="topbar-right">
            <span className="demo-label">
              <span />
              {connectionError
                ? "Mất kết nối Pi"
                : snapshot
                  ? "Dữ liệu trực tiếp"
                  : "Đang kết nối"}
            </span>
            <div className="user-avatar">PI</div>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <span className="eyebrow">TRẠM GIÁM SÁT NƯỚC</span>
              <h1>
                {navigation.find((n) => n.id === page)?.label}
                <span className="heading-dot">.</span>
              </h1>
              <p>{subtitles[page]}</p>
            </div>
            <div className="heading-actions">
              <span className="today">
                <Clock3 size={15} />
                {new Date().toLocaleDateString("vi-VN")}
              </span>
              {page === "devices" && (
                <Button onClick={startScan}>
                  <Bluetooth size={17} />
                  Quét BLE
                </Button>
              )}
            </div>
          </div>
          {connectionError && (
            <div className="live-error" role="alert">
              Không lấy được dữ liệu mới từ Pi: {connectionError}. Màn hình đang
              giữ dữ liệu nhận lần gần nhất.
            </div>
          )}
          {!snapshot && (
            <div className="panel live-empty">
              {connectionError || (
                <>
                  <LoaderCircle className="spin" size={22} /> Đang kết nối
                  Raspberry Pi…
                </>
              )}
            </div>
          )}
          {snapshot && page === "overview" && (
            <Overview
              snapshot={snapshot}
              notify={notify}
              startScan={startScan}
            />
          )}
          {snapshot && page === "devices" && (
            <Devices
              devices={devices}
              connected={snapshot.mqtt.connected && !connectionError}
              scanRequested={scanRequested}
              onProvision={setSelectedBle}
              notify={notify}
            />
          )}
          {snapshot && page === "history" && (
            <HistoryPage
              devices={devices}
              refresh={Math.floor(snapshot.serverTime / 5)}
            />
          )}
          {snapshot && page === "settings" && (
            <SettingsPage
              key={JSON.stringify(snapshot.settings)}
              snapshot={snapshot}
              notify={notify}
            />
          )}
          <footer>
            <span>
              <Droplet size={13} />
              pH Monitor <i /> Chăm sóc nguồn nước của bạn.
            </span>
            <span>
              <ShieldCheck size={13} />
              Web cục bộ trên Raspberry Pi
            </span>
          </footer>
        </main>
      </div>
      <nav
        className="mobile-bottom-nav"
        aria-label="Điều hướng trên điện thoại"
      >
        {navigation.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={page === id ? "active" : ""}
            onClick={() => navigate(id)}
            aria-current={page === id ? "page" : undefined}
          >
            <Icon size={21} />
            <span>{id === "history" ? "Lịch sử" : label}</span>
          </button>
        ))}
      </nav>
      <ProvisionDialog
        device={selectedBle}
        onClose={() => setSelectedBle(null)}
        onComplete={() =>
          notify("Pi đã nhận MQTT từ ESP32 sau khi cấu hình Wi-Fi.")
        }
      />
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={20} />
          <span>{toast}</span>
          <button aria-label="Đóng thông báo" onClick={() => setToast("")}>
            <X size={17} />
          </button>
        </div>
      )}
    </div>
  );
}

function DeviceSelect({
  devices,
  selected,
  onChange,
}: {
  devices: Device[];
  selected: string;
  onChange: (id: string) => void;
}) {
  return (
    <select
      aria-label="Chọn cảm biến"
      value={selected}
      onChange={(event) => onChange(event.target.value)}
    >
      {!devices.length && <option value="">Chưa có cảm biến</option>}
      {devices.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </select>
  );
}
function Overview({
  snapshot,
  notify,
  startScan,
}: {
  snapshot: Snapshot;
  notify: (message: string) => void;
  startScan: () => void;
}) {
  const [selected, setSelected] = useState("");
  const deviceId = snapshot.devices.some((d) => d.id === selected)
    ? selected
    : snapshot.devices[0]?.id || "";
  const device = snapshot.devices.find((d) => d.id === deviceId);
  const [range, setRange] = useState<Range>("24h");
  const [readings, setReadings] = useState<Reading[]>([]);
  const [chartError, setChartError] = useState("");
  const [metric, setMetric] = useState<"voltage" | "ph">("ph");
  const refresh = Math.floor(snapshot.serverTime / 5);
  useEffect(() => {
    const controller = new AbortController();
    if (!deviceId) return;
    const end = Date.now() / 1000,
      seconds = range === "1h" ? 3600 : range === "24h" ? 86400 : 7 * 86400;
    api<{ readings: Reading[] }>(
      `/chart?device_id=${encodeURIComponent(deviceId)}&start=${end - seconds}&end=${end}`,
      { signal: controller.signal },
    )
      .then((data) => {
        setReadings(data.readings);
        setChartError("");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setChartError(errorMessage(error));
      });
    return () => controller.abort();
  }, [deviceId, range, refresh]);
  const online = snapshot.devices.filter((d) => d.status === "online").length;
  const liveReadings = readings.filter((r) => r.deviceId === deviceId);
  return (
    <div className="page-content">
      <div className="metric-grid">
        <article className="metric-card current-ph">
          <div className="metric-top">
            <span>Điện áp cảm biến hiện tại</span>
            <div className="metric-icon">
              <Activity size={18} />
            </div>
          </div>
          <div className="metric-value">
            {format(device?.voltage)}
            <span>V</span>
          </div>
          <div className="metric-bottom">
            <Badge
              tone={
                device?.sensorError
                  ? "amber"
                  : device?.status === "online"
                    ? "green"
                    : "gray"
              }
            >
              {device?.sensorError
                ? "Lỗi đọc cảm biến"
                : device?.status === "online"
                  ? "Số đo ADC thật"
                  : "Chưa có dữ liệu mới"}
            </Badge>
          </div>
        </article>
        <article className="metric-card">
          <div className="metric-top">
            <span>Độ pH hiện tại</span>
            <div className="metric-icon blue">
              <Droplet size={18} />
            </div>
          </div>
          <div className="metric-value">
            {format(device?.ph, 2)}
            <span>pH</span>
          </div>
          <div className="metric-bottom">
            <span className="muted">
              {device?.ph == null
                ? "Chưa có số đo pH"
                : device.calibrated ? "Đã hiệu chuẩn" : "pH tạm · Chưa hiệu chuẩn"}
            </span>
          </div>
        </article>
        <article className="metric-card">
          <div className="metric-top">
            <span>Thiết bị trực tuyến</span>
            <div className="metric-icon purple">
              <Cpu size={18} />
            </div>
          </div>
          <div className="metric-value">
            {online}
            <span className="metric-denominator">
              / {snapshot.devices.length}
            </span>
          </div>
          <div className="metric-bottom">
            <span className="muted">Theo lần nhận dữ liệu gần nhất</span>
          </div>
        </article>
        <article className="metric-card">
          <div className="metric-top">
            <span>Kết nối MQTT</span>
            <div className="metric-icon orange">
              <Radio size={18} />
            </div>
          </div>
          <div className="metric-text-value">
            {snapshot.mqtt.connected ? "Đã kết nối" : "Mất kết nối"}
          </div>
          <div className="metric-bottom">
            <span className="muted">flespi · TLS {snapshot.mqtt.port}</span>
          </div>
        </article>
      </div>
      <div className="live-overview-grid">
        <section className="panel chart-panel">
          <SectionHeading
            title={
              metric === "voltage" ? "Diễn biến điện áp" : "Diễn biến độ pH"
            }
            subtitle="Lịch sử từ cảm biến, lưu trên Raspberry Pi."
            action={
              <span className="live-indicator">
                <span />
                {device?.status === "online" ? "Trực tiếp" : "Lịch sử"}
              </span>
            }
          />
          <div className="chart-toolbar">
            <div className="chart-device-select">
              <Cpu size={15} />
              <DeviceSelect
                devices={snapshot.devices}
                selected={deviceId}
                onChange={setSelected}
              />
            </div>
            <div className="range-selector">
              {(["1h", "24h", "7d"] as Range[]).map((r) => (
                <button
                  key={r}
                  className={range === r ? "active" : ""}
                  onClick={() => setRange(r)}
                >
                  {r === "1h" ? "1 giờ" : r === "24h" ? "24 giờ" : "7 ngày"}
                </button>
              ))}
            </div>
          </div>
          <div className="live-chart-switch">
            <button
              className={metric === "voltage" ? "active" : ""}
              onClick={() => setMetric("voltage")}
            >
              Điện áp (V)
            </button>
            <button
              className={metric === "ph" ? "active" : ""}
              onClick={() => setMetric("ph")}
            >
              pH
            </button>
          </div>
          {chartError ? (
            <div className="chart-empty" role="alert">
              {chartError}
            </div>
          ) : (
            <PhChart
              readings={liveReadings}
              metric={metric}
              min={Number(snapshot.settings.phMin)}
              max={Number(snapshot.settings.phMax)}
              days={range === "7d"}
            />
          )}
          <div className="chart-legend">
            <span>
              <i />
              {metric === "voltage" ? "Điện áp đầu ra PO" : "pH"}
            </span>
            <span className="chart-legend-note">
              {metric === "ph" && device?.ph != null && !device.calibrated
                ? "pH tính từ điện áp với hệ số tạm."
                : liveReadings.length
                ? "Biểu đồ trung bình theo khoảng; CSV giữ số đo gốc."
                : "Đang chờ số đo đầu tiên"}
            </span>
          </div>
        </section>
        <section className="panel live-control-panel">
          <SectionHeading
            title="Điều khiển cảm biến"
            subtitle="Lệnh được xác nhận trực tiếp bởi ESP32."
          />
          {device ? (
            <>
              <div className="live-device-head">
                <span className="device-symbol">
                  <Cpu size={23} />
                </span>
                <div>
                  <h3>{device.name}</h3>
                  <small>{device.id}</small>
                </div>
              </div>
              <DeviceStatus device={device} />
              <p className="form-hint">Cập nhật: {device.lastSeen}</p>
              {device.sensorError && (
                <p className="form-error">{device.sensorError}</p>
              )}
              <DeviceControls
                key={device.id}
                device={device}
                connected={snapshot.mqtt.connected}
                notify={notify}
              />
            </>
          ) : (
            <div className="live-empty">
              <Bluetooth size={34} />
              <h3>Thêm cảm biến đầu tiên</h3>
              <p>Quét BLE khi ESP32 ở chế độ cấu hình.</p>
              <Button onClick={startScan}>
                Quét BLE <ArrowRight size={15} />
              </Button>
            </div>
          )}
        </section>
      </div>
      <section className="panel live-storage">
        <Database size={24} />
        <div>
          <h3>Lịch sử nằm trên Pi của bạn</h3>
          <p>
            SQLite lưu từng số đo và thời gian UTC. Điện thoại và laptop xem
            cùng một nguồn dữ liệu.
          </p>
        </div>
        <Badge tone="blue">Lưu {snapshot.settings.retention} ngày</Badge>
      </section>
    </div>
  );
}
function DeviceControls({
  device,
  connected,
  notify,
}: {
  device: Device;
  connected: boolean;
  notify: (message: string) => void;
}) {
  const [cycle, setCycle] = useState(String(device.cycleSeconds));
  const [busy, setBusy] = useState<"get_status" | "set_cycle" | null>(null);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState("");
  const edited = useRef(false);
  useEffect(() => {
    if (!edited.current) setCycle(String(device.cycleSeconds));
  }, [device.cycleSeconds]);
  async function send(cmd: "get_status" | "set_cycle") {
    const value = Number(cycle);
    if (
      cmd === "set_cycle" &&
      (!Number.isInteger(value) || value < 1 || value > 86400)
    ) {
      setError("Chu kỳ cần là số nguyên từ 1 đến 86400 giây.");
      return;
    }
    setBusy(cmd);
    setError("");
    setConfirmed("");
    try {
      await command(device.id, cmd, cmd === "set_cycle" ? value : undefined);
      edited.current = false;
      const message =
        cmd === "set_cycle"
          ? `ESP32 đã lưu chu kỳ ${value} giây.`
          : "ESP32 đã gửi trạng thái và số đo hiện tại.";
      setConfirmed(message);
      notify(message);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }
  const disabled = !!busy || !connected || device.status !== "online";
  return (
    <div className="live-device-controls">
      <label>
        Chu kỳ gửi MQTT (giây)
        <input
          aria-label={`Chu kỳ gửi của ${device.id}`}
          type="number"
          min={1}
          max={86400}
          step={1}
          value={cycle}
          onChange={(e) => {
            edited.current = true;
            setCycle(e.target.value);
          }}
        />
        <small>Chu kỳ hiện tại trên ESP32: {device.cycleSeconds} giây</small>
      </label>
      <Button
        variant="outline"
        disabled={disabled}
        onClick={() => send("set_cycle")}
      >
        {busy === "set_cycle" ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <Clock3 size={16} />
        )}
        {busy === "set_cycle" ? "Đang chờ ACK…" : "Lưu chu kỳ"}
      </Button>
      <Button disabled={disabled} onClick={() => send("get_status")}>
        {busy === "get_status" ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <RefreshCw size={16} />
        )}
        {busy === "get_status" ? "Đang chờ ESP32…" : "Lấy trạng thái ngay"}
      </Button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {confirmed && (
        <p className="live-confirmed" role="status">
          {confirmed}
        </p>
      )}
    </div>
  );
}
function Devices({
  devices,
  connected,
  scanRequested,
  onProvision,
  notify,
}: {
  devices: Device[];
  connected: boolean;
  scanRequested: number;
  onProvision: (d: BleDevice) => void;
  notify: (message: string) => void;
}) {
  const [bleDevices, setBleDevices] = useState<BleDevice[]>([]),
    [scanning, setScanning] = useState(false),
    [scanError, setScanError] = useState(""),
    [scanned, setScanned] = useState(false);
  const controller = useRef<AbortController | null>(null),
    seenRequest = useRef(0),
    startRef = useRef<() => void>(() => {});
  async function start() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setScanning(true);
    setScanError("");
    setBleDevices([]);
    setScanned(true);
    try {
      const job = await api<BleJob>("/ble/scan", {
        method: "POST",
        signal: current.signal,
      });
      for (;;) {
        if (current.signal.aborted) return;
        const state = await api<BleJob>(`/ble/jobs/${job.id}`, {
          signal: current.signal,
        });
        if (state.status === "failed")
          throw new Error(state.error || "Quét BLE thất bại");
        if (state.status === "done") {
          setBleDevices(state.devices.filter((device) => device.provisionable));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    } catch (error) {
      if (!current.signal.aborted) setScanError(errorMessage(error));
    } finally {
      if (!current.signal.aborted) setScanning(false);
    }
  }
  useEffect(() => {
    startRef.current = () => {
      void start();
    };
  });
  useEffect(() => {
    if (scanRequested && scanRequested !== seenRequest.current) {
      seenRequest.current = scanRequested;
      startRef.current();
    }
  }, [scanRequested]);
  useEffect(() => () => controller.current?.abort(), []);
  return (
    <div className="page-content">
      <section className="panel live-ble-panel">
        <SectionHeading
          title="Tìm ESP32 quanh trạm"
          subtitle="Giữ nút cấu hình trên ESP32 khoảng 5 giây. Pi nhận diện service BLE của dự án."
          action={
            <Button disabled={scanning} onClick={start}>
              {scanning ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Bluetooth size={16} />
              )}
              {scanning ? "Đang quét BLE…" : "Quét lại"}
            </Button>
          }
        />
        {scanError && (
          <p className="form-error" role="alert">
            {scanError}
          </p>
        )}
        {scanning && (
          <div className="live-empty">
            <Bluetooth className="spin" size={30} />
            <p>Raspberry Pi đang quét Bluetooth…</p>
          </div>
        )}
        {!scanning && !bleDevices.length && (
          <div className="live-empty">
            <Bluetooth size={30} />
            <p>
              {scanned
                ? "Chưa tìm thấy thiết bị. Đưa ESP32 lại gần Pi và bật chế độ cấu hình."
                : "Quét BLE để tìm cảm biến đang chờ cấu hình."}
            </p>
          </div>
        )}
        {bleDevices.map((d) => (
          <div className="live-ble-row" key={d.mac}>
            <span className="device-symbol">
              <Bluetooth size={21} />
            </span>
            <div className="live-ble-identity">
              <strong>{d.name}</strong>
              <small className="live-ble-mac">{d.mac}</small>
              <small className="live-ble-signal">{d.rssi} dBm</small>
            </div>
            <Badge tone={d.provisionable ? "green" : "gray"}>
              {d.provisionable ? "ESP32 tương thích" : "BLE khác"}
            </Badge>
            <Button
              variant="outline"
              disabled={!d.provisionable}
              onClick={() => onProvision(d)}
            >
              Cấu hình
            </Button>
          </div>
        ))}
      </section>
      <SectionHeading
        title="Cảm biến trong trạm"
        subtitle={`${devices.length} thiết bị đã được Pi nhận diện.`}
      />
      <div className="live-devices-grid">
        {devices.map((device) => (
          <article className="panel live-device-card" key={device.id}>
            <div className="live-device-head">
              <span className="device-symbol">
                <Cpu size={23} />
              </span>
              <div>
                <h3>{device.name}</h3>
                <small>{device.id}</small>
              </div>
              <DeviceStatus device={device} />
            </div>
            <div className="live-device-values">
              <div>
                <small>Điện áp</small>
                <strong>
                  {format(device.voltage)} <span>V</span>
                </strong>
              </div>
              <div>
                <small>pH</small>
                <strong>{format(device.ph, 2)}</strong>
              </div>
            </div>
            <p className="form-hint">
              {device.lastSeen} ·{" "}
              {device.ph == null ? "Chưa có số đo pH" : device.calibrated ? "Đã hiệu chuẩn" : "pH tạm · Chưa hiệu chuẩn"}
            </p>
            <DeviceControls
              device={device}
              connected={connected}
              notify={notify}
            />
          </article>
        ))}
      </div>
      {!devices.length && (
        <div className="panel live-empty">
          Chưa nhận dữ liệu từ ESP32. Quét BLE để cấu hình Wi-Fi.
        </div>
      )}
    </div>
  );
}
function HistoryPage({
  devices,
  refresh,
}: {
  devices: Device[];
  refresh: number;
}) {
  const [selected, setSelected] = useState("");
  const deviceId = devices.some((d) => d.id === selected)
    ? selected
    : devices[0]?.id || "";
  const [startDate, setStartDate] = useState(localDate(new Date())),
    [endDate, setEndDate] = useState(localDate(new Date())),
    [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{ total: number; readings: Reading[] }>({
      total: 0,
      readings: [],
    }),
    [error, setError] = useState("");
  const start = new Date(`${startDate}T00:00:00`).getTime() / 1000,
    end = new Date(`${endDate}T23:59:59.999`).getTime() / 1000;
  const query = `device_id=${encodeURIComponent(deviceId)}&start=${start}&end=${end}`;
  const invalid =
    !Number.isFinite(start) || !Number.isFinite(end) || end < start;
  useEffect(() => {
    const controller = new AbortController();
    if (
      !deviceId ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end < start
    )
      return;
    api<{ total: number; readings: Reading[] }>(
      `/readings?${query}&limit=20&offset=${offset}`,
      { signal: controller.signal },
    )
      .then((data) => {
        setResult(data);
        setError("");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [deviceId, start, end, query, offset, refresh]);
  return (
    <div className="page-content">
      <section className="panel live-history-filters">
        <SectionHeading
          title="Khoảng thời gian"
          subtitle="Ngày theo múi giờ của thiết bị bạn đang dùng."
        />
        <div className="live-filter-grid">
          <label>
            Cảm biến
            <DeviceSelect
              devices={devices}
              selected={deviceId}
              onChange={(id) => {
                setSelected(id);
                setOffset(0);
              }}
            />
          </label>
          <label>
            Từ ngày
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                setOffset(0);
              }}
            />
          </label>
          <label>
            Đến ngày
            <input
              type="date"
              value={endDate}
              onChange={(e) => {
                setEndDate(e.target.value);
                setOffset(0);
              }}
            />
          </label>
          <Button
            variant="outline"
            disabled={!deviceId || invalid}
            onClick={() => {
              window.location.href = `/api/export.csv?${query}`;
            }}
          >
            <ArrowDownToLine size={16} />
            Xuất CSV
          </Button>
        </div>
        {invalid && (
          <p className="form-error" role="alert">
            Ngày kết thúc phải bằng hoặc sau ngày bắt đầu.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </section>
      <section className="panel history-table-panel">
        <SectionHeading
          title="Lịch sử số đo"
          subtitle={`${invalid ? 0 : result.total} bản ghi gốc trong SQLite.`}
        />
        <div className="live-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Thời gian</th>
                <th>Điện áp (V)</th>
                <th>pH</th>
                <th>ADC</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {!invalid &&
                result.readings.map((reading, i) => (
                  <tr key={`${reading.timestamp}-${i}`}>
                    <td>
                      {new Date(reading.timestamp).toLocaleString("vi-VN")}
                    </td>
                    <td>
                      <strong>{format(reading.voltage)}</strong>
                    </td>
                    <td>
                      {format(reading.ph, 2)}
                      {reading.ph != null && !reading.calibrated && <small className="live-ph-estimate">Tạm</small>}
                    </td>
                    <td>{reading.raw_adc ?? "—"}</td>
                    <td>
                      {reading.sensor_error ? (
                        <Badge tone="amber">{reading.sensor_error}</Badge>
                      ) : (
                        <Badge tone="green">Đã nhận</Badge>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {(invalid || !result.readings.length) && (
          <div className="live-empty">
            Chưa có số đo trong khoảng thời gian này.
          </div>
        )}
        <div className="live-pagination">
          <span>
            {result.total
              ? `${offset + 1}–${Math.min(offset + 20, result.total)} / ${result.total}`
              : "0 bản ghi"}
          </span>
          <div>
            <Button
              variant="outline"
              size="icon"
              aria-label="Trang trước"
              disabled={offset === 0 || invalid}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              <ChevronLeft size={18} />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Trang sau"
              disabled={offset + 20 >= result.total || invalid}
              onClick={() => setOffset(offset + 20)}
            >
              <ChevronRight size={18} />
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
function SettingsPage({
  snapshot,
  notify,
}: {
  snapshot: Snapshot;
  notify: (message: string) => void;
}) {
  const [draft, setDraft] = useState<Settings>(snapshot.settings),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (
      !(
        Number(draft.phMin) >= 0 &&
        Number(draft.phMin) < Number(draft.phMax) &&
        Number(draft.phMax) <= 14
      )
    ) {
      setError(
        "Ngưỡng pH cần nằm trong 0–14, ngưỡng dưới nhỏ hơn ngưỡng trên.",
      );
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api<Settings>("/settings", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      notify("Đã lưu cài đặt vào SQLite trên Pi.");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="page-content">
      <div className="live-settings-grid">
        <form className="panel settings-form" onSubmit={save}>
          <SectionHeading
            title="Trạm và lịch sử"
            subtitle="Cài đặt lưu trên Pi và dùng chung cho mọi thiết bị."
          />
          <div className="live-settings-fields">
            <label>
              Tên trạm
              <input
                value={draft.stationName}
                required
                maxLength={80}
                onChange={(e) =>
                  setDraft({ ...draft, stationName: e.target.value })
                }
              />
            </label>
            <div className="form-grid">
              <label>
                Ngưỡng pH thấp
                <input
                  type="number"
                  min={0}
                  max={14}
                  step={0.1}
                  value={draft.phMin}
                  onChange={(e) =>
                    setDraft({ ...draft, phMin: e.target.value })
                  }
                  required
                />
              </label>
              <label>
                Ngưỡng pH cao
                <input
                  type="number"
                  min={0}
                  max={14}
                  step={0.1}
                  value={draft.phMax}
                  onChange={(e) =>
                    setDraft({ ...draft, phMax: e.target.value })
                  }
                  required
                />
              </label>
            </div>
            <label>
              Lưu lịch sử (ngày)
              <input
                type="number"
                min={1}
                max={365}
                step={1}
                value={draft.retention}
                onChange={(e) =>
                  setDraft({ ...draft, retention: e.target.value })
                }
                required
              />
              <small>
                Số đo cũ hơn thời gian này được dọn mỗi phút. Giảm thời gian lưu
                sẽ xóa dữ liệu ngoài khoảng mới.
              </small>
            </label>
            <p className="form-hint">
              pH đang dùng hệ số tạm: 2,50 V → pH 7; −5,70 pH/V. Có thể xem biểu đồ pH và điện áp thật.
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" disabled={saving}>
              {saving && <LoaderCircle className="spin" size={16} />}Lưu cài đặt
            </Button>
          </div>
        </form>
        <div className="live-info-stack">
          <PiWifiPanel mqttConnected={snapshot.mqtt.connected} />
          <section className="panel live-info-panel">
            <SectionHeading
              title="MQTT broker"
              action={
                <Badge tone={snapshot.mqtt.connected ? "green" : "gray"}>
                  {snapshot.mqtt.connected ? "Đã kết nối" : "Ngắt kết nối"}
                </Badge>
              }
            />
            <dl className="live-info-list">
              <div>
                <dt>Máy chủ</dt>
                <dd>
                  {snapshot.mqtt.host}:{snapshot.mqtt.port}
                </dd>
              </div>
              <div>
                <dt>Bảo mật</dt>
                <dd>TLS · CA verification</dd>
              </div>
              <div>
                <dt>ESP32 gửi</dt>
                <dd>{snapshot.mqtt.subscribe}</dd>
              </div>
              <div>
                <dt>Pi gửi lệnh</dt>
                <dd>{snapshot.mqtt.publish}</dd>
              </div>
              <div>
                <dt>Xác thực</dt>
                <dd>Token cấu hình trong backend và firmware</dd>
              </div>
            </dl>
            {snapshot.mqtt.error && (
              <p className="form-error">{snapshot.mqtt.error}</p>
            )}
          </section>
          <section className="panel live-info-panel">
            <SectionHeading title="Web và Access Point" />
            <dl className="live-info-list">
              <div>
                <dt>
                  <Wifi size={14} />
                  Wi-Fi AP
                </dt>
                <dd>{snapshot.network.apName}</dd>
              </div>
              <div>
                <dt>Địa chỉ Pi trong AP</dt>
                <dd>{snapshot.network.apIp}</dd>
              </div>
              <div>
                <dt>Web cục bộ</dt>
                <dd>
                  <a href={`http://${snapshot.network.hostname}`}>
                    {snapshot.network.hostname}
                  </a>
                </dd>
              </div>
              <div>
                <dt>
                  <Database size={14} />
                  SQLite
                </dt>
                <dd>{snapshot.database}</dd>
              </div>
            </dl>
            <p className="form-hint">
              Web và AP tự chạy khi Pi khởi động. Pi cần Internet để trao đổi
              MQTT với flespi.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
