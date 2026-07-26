"use strict";

const fs = require("fs/promises");
const path = require("path");

function safeKey(key) {
  const normalized = String(key || "").replaceAll("\\", "/");
  if (
    !normalized
    || normalized.includes("\0")
    || normalized.startsWith("/")
    || normalized.split("/").includes("..")
  ) {
    throw new Error("Storage key inválida.");
  }
  return normalized;
}

class LocalStorageAdapter {
  constructor({ root = path.resolve(__dirname, "../../../public/uploads") } = {}) {
    this.root = root;
  }

  resolve(key) {
    const normalized = safeKey(key);
    const target = path.resolve(this.root, normalized);
    if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Storage key fora do diretório permitido.");
    }
    return target;
  }

  async save(key, buffer) {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer, { flag: "wx", mode: 0o640 });
  }

  async remove(key) {
    try {
      await fs.unlink(this.resolve(key));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async exists(key) {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  publicUrl(key) {
    return `/uploads/${safeKey(key).split("/").map(encodeURIComponent).join("/")}`;
  }

  async listKeys() {
    const keys = [];
    const visit = async (directory, prefix = "") => {
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
        else if (entry.isFile()) keys.push(relative);
      }
    };
    await visit(this.root);
    return keys;
  }
}

module.exports = { LocalStorageAdapter, safeKey };
