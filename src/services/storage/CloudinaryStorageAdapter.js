"use strict";

const DEFAULT_TIMEOUT_MS = 10_000;
const KEY_PATTERN = /^estabelecimentos\/([a-f\d]{24})\/(produtos|funcionarios|perfil)\/([0-9a-f-]{36})\.webp$/i;

class StorageError extends Error {
  constructor(code, message, { statusCode = 503, storageKey = "" } = {}) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.statusCode = statusCode;
    if (storageKey) this.storageKey = storageKey;
  }
}

function validateStorageKey(storageKey, { estabelecimentoId } = {}) {
  const key = String(storageKey || "");
  if (
    !key
    || key.includes("\0")
    || key.includes("\\")
    || key.includes("..")
    || key.startsWith("/")
    || /^[a-z][a-z\d+.-]*:/i.test(key)
  ) {
    throw new StorageError(
      "STORAGE_TENANT_INVALIDO",
      "Chave de armazenamento inválida.",
      { statusCode: 403 },
    );
  }
  const match = KEY_PATTERN.exec(key);
  if (!match) {
    throw new StorageError(
      "STORAGE_TENANT_INVALIDO",
      "Chave de armazenamento inválida.",
      { statusCode: 403 },
    );
  }
  if (
    estabelecimentoId
    && match[1].toLowerCase() !== String(estabelecimentoId).toLowerCase()
  ) {
    throw new StorageError(
      "STORAGE_TENANT_INVALIDO",
      "A imagem não pertence ao estabelecimento.",
      { statusCode: 403 },
    );
  }
  return {
    storageKey: key,
    estabelecimentoId: match[1].toLowerCase(),
    resource: match[2].toLowerCase(),
    publicId: key.slice(0, -".webp".length),
  };
}

function validateCredentials(credentials = {}) {
  const missing = [];
  for (const [name, value] of [
    ["CLOUDINARY_CLOUD_NAME", credentials.cloudName],
    ["CLOUDINARY_API_KEY", credentials.apiKey],
    ["CLOUDINARY_API_SECRET", credentials.apiSecret],
  ]) {
    if (!String(value || "").trim()) missing.push(name);
  }
  if (missing.length) {
    throw new StorageError(
      "STORAGE_CONFIG_INVALIDA",
      `Configuração de storage inválida: ${missing.join(", ")}`,
      { statusCode: 500 },
    );
  }
}

class CloudinaryStorageAdapter {
  constructor({
    cloudinary,
    cloudName,
    apiKey,
    apiSecret,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    validateCredentials({ cloudName, apiKey, apiSecret });
    if (!cloudinary?.uploader || !cloudinary?.api || typeof cloudinary.url !== "function") {
      throw new StorageError(
        "STORAGE_CONFIG_INVALIDA",
        "SDK de storage inválido.",
        { statusCode: 500 },
      );
    }
    this.cloudinary = cloudinary;
    this.timeoutMs = timeoutMs;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true,
    });
  }

  async save(storageKey, buffer, metadata = {}) {
    const parsed = validateStorageKey(storageKey, metadata);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new StorageError(
        "STORAGE_UPLOAD_FALHOU",
        "Não foi possível armazenar a imagem.",
        { storageKey },
      );
    }
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.clearTimeoutFn(timer);
        callback(value);
      };
      const timer = this.setTimeoutFn(() => {
        finish(reject, new StorageError(
          "STORAGE_RESULTADO_DESCONHECIDO",
          "O resultado do upload não pôde ser confirmado.",
          { storageKey },
        ));
      }, this.timeoutMs);
      timer.unref?.();

      let stream;
      try {
        stream = this.cloudinary.uploader.upload_stream({
          public_id: parsed.publicId,
          resource_type: "image",
          format: "webp",
          overwrite: false,
          unique_filename: false,
          invalidate: true,
        }, (error, response) => {
          if (error) {
            finish(reject, new StorageError(
              "STORAGE_UPLOAD_FALHOU",
              "Não foi possível armazenar a imagem.",
              { storageKey },
            ));
            return;
          }
          finish(resolve, response);
        });
        stream.end(buffer);
      } catch {
        finish(reject, new StorageError(
          "STORAGE_UPLOAD_FALHOU",
          "Não foi possível armazenar a imagem.",
          { storageKey },
        ));
      }
    });
    return this.normalizeUploadResult(parsed, result);
  }

  normalizeUploadResult(parsed, result = {}) {
    const valid = result.public_id === parsed.publicId
      && result.resource_type === "image"
      && result.format === "webp"
      && /^https:\/\//i.test(String(result.secure_url || ""))
      && Number.isFinite(Number(result.width))
      && Number(result.width) > 0
      && Number.isFinite(Number(result.height))
      && Number(result.height) > 0
      && Number.isFinite(Number(result.bytes))
      && Number(result.bytes) > 0;
    if (!valid) {
      throw new StorageError(
        "STORAGE_RESPOSTA_INVALIDA",
        "O provedor retornou uma resposta inválida.",
        { storageKey: parsed.storageKey },
      );
    }
    return {
      storageKey: parsed.storageKey,
      url: result.secure_url,
      mimeType: "image/webp",
      largura: Number(result.width),
      altura: Number(result.height),
      tamanho: Number(result.bytes),
      provider: "cloudinary",
    };
  }

  async remove(storageKey, context = {}) {
    const parsed = validateStorageKey(storageKey, context);
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.callWithTimeout(
          callback => this.cloudinary.uploader.destroy(parsed.publicId, {
            resource_type: "image",
            invalidate: true,
          }, callback),
          "STORAGE_TIMEOUT",
          storageKey,
        );
        if (["ok", "not found"].includes(result?.result)) {
          return { removed: result.result === "ok" };
        }
        throw new StorageError(
          "STORAGE_REMOCAO_FALHOU",
          "Não foi possível remover a imagem.",
          { storageKey },
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof StorageError
      ? lastError
      : new StorageError(
        "STORAGE_REMOCAO_FALHOU",
        "Não foi possível remover a imagem.",
        { storageKey },
      );
  }

  async exists(storageKey, context = {}) {
    const parsed = validateStorageKey(storageKey, context);
    try {
      await this.callWithTimeout(
        callback => this.cloudinary.api.resource(parsed.publicId, {
          resource_type: "image",
        }, callback),
        "STORAGE_TIMEOUT",
        storageKey,
      );
      return true;
    } catch (error) {
      if (Number(error?.http_code) === 404 || Number(error?.statusCode) === 404) {
        return false;
      }
      throw error instanceof StorageError
        ? error
        : new StorageError(
          "STORAGE_REMOCAO_FALHOU",
          "Não foi possível consultar a imagem.",
          { storageKey },
        );
    }
  }

  publicUrl(storageKey) {
    const parsed = validateStorageKey(storageKey);
    const url = this.cloudinary.url(parsed.publicId, {
      secure: true,
      format: "webp",
    });
    if (!/^https:\/\//i.test(String(url || ""))) {
      throw new StorageError(
        "STORAGE_RESPOSTA_INVALIDA",
        "O provedor retornou uma URL inválida.",
        { storageKey },
      );
    }
    return url;
  }

  async listKeys() {
    const keys = [];
    let nextCursor;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.callWithTimeout(
        callback => this.cloudinary.api.resources({
          resource_type: "image",
          type: "upload",
          prefix: "estabelecimentos/",
          max_results: 500,
          ...(nextCursor ? { next_cursor: nextCursor } : {}),
        }, callback),
        "STORAGE_TIMEOUT",
        "auditoria",
      );
      if (!Array.isArray(result?.resources)) {
        throw new StorageError(
          "STORAGE_RESPOSTA_INVALIDA",
          "O provedor retornou uma resposta inválida.",
        );
      }
      for (const resource of result.resources) {
        const key = `${String(resource?.public_id || "")}.webp`;
        try {
          keys.push(validateStorageKey(key).storageKey);
        } catch {
          // Recursos fora do namespace da aplicação não pertencem à auditoria.
        }
      }
      nextCursor = String(result.next_cursor || "");
      if (!nextCursor) return keys;
    }
    throw new StorageError(
      "STORAGE_RESPOSTA_INVALIDA",
      "A paginação do provedor excedeu o limite seguro.",
    );
  }

  callWithTimeout(operation, code, storageKey) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.clearTimeoutFn(timer);
        callback(value);
      };
      const timer = this.setTimeoutFn(() => finish(
        reject,
        new StorageError(code, "O provedor de imagens não respondeu a tempo.", {
          storageKey,
        }),
      ), this.timeoutMs);
      timer.unref?.();
      try {
        operation((error, result) => {
          if (error) return finish(reject, error);
          return finish(resolve, result);
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  salvarImagem(buffer, contexto) {
    return this.save(contexto.storageKey, buffer, contexto);
  }

  removerImagem(storageKey, contexto) {
    return this.remove(storageKey, contexto);
  }

  obterUrlPublica(storageKey) {
    return this.publicUrl(storageKey);
  }

  existe(storageKey, contexto) {
    return this.exists(storageKey, contexto);
  }
}

module.exports = {
  CloudinaryStorageAdapter,
  DEFAULT_TIMEOUT_MS,
  StorageError,
  validateCredentials,
  validateStorageKey,
};
