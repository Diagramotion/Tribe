const TYPES = new Set(["bar", "stacked-bar", "percent-stacked-bar", "horizontal-bar", "line", "area", "scatter", "bubble", "waterfall", "treemap", "radar", "funnel", "histogram", "boxplot", "pie", "heatmap"]);

function chartNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15;
}

function chartLabel(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).slice(0, 120) : "";
}

export function heatmapCoordinateKey(x, y) {
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

