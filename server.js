import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const app = express();
app.use(cors({ origin: "*" }));

app.get("/", (req, res) => {
  res.send("Realtime server running ✅");
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// roomId -> Map(socketId -> player)
const rooms = new Map();

io.on("connection", (socket) => {
  socket.on("joinRoom", ({ roomId, playerId, name }) => {
    socket.join(roomId);
    if (!rooms.has(roomId)) rooms.set(roomId, new Map());

    rooms.get(roomId).set(socket.id, {
      playerId,
      name,
      x: 0,
      z: 0,
      vx: 0,
      vz: 0
    });

    socket.emit("joined", { roomId });
  });

  socket.on("input", ({ roomId, vx, vz }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.get(socket.id);
    if (!p) return;
    p.vx = vx;
    p.vz = vz;
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.delete(socket.id) && room.size === 0) rooms.delete(roomId);
    }
  });
});

// 15 ticks per second (EverQuest-like pacing)
setInterval(() => {
  for (const [roomId, room] of rooms.entries()) {
    const players = [];
    for (const p of room.values()) {
      p.x += p.vx * 0.12;
      p.z += p.vz * 0.12;
      players.push({
        playerId: p.playerId,
        name: p.name,
        x: p.x,
        z: p.z
      });
    }
    io.to(roomId).emit("snapshot", {
      t: Date.now(),
      players
    });
  }
}, 1000 / 15);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
