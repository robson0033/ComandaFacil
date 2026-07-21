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
const app = express();
const httpServer = http.createServer(app);
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
    },
  }),
);
app.use(flash());
app.use(middleware.middlewareGlobal);
app.use(route);
app.use((req, res) => res.status(404).render("404"));
app.on("pronto", () =>
  httpServer.listen(process.env.PORT || 3000, () =>
    console.log(`http://localhost:${process.env.PORT || 3000}`),
  ),
);
