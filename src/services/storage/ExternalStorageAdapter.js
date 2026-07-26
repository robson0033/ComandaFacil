"use strict";

const { safeKey } = require("./LocalStorageAdapter");

class ExternalStorageAdapter {
  constructor({ baseUrl, provider, client } = {}) {
    if (!baseUrl || !/^https:\/\//i.test(baseUrl)) {
      throw new Error("STORAGE_EXTERNAL_BASE_URL HTTPS é obrigatória.");
    }
    if (!["s3", "cloudinary"].includes(provider)) {
      throw new Error("Provider externo inválido.");
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.provider = provider;
    this.client = client;
  }

  requireClient() {
    if (!this.client) {
      throw new Error(
        "O cliente do storage externo não foi configurado para esta implantação.",
      );
    }
    return this.client;
  }

  save(key, buffer, metadata) {
    return this.requireClient().save(safeKey(key), buffer, metadata);
  }

  remove(key) {
    return this.requireClient().remove(safeKey(key));
  }

  exists(key) {
    return this.requireClient().exists(safeKey(key));
  }

  publicUrl(key) {
    return `${this.baseUrl}/${safeKey(key).split("/").map(encodeURIComponent).join("/")}`;
  }
}

module.exports = { ExternalStorageAdapter };
