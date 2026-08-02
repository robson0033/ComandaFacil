"use strict";

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 64;
const MAX_BCRYPT_BYTES = 72;

const COMMON_PASSWORDS = new Set([
  "123456789012",
  "123456789123",
  "1234567890ab",
  "password1234",
  "senha123456",
  "senha12345678",
  "admin123456",
  "qwerty123456",
  "comandafacil",
  "comandafacil123",
]);

function normalizeForComparison(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase();
}

function validatePassword(value) {
  const password = String(value || "");
  const errors = [];

  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    errors.push(
      `A senha deve ter entre ${MIN_PASSWORD_LENGTH} e ${MAX_PASSWORD_LENGTH} caracteres.`,
    );
  }

  if (Buffer.byteLength(password, "utf8") > MAX_BCRYPT_BYTES) {
    errors.push("A senha é longa demais para ser processada com segurança.");
  }

  const normalized = normalizeForComparison(password);
  if (COMMON_PASSWORDS.has(normalized)) {
    errors.push("Escolha uma senha menos comum e mais difícil de adivinhar.");
  }

  if (/^(.)\1+$/.test(password)) {
    errors.push("A senha não pode repetir apenas o mesmo caractere.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  MAX_BCRYPT_BYTES,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validatePassword,
};
