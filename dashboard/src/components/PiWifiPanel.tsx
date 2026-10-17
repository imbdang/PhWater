import { useEffect, useState } from "react";
import { Eye, EyeOff, LoaderCircle, RefreshCw, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type PiNetwork, type WifiJob, type WifiNetwork } from "@/lib/api";

const stages: Record<string, string> = {
  queued: "Đang chuẩn bị…",
  scanning: "Đang quét Wi-Fi quanh Raspberry Pi…",
  aligning_ap: "Đang đổi kênh AP để nối Wi-Fi. Kết nối lại AP nếu cần…",
  connecting: "Đang kết nối Wi-Fi và chờ router cấp IP…",
  restoring: "Kết nối chưa thành công. Đang khôi phục mạng trước đó…",
};
const storageKey = "ph-pi-wifi-job";

export function PiWifiPanel({ mqttConnected }: { mqttConnected: boolean }) {
  const [network, setNetwork] = useState<PiNetwork | null>(null);
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [jobId, setJobId] = useState<string | null>(() => sessionStorage.getItem(storageKey));
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [success, setSuccess] = useState("");
  const busy = starting || jobId !== null;

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const result = await api<PiNetwork>("/wifi/status");
        if (!active) return;
        setNetwork(result);
        setSsid((current) => current || result.ssid || "");
        setStatusError("");
        if (result.job) setJobId((current) => current || result.job);
      } catch (error) {
        if (active) setStatusError(error instanceof Error ? error.message : "Không đọc được mạng của Pi.");
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!jobId) {
      sessionStorage.removeItem(storageKey);
      return;
    }
    sessionStorage.setItem(storageKey, jobId);
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 240_000;
    async function poll() {
      try {
        const job = await api<WifiJob>(`/wifi/jobs/${encodeURIComponent(jobId!)}`);
        if (!active) return;
        setProgress(stages[job.stage] || "Đang xử lý Wi-Fi…");
        if (job.status !== "running") {
          setJobId(null);
          setProgress("");
          if (job.status === "failed") setError(job.error || "Kết nối Wi-Fi thất bại.");
          else if (job.kind === "wifi_scan") {
            setNetworks(job.networks || []);
            setSuccess(job.networks?.length ? "Chọn mạng bên dưới hoặc nhập SSID." : "Chưa thấy mạng phù hợp. Quét lại gần router.");
          } else if (job.network) {
            setNetwork(job.network);
            setSuccess(`Pi đã kết nối ${job.network.ssid} · ${job.network.ip}. Cấu hình sẽ tự nối lại khi khởi động.`);
          }
          return;
        }
      } catch (error) {
        if (!active) return;
        if (error instanceof Error && error.message.includes("Không tìm thấy tác vụ")) {
          setJobId(null);
          setError("Pi đã khởi động lại. Kiểm tra trạng thái mạng rồi thử lại nếu cần.");
          return;
        }
        setProgress("Đang chờ Pi. Nếu AP vừa đổi kênh, kết nối lại raspi-haianh và mở dashboard.local.");
      }
      if (Date.now() > deadline) {
        setJobId(null);
        setProgress("");
        setError("Chưa đọc được kết quả. Kết nối lại AP và kiểm tra trạng thái mạng của Pi.");
        return;
      }
      timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [jobId]);

  async function start(kind: "scan" | "connect") {
    if (kind === "connect") {
      const length = new TextEncoder().encode(ssid).length;
      const passwordLength = new TextEncoder().encode(password).length;
      if (!length || length > 32 || (passwordLength > 0 && (passwordLength < 8 || passwordLength > 63))) {
        setError("SSID phải từ 1–32 byte; mật khẩu 8–63 byte (để trống cho mạng mở).");
        return;
      }
    }
    setStarting(true);
    setError("");
    setSuccess("");
    setProgress(kind === "scan" ? stages.scanning : stages.queued);
    try {
      const job = await api<WifiJob>(`/wifi/${kind}`, {
        method: "POST",
        ...(kind === "connect" ? { body: JSON.stringify({ ssid, password }) } : {}),
      });
      setJobId(job.id);
      if (kind === "connect") setPassword("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Không gửi được yêu cầu tới Pi.");
      setProgress("");
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="panel live-info-panel pi-wifi-panel" aria-labelledby="pi-wifi-title">
      <div className="section-heading">
        <div>
          <h2 id="pi-wifi-title">Wi-Fi của Raspberry Pi</h2>
          <p>Kết nối Internet để Pi nhận dữ liệu qua flespi.</p>
        </div>
        <span className={`badge badge-${network?.connected ? "green" : "gray"}`}>
          <i />{network?.connected ? "Đã kết nối" : "Chưa kết nối"}
        </span>
      </div>
      <dl className="live-info-list">
        <div><dt><Wifi size={14} />Wi-Fi client</dt><dd>{network?.connected ? network.ssid : "Chưa kết nối"}</dd></div>
        <div><dt>IP Wi-Fi</dt><dd>{network?.ip || "Chưa được cấp IP"}</dd></div>
        <div><dt>Đường Internet</dt><dd>{network?.uplink || "Chưa có kết nối"}</dd></div>
        <div><dt>AP cục bộ</dt><dd>{network?.apActive ? `${network.apSsid} · ${network.apIp}` : "Đang kiểm tra AP…"}</dd></div>
        <div><dt>MQTT flespi</dt><dd>{mqttConnected ? "Đã kết nối broker" : "Chưa kết nối broker"}</dd></div>
      </dl>
      <form className="pi-wifi-form" onSubmit={(event) => { event.preventDefault(); void start("connect"); }}>
        <Button type="button" variant="outline" disabled={busy || !network?.available} onClick={() => void start("scan")}>
          <RefreshCw size={16} />Quét Wi-Fi
        </Button>
        {networks.length > 0 && <label>
          Mạng Wi-Fi tìm thấy
          <select value={networks.some((item) => item.ssid === ssid) ? ssid : ""} disabled={busy} onChange={(event) => setSsid(event.target.value)}>
            <option value="" disabled>Chọn mạng Wi-Fi</option>
            {networks.map((item) => <option key={item.ssid} value={item.ssid} disabled={!item.supported}>
              {item.ssid} · {item.signal}% · {item.security === "open" ? "Mở" : item.security === "wpa-psk" ? "WPA/WPA2" : "Chưa hỗ trợ"}
            </option>)}
          </select>
        </label>}
        <label>SSID của Raspberry Pi
          <input value={ssid} disabled={busy} autoComplete="off" required onChange={(event) => setSsid(event.target.value)} placeholder="Ví dụ: ImBdang" />
        </label>
        <label>Mật khẩu Wi-Fi của Pi
          <div className="pi-wifi-password">
            <input type={showPassword ? "text" : "password"} value={password} disabled={busy} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} placeholder="Để trống nếu là mạng mở" />
            <button type="button" aria-label={showPassword ? "Ẩn mật khẩu Wi-Fi của Pi" : "Hiện mật khẩu Wi-Fi của Pi"} onClick={() => setShowPassword(!showPassword)}>
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
        </label>
        <p className="form-hint">
          {network?.sharedRadio ? "Chọn Wi-Fi 2.4 GHz. AP vẫn được duy trì; khi đổi kênh, điện thoại có thể cần kết nối lại AP trong vài giây." : "Cấu hình được lưu trên Pi và tự kết nối khi khởi động."}
          {" "}Wi-Fi của ESP32 được cấu hình riêng tại trang Thiết bị.
        </p>
        {(error || statusError || network?.error) && <p className="form-error" role="alert">{error || statusError || network?.error}</p>}
        {progress && busy && <p className="pi-wifi-progress" role="status"><LoaderCircle size={16} className="spin" />{progress}</p>}
        {success && <p className="pi-wifi-success" role="status">{success}</p>}
        <Button type="submit" disabled={busy || !network?.available}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <Wifi size={16} />}Kết nối Wi-Fi cho Pi
        </Button>
      </form>
    </section>
  );
}
