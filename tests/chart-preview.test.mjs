import assert from "node:assert/strict";
import test from "node:test";
import { parseChartSpec } from "../src/domain/chart-spec.js";

const parse = (spec) => parseChartSpec(JSON.stringify(spec));

test("chart fence validation accepts each supported response type", () => {
  const specs = [
    { type: "bar", data: [{ x: "Jan", y: 4 }] },
    { type: "stacked-bar", series: [
      { name: "A", data: [{ x: "Jan", y: 4 }, { x: "Feb", y: 5 }] },
      { name: "B", data: [{ x: "Jan", y: 3 }, { x: "Feb", y: 2 }] },
    ] },
    { type: "percent-stacked-bar", series: [
      { name: "A", data: [{ x: "Jan", y: 4 }, { x: "Feb", y: 5 }] },
      { name: "B", data: [{ x: "Jan", y: 3 }, { x: "Feb", y: 2 }] },
    ] },
    { type: "horizontal-bar", data: [{ x: "North", y: -4 }] },
    { type: "line", series: [{ name: "Revenue", data: [{ x: "Jan", y: 4 }] }] },
    { type: "area", data: [{ x: "Jan", y: 4 }] },
    { type: "scatter", data: [{ x: 1, y: 4 }] },
    { type: "bubble", data: [{ x: 1, y: 4, size: 10 }] },
    { type: "waterfall", data: [{ label: "Start", value: 10 }, { label: "Change", value: -2 }] },
    { type: "treemap", data: [{ label: "Compute", value: 10 }, { label: "Storage", value: 5 }] },
    { type: "radar", series: [
      { name: "A", data: [{ x: "Cost", y: 3 }, { x: "Speed", y: 4 }, { x: "Ease", y: 5 }] },
      { name: "B", data: [{ x: "Cost", y: 4 }, { x: "Speed", y: 3 }, { x: "Ease", y: 4 }] },
    ] },
    { type: "funnel", data: [{ label: "Visit", value: 100 }, { label: "Buy", value: 20 }] },
    { type: "histogram", data: [{ x: "0–10", y: 2 }, { x: "10–20", y: 3 }] },
    { type: "boxplot", data: [{ label: "A", min: 1, q1: 2, median: 3, q3: 4, max: 5 }] },
    { type: "pie", data: [{ label: "A", value: 3 }, { label: "B", value: 2 }] },
    { type: "heatmap", data: [{ x: "Mon", y: "9am", value: 2 }, { x: "Tue", y: "9am", value: 4 }] },
  ];

  for (const spec of specs) {
    assert.ok(parse({ title: "Example", ...spec }), `${spec.type} should parse`);
  }
  assert.equal(specs.length, 16);
});

test("chart fence validation rejects malformed, unsafe-sized and inconsistent data", () => {
  assert.equal(parse({ type: "unknown", title: "Example", data: [] }), null);
  assert.equal(parse({ type: "bar", title: "", data: [{ x: "Jan", y: 2 }] }), null);
  assert.equal(parse({ type: "bar", title: "Example", data: Array(241).fill({ x: "A", y: 1 }) }), null);
  assert.equal(parse({ type: "stacked-bar", title: "Example", series: [
    { name: "A", data: [{ x: "Jan", y: 2 }, { x: "Feb", y: 3 }] },
    { name: "B", data: [{ x: "Jan", y: 4 }] },
  ] }), null);
  assert.equal(parse({ type: "percent-stacked-bar", title: "Example", series: [
    { name: "A", data: [{ x: "Jan", y: 0 }, { x: "Feb", y: 0 }] },
    { name: "B", data: [{ x: "Jan", y: 0 }, { x: "Feb", y: 0 }] },
  ] }), null);
  assert.equal(parse({ type: "bubble", title: "Example", data: [{ x: 1, y: 2, size: -1 }] }), null);
  assert.equal(parse({ type: "heatmap", title: "Example", data: [
    { x: "Mon", y: "9am", value: 2 }, { x: "Mon", y: "9am", value: 3 },
  ] }), null);
  assert.equal(parse({ type: "funnel", title: "Example", data: [
    { label: "Visit", value: 100 }, { label: "Buy", value: 120 },
  ] }), null);
});

test("chart labels stay bounded and values remain data rather than executable markup", () => {
  const spec = parse({
    type: "bar", title: "Safe chart",
    data: [{ x: "<img src=x onerror=alert(1)>", y: 2 }],
  });
  assert.equal(spec.rows[0].x, "<img src=x onerror=alert(1)>");

  const bounded = parse({ type: "pie", title: "Safe chart", data: [
    { label: "x".repeat(200), value: 1 },
  ] });
  assert.equal(bounded.data[0].label.length, 120);
});
