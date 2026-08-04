"use strict";

const PERSONAL_DATA_KEY = /^(?:email|emailcliente|payeremail|recipientemail|recipient|destinatario|telefone|telefonecliente|telefonenormalizado|phone|celular|whatsapp|cpf|cnpj|cpfcnpj|documento|endereco|enderecoentrega|address|rua|ruaentrega|numeroentrega|bairro|bairroentrega|referencia|referenciaentrega|cliente|nomecliente|nomefuncionario|ip|ipaceite|useragent)$/i;

function isPersonalDataKey(value) {
  return PERSONAL_DATA_KEY.test(String(value || "").replace(/[_-]/g, ""));
}

function maskEmail(value) {
  const text = String(value || "").trim();
  const at = text.indexOf("@");
  if (at <= 0) return "[DADO_PESSOAL_REMOVIDO]";
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  if (!domain) return "[DADO_PESSOAL_REMOVIDO]";
  return `${local.slice(0, 1)}***@${domain}`;
}

function maskDocument(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11) return `***.***.***-${digits.slice(-2)}`;
  if (digits.length === 14) return `**.***.***/****-${digits.slice(-2)}`;
  return "[DADO_PESSOAL_REMOVIDO]";
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 4) return "[DADO_PESSOAL_REMOVIDO]";
  return `***${digits.slice(-4)}`;
}

function redactPersonalString(value, maxLength = 4_000) {
  return String(value ?? "")
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      email => maskEmail(email),
    )
    .replace(
      /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
      document => maskDocument(document),
    )
    .replace(
      /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g,
      document => maskDocument(document),
    )
    .replace(
      /((?:telefone|phone|celular|whatsapp)\s*[=:]\s*["']?)([^,"';}\n]+)/gi,
      "$1[DADO_PESSOAL_REMOVIDO]",
    )
    .replace(
      /((?:endereco|endere[cç]o|address|rua|bairro|referencia|refer[eê]ncia)\s*[=:]\s*["']?)([^,"';}\n]+)/gi,
      "$1[DADO_PESSOAL_REMOVIDO]",
    )
    .slice(0, maxLength);
}

module.exports = {
  isPersonalDataKey,
  maskDocument,
  maskEmail,
  maskPhone,
  redactPersonalString,
};
