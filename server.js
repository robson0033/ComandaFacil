require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const { MongoStore } = require("connect-mongo");
const flash = require("express-flash");
const path = require("path");
const session = require("express-session");
const middleware = require("./src/middleware/middlewareGlobal");
const route = require("./route");
const http = require("http");
const { Server } = require("socket.io");
const printAgentHub = require("./src/services/printAgentHub");
const printQueueService = require("./src/services/printQueueService");
const { ensureCsrfToken } = require("./src/middleware/csrf");
const app = express();
const httpServer = http.createServer(app);
const production = process.env.NODE_ENV === "production";

function validateProductionConfiguration() {
  if (!production) return;
  const validatedUrls = {};
  for (const name of ["APP_URL", "MP_REDIRECT_URI"]) {
    let url;
    try {
      url = new URL(process.env[name]);
    } catch {
      throw new Error(`${name} deve ser uma URL HTTPS válida em produção.`);
    }
    if (url.protocol !== "https:") {
      throw new Error(`${name} deve usar HTTPS em produção.`);
    }
    validatedUrls[name] = url;
  }
  if (validatedUrls.APP_URL.origin !== validatedUrls.MP_REDIRECT_URI.origin
    || validatedUrls.MP_REDIRECT_URI.pathname !== "/admin/mercado-pago/callback") {
    throw new Error("MP_REDIRECT_URI deve apontar para o callback OAuth do APP_URL.");
  }
  for (const name of [
    "MERCADO_PAGO_WEBHOOK_SECRET",
    "MERCADO_PAGO_PLATFORM_USER_ID",
    "TOKEN_ENCRYPTION_KEY",
  ]) {
    if (!process.env[name]) throw new Error(`${name} é obrigatória em produção.`);
  }
}

validateProductionConfiguration();
if (production) app.set("trust proxy", 1);
const io = new Server(httpServer, { cors: { origin: true, methods: ["GET", "POST"] } });
printAgentHub.init(io);

mongoose
  .connect(process.env.CONNECTIONSTRING)
  .then(() => app.emit("pronto"))
  .catch((e) => console.error("Erro MongoDB:", e.message));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set("views", path.resolve(__dirname, "src", "views"));
app.set("view engine", "ejs");
app.use(express.static(path.resolve(__dirname, "public")));
app.use(
  session({
    resave: false,
    saveUninitialized: false,
    secret: process.env.SECRETSESSION,
    store: MongoStore.create({
      mongoUrl: process.env.CONNECTIONSTRING,
      collectionName: "sessions",
    }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7,
      httpOnly: true,
      sameSite: "lax",
      secure: production,
    },
  }),
);
app.use(flash());
app.use(ensureCsrfToken);
app.use(middleware.middlewareGlobal);
app.use(route);
app.use((req, res) => res.status(404).render("404"));
app.on("pronto", () => {
  void printQueueService.reconciliarPedidosSemJob().catch(error =>
    console.error("Erro ao reconciliar fila de impressão:", error));
  const reconcileTimer = setInterval(() => {
    void printQueueService.reconciliarPedidosSemJob().catch(error =>
      console.error("Erro ao reconciliar fila de impressão:", error));
  }, 5 * 60 * 1000);
  reconcileTimer.unref?.();
  httpServer.listen(process.env.PORT || 3000, () =>
    console.log(`http://localhost:${process.env.PORT || 3000}`),
  );
});
