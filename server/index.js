const http = require("http");
const express = require("express");
const { Server, matchMaker } = require("@colyseus/core");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const ArenaRoom = require("./rooms/ArenaRoom");

const port = Number(process.env.PORT) || 2567;

// A bare WebSocketTransport's own http.Server has no request handler at
// all — a plain GET (e.g. a hosting platform's health check) just hangs
// forever with no response. Give it one via express, sharing the same
// port/server the WS upgrade already attaches to.
const app = express();
app.get("/", (req, res) => res.status(200).send("itsen.io arena server: OK"));

// Lobby room list (net.html's #lobbyScreen) — colyseus.js's vendored 0.16.x
// browser build (../vendor/colyseus.js) predates the official SDK's
// getAvailableRooms() helper, so the client fetches this plain JSON endpoint
// directly instead. CORS is wide open (matches the matchmake routes
// @colyseus/core itself registers) since the client and server can live on
// different hosts in a real deploy (see root CLAUDE.md's deploy notes).
app.get("/rooms", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  try {
    const rooms = await matchMaker.query({ name: "arena", locked: false });
    res.json(
      rooms.map((r) => ({
        roomId: r.roomId,
        clients: r.clients,
        maxClients: r.maxClients,
        metadata: r.metadata,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const httpServer = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("arena", ArenaRoom);

gameServer.listen(port).then(() => {
  console.log(`Arena multiplayer server listening on ws://localhost:${port}`);
});
