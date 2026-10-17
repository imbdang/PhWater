import { test, expect, type Page } from "@playwright/test";

// Controlled fixtures only exist in tests; production always calls the Pi API.
async function mockApi(
  page: Page,
  options: { ack?: "applied" | "timeout"; ble?: boolean; wifi?: "failed" | "done"; ph?: number; calibrated?: boolean } = {},
) {
  const device = {
    id: "sensor001",
    name: "Cảm biến nước",
    mac: "CC:7B:5C:34:B0:C0",
    status: "online",
    ph: options.ph ?? null,
    calibrated: options.calibrated ?? false,
    voltage: 2.15,
    sensorError: null,
    cycleSeconds: 10,
    lastSeen: "1 giây trước",
    lastSeenAt: Date.now() / 1000,
  };
  const settings = {
    stationName: "Trạm giám sát nước",
    phMin: "6.5",
    phMax: "8.5",
    retention: "30",
  };
  const readings = Array.from({ length: 24 }, (_, i) => ({
    timestamp: Date.now() - (24 - i) * 1000,
    deviceId: "sensor001",
    ph: options.ph ?? null,
    calibrated: options.calibrated ?? false,
    voltage: 2.1 + i / 1000,
    raw_adc: 1000 + i,
  }));
  const piNetwork = {
    available: true, interface: "wlan1", connected: false, ssid: null as string | null,
    ip: null as string | null, apActive: true, apSsid: "raspi-haianh", apIp: "10.42.0.1",
    uplink: "Ethernet", sharedRadio: true, error: null, job: null,
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    let json: unknown;
    if (path === "/api/snapshot")
      json = {
        devices: [device],
        settings,
        mqtt: {
          connected: true,
          error: null,
          host: "mqtt.flespi.io",
          port: 8883,
          subscribe: "phwateresp32/#",
          publish: "phwaterraspi/<device_id>",
          tls: true,
        },
        network: {
          apName: "raspi-haianh",
          apIp: "10.42.0.1",
          hostname: "dashboard.local",
        },
        database: "/var/lib/ph-monitor/history.sqlite3",
        serverTime: Date.now() / 1000,
      };
    else if (path === "/api/wifi/status") json = piNetwork;
    else if (path === "/api/wifi/scan") json = { id: "wifi-scan001", kind: "wifi_scan", status: "running", stage: "scanning", error: null };
    else if (path === "/api/wifi/jobs/wifi-scan001") json = {
      id: "wifi-scan001", kind: "wifi_scan", status: "done", stage: "done", error: null,
      networks: [
        { ssid: "ImBdang", signal: 97, channel: 10, security: "wpa-psk", supported: true },
        { ssid: "Office", signal: 70, channel: 6, security: "unsupported", supported: false },
      ],
    };
    else if (path === "/api/wifi/connect") json = { id: "wifi-connect001", kind: "wifi_connect", status: "running", stage: "connecting", error: null };
    else if (path === "/api/wifi/jobs/wifi-connect001") {
      if (options.wifi !== "failed") Object.assign(piNetwork, { connected: true, ssid: "ImBdang", ip: "192.168.1.28" });
      json = {
        id: "wifi-connect001", kind: "wifi_connect", status: options.wifi || "done", stage: "done",
        error: options.wifi === "failed" ? "Kết nối thất bại. Kiểm tra mật khẩu Wi-Fi." : null,
        network: piNetwork,
      };
    }
    else if (path === "/api/chart") json = { readings };
    else if (path === "/api/readings")
      json = {
        total: 24,
        readings: readings.slice(
          Number(url.searchParams.get("offset") || 0),
          Number(url.searchParams.get("offset") || 0) + 20,
        ),
      };
    else if (path === "/api/devices/sensor001/commands") {
      const body = route.request().postDataJSON();
      if (body.cmd === "set_cycle" && options.ack !== "timeout")
        device.cycleSeconds = body.cycle_seconds;
      json = { id: "cmd001" };
    } else if (path === "/api/commands/cmd001")
      json = {
        status: options.ack || "applied",
        error: options.ack === "timeout" ? "ack_timeout" : null,
      };
    else if (path === "/api/settings") {
      Object.assign(settings, route.request().postDataJSON());
      json = settings;
    } else if (path === "/api/ble/scan")
      json = {
        id: "scan001",
        status: "running",
        step: 0,
        devices: [],
        error: null,
      };
    else if (path === "/api/ble/jobs/scan001")
      json = {
        id: "scan001",
        status: "done",
        step: 0,
        error: null,
        devices: options.ble
          ? [
              {
                id: device.mac,
                mac: device.mac,
                name: "ICTU-HaiAnh",
                rssi: -48,
                provisionable: true,
              },
              {
                id: "other",
                mac: "11:22:33:44:55:66",
                name: "BLE khác",
                rssi: -60,
                provisionable: false,
              },
            ]
          : [],
      };
    else if (path === "/api/ble/provision")
      json = {
        id: "provision001",
        status: "running",
        step: 0,
        devices: [],
        error: null,
      };
    else if (path === "/api/ble/jobs/provision001")
      json = {
        id: "provision001",
        status: "done",
        step: 3,
        devices: [],
        error: null,
      };
    else {
      await route.fulfill({ status: 404, json: { detail: "not found" } });
      return;
    }
    await route.fulfill({ json });
  });
}

test("API values and uncalibrated pH render; commands require device ACK", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator(".metric-value").first()).toContainText("2.150");
  await expect(
    page.getByText("Chưa có số đo pH", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Dữ liệu mẫu")).toHaveCount(0);
  await page
    .getByRole("spinbutton", { name: "Chu kỳ gửi của sensor001" })
    .fill("5");
  const request = page.waitForRequest((r) =>
    r.url().endsWith("/devices/sensor001/commands"),
  );
  await page.getByRole("button", { name: "Lưu chu kỳ", exact: true }).click();
  expect((await request).postDataJSON()).toEqual({
    cmd: "set_cycle",
    cycle_seconds: 5,
  });
  await expect(page.locator(".live-confirmed")).toContainText(
    "đã lưu chu kỳ 5 giây",
  );
  await page
    .getByRole("button", { name: "Lấy trạng thái ngay", exact: true })
    .click();
  await expect(page.locator(".live-confirmed")).toContainText(
    "đã gửi trạng thái",
  );
});

test("ACK timeout cannot be displayed as command success", async ({ page }) => {
  await mockApi(page, { ack: "timeout" });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Lấy trạng thái ngay", exact: true })
    .click();
  await expect(
    page.locator('.live-device-controls [role="alert"]'),
  ).toContainText("Chưa nhận ACK");
  await expect(page.locator(".live-confirmed")).toHaveCount(0);
});

test("BLE scan provisions compatible ESP32 only and sends Wi-Fi to Pi", async ({
  page,
}) => {
  await mockApi(page, { ble: true });
  await page.goto("/#devices");
  await page.getByRole("button", { name: "Quét lại", exact: true }).click();
  const rows = page.locator(".live-ble-row");
  await expect(rows).toHaveCount(1);
  await expect(page.getByText("BLE khác", { exact: true })).toHaveCount(0);
  await rows.first().getByRole("button", { name: "Cấu hình" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Tên Wi-Fi (SSID)").fill("Test-WiFi");
  await dialog.getByLabel("Mật khẩu Wi-Fi", { exact: true }).fill("12345678");
  await dialog.getByRole("button", { name: "Tiếp tục" }).click();
  const request = page.waitForRequest((r) =>
    r.url().endsWith("/ble/provision"),
  );
  await dialog
    .getByRole("button", { name: "Gửi cấu hình", exact: true })
    .click();
  expect((await request).postDataJSON()).toMatchObject({
    ssid: "Test-WiFi",
    password: "12345678",
    mac: "CC:7B:5C:34:B0:C0",
  });
  await expect(
    dialog.getByText("ESP32 đã kết nối", { exact: true }),
  ).toBeVisible();
});

test("history paginates SQLite rows; settings write to Pi API", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/#history");
  await expect(page.locator("tbody tr")).toHaveCount(20);
  await page.getByRole("button", { name: "Trang sau" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(4);
  await page.goto("/#settings");
  await page.getByLabel("Tên trạm", { exact: true }).fill("Trạm nước nhà");
  const request = page.waitForRequest(
    (r) => r.url().endsWith("/settings") && r.method() === "PUT",
  );
  await page.getByRole("button", { name: "Lưu cài đặt", exact: true }).click();
  expect((await request).postDataJSON()).toMatchObject({
    stationName: "Trạm nước nhà",
  });
  await expect(page.getByRole("status")).toContainText("SQLite");
});

test("API failure never falls back to sample data", async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 503, json: { detail: "Pi offline" } }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Pi offline");
  await expect(page.locator(".metric-grid")).toHaveCount(0);
});

test("temporary pH is displayed and charted without claiming calibration", async ({ page }) => {
  await mockApi(page, { ph: 6.6238 });
  await page.goto("/");
  await expect(page.locator(".metric-value").nth(1)).toContainText("6.62");
  await expect(page.getByText("pH tạm · Chưa hiệu chuẩn", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "pH", exact: true }).click();
  await expect(page.locator(".ph-chart")).toBeVisible();
  await expect(page.getByText("pH tính từ điện áp với hệ số tạm.", { exact: true })).toBeVisible();
  await page.goto("/#devices");
  await expect(page.getByText("pH tạm · Chưa hiệu chuẩn", { exact: false })).toBeVisible();
  await expect(page.getByText("Đã hiệu chuẩn", { exact: true })).toHaveCount(0);
  await page.goto("/#history");
  await expect(page.locator(".live-ph-estimate")).toHaveCount(20);
});

test("calibrated firmware measurements keep their calibration label", async ({ page }) => {
  await mockApi(page, { ph: 7.1, calibrated: true });
  await page.goto("/");
  await expect(page.getByText("Đã hiệu chuẩn", { exact: true })).toBeVisible();
  await expect(page.getByText("pH tạm · Chưa hiệu chuẩn", { exact: true })).toHaveCount(0);
});

test("Pi Wi-Fi scans and connects using its own API, with AP retained", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#settings");
  const panel = page.getByRole("region", { name: "Wi-Fi của Raspberry Pi" });
  await panel.getByRole("button", { name: "Quét Wi-Fi", exact: true }).click();
  await panel.getByLabel("Mạng Wi-Fi tìm thấy").selectOption("ImBdang");
  await expect(panel.getByLabel("SSID của Raspberry Pi", { exact: true })).toHaveValue("ImBdang");
  await expect(panel.locator('option[value="Office"]')).toHaveAttribute("disabled", "");
  await panel.getByLabel("Mật khẩu Wi-Fi của Pi", { exact: true }).fill("testpassword");
  const request = page.waitForRequest((r) => r.url().endsWith("/wifi/connect"));
  await panel.getByRole("button", { name: "Kết nối Wi-Fi cho Pi", exact: true }).click();
  expect((await request).postDataJSON()).toEqual({ ssid: "ImBdang", password: "testpassword" });
  await expect(panel.locator(".pi-wifi-success")).toContainText("Pi đã kết nối ImBdang");
  await expect(panel.getByLabel("Mật khẩu Wi-Fi của Pi", { exact: true })).toHaveValue("");
  await expect(panel.getByText("raspi-haianh · 10.42.0.1", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }))).not.toContain("testpassword");
});

test("failed Pi Wi-Fi connection never reports success", async ({ page }) => {
  await mockApi(page, { wifi: "failed" });
  await page.goto("/#settings");
  const panel = page.getByRole("region", { name: "Wi-Fi của Raspberry Pi" });
  await panel.getByLabel("SSID của Raspberry Pi", { exact: true }).fill("ImBdang");
  await panel.getByLabel("Mật khẩu Wi-Fi của Pi", { exact: true }).fill("wrongpassword");
  await panel.getByRole("button", { name: "Kết nối Wi-Fi cho Pi", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Kết nối thất bại");
  await expect(panel.locator(".pi-wifi-success")).toHaveCount(0);
  await expect(panel.getByText("raspi-haianh · 10.42.0.1", { exact: true })).toBeVisible();
});

for (const width of [360, 390, 768, 1440]) {
  test(`all views fit ${width}px without browser errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await mockApi(page, { ble: true });
    await page.setViewportSize({ width, height: 900 });
    for (const view of ["overview", "devices", "history", "settings"]) {
      await page.goto(`/#${view}`);
      await expect(page.locator(".page-content")).toBeVisible();
      if (view === "devices") {
        await page
          .getByRole("button", { name: "Quét lại", exact: true })
          .click();
        await expect(page.locator(".live-ble-row")).toHaveCount(1);
        const mac = page.locator(".live-ble-mac");
        await expect(mac).toHaveCSS("white-space", "nowrap");
        expect(
          await mac.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return range.getClientRects().length;
          }),
        ).toBe(1);
      }
      if (view === "settings") {
        await page.getByRole("button", { name: "Quét Wi-Fi", exact: true }).click();
        await expect(page.getByLabel("Mạng Wi-Fi tìm thấy")).toBeVisible();
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    }
    expect(errors).toEqual([]);
  });
}
