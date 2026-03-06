const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Игровое состояние
const players = new Map();
const monsters = new Map();
const buildings = new Map(); // стены, ловушки, костры
const resources = new Map(); // деревья, ягоды

let nextMonsterId = 0;
let nextBuildingId = 0;
let dayCount = 1;
let dayTime = true;
let timeOfDay = 12; // 12:00 день

// Генерация леса (деревья, кусты)
for (let i = 0; i < 150; i++) {
    const x = (Math.random() - 0.5) * 300;
    const z = (Math.random() - 0.5) * 300;
    if (Math.abs(x) < 20 && Math.abs(z) < 20) continue; // Не спавним рядом с базой
    
    resources.set('tree_' + i, {
        type: 'tree',
        x, z,
        health: 100,
        resource: 'wood',
        variant: Math.floor(Math.random() * 3)
    });
}

for (let i = 0; i < 80; i++) {
    const x = (Math.random() - 0.5) * 300;
    const z = (Math.random() - 0.5) * 300;
    if (Math.abs(x) < 20 && Math.abs(z) < 20) continue;
    
    resources.set('berry_' + i, {
        type: 'berry_bush',
        x, z,
        health: 30,
        resource: 'berries',
        regenTime: 0
    });
}

// Таймер дня/ночи
setInterval(() => {
    timeOfDay += 0.002;
    if (timeOfDay >= 24) {
        timeOfDay = 0;
        dayCount++;
    }
    
    const wasDay = dayTime;
    dayTime = timeOfDay >= 6 && timeOfDay < 20;
    
    // Если наступила ночь - спавним монстров
    if (wasDay && !dayTime) {
        spawnMonsters();
    }
    
    // Регенерация ягод (каждые 5 минут)
    resources.forEach((res, id) => {
        if (res.type === 'berry_bush' && res.health <= 0) {
            if (!res.regenTime) res.regenTime = Date.now() + 300000;
            if (Date.now() > res.regenTime) {
                res.health = 30;
                res.regenTime = 0;
                broadcast({ type: 'resource_respawn', id });
            }
        }
    });
    
    broadcast({
        type: 'time_update',
        timeOfDay,
        dayCount,
        dayTime
    });
}, 1000);

function spawnMonsters() {
    const count = 8 + dayCount * 2; // С каждым днём монстров больше
    
    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 50 + Math.random() * 80;
        const x = Math.cos(angle) * dist;
        const z = Math.sin(angle) * dist;
        
        // Не спавним слишком близко к базе
        if (Math.abs(x) < 15 && Math.abs(z) < 15) continue;
        
        const r = Math.random();
        let type, health, damage, speed, exp;
        
        if (r < 0.5) {
            type = 'wolf';
            health = 50;
            damage = 15;
            speed = 0.06;
            exp = 10;
        } else if (r < 0.8) {
            type = 'bear';
            health = 150;
            damage = 30;
            speed = 0.03;
            exp = 25;
        } else {
            type = 'spirit';
            health = 80;
            damage = 20;
            speed = 0.04;
            exp = 15;
        }
        
        const monsterId = 'm' + (nextMonsterId++);
        monsters.set(monsterId, {
            type,
            x, z,
            health,
            maxHealth: health,
            damage,
            speed,
            exp,
            targetId: null,
            lastAttack: 0
        });
        
        broadcast({
            type: 'monster_spawn',
            id: monsterId,
            type,
            x, z,
            health
        });
    }
}

// Движение монстров
setInterval(() => {
    if (players.size === 0 || dayTime) return; // Днём не двигаются
    
    monsters.forEach((monster, id) => {
        // Ищем ближайший костёр или игрока
        let target = null;
        let targetDist = 1000;
        
        // Сначала ищем костры (монстры хотят их потушить)
        buildings.forEach((building, bid) => {
            if (building.type === 'campfire' && building.health > 0) {
                const dist = Math.sqrt(
                    (building.x - monster.x)**2 + 
                    (building.z - monster.z)**2
                );
                if (dist < targetDist) {
                    targetDist = dist;
                    target = { type: 'building', id: bid, x: building.x, z: building.z };
                }
            }
        });
        
        // Если нет костров рядом, ищем игроков
        if (!target) {
            players.forEach((player, pid) => {
                const dist = Math.sqrt(
                    (player.x - monster.x)**2 + 
                    (player.z - monster.z)**2
                );
                if (dist < targetDist && player.hp > 0) {
                    targetDist = dist;
                    target = { type: 'player', id: pid, x: player.x, z: player.z };
                }
            });
        }
        
        if (target) {
            // Движение к цели
            const dx = target.x - monster.x;
            const dz = target.z - monster.z;
            const dist = Math.sqrt(dx*dx + dz*dz);
            
            if (dist > 2) {
                monster.x += (dx / dist) * monster.speed;
                monster.z += (dz / dist) * monster.speed;
            } else {
                // Атака
                const now = Date.now();
                if (now - monster.lastAttack > 1500) {
                    if (target.type === 'player') {
                        const player = players.get(target.id);
                        if (player) {
                            player.hp = Math.max(0, player.hp - monster.damage);
                            broadcast({
                                type: 'player_hit',
                                id: target.id,
                                hp: player.hp
                            });
                            if (player.hp <= 0) {
                                broadcast({
                                    type: 'player_death',
                                    id: target.id
                                });
                                // Возврат в точку возрождения
                                player.x = 0;
                                player.z = 5;
                                player.hp = player.maxHp;
                                setTimeout(() => {
                                    broadcast({
                                        type: 'player_respawn',
                                        id: target.id,
                                        x: 0,
                                        z: 5
                                    });
                                }, 5000);
                            }
                        }
                    } else if (target.type === 'building') {
                        const building = buildings.get(target.id);
                        if (building && building.type === 'campfire') {
                            building.health = Math.max(0, building.health - monster.damage);
                            broadcast({
                                type: 'building_hit',
                                id: target.id,
                                health: building.health
                            });
                            if (building.health <= 0) {
                                buildings.delete(target.id);
                                broadcast({
                                    type: 'building_destroy',
                                    id: target.id
                                });
                            }
                        }
                    }
                    monster.lastAttack = now;
                }
            }
            
            broadcast({
                type: 'monster_move',
                id,
                x: monster.x,
                z: monster.z
            });
        }
    });
}, 100);

wss.on('connection', (ws) => {
    const playerId = 'p' + Math.random().toString(36).substring(7);
    const playerColor = Math.floor(Math.random() * 0xffffff);
    
    players.set(playerId, {
        ws,
        name: 'Выживший_' + Math.floor(Math.random() * 1000),
        color: playerColor,
        x: 0,
        z: 5,
        rot: 0,
        hp: 100,
        maxHp: 100,
        hunger: 100,
        thirst: 100,
        exp: 0,
        level: 1,
        inventory: [],
        lastSeen: Date.now()
    });
    
    // Отправляем новому игроку состояние мира
    ws.send(JSON.stringify({
        type: 'init',
        id: playerId,
        color: playerColor,
        timeOfDay,
        dayCount,
        dayTime,
        monsters: Array.from(monsters.entries()).map(([id, m]) => ({ id, ...m })),
        buildings: Array.from(buildings.entries()).map(([id, b]) => ({ id, ...b })),
        resources: Array.from(resources.entries()).map(([id, r]) => ({ id, ...r }))
    }));
    
    // Сообщаем всем о новом игроке
    broadcast({
        type: 'player_join',
        id: playerId,
        name: players.get(playerId).name,
        color: playerColor,
        x: 0,
        z: 5,
        rot: 0,
        hp: 100
    }, ws);
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const player = players.get(playerId);
            if (!player) return;
            
            player.lastSeen = Date.now();
            
            switch(msg.type) {
                case 'move':
                    player.x = msg.x;
                    player.z = msg.z;
                    player.rot = msg.rot;
                    
                    broadcast({
                        type: 'player_move',
                        id: playerId,
                        x: msg.x,
                        z: msg.z,
                        rot: msg.rot
                    }, ws);
                    break;
                    
                case 'build':
                    // Проверяем, можно ли поставить
                    let canBuild = true;
                    buildings.forEach(b => {
                        const dx = b.x - msg.x;
                        const dz = b.z - msg.z;
                        if (Math.sqrt(dx*dx + dz*dz) < 2) canBuild = false;
                    });
                    
                    if (canBuild) {
                        const buildingId = 'b' + (nextBuildingId++);
                        const health = msg.buildingType === 'wall' ? 300 :
                                      msg.buildingType === 'campfire' ? 150 : 200;
                        
                        buildings.set(buildingId, {
                            type: msg.buildingType,
                            x: msg.x,
                            z: msg.z,
                            health,
                            maxHealth: health,
                            owner: playerId
                        });
                        
                        broadcast({
                            type: 'build',
                            id: buildingId,
                            buildingType: msg.buildingType,
                            x: msg.x,
                            z: msg.z
                        });
                    }
                    break;
                    
                case 'damage_resource':
                    if (resources.has(msg.id)) {
                        const res = resources.get(msg.id);
                        if (res.health > 0) {
                            res.health -= msg.damage;
                            
                            if (res.health <= 0) {
                                broadcast({
                                    type: 'resource_destroy',
                                    id: msg.id
                                });
                                
                                // Добавляем ресурс игроку
                                ws.send(JSON.stringify({
                                    type: 'add_item',
                                    itemType: res.resource,
                                    count: res.type === 'tree' ? 3 : 1
                                }));
                            } else {
                                broadcast({
                                    type: 'resource_hit',
                                    id: msg.id,
                                    health: res.health
                                });
                            }
                        }
                    }
                    break;
                    
                case 'monster_hit':
                    if (monsters.has(msg.id)) {
                        const monster = monsters.get(msg.id);
                        monster.health -= msg.damage;
                        
                        if (monster.health <= 0) {
                            monsters.delete(msg.id);
                            broadcast({
                                type: 'monster_death',
                                id: msg.id,
                                x: monster.x,
                                z: monster.z
                            });
                            
                            // Опыт и выпадение ресурсов
                            player.exp += monster.exp;
                            if (player.exp >= player.level * 100) {
                                player.level++;
                                player.maxHp += 20;
                                player.hp = player.maxHp;
                                broadcast({
                                    type: 'player_level_up',
                                    id: playerId,
                                    level: player.level
                                });
                            }
                            
                            // Шанс выпадения мяса
                            if (Math.random() < 0.6) {
                                ws.send(JSON.stringify({
                                    type: 'add_item',
                                    itemType: 'meat',
                                    count: monster.type === 'bear' ? 3 : 1
                                }));
                            }
                        } else {
                            broadcast({
                                type: 'monster_hit',
                                id: msg.id,
                                health: monster.health
                            });
                        }
                    }
                    break;
                    
                case 'add_item':
                    ws.send(JSON.stringify({
                        type: 'add_item',
                        itemType: msg.itemType,
                        count: msg.count
                    }));
                    break;
                    
                case 'update_stats':
                    player.hp = msg.hp;
                    player.hunger = msg.hunger;
                    player.thirst = msg.thirst;
                    break;
                    
                case 'chat':
                    broadcast({
                        type: 'chat',
                        name: player.name,
                        message: msg.message,
                        color: player.color
                    });
                    break;
            }
        } catch(e) {
            console.log('Ошибка:', e);
        }
    });
    
    ws.on('close', () => {
        players.delete(playerId);
        broadcast({ type: 'player_left', id: playerId });
    });
});

function broadcast(message, exclude = null) {
    wss.clients.forEach(client => {
        if (client !== exclude && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('🔥 ============================');
    console.log('🔥 WILD NIGHTS - ВЫЖИВАНИЕ В ЛЕСУ');
    console.log('🔥 Сервер запущен на порту', PORT);
    console.log('🔥 ============================');
});
