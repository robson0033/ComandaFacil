"use strict";

function safeJsonForHtml(value) {
  const json = JSON.stringify(value);
  if (json === undefined) return "null";
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function hasControlCharacters(value) {
  return /[\u0000-\u001F\u007F]/.test(value);
}

function safePublicUrl(value, {
  allowDataImage = false,
  allowHash = false,
} = {}) {
  const text = String(value ?? "").trim();
  if (!text || hasControlCharacters(text)) return "";
  if (allowHash && text === "#") return "#";
  if (text.startsWith("/") && !text.startsWith("//")) return text;
  if (allowDataImage
      && /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i
        .test(text)) return text;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

module.exports = {
  safeJsonForHtml,
  safePublicUrl,
};
