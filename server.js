import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const app = express();
app.use(cors({ origin: "*" }));
app.get("/", (req, res) => res.send("Realtime server running ✅"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

/**
 * Future-proof model:
 * - Client -> server:
 *   - joinRoom { roomId, playerId, name }
 *   - input { roomId, vx, vz, rotY }
 *   - action { roomId, actorId, type, payload }
 *
 * - Server -> client:
 *   - snapshot { t, players, enemies, projectiles, env }
 *   - event { t, roomId, type, payload }
 *
 * IMPORTANT PRINCIPLES:
 * - Smooth things (moving) belong in snapshot every tick: players/enemies/projectiles.
 * - Discrete moments belong in event stream: cast_start, cast_finish, hit, damage, death, interact.
 */

const rooms = new Map();
// roomId -> {
//   players: Map<socketId, PlayerState>
//   enemies: Map<enemyId, EnemyState>
//   projectiles: Map<projId, ProjectileState>
//   env: { timeOfDay, weather, flags... } (slow-changing / optional)
// }

const CONFIG = {
  tickHz: 15,
  dtClampSeconds: 0.25,
  playerSpeed: 4.0,
  enemySpeed: 2.2,
  enemyChaseRange: 12,
  enemyCount: 6,
  projectileSpeed: 10.0,
  maxProjectilesPerRoom: 200,
  defaultFireball: { castTimeMs: 650, damage: 12, lifetimeMs: 2500 }
};

function nowMs() {
  return Date.now();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function len(x, z) {
  return Math.sqrt(x * x + z * z);
}

function norm2(x, z) {
  const m = len(x, z);
  if (m < 1e-6) return { x: 0, z: 0 };
  return { x: x / m, z: z / m };
}

function emitEvent(roomId, type, payload) {
  io.to(roomId).emit("event", { t: nowMs(), roomId, type, payload });
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    const enemies = new Map();
    for (let i = 0; i < CONFIG.enemyCount; i++) {
      const enemyId = `e${i + 1}`;
      enemies.set(enemyId, {
        enemyId,
        x: (Math.random() * 20) - 10,
        z: (Math.random() * 20) - 10,
        vx: 0,
        vz: 0,
        rotY: 0,
        state: "wander",
        nextWanderAt: 0,
        hp: 50,
        maxHp: 50
      });
    }

    rooms.set(roomId, {
      players: new Map(),
      enemies,
      projectiles: new Map(),
      env: { timeOfDay: 12.0, weather: "clear" }
    });
  }
  return rooms.get(roomId);
}

function findPlayerByPlayerId(room, playerId) {
  for (const p of room.players.values()) {
    if (p.playerId === playerId) return p;
  }
  return null;
}

function findEnemy(room, enemyId) {
  return room.enemies.get(enemyId) || null;
}

function pickNearestPlayer(room, x, z) {
  let best = null;
  let bestD2 = Infinity;
  for (const p of room.players.values()) {
    const dx = p.x - x;
    const dz = p.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = p;
    }
  }
  return best;
}

function spawnProjectile(room, proj) {
  // simple cap to prevent runaway memory
  if (room.projectiles.size > CONFIG.maxProjectilesPerRoom) {
    // delete an arbitrary old one
    const firstKey = room.projectiles.keys().next().value;
    if (firstKey) room.projectiles.delete(firstKey);
  }
  room.projectiles.set(proj.projId, proj);
}

io.on("connection", (socket) => {
  socket.on("joinRoom", ({ roomId, playerId, name }) => {
    if (!roomId) return;

    socket.join(roomId);
    const room = getRoom(roomId);

    room.players.set(socket.id, {
      socketId: socket.id,
      playerId: playerId || socket.id,
      name: name || "Player",
      x: 0,
      z: 0,
      vx: 0,
      vz: 0,
      rotY: 0,
      hp: 100,
      maxHp: 100,
      mana: 50,
      maxMana: 50,
      casts: [] // queued cast timers
    });

    socket.emit("joined", { roomId });
    emitEvent(roomId, "player_joined", { playerId: playerId || socket.id, name: name || "Player" });
  });

  socket.on("input", ({ roomId, vx, vz, rotY }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;

    if (typeof vx === "number") p.vx = vx;
    if (typeof vz === "number") p.vz = vz;
    if (typeof rotY === "number") p.rotY = rotY;
  });

  // Generic future-proof action channel
  // Example actions:
  // - {type:"cast", payload:{ spellId:"fireball", targetEnemyId:"e2" }}
  // - {type:"attack", payload:{ targetEnemyId:"e1" }}
  // - {type:"interact", payload:{ objectId:"door_1" }}
  socket.on("action", ({ roomId, actorId, type, payload }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const actor = findPlayerByPlayerId(room, actorId) || room.players.get(socket.id);
    if (!actor) return;

    if (type === "cast") {
      const spellId = payload?.spellId || "fireball";
      const targetEnemyId = payload?.targetEnemyId || null;

      // basic cast start event
      const castTimeMs = CONFIG.defaultFireball.castTimeMs;
      actor.casts.push({
        spellId,
        targetEnemyId,
        startAt: nowMs(),
        finishAt: nowMs() + castTimeMs
      });

      emitEvent(roomId, "cast_start", {
        actorId: actor.playerId,
        spellId,
        targetEnemyId,
        castTimeMs
      });
      return;
    }

    if (type === "attack") {
      const targetEnemyId = payload?.targetEnemyId;
      const e = targetEnemyId ? findEnemy(room, targetEnemyId) : null;
      if (!e) return;

      const dmg = 6;
      e.hp = Math.max(0, e.hp - dmg);
      emitEvent(roomId, "damage", { sourceId: actor.playerId, targetType: "enemy", targetId: e.enemyId, amount: dmg, hp: e.hp, maxHp: e.maxHp });
      if (e.hp <= 0) emitEvent(roomId, "enemy_death", { enemyId: e.enemyId });
      return;
    }

    // Unknown action types are ignored safely
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      const p = room.players.get(socket.id);
      if (p) {
        room.players.delete(socket.id);
        emitEvent(roomId, "player_left", { playerId: p.playerId, name: p.name });

        if (room.players.size === 0) {
          rooms.delete(roomId);
        }
        break;
      }
    }
  });
});

// Main tick loop
const TICK_MS = Math.round(1000 / CONFIG.tickHz);
let lastTick = nowMs();

setInterval(() => {
  const now = nowMs();
  const dt = clamp((now - lastTick) / 1000, 0, CONFIG.dtClampSeconds);
  lastTick = now;

  for (const [roomId, room] of rooms.entries()) {
    // 1) Players (authoritative movement)
    for (const p of room.players.values()) {
      let vx = p.vx;
      let vz = p.vz;
      const m = len(vx, vz);
      if (m > 1) { vx /= m; vz /= m; }
      p.x += vx * CONFIG.playerSpeed * dt;
      p.z += vz * CONFIG.playerSpeed * dt;
    }

    // 2) Enemies (authoritative movement)
    for (const e of room.enemies.values()) {
      const target = pickNearestPlayer(room, e.x, e.z);
      if (!target) {
        e.vx = 0; e.vz = 0;
        e.state = "idle";
      } else {
        const dx = target.x - e.x;
        const dz = target.z - e.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < CONFIG.enemyChaseRange) {
          e.state = "chase";
          const n = norm2(dx, dz);
          e.vx = n.x; e.vz = n.z;
        } else {
          e.state = "wander";
          if (!e.nextWanderAt || now >= e.nextWanderAt) {
            const ang = Math.random() * Math.PI * 2;
            e.vx = Math.cos(ang);
            e.vz = Math.sin(ang);
            e.nextWanderAt = now + (800 + Math.random() * 1200);
          }
        }
        e.rotY = Math.atan2(e.vx, e.vz);
      }

      e.x += e.vx * CONFIG.enemySpeed * dt;
      e.z += e.vz * CONFIG.enemySpeed * dt;
    }

    // 3) Cast resolution + projectiles
    for (const p of room.players.values()) {
      if (!p.casts || p.casts.length === 0) continue;

      const remaining = [];
      for (const c of p.casts) {
        if (now < c.finishAt) {
          remaining.push(c);
          continue;
        }

        // Cast completes now
        emitEvent(roomId, "cast_finish", {
          actorId: p.playerId,
          spellId: c.spellId,
          targetEnemyId: c.targetEnemyId
        });

        // Example spell: fireball projectile OR instant if no target
        if (c.spellId === "fireball") {
          const target = c.targetEnemyId ? findEnemy(room, c.targetEnemyId) : null;

          // If we have a target, fire a projectile toward it
          if (target) {
            const dx = target.x - p.x;
            const dz = target.z - p.z;
            const n = norm2(dx, dz);

            const projId = `p_${p.playerId}_${now}_${Math.floor(Math.random() * 9999)}`;
            spawnProjectile(room, {
              projId,
              type: "fireball",
              x: p.x,
              z: p.z,
              vx: n.x * CONFIG.projectileSpeed,
              vz: n.z * CONFIG.projectileSpeed,
              rotY: Math.atan2(n.x, n.z),
              ownerId: p.playerId,
              targetEnemyId: target.enemyId,
              createdAt: now,
              expiresAt: now + CONFIG.defaultFireball.lifetimeMs,
              damage: CONFIG.defaultFireball.damage
            });

            emitEvent(roomId, "projectile_spawn", {
              projId,
              type: "fireball",
              ownerId: p.playerId,
              targetEnemyId: target.enemyId
            });
          } else {
            // Instant “no target” cast event only (client can show visuals)
            emitEvent(roomId, "spell_effect", { actorId: p.playerId, spellId: "fireball", note: "no_target" });
          }
        }
      }

      p.casts = remaining;
    }

    // 4) Projectiles movement + hit detection (simple)
    for (const [projId, proj] of room.projectiles.entries()) {
      // Move
      proj.x += proj.vx * dt;
      proj.z += proj.vz * dt;

      // Expire
      if (now >= proj.expiresAt) {
        room.projectiles.delete(projId);
        emitEvent(roomId, "projectile_despawn", { projId });
        continue;
      }

      // Hit detection: if target exists and we are close enough
      if (proj.targetEnemyId) {
        const e = findEnemy(room, proj.targetEnemyId);
        if (e) {
          const dx = e.x - proj.x;
          const dz = e.z - proj.z;
          if ((dx * dx + dz * dz) < 0.6 * 0.6) {
            // Hit
            e.hp = Math.max(0, e.hp - proj.damage);
            emitEvent(roomId, "hit", { projId, ownerId: proj.ownerId, targetType: "enemy", targetId: e.enemyId });
            emitEvent(roomId, "damage", { sourceId: proj.ownerId, targetType: "enemy", targetId: e.enemyId, amount: proj.damage, hp: e.hp, maxHp: e.maxHp });

            room.projectiles.delete(projId);
            emitEvent(roomId, "projectile_despawn", { projId });

            if (e.hp <= 0) emitEvent(roomId, "enemy_death", { enemyId: e.enemyId });
          }
        }
      }
    }

    // 5) Snapshot (steady, includes moving objects)
    const players = Array.from(room.players.values()).map(p => ({
      playerId: p.playerId,
      name: p.name,
      x: p.x,
      z: p.z,
      rotY: p.rotY,
      hp: p.hp,
      maxHp: p.maxHp,
      mana: p.mana,
      maxMana: p.maxMana
    }));

    const enemies = Array.from(room.enemies.values()).map(e => ({
      enemyId: e.enemyId,
      x: e.x,
      z: e.z,
      rotY: e.rotY,
      state: e.state,
      hp: e.hp,
      maxHp: e.maxHp
    }));

    const projectiles = Array.from(room.projectiles.values()).map(pr => ({
      projId: pr.projId,
      type: pr.type,
      x: pr.x,
      z: pr.z,
      rotY: pr.rotY,
      ownerId: pr.ownerId
    }));

    io.to(roomId).emit("snapshot", { t: now, players, enemies, projectiles, env: room.env });
  }
}, TICK_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
