import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { chartReadings, type Reading } from "@/lib/api";

export function PhChart({
  readings,
  min = 6.5,
  max = 8.5,
  days = false,
  compact = false,
  metric = "voltage",
}: {
  readings: Reading[];
  min?: number;
  max?: number;
  days?: boolean;
  compact?: boolean;
  metric?: "ph" | "voltage";
}) {
  const id = useId().replaceAll(":", "");
  // Old voltage-only history has no pH. Start the axis at the first measured
  // value for the selected metric; retain gaps between valid samples.
  const firstValid = readings.findIndex((row) => row[metric] != null);
  let lastValid = readings.length - 1;
  while (lastValid >= 0 && readings[lastValid][metric] == null) lastValid--;
  const data = firstValid < 0 ? [] : readings.slice(firstValid, lastValid + 1);
  const values = data
    .map((r) => r[metric])
    .filter((v): v is number => v !== null);
  const domainMin =
    metric === "voltage"
      ? Math.max(0, Math.min(...values) - 0.05)
      : Math.max(0, Math.min(...values, 6, min - 0.5) - 0.2);
  const domainMax =
    metric === "voltage"
      ? Math.max(...values) + 0.05
      : Math.min(14, Math.max(...values, 9, max + 0.5) + 0.2);
  if (!values.length)
    return (
      <div className="chart-empty">
        Chưa có số đo trong khoảng thời gian này.
      </div>
    );
  const first = data[0].timestamp;
  const last = data[data.length - 1].timestamp;
  const ticks: number[] = [];
  if (first === last) {
    ticks.push(first);
  } else if (days) {
    const day = new Date(first);
    day.setHours(0, 0, 0, 0);
    if (day.getTime() < first) day.setDate(day.getDate() + 1);
    while (day.getTime() <= last) {
      ticks.push(day.getTime());
      day.setDate(day.getDate() + 1);
    }
  } else {
    for (let i = 0; i < 6; i++) ticks.push(first + ((last - first) * i) / 5);
  }
  return (
    <div className={compact ? "ph-chart compact" : "ph-chart"}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart
          data={chartReadings(data)}
          margin={{ top: 14, right: 10, bottom: 0, left: -22 }}
          accessibilityLayer
        >
          <defs>
            <linearGradient id={`ph-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0f9b83" stopOpacity={0.23} />
              <stop offset="100%" stopColor="#0f9b83" stopOpacity={0.015} />
            </linearGradient>
          </defs>
          <CartesianGrid
            vertical={false}
            stroke="#e8eeed"
            strokeDasharray="4 5"
          />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={["dataMin", "dataMax"]}
            scale="time"
            ticks={ticks}
            minTickGap={35}
            axisLine={false}
            tickLine={false}
            tickMargin={14}
            tick={{ fill: "#879497", fontSize: 11 }}
            tickFormatter={(value) =>
              new Date(value).toLocaleString(
                "vi-VN",
                days
                  ? { day: "2-digit", month: "2-digit" }
                  : { hour: "2-digit", minute: "2-digit" },
              )
            }
          />
          <YAxis
            domain={[domainMin, domainMax]}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#879497", fontSize: 11 }}
            tickCount={7}
            tickFormatter={(value) => Number(value).toFixed(1)}
          />
          {metric === "ph" && (
            <>
              <ReferenceArea
                y1={min}
                y2={max}
                fill="#0f9b83"
                fillOpacity={0.025}
              />
              <ReferenceLine y={min} stroke="#99b9ad" strokeDasharray="4 5" />
              <ReferenceLine y={max} stroke="#99b9ad" strokeDasharray="4 5" />
            </>
          )}
          <Tooltip
            cursor={{ stroke: "#9baea8", strokeDasharray: "3 3" }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <div className="chart-tooltip">
                  <span>
                    {new Date(Number(label)).toLocaleString("vi-VN", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <strong>
                    <i />
                    {Number(payload[0].value).toFixed(2)}{" "}
                    <small>{metric === "ph" ? "pH" : "V"}</small>
                  </strong>
                </div>
              ) : null
            }
          />
          <Area
            type="monotone"
            dataKey={metric}
            name={metric === "ph" ? "pH" : "Điện áp"}
            stroke="#0f9b83"
            strokeWidth={2.5}
            fill={`url(#ph-${id})`}
            activeDot={{ r: 5, stroke: "#fff", strokeWidth: 3 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
