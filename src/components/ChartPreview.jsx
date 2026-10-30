import { useMemo, useRef } from "react";
import { ArrowLineDown, FileCsv, Image as ImageIcon } from "@phosphor-icons/react";

const WIDTH = 720;
const HEIGHT = 340;
const COLORS = ["#55b8ff", "#62d6a5", "#c3a4ff", "#ffbb67", "#ff8797", "#52d4d1", "#e5dc75", "#91aaff"];
const TYPES = new Set(["bar", "stacked-bar", "percent-stacked-bar", "horizontal-bar", "line", "area", "scatter", "bubble", "waterfall", "treemap", "radar", "funnel", "histogram", "boxplot", "pie", "heatmap"]);

function chartNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15;
}

function chartLabel(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).slice(0, 120) : "";
}

function heatmapCoordinateKey(x, y) {
  return JSON.stringify([x, y]);
}

export function parseChartSpec(source) {
  let spec;
  try { spec = JSON.parse(source); } catch { return null; }
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || !TYPES.has(spec.type)) return null;
  if (typeof spec.title !== "string" || !spec.title.trim() || spec.title.length > 160) return null;

  if (spec.type === "pie") {
    if (!Array.isArray(spec.data) || spec.data.length < 1 || spec.data.length > 24) return null;
    const data = spec.data.map((item) => ({ label: chartLabel(item?.label ?? item?.x), value: item?.value ?? item?.y }));
    return data.every((item) => item.label && chartNumber(item.value) && item.value >= 0) && data.some((item) => item.value > 0)
      ? { type: spec.type, title: spec.title.trim(), data }
      : null;
  }

  if (spec.type === "boxplot") {
    if (!Array.isArray(spec.data) || spec.data.length < 1 || spec.data.length > 24) return null;
    const data = spec.data.map((item) => ({
      label: chartLabel(item?.label ?? item?.x),
      min: item?.min, q1: item?.q1, median: item?.median, q3: item?.q3, max: item?.max,
    }));
    const valid = data.every((item) => item.label
      && [item.min, item.q1, item.median, item.q3, item.max].every(chartNumber)
      && item.min <= item.q1 && item.q1 <= item.median
      && item.median <= item.q3 && item.q3 <= item.max);
    return valid ? {
      type: spec.type, title: spec.title.trim(), data,
      xLabel: typeof spec.xLabel === "string" ? spec.xLabel.slice(0, 80) : "",
      yLabel: typeof spec.yLabel === "string" ? spec.yLabel.slice(0, 80) : "",
    } : null;
  }

  if (spec.type === "heatmap") {
    if (!Array.isArray(spec.data) || spec.data.length < 1 || spec.data.length > 240) return null;
    const rows = spec.data.map((item) => ({
      x: chartLabel(item?.x), y: chartLabel(item?.y), value: item?.value,
    }));
    const xCategories = [...new Set(rows.map((row) => row.x))];
    const yCategories = [...new Set(rows.map((row) => row.y))];
    const coordinates = new Set(rows.map((row) => heatmapCoordinateKey(row.x, row.y)));
    return rows.every((row) => row.x && row.y && chartNumber(row.value))
      && xCategories.length <= 20 && yCategories.length <= 20 && coordinates.size === rows.length
      ? {
        type: spec.type, title: spec.title.trim(), rows, xCategories, yCategories,
        seriesNames: [],
        xLabel: typeof spec.xLabel === "string" ? spec.xLabel.slice(0, 80) : "",
        yLabel: typeof spec.yLabel === "string" ? spec.yLabel.slice(0, 80) : "",
      }
      : null;
  }

  if (spec.type === "bubble") {
    if (!Array.isArray(spec.data) || spec.data.length < 1 || spec.data.length > 240) return null;
    const rows = spec.data.map((item) => ({
      x: item?.x, y: item?.y, size: item?.size,
      label: chartLabel(item?.label), series: typeof item?.series === "string" ? item.series.trim().slice(0, 80) : "",
    }));
    const names = [...new Set(rows.map((row) => row.series).filter(Boolean))];
    return rows.every((row) => chartNumber(row.x) && chartNumber(row.y) && chartNumber(row.size) && row.size >= 0)
      && rows.some((row) => row.size > 0) && names.length <= 8 && (!names.length || rows.every((row) => row.series))
      ? {
        type: spec.type, title: spec.title.trim(), rows,
        seriesNames: names.length ? names : [""],
        xLabel: typeof spec.xLabel === "string" ? spec.xLabel.slice(0, 80) : "",
        yLabel: typeof spec.yLabel === "string" ? spec.yLabel.slice(0, 80) : "",
        sizeLabel: typeof spec.sizeLabel === "string" ? spec.sizeLabel.slice(0, 80) : "Size",
      }
      : null;
  }

  if (spec.type === "waterfall") {
    if (!Array.isArray(spec.data) || spec.data.length < 2 || spec.data.length > 24) return null;
    let runningTotal = 0;
    const rows = spec.data.map((item, index) => {
      const label = chartLabel(item?.label ?? item?.x);
      const value = item?.value ?? item?.y;
      const stepType = item?.type ?? "delta";
      const start = stepType === "total" ? 0 : runningTotal;
      const end = stepType === "total" ? value : runningTotal + value;
      runningTotal = end;
      return { label, value, type: stepType, start, end, runningTotal, index };
    });
    return rows.every((row) => row.label && chartNumber(row.value) && ["delta", "total"].includes(row.type))
      ? {
        type: spec.type, title: spec.title.trim(), data: rows, rows, seriesNames: [],
        xLabel: typeof spec.xLabel === "string" ? spec.xLabel.slice(0, 80) : "",
        yLabel: typeof spec.yLabel === "string" ? spec.yLabel.slice(0, 80) : "",
      }
      : null;
  }

  if (spec.type === "treemap") {
    if (!Array.isArray(spec.data) || spec.data.length < 2 || spec.data.length > 120) return null;
    const rows = spec.data.map((item) => ({
      label: chartLabel(item?.label ?? item?.x),
      group: typeof (item?.group ?? item?.series) === "string" ? String(item.group ?? item.series).trim().slice(0, 80) : "",
      value: item?.value ?? item?.y,
    }));
    const groupNames = [...new Set(rows.map((row) => row.group).filter(Boolean))];
    const keys = new Set(rows.map((row) => JSON.stringify([row.group, row.label])));
    return rows.every((row) => row.label && chartNumber(row.value) && row.value > 0)
      && groupNames.length <= 8 && (!groupNames.length || rows.every((row) => row.group)) && keys.size === rows.length
      ? { type: spec.type, title: spec.title.trim(), rows, seriesNames: groupNames }
      : null;
  }

  if (spec.type === "radar") {
    if (!Array.isArray(spec.series) || spec.series.length < 2 || spec.series.length > 8) return null;
    const series = spec.series.map((item) => ({
      name: typeof item?.name === "string" ? item.name.trim().slice(0, 80) : "",
      data: Array.isArray(item?.data) ? item.data.map((point) => ({ x: chartLabel(point?.x), y: point?.y })) : [],
    }));
    const categories = series[0].data.map((point) => point.x);
    const categorySet = new Set(categories);
    const names = new Set(series.map((item) => item.name));
    if (categories.length < 3 || categories.length > 8 || categories.some((item) => !item) || categorySet.size !== categories.length) return null;
    if (names.size !== series.length || series.some((item) => !item.name || item.data.length !== categories.length
      || new Set(item.data.map((point) => point.x)).size !== categories.length
      || item.data.some((point) => !categorySet.has(point.x) || !chartNumber(point.y) || point.y < 0))) return null;
    const rows = series.flatMap((item) => {
      const values = new Map(item.data.map((point) => [point.x, point.y]));
      return categories.map((x) => ({ x, y: values.get(x), series: item.name }));
    });
    const dataMax = Math.max(...rows.map((row) => row.y));
    const maxValue = spec.maxValue === undefined ? dataMax : spec.maxValue;
    return dataMax > 0 && chartNumber(maxValue) && maxValue >= dataMax && maxValue > 0
      ? { type: spec.type, title: spec.title.trim(), seriesNames: series.map((item) => item.name), categories, rows, maxValue }
      : null;
  }

  if (spec.type === "funnel") {
    if (!Array.isArray(spec.data) || spec.data.length < 2 || spec.data.length > 12) return null;
    const stages = spec.data.map((item) => ({ label: chartLabel(item?.label ?? item?.x), value: item?.value ?? item?.y }));
    const labels = new Set(stages.map((stage) => stage.label));
    if (labels.size !== stages.length || stages.some((stage) => !stage.label || !chartNumber(stage.value) || stage.value < 0)) return null;
    if (stages[0].value <= 0 || stages.some((stage, index) => index > 0 && stage.value > stages[index - 1].value)) return null;
    const data = stages.map((stage, index) => ({
      ...stage,
      isFirst: index === 0,
      conversion: index === 0 || stages[index - 1].value === 0 ? null : stage.value / stages[index - 1].value * 100,
      overall: stage.value / stages[0].value * 100,
    }));
    return { type: spec.type, title: spec.title.trim(), data, rows: data, seriesNames: [] };
  }

  let rows = [];
  if (Array.isArray(spec.series)) {
    if (spec.series.length < 1 || spec.series.length > 8) return null;
    for (const series of spec.series) {
      if (typeof series?.name !== "string" || !series.name.trim() || !Array.isArray(series.data)) return null;
      rows.push(...series.data.map((item) => ({ x: item?.x, y: item?.y, series: series.name.trim() })));
    }
  } else if (Array.isArray(spec.data)) {
    rows = spec.data.map((item) => ({ x: item?.x ?? item?.label, y: item?.y ?? item?.value, series: item?.series ?? "" }));
  } else return null;
  if (rows.length < 1 || rows.length > 240) return null;
  if (spec.type === "histogram" && rows.length > 80) return null;
  if (rows.some((row) => !chartLabel(row.x) || !chartNumber(row.y) || typeof row.series !== "string")) return null;
  const names = [...new Set(rows.map((row) => row.series).filter(Boolean))];
  if (names.length > 8) return null;
  if (spec.type === "stacked-bar" || spec.type === "percent-stacked-bar") {
    const categories = [...new Set(rows.map((row) => row.x))];
    const categorySet = new Set(categories);
    if (names.length < 2 || categories.length < 2 || categories.length > 20 || rows.some((row) => row.y < 0 || !row.series)) return null;
    if (names.some((name) => {
      const values = rows.filter((row) => row.series === name);
      return values.length !== categories.length || new Set(values.map((row) => row.x)).size !== categories.length
        || values.some((row) => !categorySet.has(row.x));
    })) return null;
    const totals = new Map(categories.map((category) => [category, rows.filter((row) => row.x === category).reduce((sum, row) => sum + row.y, 0)]));
    if (spec.type === "percent-stacked-bar" && [...totals.values()].some((total) => total <= 0)) return null;
    const chartRows = spec.type === "percent-stacked-bar"
      ? rows.map((row) => ({ ...row, share: row.y / totals.get(row.x) * 100 }))
      : rows;
    return {
      type: spec.type, title: spec.title.trim(),
      xLabel: typeof spec.xLabel === "string" ? spec.xLabel.slice(0, 80) : "",
      yLabel: typeof spec.yLabel === "string" ? spec.yLabel.slice(0, 80) : "",
      valueLabel: typeof spec.valueLabel === "string" ? spec.valueLabel.slice(0, 80) : "Value",
      rows: chartRows, seriesNames: names,
    };
  }
  if (spec.type === "histogram" && (names.length > 1 || new Set(rows.map((row) => row.x)).size !== rows.length)) return null;
  if (spec.type === "horizontal-bar" && new Set(rows.map((row) => row.x)).size > 20) return null;
  if (spec.type === "scatter" && rows.some((row) => !chartNumber(Number(row.x)))) return null;
  return {
    type: spec.type,
    title: spec.title.trim(),
    xLabel: typeof spec.xLabel === "string" ? spec.xLabel.slice(0, 80) : "",
    yLabel: typeof spec.yLabel === "string" ? spec.yLabel.slice(0, 80) : "",
    rows,
    seriesNames: names.length ? names : [""],
  };
}

function tickValues(min, max, count = 4) {
  if (min === max) return [min];
  return Array.from({ length: count + 1 }, (_, index) => min + (max - min) * index / count);
}

function formatTick(value) {
  return new Intl.NumberFormat(undefined, { notation: Math.abs(value) >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function csvCell(value) {
  const text = String(value ?? "");
  const safeText = typeof value === "string" && /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

function PieChart({ spec }) {
  const total = spec.data.reduce((sum, item) => sum + item.value, 0);
  let angle = -Math.PI / 2;
  const radius = 112;
  const cx = 250;
  const cy = 166;
  return <div className="chart-pie-layout">
    <svg aria-label={spec.title} className="chart-svg chart-svg--pie" role="img" viewBox="0 0 500 340">
      <title>{spec.title}</title>
      {spec.data.map((item, index) => {
        const start = angle;
        const sweep = item.value / total * Math.PI * 2;
        angle += sweep;
        const end = angle;
        const largeArc = sweep > Math.PI ? 1 : 0;
        const x1 = cx + radius * Math.cos(start);
        const y1 = cy + radius * Math.sin(start);
        const x2 = cx + radius * Math.cos(end);
        const y2 = cy + radius * Math.sin(end);
        const path = sweep >= Math.PI * 2 - 0.00001
          ? `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius} L ${cx} ${cy} Z`
          : `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
        return <path d={path} fill={COLORS[index % COLORS.length]} key={item.label} stroke="var(--canvas)" strokeWidth="2"><title>{`${item.label}: ${formatTick(item.value)} (${(item.value / total * 100).toFixed(1)}%)`}</title></path>;
      })}
    </svg>
    <ul className="chart-legend chart-legend--pie">{spec.data.map((item, index) => <li key={`${item.label}-${index}`}><i style={{ background: COLORS[index % COLORS.length] }} /><span>{item.label}</span><strong>{(item.value / total * 100).toFixed(1)}%</strong></li>)}</ul>
  </div>;
}

function FunnelChart({ spec }) {
  const width = 720;
  const centerX = 380;
  const maxWidth = 320;
  const rowHeight = 34;
  const top = 24;
  const height = top + rowHeight * spec.data.length + 14;
  return <svg aria-label={spec.title} className="chart-svg chart-svg--funnel" role="img" viewBox={`0 0 ${width} ${height}`}>
    <title>{spec.title}</title>
    {spec.data.map((stage, index) => {
      const y = top + index * rowHeight;
      const barWidth = Math.max(stage.value > 0 ? 3 : 0, maxWidth * stage.value / spec.data[0].value);
      const left = centerX - barWidth / 2;
      const label = stage.label.length > 24 ? `${stage.label.slice(0, 23)}…` : stage.label;
      const conversion = stage.isFirst ? "Initial stage" : stage.conversion === null ? "No remaining volume" : `${stage.conversion.toFixed(1)}% prev · ${stage.overall.toFixed(1)}% overall`;
      return <g key={stage.label}>
        <text className="chart-tick chart-funnel-label" textAnchor="end" x="190" y={y + 16}>{label}<title>{stage.label}</title></text>
        <rect className="chart-funnel-bar" fill={COLORS[0]} height="21" rx="3" width={barWidth} x={left} y={y}>
          <title>{`${stage.label}: ${formatTick(stage.value)}${stage.conversion === null ? "" : `; ${stage.conversion.toFixed(1)}% of previous stage`}`}</title>
        </rect>
        <text className="chart-axis-label chart-funnel-value" textAnchor="start" x="552" y={y + 10}>{formatTick(stage.value)}</text>
        <text className="chart-tick chart-funnel-conversion" textAnchor="start" x="552" y={y + 23}>{conversion}</text>
      </g>;
    })}
  </svg>;
}

function RadarChart({ spec }) {
  const centerX = 360;
  const centerY = 208;
  const radius = 132;
  const angleAt = (index) => -Math.PI / 2 + index * Math.PI * 2 / spec.categories.length;
  const pointAt = (index, ratio) => ({
    x: centerX + Math.cos(angleAt(index)) * radius * ratio,
    y: centerY + Math.sin(angleAt(index)) * radius * ratio,
  });
  const pointsFor = (values) => values.map((value, index) => pointAt(index, value / spec.maxValue));
  return <svg aria-label={spec.title} className="chart-svg chart-svg--radar" role="img" viewBox="0 0 720 416">
    <title>{spec.title}</title>
    {[.25, .5, .75, 1].map((ratio) => {
      const points = spec.categories.map((_, index) => pointAt(index, ratio));
      return <g key={ratio}>
        <polygon className="chart-gridline chart-radar-grid" fill="none" points={points.map((point) => `${point.x},${point.y}`).join(" ")} />
        <text className="chart-tick" textAnchor="start" x={centerX + 5} y={centerY - radius * ratio + 12}>{formatTick(spec.maxValue * ratio)}</text>
      </g>;
    })}
    {spec.categories.map((category, index) => {
      const end = pointAt(index, 1);
      const label = pointAt(index, 1.22);
      const dx = Math.cos(angleAt(index));
      const dy = Math.sin(angleAt(index));
      const anchor = dx > .18 ? "start" : dx < -.18 ? "end" : "middle";
      const y = label.y + (dy > .35 ? 4 : dy < -.35 ? -2 : 4);
      const shortLabel = category.length > 18 ? `${category.slice(0, 17)}…` : category;
      return <g key={category}>
        <line className="chart-axis" x1={centerX} x2={end.x} y1={centerY} y2={end.y} />
        <text className="chart-tick chart-radar-label" textAnchor={anchor} x={label.x} y={y}>{shortLabel}<title>{category}</title></text>
      </g>;
    })}
    {spec.seriesNames.map((name, seriesIndex) => {
      const values = spec.rows.filter((row) => row.series === name);
      const points = pointsFor(values.map((row) => row.y));
      const color = COLORS[seriesIndex % COLORS.length];
      return <g key={name}>
        <polygon className="chart-radar-area" fill={color} fillOpacity=".16" points={points.map((point) => `${point.x},${point.y}`).join(" ")} stroke={color} />
        {points.map((point, index) => <circle className="chart-radar-point" cx={point.x} cy={point.y} fill={color} key={spec.categories[index]} r="4">
          <title>{`${name} · ${spec.categories[index]}: ${formatTick(values[index].y)}`}</title>
        </circle>)}
      </g>;
    })}
  </svg>;
}

function CartesianChart({ spec }) {
  const { type, rows, seriesNames } = spec;
  const left = 66;
  const right = 18;
  const top = 16;
  const bottom = 68;
  const plotWidth = WIDTH - left - right;
  const plotHeight = HEIGHT - top - bottom;
  const categories = [...new Set(rows.map((row) => row.x))];
  const categoryTickInterval = Math.ceil(categories.length / 16);
  const minY = Math.min(0, ...rows.map((row) => row.y));
  const isStackedBar = type === "stacked-bar" || type === "percent-stacked-bar";
  const isPercentStacked = type === "percent-stacked-bar";
  const stackedTotals = isStackedBar
    ? categories.map((category) => rows.filter((row) => row.x === category).reduce((total, row) => total + (isPercentStacked ? row.share : row.y), 0))
    : [];
  const maxY = isPercentStacked ? 100 : Math.max(1, ...(isStackedBar ? stackedTotals : rows.map((row) => row.y)));
  const yRange = maxY - minY || 1;
  const y = (value) => top + plotHeight - (value - minY) / yRange * plotHeight;
  const isScatter = type === "scatter";
  const scatterXs = rows.map((row) => Number(row.x));
  const minX = Math.min(...scatterXs);
  const maxX = Math.max(...scatterXs);
  const x = (value, index) => isScatter
    ? left + (maxX === minX ? 0.5 : (Number(value) - minX) / (maxX - minX)) * plotWidth
    : left + (categories.length === 1 ? plotWidth / 2 : index * plotWidth / (categories.length - 1));
  const series = seriesNames.map((name) => rows.filter((row) => row.series === name));
  const groupedBars = type === "bar" && seriesNames.length > 1;
  const barWidth = type === "histogram"
    ? Math.min(64, plotWidth / Math.max(1, categories.length) * 0.94)
    : Math.min(42, plotWidth / Math.max(1, categories.length) * (groupedBars ? 0.72 / seriesNames.length : 0.62));
  return <svg aria-label={spec.title} className="chart-svg" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
    <title>{spec.title}</title>
    {tickValues(minY, maxY).map((tick) => <g key={tick}>
      <line className="chart-gridline" x1={left} x2={WIDTH - right} y1={y(tick)} y2={y(tick)} />
      <text className="chart-tick chart-tick--y" textAnchor="end" x={left - 9} y={y(tick) + 4}>{formatTick(tick)}{isPercentStacked ? "%" : ""}</text>
    </g>)}
    <line className="chart-axis" x1={left} x2={WIDTH - right} y1={top + plotHeight} y2={top + plotHeight} />
    {isScatter ? tickValues(minX, maxX).map((tick) => <g key={tick}>
      <line className="chart-gridline chart-gridline--vertical" x1={x(tick)} x2={x(tick)} y1={top} y2={top + plotHeight} />
      <text className="chart-tick" textAnchor="middle" x={x(tick)} y={top + plotHeight + 19}>{formatTick(tick)}</text>
    </g>) : categories.map((category, index) => index % categoryTickInterval === 0 || index === categories.length - 1
      ? <text className="chart-tick" key={category} textAnchor="middle" x={x(category, index)} y={top + plotHeight + 19}>{category.length > 14 ? `${category.slice(0, 12)}…` : category}</text>
      : null)}
    {isStackedBar && categories.map((category, categoryIndex) => {
      let total = 0;
      const categoryRows = series.map((values) => values.find((row) => row.x === category));
      const categoryTotal = categoryRows.reduce((sum, row) => sum + row.y, 0);
      return <g key={category}>{categoryRows.map((row, seriesIndex) => {
        const segmentValue = isPercentStacked ? row.share : row.y;
        const start = total;
        total += segmentValue;
        const startY = y(start);
        const endY = y(total);
        return <rect className="chart-bar" fill={COLORS[seriesIndex % COLORS.length]} height={Math.max(0, startY - endY)} key={`${row.series}-${category}`} width={barWidth} x={x(category, categoryIndex) - barWidth / 2} y={endY}>
          <title>{`${row.series} · ${category}: ${formatTick(row.y)}${spec.valueLabel ? ` ${spec.valueLabel}` : ""}${isPercentStacked ? ` (${formatTick(segmentValue)}%)` : ""} (total ${formatTick(categoryTotal)})`}</title>
        </rect>;
      })}</g>;
    })}
    {(type === "bar" || type === "histogram") && series.flatMap((values, seriesIndex) => values.map((row) => {
      const categoryIndex = categories.indexOf(row.x);
      const baseX = x(row.x, categoryIndex);
      const centerX = groupedBars ? baseX + (seriesIndex - (series.length - 1) / 2) * barWidth : baseX;
      const valueY = y(row.y);
      const zeroY = y(0);
        return <rect className="chart-bar" fill={COLORS[seriesIndex % COLORS.length]} height={Math.max(1, Math.abs(zeroY - valueY))} key={`${row.series}-${row.x}-${seriesIndex}`} rx="3" width={barWidth} x={centerX - barWidth / 2} y={Math.min(valueY, zeroY)}><title>{`${row.series ? `${row.series} · ` : ""}${row.x}: ${formatTick(row.y)}`}</title></rect>;
    }))}
    {(type === "line" || type === "area") && series.map((values, seriesIndex) => {
      const points = values.map((row) => [x(row.x, categories.indexOf(row.x)), y(row.y)]);
      const pointString = points.map(([px, py]) => `${px},${py}`).join(" ");
      return <g key={seriesNames[seriesIndex]}>
        {type === "area" && points.length > 1 && <polygon fill={COLORS[seriesIndex % COLORS.length]} fillOpacity=".14" points={`${points[0][0]},${y(0)} ${pointString} ${points.at(-1)[0]},${y(0)}`} />}
        <polyline className="chart-line" fill="none" points={pointString} stroke={COLORS[seriesIndex % COLORS.length]} />
        {values.map((row, index) => <circle className="chart-point" cx={points[index][0]} cy={points[index][1]} fill={COLORS[seriesIndex % COLORS.length]} key={`${row.x}-${index}`} r="4"><title>{`${seriesNames[seriesIndex] ? `${seriesNames[seriesIndex]} · ` : ""}${row.x}: ${formatTick(row.y)}`}</title></circle>)}
      </g>;
    })}
    {isScatter && series.flatMap((values, seriesIndex) => values.map((row, index) => <circle className="chart-point" cx={x(row.x)} cy={y(row.y)} fill={COLORS[seriesIndex % COLORS.length]} key={`${row.x}-${row.y}-${index}`} r="5"><title>{`${seriesNames[seriesIndex] ? `${seriesNames[seriesIndex]} · ` : ""}${formatTick(Number(row.x))}, ${formatTick(row.y)}`}</title></circle>))}
    {spec.xLabel && <text className="chart-axis-label" textAnchor="middle" x={left + plotWidth / 2} y={HEIGHT - 7}>{spec.xLabel}</text>}
    {spec.yLabel && <text className="chart-axis-label" textAnchor="middle" transform={`translate(15 ${top + plotHeight / 2}) rotate(-90)`}>{spec.yLabel}</text>}
  </svg>;
}

function BubbleChart({ spec }) {
  const { rows, seriesNames } = spec;
  const left = 66;
  const right = 24;
  const top = 20;
  const height = 430;
  const bottom = 145;
  const plotWidth = WIDTH - left - right;
  const plotHeight = height - top - bottom;
  const minX = Math.min(...rows.map((row) => row.x));
  const maxX = Math.max(...rows.map((row) => row.x));
  const minY = Math.min(...rows.map((row) => row.y));
  const maxY = Math.max(...rows.map((row) => row.y));
  const xSpan = maxX - minX || Math.abs(maxX) * 0.1 || 1;
  const ySpan = maxY - minY || Math.abs(maxY) * 0.1 || 1;
  const xMin = minX - xSpan * 0.06;
  const xMax = maxX + xSpan * 0.06;
  const yMin = minY - ySpan * 0.06;
  const yMax = maxY + ySpan * 0.06;
  const maxSize = Math.max(...rows.map((row) => row.size));
  const x = (value) => left + (value - xMin) / (xMax - xMin) * plotWidth;
  const y = (value) => top + plotHeight - (value - yMin) / (yMax - yMin) * plotHeight;
  const radius = (size) => size === 0 ? 2 : 3 + Math.sqrt(size / maxSize) * 17;
  const sizeReferenceValues = [maxSize / 4, maxSize / 2, maxSize];
  return <div className="chart-bubble-layout">
    <svg aria-label={spec.title} className="chart-svg" role="img" viewBox={`0 0 ${WIDTH} ${height}`}>
    <title>{spec.title}</title>
    {tickValues(yMin, yMax).map((tick) => <g key={`y-${tick}`}>
      <line className="chart-gridline" x1={left} x2={WIDTH - right} y1={y(tick)} y2={y(tick)} />
      <text className="chart-tick chart-tick--y" textAnchor="end" x={left - 9} y={y(tick) + 4}>{formatTick(tick)}</text>
    </g>)}
    {tickValues(xMin, xMax).map((tick) => <g key={`x-${tick}`}>
      <line className="chart-gridline chart-gridline--vertical" x1={x(tick)} x2={x(tick)} y1={top} y2={top + plotHeight} />
      <text className="chart-tick" textAnchor="middle" x={x(tick)} y={top + plotHeight + 19}>{formatTick(tick)}</text>
    </g>)}
    <line className="chart-axis" x1={left} x2={WIDTH - right} y1={top + plotHeight} y2={top + plotHeight} />
    {rows.map((row, index) => {
      const seriesIndex = Math.max(0, seriesNames.indexOf(row.series));
      return <circle
        className="chart-point"
        cx={x(row.x)} cy={y(row.y)} fill={COLORS[seriesIndex % COLORS.length]}
        fillOpacity=".62" key={`${row.series}-${row.x}-${row.y}-${index}`}
        r={radius(row.size)} stroke={COLORS[seriesIndex % COLORS.length]} strokeWidth="1.5"
      ><title>{`${row.label ? `${row.label} · ` : ""}${row.series ? `${row.series} · ` : ""}x ${formatTick(row.x)}, y ${formatTick(row.y)}, ${spec.sizeLabel.toLowerCase()} ${formatTick(row.size)}`}</title></circle>;
    })}
    <text className="chart-tick" x={left} y={height - 88}>{spec.sizeLabel}</text>
    {sizeReferenceValues.map((value, index) => {
      const centerX = left + 80 + index * 150;
      const centerY = height - 57;
      return <g key={value}>
        <circle cx={centerX} cy={centerY} fill="#55b8ff" fillOpacity=".2" r={radius(value)} stroke="#55b8ff" />
        <text className="chart-tick" x={centerX + radius(value) + 4} y={centerY + 4}>{formatTick(value)}</text>
      </g>;
    })}
    {spec.xLabel && <text className="chart-axis-label" textAnchor="middle" x={left + plotWidth / 2} y={height - 7}>{spec.xLabel}</text>}
    {spec.yLabel && <text className="chart-axis-label" textAnchor="middle" transform={`translate(15 ${top + plotHeight / 2}) rotate(-90)`}>{spec.yLabel}</text>}
    </svg>
  </div>;
}

function WaterfallChart({ spec }) {
  const left = 66;
  const right = 18;
  const top = 18;
  const bottom = 68;
  const plotWidth = WIDTH - left - right;
  const plotHeight = HEIGHT - top - bottom;
  const values = spec.data.flatMap((row) => [row.start, row.end]);
  const minValue = Math.min(0, ...values);
  const maxValue = Math.max(0, ...values);
  const span = maxValue - minValue || 1;
  const domainMin = minValue - span * 0.06;
  const domainMax = maxValue + span * 0.06;
  const y = (value) => top + plotHeight - (value - domainMin) / (domainMax - domainMin) * plotHeight;
  const slotWidth = plotWidth / spec.data.length;
  const barWidth = Math.min(44, slotWidth * 0.62);
  const categoryInterval = Math.ceil(spec.data.length / 14);
  const colorFor = (row) => row.type === "total" ? "#55b8ff" : row.value >= 0 ? "#62d6a5" : "#ff8797";
  return <svg aria-label={spec.title} className="chart-svg" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
    <title>{spec.title}</title>
    {tickValues(domainMin, domainMax).map((tick) => <g key={tick}>
      <line className="chart-gridline" x1={left} x2={WIDTH - right} y1={y(tick)} y2={y(tick)} />
      <text className="chart-tick chart-tick--y" textAnchor="end" x={left - 9} y={y(tick) + 4}>{formatTick(tick)}</text>
    </g>)}
    <line className="chart-axis" x1={left} x2={WIDTH - right} y1={y(0)} y2={y(0)} />
    {spec.data.map((row, index) => {
      const centerX = left + slotWidth * (index + 0.5);
      const topY = y(Math.max(row.start, row.end));
      const bottomY = y(Math.min(row.start, row.end));
      const color = colorFor(row);
      return <g key={`${row.label}-${index}`}>
        {index < spec.data.length - 1 && <line className="chart-waterfall-connector" x1={centerX + barWidth / 2} x2={centerX + slotWidth - barWidth / 2} y1={y(row.end)} y2={y(row.end)} />}
        <rect className="chart-bar" fill={color} height={Math.max(1, bottomY - topY)} rx="3" width={barWidth} x={centerX - barWidth / 2} y={topY}>
          <title>{`${row.label}: ${row.type === "total" ? "total" : "change"} ${formatTick(row.value)}; running total ${formatTick(row.runningTotal)}`}</title>
        </rect>
        {index % categoryInterval === 0 || index === spec.data.length - 1
          ? <text className="chart-tick" textAnchor="middle" x={centerX} y={top + plotHeight + 19}>{row.label.length > 14 ? `${row.label.slice(0, 12)}…` : row.label}<title>{row.label}</title></text>
          : null}
      </g>;
    })}
    {spec.xLabel && <text className="chart-axis-label" textAnchor="middle" x={left + plotWidth / 2} y={HEIGHT - 7}>{spec.xLabel}</text>}
    {spec.yLabel && <text className="chart-axis-label" textAnchor="middle" transform={`translate(15 ${top + plotHeight / 2}) rotate(-90)`}>{spec.yLabel}</text>}
  </svg>;
}

function treemapLayout(items, x, y, width, height, valueOf = (item) => item.value) {
  if (items.length === 1) return [{ item: items[0], x, y, width, height }];
  const sorted = [...items].sort((left, right) => valueOf(right) - valueOf(left));
  const total = sorted.reduce((sum, item) => sum + valueOf(item), 0);
  let accumulated = 0;
  let splitIndex = 1;
  let closestDifference = Infinity;
  for (let index = 1; index < sorted.length; index += 1) {
    accumulated += valueOf(sorted[index - 1]);
    const difference = Math.abs(total / 2 - accumulated);
    if (difference < closestDifference) {
      closestDifference = difference;
      splitIndex = index;
    }
  }
  const first = sorted.slice(0, splitIndex);
  const second = sorted.slice(splitIndex);
  const firstValue = first.reduce((sum, item) => sum + valueOf(item), 0);
  const firstRatio = firstValue / total;
  if (width >= height) {
    const firstWidth = width * firstRatio;
    return [
      ...treemapLayout(first, x, y, firstWidth, height, valueOf),
      ...treemapLayout(second, x + firstWidth, y, width - firstWidth, height, valueOf),
    ];
  }
  const firstHeight = height * firstRatio;
  return [
    ...treemapLayout(first, x, y, width, firstHeight, valueOf),
    ...treemapLayout(second, x, y + firstHeight, width, height - firstHeight, valueOf),
  ];
}

function TreemapChart({ spec }) {
  const padding = 4;
  const groups = spec.seriesNames.length
    ? spec.seriesNames.map((name) => ({ name, items: spec.rows.filter((row) => row.group === name) }))
    : [{ name: "", items: spec.rows }];
  const grouped = groups.map((group) => ({ ...group, value: group.items.reduce((sum, item) => sum + item.value, 0) }));
  const total = grouped.reduce((sum, group) => sum + group.value, 0);
  const groupRects = treemapLayout(grouped, 0, 0, WIDTH, HEIGHT, (group) => group.value);
  return <svg aria-label={spec.title} className="chart-svg chart-svg--treemap" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
    <title>{spec.title}</title>
    {groupRects.map(({ item: group, x, y, width, height }, groupIndex) => {
      const color = COLORS[Math.max(0, spec.seriesNames.indexOf(group.name)) % COLORS.length];
      const groupInset = Math.min(padding, width / 8, height / 8);
      const headingHeight = group.name && height > 42 && width > 54 ? 24 : 0;
      const innerX = x + groupInset;
      const innerY = y + groupInset + headingHeight;
      const innerWidth = Math.max(0, width - groupInset * 2);
      const innerHeight = Math.max(0, height - groupInset * 2 - headingHeight);
      const leaves = innerWidth > 0 && innerHeight > 0
        ? treemapLayout(group.items, innerX, innerY, innerWidth, innerHeight)
        : [];
      return <g key={group.name || "ungrouped"}>
        {spec.seriesNames.length > 0 && <rect className="chart-treemap-group" fill={color} fillOpacity=".1" height={height} stroke={color} strokeOpacity=".7" width={width} x={x} y={y} />}
        {headingHeight > 0 && <text className="chart-treemap-heading" fill={color} x={innerX + 5} y={y + groupInset + 16}>{group.name.length > Math.floor((width - 20) / 7) ? `${group.name.slice(0, Math.max(1, Math.floor((width - 24) / 7) - 1))}…` : group.name}<title>{`${group.name}: ${formatTick(group.value)} (${(group.value / total * 100).toFixed(1)}%)`}</title></text>}
        {leaves.map(({ item, x: leafX, y: leafY, width: leafWidth, height: leafHeight }, index) => {
          const opacity = 0.38 + (index % 3) * 0.06;
          const labelLimit = Math.floor((leafWidth - 12) / 7);
          const showLabel = leafWidth >= 48 && leafHeight >= 25;
          const showValue = leafWidth >= 72 && leafHeight >= 44;
          return <g key={`${item.group}-${item.label}`}>
            <rect className="chart-treemap-cell" fill={color} fillOpacity={opacity} height={Math.max(0, leafHeight)} stroke="var(--canvas)" strokeWidth="2" width={Math.max(0, leafWidth)} x={leafX} y={leafY}>
              <title>{`${item.group ? `${item.group} · ` : ""}${item.label}: ${formatTick(item.value)} (${(item.value / total * 100).toFixed(1)}%)`}</title>
            </rect>
            {showLabel && <text className="chart-treemap-label" x={leafX + 6} y={leafY + 16}>{item.label.length > labelLimit ? `${item.label.slice(0, Math.max(1, labelLimit - 1))}…` : item.label}<title>{item.label}</title></text>}
            {showValue && <text className="chart-treemap-value" x={leafX + 6} y={leafY + 33}>{formatTick(item.value)}</text>}
          </g>;
        })}
      </g>;
    })}
  </svg>;
}

function HorizontalBarChart({ spec }) {
  const { rows, seriesNames } = spec;
  const left = 184;
  const right = 62;
  const top = 18;
  const bottom = 44;
  const plotWidth = WIDTH - left - right;
  const plotHeight = HEIGHT - top - bottom;
  const categories = [...new Set(rows.map((row) => row.x))];
  const minValue = Math.min(0, ...rows.map((row) => row.y));
  const maxValue = Math.max(0, ...rows.map((row) => row.y));
  const domainMax = minValue === maxValue ? minValue + 1 : maxValue;
  const domainMin = minValue === maxValue ? Math.min(0, minValue) : minValue;
  const range = domainMax - domainMin || 1;
  const x = (value) => left + (value - domainMin) / range * plotWidth;
  const slotHeight = plotHeight / categories.length;
  const groupedBars = seriesNames.length > 1;
  const barHeight = Math.min(25, slotHeight * (groupedBars ? 0.72 / seriesNames.length : 0.62));
  const series = seriesNames.map((name) => rows.filter((row) => row.series === name));
  const ticks = tickValues(domainMin, domainMax);
  return <svg aria-label={spec.title} className="chart-svg" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
    <title>{spec.title}</title>
    {ticks.map((tick) => <g key={tick}>
      <line className="chart-gridline chart-gridline--vertical" x1={x(tick)} x2={x(tick)} y1={top} y2={top + plotHeight} />
      <text className="chart-tick" textAnchor="middle" x={x(tick)} y={top + plotHeight + 19}>{formatTick(tick)}</text>
    </g>)}
    <line className="chart-axis" x1={x(0)} x2={x(0)} y1={top} y2={top + plotHeight} />
    <line className="chart-axis" x1={left} x2={WIDTH - right} y1={top + plotHeight} y2={top + plotHeight} />
    {categories.map((category, categoryIndex) => {
      const centerY = top + slotHeight * (categoryIndex + 0.5);
      const label = category.length > 27 ? `${category.slice(0, 25)}…` : category;
      return <g key={category}>
        <text className="chart-tick" textAnchor="end" x={left - 12} y={centerY + 4}>{label}<title>{category}</title></text>
        {series.flatMap((values, seriesIndex) => values.filter((row) => row.x === category).map((row) => {
          const seriesOffset = groupedBars ? (seriesIndex - (series.length - 1) / 2) * barHeight : 0;
          const valueX = x(row.y);
          const zeroX = x(0);
          return <rect className="chart-bar" fill={COLORS[seriesIndex % COLORS.length]} height={barHeight} key={`${row.series}-${category}-${seriesIndex}`} rx="3" width={Math.max(1, Math.abs(valueX - zeroX))} x={Math.min(valueX, zeroX)} y={centerY + seriesOffset - barHeight / 2}>
            <title>{`${row.series ? `${row.series} · ` : ""}${category}: ${formatTick(row.y)}`}</title>
          </rect>;
        }))}
      </g>;
    })}
    {spec.xLabel && <text className="chart-axis-label" textAnchor="middle" x={left + plotWidth / 2} y={HEIGHT - 6}>{spec.xLabel}</text>}
    {spec.yLabel && <text className="chart-axis-label" textAnchor="middle" transform={`translate(15 ${top + plotHeight / 2}) rotate(-90)`}>{spec.yLabel}</text>}
  </svg>;
}

function BoxPlotChart({ spec }) {
  const left = 66;
  const right = 18;
  const top = 16;
  const bottom = 68;
  const plotWidth = WIDTH - left - right;
  const plotHeight = HEIGHT - top - bottom;
  const values = spec.data.flatMap((item) => [item.min, item.max]);
  let minY = Math.min(...values);
  let maxY = Math.max(...values);
  if (minY === maxY) { minY -= 1; maxY += 1; }
  const y = (value) => top + plotHeight - (value - minY) / (maxY - minY) * plotHeight;
  const slotWidth = plotWidth / spec.data.length;
  const boxWidth = Math.min(62, slotWidth * 0.48);
  const labelInterval = Math.ceil(spec.data.length / 12);
  return <svg aria-label={spec.title} className="chart-svg" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
    <title>{spec.title}</title>
    {tickValues(minY, maxY).map((tick) => <g key={tick}>
      <line className="chart-gridline" x1={left} x2={WIDTH - right} y1={y(tick)} y2={y(tick)} />
      <text className="chart-tick chart-tick--y" textAnchor="end" x={left - 9} y={y(tick) + 4}>{formatTick(tick)}</text>
    </g>)}
    {spec.data.map((item, index) => {
      const centerX = left + slotWidth * (index + 0.5);
      const color = COLORS[index % COLORS.length];
      return <g key={`${item.label}-${index}`}>
        <line stroke={color} strokeWidth="2" x1={centerX} x2={centerX} y1={y(item.min)} y2={y(item.max)} />
        <line stroke={color} strokeWidth="2" x1={centerX - boxWidth * 0.24} x2={centerX + boxWidth * 0.24} y1={y(item.min)} y2={y(item.min)} />
        <line stroke={color} strokeWidth="2" x1={centerX - boxWidth * 0.24} x2={centerX + boxWidth * 0.24} y1={y(item.max)} y2={y(item.max)} />
        <rect fill={color} fillOpacity=".2" height={Math.max(1, y(item.q1) - y(item.q3))} stroke={color} strokeWidth="2" width={boxWidth} x={centerX - boxWidth / 2} y={y(item.q3)} />
        <line stroke={color} strokeWidth="2.5" x1={centerX - boxWidth / 2} x2={centerX + boxWidth / 2} y1={y(item.median)} y2={y(item.median)} />
        {index % labelInterval === 0 || index === spec.data.length - 1
          ? <text className="chart-tick" textAnchor="middle" x={centerX} y={top + plotHeight + 19}>{item.label.length > 14 ? `${item.label.slice(0, 12)}…` : item.label}</text>
          : null}
        <title>{`${item.label}: min ${item.min}, Q1 ${item.q1}, median ${item.median}, Q3 ${item.q3}, max ${item.max}`}</title>
      </g>;
    })}
    {spec.xLabel && <text className="chart-axis-label" textAnchor="middle" x={left + plotWidth / 2} y={HEIGHT - 7}>{spec.xLabel}</text>}
    {spec.yLabel && <text className="chart-axis-label" textAnchor="middle" transform={`translate(15 ${top + plotHeight / 2}) rotate(-90)`}>{spec.yLabel}</text>}
  </svg>;
}

function mixHex(start, end, amount) {
  const channels = [1, 3, 5].map((offset) => {
    const left = Number.parseInt(start.slice(offset, offset + 2), 16);
    const right = Number.parseInt(end.slice(offset, offset + 2), 16);
    return Math.round(left + (right - left) * amount).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

function heatmapColor(value, min, max) {
  const range = max - min;
  const ratio = range === 0 ? 0.5 : (value - min) / range;
  if (min < 0 && max > 0) {
    const neutral = "#17283d";
    return value <= 0
      ? mixHex("#348ac4", neutral, (value - min) / -min)
      : mixHex(neutral, "#e9a15c", value / max);
  }
  return mixHex("#17324d", "#55b8ff", ratio);
}

function HeatmapChart({ spec }) {
  const left = 136;
  const right = 20;
  const top = 20;
  const cellWidth = 38;
  const cellHeight = 24;
  const width = Math.max(720, left + right + spec.xCategories.length * cellWidth);
  const plotWidth = width - left - right;
  const plotHeight = spec.yCategories.length * cellHeight;
  const plotBottom = top + plotHeight;
  const height = plotBottom + 118;
  const xStep = plotWidth / spec.xCategories.length;
  const values = spec.rows.map((row) => row.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const cells = new Map(spec.rows.map((row) => [heatmapCoordinateKey(row.x, row.y), row]));
  const scaleWidth = Math.min(220, plotWidth * 0.46);
  const scaleX = left + (plotWidth - scaleWidth) / 2;
  const scaleY = height - 28;

  return <svg aria-label={spec.title} className="chart-svg chart-svg--heatmap" role="img" viewBox={`0 0 ${width} ${height}`}>
    <title>{spec.title}</title>
    {spec.yCategories.map((category, yIndex) => {
      const centerY = top + yIndex * cellHeight + cellHeight / 2;
      return <g key={category}>
        <text className="chart-tick" textAnchor="end" x={left - 10} y={centerY + 4}>{category.length > 20 ? `${category.slice(0, 18)}…` : category}<title>{category}</title></text>
        {spec.xCategories.map((xCategory, xIndex) => {
          const row = cells.get(heatmapCoordinateKey(xCategory, category));
          if (!row) return null;
          return <rect
            fill={heatmapColor(row.value, min, max)}
            height={cellHeight - 2}
            key={`${xCategory}-${category}`}
            rx="2"
            width={Math.max(1, xStep - 2)}
            x={left + xIndex * xStep + 1}
            y={top + yIndex * cellHeight + 1}
          ><title>{`${category} · ${xCategory}: ${formatTick(row.value)}`}</title></rect>;
        })}
      </g>;
    })}
    {spec.xCategories.map((category, index) => {
      const x = left + index * xStep + xStep / 2;
      return <text className="chart-tick" key={category} textAnchor="end" transform={`translate(${x} ${plotBottom + 12}) rotate(-42)`}>
        {category.length > 18 ? `${category.slice(0, 16)}…` : category}<title>{category}</title>
      </text>;
    })}
    {spec.xLabel && <text className="chart-axis-label" textAnchor="middle" x={left + plotWidth / 2} y={height - 58}>{spec.xLabel}</text>}
    {spec.yLabel && <text className="chart-axis-label" textAnchor="middle" transform={`translate(15 ${top + plotHeight / 2}) rotate(-90)`}>{spec.yLabel}</text>}
    {Array.from({ length: 32 }, (_, index) => {
      const ratio = index / 31;
      const value = min + (max - min) * ratio;
      return <rect fill={heatmapColor(value, min, max)} height="8" key={index} width={scaleWidth / 32 + 0.5} x={scaleX + index * scaleWidth / 32} y={scaleY} />;
    })}
    <text className="chart-tick" textAnchor="start" x={scaleX} y={scaleY + 19}>{formatTick(min)}</text>
    <text className="chart-tick" textAnchor="middle" x={scaleX + scaleWidth / 2} y={scaleY + 19}>{formatTick(min + (max - min) / 2)}</text>
    <text className="chart-tick" textAnchor="end" x={scaleX + scaleWidth} y={scaleY + 19}>{formatTick(max)}</text>
  </svg>;
}

export function ChartPreview({ spec, source }) {
  const svgRef = useRef(null);
  const tableRows = useMemo(() => spec.type === "bubble"
    ? spec.rows
    : spec.type === "waterfall" ? spec.data
    : spec.type === "funnel" ? spec.data
    : spec.type === "treemap" ? spec.rows
    : spec.type === "pie"
    ? spec.data.map((item) => ({ series: "", x: item.label, y: item.value }))
    : spec.type === "boxplot"
      ? spec.data.map((item) => ({ ...item }))
      : spec.rows, [spec]);

  function downloadCsv() {
    const hasSeries = spec.type !== "pie" && spec.type !== "boxplot" && spec.type !== "heatmap" && spec.seriesNames.some(Boolean);
    const headers = spec.type === "waterfall"
      ? ["Step", "Type", "Value", "Running total"]
      : spec.type === "funnel"
      ? ["Stage", "Count", "Conversion from previous (%)", "Overall conversion (%)"]
      : spec.type === "percent-stacked-bar"
      ? ["Series", spec.xLabel || "Category", spec.valueLabel || "Value", "Share (%)"]
      : spec.type === "radar"
      ? ["Criterion", "Series", "Score"]
      : spec.type === "treemap"
      ? [...(hasSeries ? ["Group"] : []), "Category", "Value"]
      : spec.type === "bubble"
      ? [...(tableRows.some((row) => row.label) ? ["Label"] : []), ...(hasSeries ? ["Series"] : []), spec.xLabel || "X", spec.yLabel || "Y", spec.sizeLabel || "Size"]
      : spec.type === "boxplot"
      ? ["Group", "Minimum", "Q1", "Median", "Q3", "Maximum"]
      : spec.type === "heatmap" ? [spec.yLabel || "Row", spec.xLabel || "Column", "Value"]
      : [...(hasSeries ? ["Series"] : []), spec.xLabel || "Label", spec.yLabel || "Value"];
    const rows = spec.type === "waterfall"
      ? tableRows.map((row) => [row.label, row.type, row.value, row.runningTotal])
      : spec.type === "funnel"
      ? tableRows.map((row) => [row.label, row.value, row.conversion ?? "", row.overall])
      : spec.type === "percent-stacked-bar"
      ? tableRows.map((row) => [row.series, row.x, row.y, row.share])
      : spec.type === "radar"
      ? tableRows.map((row) => [row.x, row.series, row.y])
      : spec.type === "treemap"
      ? tableRows.map((row) => [...(hasSeries ? [row.group] : []), row.label, row.value])
      : spec.type === "bubble"
      ? tableRows.map((row) => [...(tableRows.some((item) => item.label) ? [row.label] : []), ...(hasSeries ? [row.series || "Series 1"] : []), row.x, row.y, row.size])
      : spec.type === "boxplot"
      ? tableRows.map((row) => [row.label, row.min, row.q1, row.median, row.q3, row.max])
      : spec.type === "heatmap" ? tableRows.map((row) => [row.y, row.x, row.value])
      : tableRows.map((row) => [...(hasSeries ? [row.series || "Series 1"] : []), row.x, row.y]);
    const csv = `\ufeff${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${spec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chart"}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function buildExportSvg() {
    const svgElement = svgRef.current?.querySelector("svg");
    if (!svgElement) return null;
    const output = svgElement.cloneNode(true);
    const [viewX, viewY, viewWidth, viewHeight] = output.getAttribute("viewBox").split(/\s+/).map(Number);
    const legendItems = spec.type === "waterfall"
      ? [{ name: "Increase", color: "#62d6a5" }, { name: "Decrease", color: "#ff8797" }, { name: "Total", color: "#55b8ff" }]
      : spec.type === "pie"
      ? spec.data.map((item, index) => ({ name: `${item.label} · ${(item.value / spec.data.reduce((sum, entry) => sum + entry.value, 0) * 100).toFixed(1)}%`, color: COLORS[index % COLORS.length] }))
      : spec.type === "boxplot" || spec.type === "heatmap" ? []
        : spec.seriesNames.filter(Boolean).map((name, index) => ({ name, color: COLORS[index % COLORS.length] }));
    const namespace = "http://www.w3.org/2000/svg";
    const style = document.createElementNS(namespace, "style");
    style.textContent = "text{fill:#b8c8d9;font:11px Arial,sans-serif}.chart-gridline{stroke:#33465b;stroke-width:1}.chart-axis{stroke:#52677d;stroke-width:1}.chart-point{stroke:#122033;stroke-width:2}.chart-line{stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}.chart-radar-area{stroke-width:2;stroke-linejoin:round}.chart-radar-point{stroke:#132338;stroke-width:2}";
    output.insertBefore(style, output.firstChild);
    const background = document.createElementNS(namespace, "rect");
    background.setAttribute("width", viewWidth);
    background.setAttribute("height", viewHeight + legendItems.length * 20 + 12);
    background.setAttribute("fill", "#0e1a29");
    output.insertBefore(background, style.nextSibling);
    if (legendItems.length) {
      const legend = document.createElementNS(namespace, "g");
      legendItems.forEach((item, index) => {
        const y = viewHeight + 18 + index * 20;
        const marker = document.createElementNS(namespace, "rect");
        marker.setAttribute("x", "18"); marker.setAttribute("y", String(y - 8));
        marker.setAttribute("width", "8"); marker.setAttribute("height", "8");
        marker.setAttribute("rx", "2"); marker.setAttribute("fill", item.color);
        const label = document.createElementNS(namespace, "text");
        label.setAttribute("x", "32"); label.setAttribute("y", String(y));
        label.textContent = item.name;
        legend.append(marker, label);
      });
      output.append(legend);
    }
    const exportHeight = viewHeight + legendItems.length * 20 + 12;
    output.setAttribute("viewBox", `${viewX} ${viewY} ${viewWidth} ${exportHeight}`);
    output.setAttribute("width", String(viewWidth));
    output.setAttribute("height", String(exportHeight));
    const svg = new XMLSerializer().serializeToString(output);
    return { markup: `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`, width: viewWidth, height: exportHeight };
  }

  function downloadSvg() {
    const exported = buildExportSvg();
    if (!exported) return;
    const blob = new Blob([exported.markup], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${spec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chart"}.svg`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadPng() {
    const exported = buildExportSvg();
    if (!exported) return;
    const svgUrl = URL.createObjectURL(new Blob([exported.markup], { type: "image/svg+xml;charset=utf-8" }));
    const image = new window.Image();
    image.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(exported.width * scale);
      canvas.height = Math.round(exported.height * scale);
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(svgUrl);
        return;
      }
      context.fillStyle = "#0e1a29";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(svgUrl);
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${spec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chart"}.png`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, "image/png");
    };
    image.onerror = () => URL.revokeObjectURL(svgUrl);
    image.src = svgUrl;
  }

  return <figure className="chart-preview">
    <header className="chart-preview-heading"><strong>{spec.title}</strong><div className="chart-preview-actions"><button aria-label="Download chart as CSV" className="chart-download" onClick={downloadCsv} title="Download CSV" type="button"><FileCsv size={15} /></button><button aria-label="Download chart as SVG" className="chart-download" onClick={downloadSvg} title="Download SVG" type="button"><ArrowLineDown size={15} /></button><button aria-label="Download chart as PNG" className="chart-download" onClick={downloadPng} title="Download PNG" type="button"><ImageIcon size={15} /></button></div></header>
    {spec.type === "waterfall" ? <div ref={svgRef}><WaterfallChart spec={spec} /></div>
      : spec.type === "funnel" ? <div ref={svgRef}><FunnelChart spec={spec} /></div>
      : spec.type === "treemap" ? <div ref={svgRef}><TreemapChart spec={spec} /></div>
      : spec.type === "bubble" ? <div ref={svgRef}><BubbleChart spec={spec} /></div>
      : spec.type === "radar" ? <div ref={svgRef}><RadarChart spec={spec} /></div>
      : spec.type === "pie" ? <div ref={svgRef}><PieChart spec={spec} /></div>
      : spec.type === "boxplot" ? <div ref={svgRef}><BoxPlotChart spec={spec} /></div>
        : spec.type === "heatmap" ? <div ref={svgRef}><HeatmapChart spec={spec} /></div>
        : spec.type === "horizontal-bar" ? <div ref={svgRef}><HorizontalBarChart spec={spec} /></div>
          : <div ref={svgRef}><CartesianChart spec={spec} /></div>}
    {spec.type === "waterfall" && <ul className="chart-legend"><li><i style={{ background: "#62d6a5" }} /><span>Increase</span></li><li><i style={{ background: "#ff8797" }} /><span>Decrease</span></li><li><i style={{ background: "#55b8ff" }} /><span>Total</span></li></ul>}
    {spec.type !== "waterfall" && spec.type !== "pie" && spec.type !== "boxplot" && spec.type !== "heatmap" && spec.seriesNames.some(Boolean) && <ul className="chart-legend">{spec.seriesNames.map((name, index) => <li key={name}><i style={{ background: COLORS[index % COLORS.length] }} /><span>{name || "Series 1"}</span></li>)}</ul>}
    <details className="chart-data"><summary>View data</summary><div className="chart-data-scroll"><table><thead><tr>{spec.type === "waterfall" ? <><th>Step</th><th>Type</th><th>Value</th><th>Running total</th></> : spec.type === "funnel" ? <><th>Stage</th><th>Count</th><th>Conversion from previous (%)</th><th>Overall conversion (%)</th></> : spec.type === "percent-stacked-bar" ? <><th>Series</th><th>{spec.xLabel || "Category"}</th><th>{spec.valueLabel || "Value"}</th><th>Share (%)</th></> : spec.type === "radar" ? <><th>Criterion</th><th>Series</th><th>Score</th></> : spec.type === "treemap" ? <>{spec.seriesNames.some(Boolean) && <th>Group</th>}<th>Category</th><th>Value</th></> : spec.type === "bubble" ? <>{tableRows.some((row) => row.label) && <th>Label</th>}{spec.seriesNames.some(Boolean) && <th>Series</th>}<th>{spec.xLabel || "X"}</th><th>{spec.yLabel || "Value"}</th><th>{spec.sizeLabel || "Size"}</th></> : spec.type === "boxplot" ? <><th>Group</th><th>Minimum</th><th>Q1</th><th>Median</th><th>Q3</th><th>Maximum</th></> : spec.type === "heatmap" ? <><th>{spec.yLabel || "Row"}</th><th>{spec.xLabel || "Column"}</th><th>Value</th></> : <>{spec.type !== "pie" && spec.seriesNames.some(Boolean) && <th>Series</th>}<th>{spec.xLabel || "Label"}</th><th>{spec.yLabel || "Value"}</th></>}</tr></thead><tbody>{tableRows.map((row, index) => spec.type === "waterfall"
      ? <tr key={`${row.label}-${index}`}><td>{row.label}</td><td>{row.type === "total" ? "Total" : row.value >= 0 ? "Increase" : "Decrease"}</td><td>{String(row.value)}</td><td>{String(row.runningTotal)}</td></tr>
      : spec.type === "funnel" ? <tr key={`${row.label}-${index}`}><td>{row.label}</td><td>{String(row.value)}</td><td>{row.conversion === null ? "—" : `${row.conversion.toFixed(1)}%`}</td><td>{`${row.overall.toFixed(1)}%`}</td></tr>
      : spec.type === "percent-stacked-bar" ? <tr key={`${row.series}-${row.x}-${index}`}><td>{row.series}</td><td>{row.x}</td><td>{String(row.y)}</td><td>{`${row.share.toFixed(1)}%`}</td></tr>
      : spec.type === "radar" ? <tr key={`${row.series}-${row.x}-${index}`}><td>{row.x}</td><td>{row.series}</td><td>{String(row.y)}</td></tr>
      : spec.type === "treemap" ? <tr key={`${row.group}-${row.label}`} >{spec.seriesNames.some(Boolean) && <td>{row.group}</td>}<td>{row.label}</td><td>{String(row.value)}</td></tr>
      : spec.type === "bubble"
      ? <tr key={`${row.series}-${row.x}-${row.y}-${index}`}>{tableRows.some((item) => item.label) && <td>{row.label}</td>}{spec.seriesNames.some(Boolean) && <td>{row.series}</td>}<td>{String(row.x)}</td><td>{String(row.y)}</td><td>{String(row.size)}</td></tr>
      : spec.type === "boxplot"
      ? <tr key={`${row.label}-${index}`}><td>{row.label}</td><td>{String(row.min)}</td><td>{String(row.q1)}</td><td>{String(row.median)}</td><td>{String(row.q3)}</td><td>{String(row.max)}</td></tr>
      : spec.type === "heatmap" ? <tr key={`${row.x}-${row.y}-${index}`}><td>{row.y}</td><td>{row.x}</td><td>{String(row.value)}</td></tr>
        : <tr key={`${row.series}-${row.x}-${index}`}>{spec.type !== "pie" && spec.seriesNames.some(Boolean) && <td>{row.series || "Series 1"}</td>}<td>{row.x}</td><td>{String(row.y)}</td></tr>)}</tbody></table></div></details>
    <figcaption className="visually-hidden">{spec.type} chart. The underlying data is available in the expandable table.</figcaption>
    {source && <span className="visually-hidden">Chart source: {source}</span>}
  </figure>;
}
