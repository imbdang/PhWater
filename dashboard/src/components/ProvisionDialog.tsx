import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  ArrowRight,
  Bluetooth,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  LoaderCircle,
  Radio,
  ShieldCheck,
  Wifi,
  X,
  CircleAlert,
} from "lucide-react";
import { Button } from "./ui/button";
import { api, type BleJob, type BleDevice } from "@/lib/api";

export function ProvisionDialog({
  device,
  onClose,
  onComplete,
}: {
  device: BleDevice | null;
  onClose: () => void;
  onComplete: (device: BleDevice, name: string) => void;
}) {
  return (
    <Dialog.Root
      open={!!device}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="provision-dialog">
          {device && (
            <ProvisionForm
              key={device.id}
              device={device}
              onClose={onClose}
              onComplete={onComplete}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ProvisionForm({
  device,
  onClose,
  onComplete,
}: {
  device: BleDevice;
  onClose: () => void;
  onComplete: (device: BleDevice, name: string) => void;
}) {
  const [view, setView] = useState<
    "form" | "review" | "progress" | "success" | "error"
  >("form");
  const [name, setName] = useState("Cảm biến nước");
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const encoder = new TextEncoder();

  function review(event: React.FormEvent) {
    event.preventDefault();
    if (!ssid.trim() || encoder.encode(ssid).length > 32) {
      setError("SSID cần có từ 1 đến 32 byte.");
      return;
    }
    if (
      encoder.encode(password).length < 8 ||
      encoder.encode(password).length > 63
    ) {
      setError("Mật khẩu Wi-Fi cần có từ 8 đến 63 byte.");
      return;
    }
    if (!name.trim()) {
      setError("Nhập tên để dễ nhận diện cảm biến.");
      return;
    }
    setError("");
    setView("review");
  }

  async function start() {
    controller.current?.abort();
    controller.current = new AbortController();
    setError("");
    setStep(0);
    setView("progress");
    try {
      const signal = controller.current.signal;
      const job = await api<BleJob>("/ble/provision", {
        method: "POST",
        body: JSON.stringify({
          mac: device.mac,
          name: name.trim(),
          ssid,
          password,
        }),
        signal,
      });
      for (;;) {
        if (signal.aborted) return;
        const status = await api<BleJob>(`/ble/jobs/${job.id}`, { signal });
        setStep(status.step);
        if (status.status === "failed")
          throw new Error(status.error || "Cấu hình thất bại");
        if (status.status === "done") break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      setView("success");
      onComplete(device, name.trim());
      setPassword("");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(
        err instanceof Error ? err.message : "Có lỗi xảy ra. Vui lòng thử lại.",
      );
      setView("error");
    }
  }

  return (
    <>
      <div className="dialog-top">
        <div className="dialog-symbol">
          <Bluetooth size={25} />
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Đóng cấu hình"
          onClick={onClose}
        >
          <X size={20} />
        </Button>
      </div>
      <Dialog.Title className="dialog-title">
        {view === "success" ? "ESP32 đã kết nối" : "Cấu hình ESP32 qua BLE"}
      </Dialog.Title>
      <Dialog.Description className="dialog-description">
        {device.name} <span>·</span> {device.mac}
      </Dialog.Description>
      <div className="demo-callout">
        <Radio size={15} />
        <span>
          Raspberry Pi kết nối trực tiếp BLE và chờ bản tin MQTT từ ESP32.
        </span>
      </div>

      {(view === "form" || view === "review") && (
        <div className="wizard-steps">
          <span className={view === "form" ? "active" : "complete"}>
            <i>{view === "form" ? "1" : <Check size={12} />}</i> Wi-Fi
          </span>
          <div />
          <span className={view === "review" ? "active" : ""}>
            <i>2</i> Xác nhận
          </span>
          <div />
          <span>
            <i>3</i> Hoàn tất
          </span>
        </div>
      )}

      {view === "form" && (
        <form onSubmit={review}>
          <div className="form-stack">
            <label>
              Tên hiển thị
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder="Ví dụ: Cảm biến bể nuôi"
                required
              />
            </label>
            <label>
              Tên Wi-Fi (SSID)
              <div className="input-with-icon">
                <Wifi size={17} />
                <input
                  value={ssid}
                  onChange={(e) => setSsid(e.target.value)}
                  placeholder="Wi-Fi ESP32 sẽ kết nối"
                  autoComplete="off"
                  required
                />
              </div>
            </label>
            <label>
              Mật khẩu Wi-Fi
              <div className="password-input">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Ít nhất 8 ký tự"
                  autoComplete="new-password"
                  required
                />
                <button
                  type="button"
                  aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>
          </div>
          <p className="form-hint">
            <ShieldCheck size={15} />
            Chọn mạng 2.4 GHz mà ESP32 có thể truy cập.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Button type="button" variant="outline" onClick={onClose}>
              Hủy
            </Button>
            <Button type="submit">
              Tiếp tục <ArrowRight size={16} />
            </Button>
          </div>
        </form>
      )}

      {view === "review" && (
        <>
          <div className="review-card">
            <h3>Kiểm tra thông tin</h3>
            <dl>
              <div>
                <dt>Thiết bị</dt>
                <dd>{device.id}</dd>
              </div>
              <div>
                <dt>Tên hiển thị</dt>
                <dd>{name}</dd>
              </div>
              <div>
                <dt>Wi-Fi</dt>
                <dd>{ssid}</dd>
              </div>
              <div>
                <dt>Mật khẩu</dt>
                <dd>••••••••</dd>
              </div>
            </dl>
          </div>
          <p className="form-hint">
            ESP32 sẽ nhận thông tin Wi-Fi qua BLE, sau đó chuyển sang kết nối
            mạng. Hãy giữ thiết bị gần Raspberry Pi.
          </p>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setView("form")}>
              <ArrowLeft size={15} />
              Quay lại
            </Button>
            <Button onClick={start}>
              <Bluetooth size={16} />
              Gửi cấu hình
            </Button>
          </div>
        </>
      )}

      {view === "progress" && (
        <div className="provision-progress">
          <div className="progress-orbit">
            <Bluetooth size={31} />
            <span />
          </div>
          <h3>Đang cấu hình ESP32...</h3>
          <p>
            Đang kết nối BLE và gửi Wi-Fi. Pi chờ MQTT tối đa 60 giây sau khi
            gửi.
          </p>
          <ol>
            {[
              "Kết nối với ESP32 qua BLE",
              "Gửi SSID và mật khẩu Wi-Fi",
              "Chờ dữ liệu MQTT thật từ ESP32",
            ].map((label, index) => (
              <li
                key={label}
                className={
                  step === index ? "current" : step > index ? "done" : ""
                }
              >
                {step > index ? (
                  <CheckCircle2 size={19} />
                ) : step === index ? (
                  <LoaderCircle className="spin" size={19} />
                ) : (
                  <span className="step-circle" />
                )}
                {label}
              </li>
            ))}
          </ol>
          <p>Đóng cửa sổ sẽ không dừng tác vụ đang chạy trên Pi.</p>
          <Button variant="outline" onClick={onClose}>
            Đóng cửa sổ
          </Button>
        </div>
      )}

      {view === "success" && (
        <div className="provision-result">
          <CheckCircle2 size={52} />
          <h3>{name} đã sẵn sàng</h3>
          <p>
            Pi đã nhận dữ liệu MQTT từ thiết bị sau khi cấu hình Wi-Fi{" "}
            <strong>{ssid}</strong>.
          </p>
          <Button onClick={onClose}>
            Xem danh sách thiết bị <ArrowRight size={16} />
          </Button>
        </div>
      )}
      {view === "error" && (
        <div className="provision-result error">
          <CircleAlert size={48} />
          <h3>Chưa hoàn tất cấu hình</h3>
          <p role="alert">{error}</p>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setView("form")}>
              Sửa thông tin
            </Button>
            <Button onClick={start}>Thử lại</Button>
          </div>
        </div>
      )}
    </>
  );
}
