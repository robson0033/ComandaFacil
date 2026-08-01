"use strict";

const DEFAULT_TIMEZONE = "America/Sao_Paulo";

function isValidTimezone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: String(value) }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function getEstablishmentTimezone(establishment = {}) {
  const configured = String(establishment?.timezone || "").trim();
  return isValidTimezone(configured) ? configured : DEFAULT_TIMEZONE;
}

function datePartsInTimezone(date, timeZone = DEFAULT_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: isValidTimezone(timeZone) ? timeZone : DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(date));
  const number = type => Number(parts.find(part => part.type === type)?.value);
  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour"),
    minute: number("minute"),
    second: number("second"),
  };
}

function localDateTimeToUtc(parts, timeZone = DEFAULT_TIMEZONE) {
  const zone = isValidTimezone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  const target = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour || 0, parts.minute || 0, parts.second || 0, parts.millisecond || 0,
  );
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const displayed = datePartsInTimezone(new Date(candidate), zone);
    const displayedAsUtc = Date.UTC(
      displayed.year, displayed.month - 1, displayed.day,
      displayed.hour, displayed.minute, displayed.second, parts.millisecond || 0,
    );
    candidate += target - displayedAsUtc;
  }
  return new Date(candidate);
}

function localDateRangeToUtc({ startDate, endDate, timezone = DEFAULT_TIMEZONE }) {
  const parse = value => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) throw new Error("Data local inválida.");
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  };
  const start = parse(startDate);
  const end = parse(endDate);
  const startUtc = localDateTimeToUtc(start, timezone);
  const endUtc = localDateTimeToUtc({
    ...end, hour: 23, minute: 59, second: 59, millisecond: 999,
  }, timezone);
  if (startUtc > endUtc) throw new Error("Período local inválido.");
  return { startUtc, endUtc };
}

function formatDateTimeInTimezone(date, timeZone = DEFAULT_TIMEZONE) {
  if (!date || Number.isNaN(new Date(date).getTime())) return "-";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: isValidTimezone(timeZone) ? timeZone : DEFAULT_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(date));
}

module.exports = {
  DEFAULT_TIMEZONE,
  datePartsInTimezone,
  formatDateTimeInTimezone,
  getEstablishmentTimezone,
  isValidTimezone,
  localDateRangeToUtc,
  localDateTimeToUtc,
};
