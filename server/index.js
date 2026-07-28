const http = require("http");
const express = require("express");
const { Server } = require("@colyseus/core");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const ArenaRoom = require("./rooms/ArenaRoom");

const port = Number(process.env.PORT) || 2567;

// A bare WebSocketTransport's own http.Server has no request handler at
// all — a plain GET (e.g. a hosting platform's health check) just hangs
// forever with no response. Give it one via express, sharing the same
// port/server the WS upgrade already attaches to.
const app = express();
app.get("/", (req, res) => res.status(200).send("itsen.io arena server: OK"));
const httpServer = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("arena", ArenaRoom);

gameServer.listen(port).then(() => {
  console.log(`Arena multiplayer server listening on ws://localhost:${port}`);
});
