"use strict";

const { logger: appLogger } = require("../utils/logger");

const {
  definitions,
  equivalentIndex,
} = require("../../scripts/create-mercado-pago-indexes");

class CriticalIndexError extends Error {
  constructor(missing) {
    super(`Índices críticos ausentes ou divergentes: ${missing.join(", ")}`);
    this.name = "CriticalIndexError";
    this.code = "CRITICAL_INDEXES_INVALID";
    this.missing = missing;
  }
}

async function verifyCriticalIndexes({ logger = appLogger } = {}) {
  const grouped = new Map();
  for (const definition of definitions) {
    const collection = definition.model.collection;
    const key = collection.collectionName;
    if (!grouped.has(key)) grouped.set(key, { collection, definitions: [] });
    grouped.get(key).definitions.push(definition);
  }

  const missing = [];
  for (const { collection, definitions: expected } of grouped.values()) {
    let existing;
    try {
      existing = await collection.indexes();
    } catch (error) {
      if (error?.codeName === "NamespaceNotFound" || Number(error?.code) === 26) {
        existing = [];
      } else {
        throw error;
      }
    }
    for (const definition of expected) {
      if (!existing.some(index => equivalentIndex(index, definition))) {
        missing.push(`${collection.collectionName}.${definition.options.name}`);
      }
    }
  }

  if (missing.length) {
    logger.error?.("critical_indexes_invalid", {
      code: "CRITICAL_INDEXES_INVALID",
      missingCount: missing.length,
      missing,
    });
    throw new CriticalIndexError(missing);
  }
  return { ok: true, checked: definitions.length };
}

module.exports = {
  CriticalIndexError,
  verifyCriticalIndexes,
};
