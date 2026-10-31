const WEEKDAYS = [
  { value: "0", short: "Sun", name: "Sunday" },
  { value: "1", short: "Mon", name: "Monday" },
  { value: "2", short: "Tue", name: "Tuesday" },
  { value: "3", short: "Wed", name: "Wednesday" },
  { value: "4", short: "Thu", name: "Thursday" },
  { value: "5", short: "Fri", name: "Friday" },
  { value: "6", short: "Sat", name: "Saturday" },
];

const WEEKDAY_VALUES = Object.fromEntries(WEEKDAYS.flatMap(({ value, short, name }) => [
  [value, value], [short.toUpperCase(), value], [name.slice(0, 3).toUpperCase(), value],
]));

function parseWeekdayField(field) {
  const values = new Set();
  for (const part of field.split(",")) {
    const match = /^([A-Z]+|\d+)(?:-([A-Z]+|\d+))?$/i.exec(part);
    if (!match) return null;
    const start = Number.isNaN(Number(match[1])) ? WEEKDAY_VALUES[match[1].slice(0, 3).toUpperCase()] : Number(match[1]);
    const end = match[2]
      ? (Number.isNaN(Number(match[2])) ? WEEKDAY_VALUES[match[2].slice(0, 3).toUpperCase()] : Number(match[2]))
      : start;
    if (start == null || end == null || start < 0 || start > 7 || end < 0 || end > 7 || start > end) return null;
    for (let day = start; day <= end; day += 1) values.add(String(day === 7 ? 0 : day));
  }
  return values.size ? [...values].sort((left, right) => Number(left) - Number(right)) : null;
}

export function cronFields(value) {
  const fields = typeof value === "string" ? value.trim().split(/\s+/) : [];
  return fields.length === 5 ? fields : null;
}

export function selectedDaysFromCron(value) {
  const fields = cronFields(value);
  if (!fields || fields[2] !== "*" || fields[3] !== "*" || fields[4] === "*"
    || !/^\d{1,2}$/.test(fields[0]) || !/^\d{1,2}$/.test(fields[1])) return null;
  return parseWeekdayField(fields[4]);
}

export function hourWindowFromCron(value) {
  const fields = cronFields(value);
  if (!fields || fields[0] !== "0" || fields[2] !== "*" || fields[3] !== "*" || fields[4] !== "*") return null;
  const hours = fields[1].split(",");
  const regular = /^(\d{1,2})-(\d{1,2})$/.exec(fields[1]);
  if (regular) {
    const start = Number(regular[1]);
    const end = Number(regular[2]);
    return start <= end && end <= 23 ? [start, end] : null;
  }
  if (hours.length === 2) {
    const first = /^(\d{1,2})-23$/.exec(hours[0]);
    const second = /^0-(\d{1,2})$/.exec(hours[1]);
    if (first && second) {
      const start = Number(first[1]);
      const end = Number(second[1]);
      if (start > end && start <= 23 && end <= 23) return [start, end];
    }
  }
  if (/^\d{1,2}$/.test(fields[1])) {
    const hour = Number(fields[1]);
    if (hour <= 23) return [hour, hour];
  }
  return null;
}

export function monthlyDayFromCron(value) {
  const fields = cronFields(value);
  if (!fields || fields[2] === "*" || fields[3] !== "*" || fields[4] !== "*"
    || !/^\d{1,2}$/.test(fields[0]) || !/^\d{1,2}$/.test(fields[1])) return null;
  if (!/^\d{1,2}$/.test(fields[2])) return null;
  const day = Number(fields[2]);
  return day >= 1 && day <= 31 ? day : null;
}

export function scheduleCronExpression({ cadence, deliveryTime, weeklyDays, monthlyDay, hourlyStartHour, hourlyEndHour, cronParts }) {
  if (cadence === "cron") return cronParts.join(" ").trim();
  if (cadence === "weekly") {
    const [hour, minute] = deliveryTime.split(":");
    return `${Number(minute)} ${Number(hour)} * * ${[...weeklyDays].sort((a, b) => Number(a) - Number(b)).join(",")}`;
  }
  if (cadence === "monthly") {
    const [hour, minute] = deliveryTime.split(":");
    return `${Number(minute)} ${Number(hour)} ${monthlyDay} * *`;
  }
  if (cadence === "hourly") {
    const start = Number(hourlyStartHour);
    const end = Number(hourlyEndHour);
    const hours = start <= end ? `${start}-${end}` : `${start}-23,0-${end}`;
    return `0 ${hours} * * *`;
  }
  return "";
}

export { WEEKDAYS };
