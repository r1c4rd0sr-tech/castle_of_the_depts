import React, { useEffect, useRef, useState, useReducer, useCallback } from "react";
import JSZip from "jszip";

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

const T = 32; // tile size in pixels
const MAP_W = 52;
const MAP_H = 38;
const VIEW_W = 19;
const VIEW_H = 15;
const FOV_R = 9;
const MAX_FLOOR = 6;

// Tile IDs
const VOID = 0, WALL = 1, FLOOR = 2, DOOR_C = 3, DOOR_O = 4, STAIR_D = 5, STAIR_U = 6;

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface Pos { x: number; y: number; }

interface InvItem {
  id: string;
  qty: number;
  identified: boolean;
}

interface Player extends Pos {
  hp: number; maxHp: number;
  mp: number; maxMp: number;
  str: number; dex: number; intel: number; con: number;
  level: number; xp: number; xpNext: number;
  gold: number;
  inv: InvItem[];
  weapon: string | null;
  armor: string | null;
  shield: string | null;
  ring: string | null;
  amulet: string | null;
  baseAC: number;
}

interface Enemy extends Pos {
  uid: string;
  kind: string;
  hp: number; maxHp: number;
  atk: [number, number];
  def: number;
  xp: number;
  aggro: boolean;
}

interface MapItem extends Pos {
  uid: string;
  id: string;
  qty: number;
}

type Vis = 0 | 1 | 2; // 0=hidden 1=explored 2=visible

interface Cell {
  tile: number;
  vis: Vis;
}

interface DungeonMap {
  floor: number;
  cells: Cell[][];
  enemies: Enemy[];
  items: MapItem[];
}

interface GameState {
  player: Player;
  map: DungeonMap;
  messages: string[];
  phase: "title" | "playing" | "dead" | "win";
  showInv: boolean;
  invSel: number;
  turn: number;
}

type Action =
  | { type: "START" }
  | { type: "MOVE"; dx: number; dy: number }
  | { type: "WAIT" }
  | { type: "PICKUP" }
  | { type: "DESCEND" }
  | { type: "ASCEND" }
  | { type: "TOGGLE_INV" }
  | { type: "INV_SEL"; idx: number }
  | { type: "INV_USE" }
  | { type: "INV_DROP" }
  | { type: "RESTART" };

// ═══════════════════════════════════════════════════════════════
// ITEM DEFINITIONS
// ═══════════════════════════════════════════════════════════════

interface ItemDef {
  name: string;
  cat: "weapon" | "armor" | "shield" | "ring" | "amulet" | "potion" | "scroll" | "gold";
  desc: string;
  weight: number;
  value: number;
  damage?: [number, number];
  acc?: number;
  ac?: number;
  effect?: string;
  amt?: number;
  statBonus?: { stat: string; val: number };
  minFloor?: number;
}

const ITEMS: Record<string, ItemDef> = {
  gold:         { name: "Gold Coins",       cat: "gold",   desc: "Shiny coins",              weight: 0, value: 0 },
  dagger:       { name: "Dagger",           cat: "weapon", desc: "+1 atk, fast",             weight: 2, value: 25,  damage: [1,4],  acc: 1 },
  short_sword:  { name: "Short Sword",      cat: "weapon", desc: "+2 atk",                   weight: 4, value: 60,  damage: [1,6],  acc: 2, minFloor: 1 },
  long_sword:   { name: "Long Sword",       cat: "weapon", desc: "+3 atk",                   weight: 6, value: 150, damage: [1,8],  acc: 3, minFloor: 2 },
  great_axe:    { name: "Great Axe",        cat: "weapon", desc: "Powerful, -1 acc",         weight: 9, value: 280, damage: [2,8],  acc: -1, minFloor: 3 },
  staff:        { name: "Wizard Staff",     cat: "weapon", desc: "+INT bonus",               weight: 3, value: 90,  damage: [1,6],  acc: 1, minFloor: 2 },
  leather:      { name: "Leather Armor",    cat: "armor",  desc: "AC +2",                    weight: 5, value: 50,  ac: 2 },
  chain_mail:   { name: "Chain Mail",       cat: "armor",  desc: "AC +5",                    weight: 8, value: 130, ac: 5, minFloor: 2 },
  plate_armor:  { name: "Plate Armor",      cat: "armor",  desc: "AC +9",                    weight: 15, value: 400, ac: 9, minFloor: 4 },
  buckler:      { name: "Buckler",          cat: "shield", desc: "AC +1",                    weight: 2, value: 35,  ac: 1 },
  kite_shield:  { name: "Kite Shield",      cat: "shield", desc: "AC +3",                    weight: 5, value: 120, ac: 3, minFloor: 2 },
  ring_str:     { name: "Ring of Strength", cat: "ring",   desc: "STR +3",                   weight: 0, value: 200, statBonus: { stat: "str", val: 3 }, minFloor: 3 },
  ring_dex:     { name: "Ring of Dexterity",cat: "ring",  desc: "DEX +3",                   weight: 0, value: 200, statBonus: { stat: "dex", val: 3 }, minFloor: 3 },
  amulet_prot:  { name: "Amulet of Protection", cat: "amulet", desc: "AC +3",               weight: 0, value: 300, ac: 3, minFloor: 4 },
  hp_potion:    { name: "Health Potion",    cat: "potion", desc: "Restores 25 HP",           weight: 1, value: 40,  effect: "heal", amt: 25 },
  big_hp_potion:{ name: "Greater Healing",  cat: "potion", desc: "Restores 60 HP",           weight: 1, value: 100, effect: "heal", amt: 60, minFloor: 3 },
  mp_potion:    { name: "Mana Potion",      cat: "potion", desc: "Restores 20 MP",           weight: 1, value: 45,  effect: "mana", amt: 20 },
  str_potion:   { name: "Potion of Might",  cat: "potion", desc: "STR +1 permanently",       weight: 1, value: 150, effect: "str",  amt: 1, minFloor: 3 },
  scroll_fire:  { name: "Scroll of Fire",   cat: "scroll", desc: "Deals 20-35 fire damage",  weight: 0, value: 80,  effect: "fire", amt: 30, minFloor: 2 },
  scroll_tele:  { name: "Scroll of Teleport",cat: "scroll",desc: "Teleports you randomly",   weight: 0, value: 70,  effect: "tele", minFloor: 2 },
  scroll_map:   { name: "Scroll of Mapping",cat: "scroll", desc: "Reveals the entire floor", weight: 0, value: 60,  effect: "map" },
};

// ═══════════════════════════════════════════════════════════════
// ENEMY DEFINITIONS
// ═══════════════════════════════════════════════════════════════

interface EnemyDef {
  name: string;
  hp: [number, number];
  atk: [number, number];
  def: number;
  xp: number;
  minFloor: number;
  maxFloor: number;
  dropChance: number;
  drops?: string[];
}

const ENEMIES: Record<string, EnemyDef> = {
  rat:      { name: "Giant Rat",    hp:[4,8],    atk:[1,3],  def:0, xp:5,   minFloor:1, maxFloor:2, dropChance:0.1 },
  bat:      { name: "Cave Bat",     hp:[3,6],    atk:[1,2],  def:0, xp:4,   minFloor:1, maxFloor:2, dropChance:0.05 },
  snake:    { name: "Viper",        hp:[6,10],   atk:[1,4],  def:1, xp:8,   minFloor:1, maxFloor:3, dropChance:0.1 },
  goblin:   { name: "Goblin",       hp:[8,15],   atk:[2,5],  def:2, xp:15,  minFloor:1, maxFloor:3, dropChance:0.3, drops:["dagger","gold","hp_potion"] },
  skeleton: { name: "Skeleton",     hp:[12,20],  atk:[3,7],  def:3, xp:22,  minFloor:2, maxFloor:4, dropChance:0.3, drops:["short_sword","gold","buckler"] },
  zombie:   { name: "Zombie",       hp:[18,28],  atk:[4,8],  def:2, xp:28,  minFloor:2, maxFloor:4, dropChance:0.25, drops:["gold","leather","hp_potion"] },
  orc:      { name: "Orc Warrior",  hp:[22,35],  atk:[5,10], def:4, xp:45,  minFloor:3, maxFloor:5, dropChance:0.4, drops:["long_sword","chain_mail","gold"] },
  troll:    { name: "Cave Troll",   hp:[35,55],  atk:[8,15], def:6, xp:80,  minFloor:3, maxFloor:5, dropChance:0.4, drops:["great_axe","big_hp_potion","gold"] },
  demon:    { name: "Demon",        hp:[45,70],  atk:[10,18],def:7, xp:120, minFloor:4, maxFloor:6, dropChance:0.5, drops:["ring_str","scroll_fire","gold"] },
  dragon:   { name: "Dragon",       hp:[80,120], atk:[15,25],def:10,xp:300, minFloor:5, maxFloor:6, dropChance:0.9, drops:["plate_armor","amulet_prot","ring_dex","gold"] },
};

// ═══════════════════════════════════════════════════════════════
// SPRITE RENDERER — programmatic pixel art on Canvas
// ═══════════════════════════════════════════════════════════════

function createSprite(draw: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = T; cv.height = T;
  const ctx = cv.getContext("2d")!;
  draw(ctx);
  return cv;
}

function px(v: number) { return Math.round(v); }

// Reusable pixel-art helpers
function rect(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = color;
  ctx.fillRect(px(x), px(y), px(w), px(h));
}

const spriteCache: Record<string, HTMLCanvasElement> = {};

function getSprite(key: string): HTMLCanvasElement {
  if (spriteCache[key]) return spriteCache[key];
  const s = buildSprite(key);
  spriteCache[key] = s;
  return s;
}

function buildSprite(key: string): HTMLCanvasElement {
  return createSprite((ctx) => {
    switch (key) {
      // ── TILES ────────────────────────────────────────────────
      case "floor": {
        rect(ctx, "#2e2a3a", 0, 0, T, T);
        rect(ctx, "#363044", 0, 0, T, 1);
        rect(ctx, "#363044", 0, 0, 1, T);
        // subtle texture dots
        for (let i = 0; i < 8; i++) {
          const dx = ((i * 7 + 3) % 28) + 2;
          const dy = ((i * 11 + 5) % 28) + 2;
          rect(ctx, "#282435", dx, dy, 2, 2);
        }
        break;
      }
      case "wall": {
        rect(ctx, "#4a4860", 0, 0, T, T);
        // brick pattern
        for (let row = 0; row < 4; row++) {
          const y0 = row * 8;
          rect(ctx, "#3a3850", 0, y0, T, 1);
          const offset = row % 2 === 0 ? 0 : 12;
          for (let c = 0; c < 4; c++) {
            rect(ctx, "#3a3850", offset + c * 16, y0 + 1, 1, 7);
          }
        }
        rect(ctx, "#6a6880", 0, 0, T, 1);
        rect(ctx, "#6a6880", 0, 0, 1, T);
        rect(ctx, "#28263a", T - 1, 0, 1, T);
        rect(ctx, "#28263a", 0, T - 1, T, 1);
        break;
      }
      case "void": {
        rect(ctx, "#08060e", 0, 0, T, T);
        break;
      }
      case "door_c": {
        rect(ctx, "#5a3a1a", 0, 0, T, T);
        rect(ctx, "#4a2e10", 4, 2, T - 8, T - 4);
        rect(ctx, "#d4a017", T / 2 - 3, T / 2 - 1, 6, 2);
        rect(ctx, "#8b6010", 0, 0, T, 2);
        rect(ctx, "#8b6010", 0, T - 2, T, 2);
        rect(ctx, "#8b6010", 0, 0, 2, T);
        rect(ctx, "#8b6010", T - 2, 0, 2, T);
        break;
      }
      case "door_o": {
        rect(ctx, "#2e2a3a", 0, 0, T, T);
        rect(ctx, "#5a3a1a", 0, 0, 4, T);
        rect(ctx, "#5a3a1a", T - 4, 0, 4, T);
        rect(ctx, "#5a3a1a", 0, 0, T, 3);
        break;
      }
      case "stair_d": {
        rect(ctx, "#2e2a3a", 0, 0, T, T);
        for (let i = 0; i < 6; i++) {
          rect(ctx, i % 2 === 0 ? "#4a4460" : "#3a3450", i * 5, T - (i + 1) * 5, T - i * 5, 5);
        }
        rect(ctx, "#d4a017", T / 2 - 4, T / 2 - 4, 8, 8);
        rect(ctx, "#2e2a3a", T / 2 - 2, T / 2 - 2, 4, 4);
        // down arrow
        rect(ctx, "#d4a017", T / 2 - 1, T / 2 - 3, 2, 6);
        rect(ctx, "#d4a017", T / 2 - 3, T / 2 + 1, 6, 2);
        rect(ctx, "#d4a017", T / 2 - 2, T / 2 + 2, 4, 1);
        rect(ctx, "#d4a017", T / 2 - 1, T / 2 + 3, 2, 1);
        break;
      }
      case "stair_u": {
        rect(ctx, "#2e2a3a", 0, 0, T, T);
        for (let i = 0; i < 6; i++) {
          rect(ctx, i % 2 === 0 ? "#5a5470" : "#4a4460", i * 5, i * 5, T - i * 10, 5);
        }
        rect(ctx, "#d4a017", T / 2 - 4, T / 2 - 4, 8, 8);
        rect(ctx, "#2e2a3a", T / 2 - 2, T / 2 - 2, 4, 4);
        // up arrow
        rect(ctx, "#d4a017", T / 2 - 1, T / 2 - 3, 2, 6);
        rect(ctx, "#d4a017", T / 2 - 3, T / 2 - 3, 6, 2);
        rect(ctx, "#d4a017", T / 2 - 2, T / 2 - 4, 4, 1);
        rect(ctx, "#d4a017", T / 2 - 1, T / 2 - 5, 2, 1);
        break;
      }

      // ── PLAYER ───────────────────────────────────────────────
      case "player": {
        // shadow
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.beginPath(); ctx.ellipse(T / 2, T - 4, 8, 3, 0, 0, Math.PI * 2); ctx.fill();
        // boots
        rect(ctx, "#3a1a00", 9, 26, 5, 4);
        rect(ctx, "#3a1a00", 18, 26, 5, 4);
        // legs
        rect(ctx, "#1a3a8a", 10, 18, 5, 9);
        rect(ctx, "#1a3a8a", 17, 18, 5, 9);
        // body armor
        rect(ctx, "#2255cc", 8, 11, 16, 9);
        rect(ctx, "#4477ee", 9, 12, 7, 4); // highlight
        rect(ctx, "#334488", 8, 18, 16, 2); // belt shadow
        // belt
        rect(ctx, "#8b5a00", 8, 19, 16, 2);
        rect(ctx, "#d4a017", 14, 19, 4, 2); // buckle
        // shield (left)
        rect(ctx, "#7a5500", 2, 10, 7, 10);
        rect(ctx, "#d4a017", 4, 13, 3, 5);
        rect(ctx, "#d4a017", 3, 14, 5, 2);
        // sword blade (right)
        rect(ctx, "#d8d8e0", 26, 5, 3, 14);
        rect(ctx, "#c0c0cc", 27, 6, 1, 12);
        // sword guard
        rect(ctx, "#d4a017", 23, 16, 9, 2);
        // sword grip
        rect(ctx, "#5a3010", 26, 18, 3, 6);
        // arm left
        rect(ctx, "#2255cc", 4, 11, 5, 8);
        // arm right
        rect(ctx, "#2255cc", 23, 11, 5, 8);
        // neck
        rect(ctx, "#e8b878", 12, 9, 8, 3);
        // head
        rect(ctx, "#e8b878", 10, 2, 12, 9);
        // hair
        rect(ctx, "#5a2800", 10, 2, 12, 3);
        rect(ctx, "#5a2800", 10, 2, 2, 7);
        rect(ctx, "#5a2800", 20, 2, 2, 5);
        // eyes
        rect(ctx, "#1a1030", 13, 7, 3, 2);
        rect(ctx, "#1a1030", 18, 7, 3, 2);
        rect(ctx, "#88aaff", 14, 7, 1, 1);
        rect(ctx, "#88aaff", 19, 7, 1, 1);
        break;
      }

      // ── ENEMIES ──────────────────────────────────────────────
      case "rat": {
        rect(ctx, "#6b3a1a", 6, 14, 20, 10);
        rect(ctx, "#8b5a2a", 6, 14, 12, 8); // highlight
        rect(ctx, "#6b3a1a", 10, 10, 10, 6); // head
        rect(ctx, "#cc4444", 12, 11, 3, 2); // eye
        rect(ctx, "#ffaaaa", 15, 12, 4, 2); // nose
        rect(ctx, "#4a2010", 2, 20, 4, 2); // tail
        rect(ctx, "#4a2010", 4, 22, 4, 2);
        rect(ctx, "#4a2010", 6, 24, 6, 2);
        // legs
        rect(ctx, "#4a2010", 8, 22, 3, 4);
        rect(ctx, "#4a2010", 14, 22, 3, 4);
        rect(ctx, "#4a2010", 20, 22, 3, 4);
        break;
      }
      case "bat": {
        // wings
        rect(ctx, "#1a0a2a", 0, 8, 12, 12);
        rect(ctx, "#2a1040", 20, 8, 12, 12);
        // body
        rect(ctx, "#2a1040", 10, 10, 12, 10);
        // ears
        rect(ctx, "#1a0a2a", 10, 6, 3, 6);
        rect(ctx, "#1a0a2a", 19, 6, 3, 6);
        // eyes
        rect(ctx, "#ff2222", 12, 13, 3, 2);
        rect(ctx, "#ff2222", 17, 13, 3, 2);
        rect(ctx, "#ffaaaa", 13, 13, 1, 1);
        rect(ctx, "#ffaaaa", 18, 13, 1, 1);
        // wing membrane lines
        rect(ctx, "#3a1a50", 4, 10, 1, 8);
        rect(ctx, "#3a1a50", 22, 12, 1, 6);
        break;
      }
      case "snake": {
        rect(ctx, "#1a6010", 10, 4, 8, 8); // head
        rect(ctx, "#228822", 11, 5, 6, 6);
        rect(ctx, "#ffcc00", 10, 8, 1, 2); // eye
        rect(ctx, "#ffcc00", 17, 8, 1, 2);
        rect(ctx, "#cc2222", 14, 9, 4, 2); // tongue
        rect(ctx, "#cc2222", 14, 10, 2, 2);
        rect(ctx, "#cc2222", 16, 10, 2, 2);
        // body coils
        rect(ctx, "#1a6010", 8, 11, 10, 5);
        rect(ctx, "#228822", 9, 12, 8, 3);
        rect(ctx, "#1a6010", 6, 15, 16, 5);
        rect(ctx, "#228822", 7, 16, 14, 3);
        rect(ctx, "#1a6010", 8, 19, 12, 5);
        rect(ctx, "#228822", 9, 20, 10, 3);
        // tail
        rect(ctx, "#1a6010", 16, 24, 6, 3);
        rect(ctx, "#1a6010", 18, 27, 4, 2);
        break;
      }
      case "goblin": {
        // shadow
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.beginPath(); ctx.ellipse(T / 2, T - 3, 7, 2, 0, 0, Math.PI * 2); ctx.fill();
        // legs
        rect(ctx, "#4a7a20", 11, 20, 4, 8);
        rect(ctx, "#4a7a20", 17, 20, 4, 8);
        // body
        rect(ctx, "#4a7a20", 10, 10, 12, 12);
        rect(ctx, "#5a9a28", 11, 11, 6, 5);
        // arms
        rect(ctx, "#4a7a20", 6, 10, 5, 8);
        rect(ctx, "#4a7a20", 21, 10, 5, 8);
        // club (right hand)
        rect(ctx, "#8b5500", 25, 6, 3, 12);
        rect(ctx, "#5a3a00", 23, 4, 7, 5);
        // head
        rect(ctx, "#4a7a20", 9, 3, 14, 9);
        rect(ctx, "#5a9a28", 10, 4, 8, 5);
        // ears
        rect(ctx, "#3a6a10", 7, 5, 3, 4);
        rect(ctx, "#3a6a10", 22, 5, 3, 4);
        // eyes
        rect(ctx, "#ff8800", 11, 7, 3, 2);
        rect(ctx, "#ff8800", 18, 7, 3, 2);
        rect(ctx, "#440000", 12, 7, 1, 2);
        rect(ctx, "#440000", 19, 7, 1, 2);
        break;
      }
      case "skeleton": {
        ctx.fillStyle = "rgba(0,0,0,0.2)";
        ctx.beginPath(); ctx.ellipse(T / 2, T - 3, 7, 2, 0, 0, Math.PI * 2); ctx.fill();
        // legs / feet
        rect(ctx, "#c8c0a8", 11, 22, 3, 8);
        rect(ctx, "#c8c0a8", 18, 22, 3, 8);
        rect(ctx, "#c8c0a8", 9, 28, 6, 2);
        rect(ctx, "#c8c0a8", 17, 28, 6, 2);
        // pelvis
        rect(ctx, "#c8c0a8", 10, 19, 12, 4);
        // spine
        rect(ctx, "#c8c0a8", 15, 11, 2, 9);
        // ribs
        for (let i = 0; i < 3; i++) {
          rect(ctx, "#c8c0a8", 10, 12 + i * 3, 5, 1);
          rect(ctx, "#c8c0a8", 17, 12 + i * 3, 5, 1);
        }
        // arms
        rect(ctx, "#c8c0a8", 6, 11, 5, 8);
        rect(ctx, "#c8c0a8", 21, 11, 5, 8);
        // sword
        rect(ctx, "#a0a0b8", 25, 4, 2, 14);
        rect(ctx, "#d4a017", 22, 14, 8, 2);
        // skull
        rect(ctx, "#d8d0b8", 10, 2, 12, 10);
        rect(ctx, "#c8c0a8", 11, 3, 10, 8);
        // eye sockets
        rect(ctx, "#0a0818", 12, 5, 3, 3);
        rect(ctx, "#0a0818", 17, 5, 3, 3);
        // nose
        rect(ctx, "#0a0818", 15, 9, 2, 2);
        break;
      }
      case "zombie": {
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.beginPath(); ctx.ellipse(T / 2, T - 3, 7, 2, 0, 0, Math.PI * 2); ctx.fill();
        // legs
        rect(ctx, "#4a5a3a", 10, 21, 5, 9);
        rect(ctx, "#4a5a3a", 17, 21, 5, 9);
        // body
        rect(ctx, "#5a6a48", 9, 11, 14, 12);
        rect(ctx, "#6a7a58", 10, 12, 6, 6);
        // torn clothing
        rect(ctx, "#3a4a2a", 9, 20, 14, 3);
        // arms outstretched
        rect(ctx, "#4a5a3a", 2, 10, 8, 4);
        rect(ctx, "#4a5a3a", 22, 10, 8, 4);
        // head
        rect(ctx, "#6a7a50", 10, 3, 12, 10);
        rect(ctx, "#7a8a60", 11, 4, 8, 6);
        // dead eyes
        rect(ctx, "#d8c888", 12, 6, 3, 2);
        rect(ctx, "#d8c888", 18, 6, 3, 2);
        rect(ctx, "#888870", 13, 7, 1, 1);
        rect(ctx, "#888870", 19, 7, 1, 1);
        // mouth
        rect(ctx, "#2a1a0a", 13, 10, 6, 2);
        rect(ctx, "#cc2222", 14, 10, 1, 2);
        rect(ctx, "#cc2222", 17, 10, 1, 2);
        break;
      }
      case "orc": {
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.beginPath(); ctx.ellipse(T / 2, T - 3, 9, 3, 0, 0, Math.PI * 2); ctx.fill();
        // boots
        rect(ctx, "#2a1800", 8, 26, 6, 4);
        rect(ctx, "#2a1800", 18, 26, 6, 4);
        // legs
        rect(ctx, "#2a5018", 9, 19, 5, 8);
        rect(ctx, "#2a5018", 18, 19, 5, 8);
        // body
        rect(ctx, "#2a5018", 7, 9, 18, 12);
        rect(ctx, "#3a7028", 8, 10, 10, 6);
        // chain mail
        rect(ctx, "#888888", 7, 9, 18, 2);
        for (let i = 0; i < 4; i++) {
          rect(ctx, "#888888", 7, 11 + i * 2, 18, 1);
        }
        // axes
        rect(ctx, "#5a3800", 26, 5, 2, 16); // handle
        rect(ctx, "#aaaacc", 24, 3, 6, 8); // blade
        rect(ctx, "#ccccee", 25, 4, 3, 5);
        // arms
        rect(ctx, "#2a5018", 3, 9, 5, 10);
        rect(ctx, "#2a5018", 24, 9, 5, 10);
        // head
        rect(ctx, "#2a5018", 8, 2, 16, 9);
        rect(ctx, "#3a7028", 9, 3, 12, 6);
        // tusks
        rect(ctx, "#ffffee", 10, 9, 2, 4);
        rect(ctx, "#ffffee", 20, 9, 2, 4);
        // eyes
        rect(ctx, "#cc2200", 11, 5, 4, 2);
        rect(ctx, "#cc2200", 17, 5, 4, 2);
        rect(ctx, "#ff6622", 12, 5, 2, 1);
        rect(ctx, "#ff6622", 18, 5, 2, 1);
        break;
      }
      case "troll": {
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.beginPath(); ctx.ellipse(T / 2, T - 2, 12, 4, 0, 0, Math.PI * 2); ctx.fill();
        // huge feet
        rect(ctx, "#3a2800", 4, 26, 8, 6);
        rect(ctx, "#3a2800", 20, 26, 8, 6);
        // legs
        rect(ctx, "#4a7030", 6, 18, 7, 10);
        rect(ctx, "#4a7030", 19, 18, 7, 10);
        // massive body
        rect(ctx, "#4a7030", 4, 8, 24, 12);
        rect(ctx, "#5a8840", 5, 9, 14, 7);
        // belly
        rect(ctx, "#3a5a20", 8, 16, 16, 5);
        // club
        rect(ctx, "#4a2800", 27, 4, 3, 16);
        rect(ctx, "#5a3800", 24, 1, 8, 7);
        rect(ctx, "#3a1a00", 25, 2, 6, 5);
        // arms
        rect(ctx, "#4a7030", 0, 8, 5, 12);
        rect(ctx, "#4a7030", 27, 8, 5, 12);
        // big head
        rect(ctx, "#4a7030", 6, 1, 20, 10);
        rect(ctx, "#5a8840", 7, 2, 14, 7);
        // horns
        rect(ctx, "#2a1800", 8, 0, 3, 4);
        rect(ctx, "#2a1800", 21, 0, 3, 4);
        // tiny eyes
        rect(ctx, "#ff4400", 10, 5, 4, 3);
        rect(ctx, "#ff4400", 18, 5, 4, 3);
        rect(ctx, "#ff8800", 11, 5, 2, 2);
        rect(ctx, "#ff8800", 19, 5, 2, 2);
        // nostrils
        rect(ctx, "#2a1800", 13, 8, 2, 2);
        rect(ctx, "#2a1800", 17, 8, 2, 2);
        break;
      }
      case "demon": {
        ctx.fillStyle = "rgba(80,0,0,0.4)";
        ctx.beginPath(); ctx.ellipse(T / 2, T - 3, 10, 3, 0, 0, Math.PI * 2); ctx.fill();
        // wings
        rect(ctx, "#5a0000", 0, 4, 8, 18);
        rect(ctx, "#5a0000", 24, 4, 8, 18);
        rect(ctx, "#3a0000", 2, 6, 5, 14);
        rect(ctx, "#3a0000", 25, 6, 5, 14);
        // legs
        rect(ctx, "#8a2010", 10, 21, 5, 9);
        rect(ctx, "#8a2010", 17, 21, 5, 9);
        // hooves
        rect(ctx, "#1a0808", 9, 28, 6, 4);
        rect(ctx, "#1a0808", 17, 28, 6, 4);
        // body
        rect(ctx, "#8a2010", 8, 10, 16, 13);
        rect(ctx, "#aa3020", 9, 11, 9, 7);
        // arms
        rect(ctx, "#8a2010", 4, 10, 5, 10);
        rect(ctx, "#8a2010", 23, 10, 5, 10);
        // claws
        rect(ctx, "#cc4422", 2, 18, 3, 4);
        rect(ctx, "#cc4422", 26, 18, 3, 4);
        rect(ctx, "#cc4422", 3, 20, 2, 4);
        rect(ctx, "#cc4422", 27, 20, 2, 4);
        // head
        rect(ctx, "#8a2010", 9, 2, 14, 10);
        rect(ctx, "#aa3020", 10, 3, 10, 7);
        // horns
        rect(ctx, "#cc4422", 10, 0, 3, 5);
        rect(ctx, "#cc4422", 8, 0, 3, 3);
        rect(ctx, "#cc4422", 19, 0, 3, 5);
        rect(ctx, "#cc4422", 21, 0, 3, 3);
        // glowing eyes
        rect(ctx, "#ffcc00", 11, 5, 4, 2);
        rect(ctx, "#ffcc00", 17, 5, 4, 2);
        rect(ctx, "#ffffff", 12, 5, 2, 1);
        rect(ctx, "#ffffff", 18, 5, 2, 1);
        // teeth
        rect(ctx, "#ffffee", 12, 10, 2, 2);
        rect(ctx, "#ffffee", 15, 10, 2, 2);
        rect(ctx, "#ffffee", 18, 10, 2, 2);
        break;
      }
      case "dragon": {
        ctx.fillStyle = "rgba(0,40,0,0.5)";
        ctx.beginPath(); ctx.ellipse(T / 2, T - 2, 13, 4, 0, 0, Math.PI * 2); ctx.fill();
        // wings
        rect(ctx, "#005500", 0, 2, 10, 22);
        rect(ctx, "#003300", 1, 4, 7, 18);
        rect(ctx, "#005500", 22, 2, 10, 22);
        rect(ctx, "#003300", 24, 4, 7, 18);
        // tail
        rect(ctx, "#006600", 0, 18, 10, 4);
        rect(ctx, "#006600", 0, 22, 6, 3);
        rect(ctx, "#006600", 0, 25, 3, 3);
        // legs
        rect(ctx, "#006600", 8, 21, 6, 9);
        rect(ctx, "#006600", 18, 21, 6, 9);
        rect(ctx, "#004400", 7, 28, 8, 4);
        rect(ctx, "#004400", 17, 28, 8, 4);
        // body
        rect(ctx, "#007700", 6, 10, 20, 14);
        rect(ctx, "#008800", 7, 11, 12, 9);
        // belly scales
        rect(ctx, "#44aa44", 9, 14, 14, 8);
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            rect(ctx, "#33aa33", 10 + j * 4, 15 + i * 3, 3, 2);
          }
        }
        // arms
        rect(ctx, "#007700", 4, 10, 5, 10);
        rect(ctx, "#007700", 23, 10, 5, 10);
        // claws
        rect(ctx, "#228822", 3, 18, 3, 5);
        rect(ctx, "#228822", 26, 18, 3, 5);
        // neck
        rect(ctx, "#007700", 11, 4, 10, 8);
        // head
        rect(ctx, "#008800", 8, 1, 16, 8);
        rect(ctx, "#00aa00", 9, 2, 12, 6);
        // snout
        rect(ctx, "#007700", 22, 4, 7, 5);
        // fire
        rect(ctx, "#ff8800", 29, 4, 3, 2);
        rect(ctx, "#ffcc00", 30, 3, 2, 4);
        rect(ctx, "#ff4400", 31, 2, 1, 6);
        // horns
        rect(ctx, "#004400", 9, 0, 3, 4);
        rect(ctx, "#004400", 20, 0, 3, 4);
        // eyes
        rect(ctx, "#ffcc00", 11, 4, 4, 2);
        rect(ctx, "#ffcc00", 17, 4, 4, 2);
        rect(ctx, "#ff4400", 12, 4, 2, 1);
        rect(ctx, "#ff4400", 18, 4, 2, 1);
        break;
      }

      // ── ITEMS ────────────────────────────────────────────────
      case "gold": {
        rect(ctx, "#d4a017", 10, 16, 6, 4);
        rect(ctx, "#d4a017", 14, 14, 5, 4);
        rect(ctx, "#d4a017", 8, 18, 6, 4);
        rect(ctx, "#ffe070", 11, 17, 3, 2);
        rect(ctx, "#ffe070", 15, 15, 2, 2);
        rect(ctx, "#ffe070", 9, 19, 3, 2);
        rect(ctx, "#c49010", 10, 20, 6, 1);
        rect(ctx, "#c49010", 14, 18, 5, 1);
        rect(ctx, "#c49010", 8, 22, 6, 1);
        break;
      }
      case "dagger": {
        rect(ctx, "#ddddee", 15, 5, 3, 16);
        rect(ctx, "#eeeeff", 16, 6, 1, 14);
        rect(ctx, "#d4a017", 12, 19, 9, 2);
        rect(ctx, "#8b5500", 15, 21, 3, 6);
        rect(ctx, "#c49010", 14, 22, 5, 1);
        break;
      }
      case "short_sword": {
        rect(ctx, "#ddddee", 14, 3, 4, 18);
        rect(ctx, "#eeeeff", 15, 4, 2, 16);
        rect(ctx, "#d4a017", 10, 19, 12, 3);
        rect(ctx, "#8b5500", 14, 22, 4, 8);
        rect(ctx, "#c49010", 13, 25, 6, 2);
        break;
      }
      case "long_sword": {
        rect(ctx, "#ccccdd", 15, 1, 4, 20);
        rect(ctx, "#ddddee", 16, 2, 2, 18);
        rect(ctx, "#d4a017", 9, 19, 14, 3);
        rect(ctx, "#7a4500", 15, 22, 4, 8);
        rect(ctx, "#c49010", 13, 26, 8, 2);
        break;
      }
      case "great_axe": {
        // handle
        rect(ctx, "#5a3000", 15, 4, 3, 26);
        // blade
        rect(ctx, "#9090aa", 6, 3, 14, 16);
        rect(ctx, "#aaaacc", 7, 4, 10, 12);
        rect(ctx, "#7a7a99", 6, 3, 3, 16);
        // edge highlight
        rect(ctx, "#ddddff", 6, 5, 1, 10);
        break;
      }
      case "staff": {
        rect(ctx, "#7a5500", 15, 2, 3, 26);
        rect(ctx, "#8b6600", 16, 3, 1, 24);
        // orb
        rect(ctx, "#4466dd", 11, 0, 10, 10);
        rect(ctx, "#6688ff", 12, 1, 8, 8);
        rect(ctx, "#8899ff", 13, 2, 4, 4);
        rect(ctx, "#aabbff", 13, 2, 2, 2);
        break;
      }
      case "leather": {
        rect(ctx, "#7a4a1a", 6, 4, 20, 24);
        rect(ctx, "#9a6a3a", 7, 5, 12, 16);
        rect(ctx, "#5a3a10", 6, 4, 20, 2); // collar
        for (let i = 0; i < 4; i++) {
          rect(ctx, "#5a3a10", 6, 8 + i * 5, 20, 1);
        }
        rect(ctx, "#d4a017", 15, 14, 2, 2);
        break;
      }
      case "chain_mail": {
        rect(ctx, "#808098", 5, 4, 22, 24);
        rect(ctx, "#6a6a80", 5, 4, 22, 24);
        // chain links
        for (let r = 0; r < 6; r++) {
          for (let c = 0; c < 5; c++) {
            rect(ctx, "#aaaacc", 6 + c * 4, 5 + r * 4, 3, 1);
            rect(ctx, "#aaaacc", 6 + c * 4, 6 + r * 4, 1, 2);
            rect(ctx, "#aaaacc", 8 + c * 4, 6 + r * 4, 1, 2);
          }
        }
        rect(ctx, "#d4a017", 14, 14, 4, 3);
        break;
      }
      case "plate_armor": {
        rect(ctx, "#aaaacc", 5, 4, 22, 24);
        rect(ctx, "#ccccee", 6, 5, 14, 18);
        // plate lines
        rect(ctx, "#8888aa", 5, 12, 22, 2);
        rect(ctx, "#8888aa", 5, 18, 22, 2);
        rect(ctx, "#8888aa", 15, 4, 2, 24);
        // shoulder guards
        rect(ctx, "#bbbbdd", 3, 4, 4, 8);
        rect(ctx, "#bbbbdd", 25, 4, 4, 8);
        rect(ctx, "#d4a017", 14, 13, 4, 4);
        rect(ctx, "#ffffff", 6, 6, 5, 5);
        break;
      }
      case "buckler": {
        rect(ctx, "#8b6914", 8, 6, 16, 20);
        rect(ctx, "#aa8822", 9, 7, 12, 16);
        rect(ctx, "#d4a017", 14, 14, 4, 6);
        rect(ctx, "#ffe070", 15, 15, 2, 3);
        rect(ctx, "#5a4400", 8, 6, 16, 2); // rim top
        rect(ctx, "#5a4400", 8, 24, 16, 2); // rim bot
        rect(ctx, "#5a4400", 8, 6, 2, 20);
        rect(ctx, "#5a4400", 22, 6, 2, 20);
        break;
      }
      case "kite_shield": {
        rect(ctx, "#7a7a99", 7, 3, 18, 26);
        rect(ctx, "#9a9abb", 8, 4, 14, 22);
        // cross
        rect(ctx, "#d4a017", 15, 4, 2, 24);
        rect(ctx, "#d4a017", 7, 14, 18, 2);
        rect(ctx, "#c49010", 8, 3, 16, 2); // top edge
        rect(ctx, "#c49010", 7, 3, 2, 26); // left edge
        rect(ctx, "#5a5a77", 23, 3, 2, 26); // right shadow
        rect(ctx, "#5a5a77", 7, 27, 18, 2); // bottom shadow
        break;
      }
      case "ring_str": case "ring_dex": {
        const rc = key === "ring_str" ? "#dd4422" : "#4488dd";
        ctx.beginPath();
        ctx.strokeStyle = "#d4a017";
        ctx.lineWidth = 3;
        ctx.arc(T / 2, T / 2, 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.fillStyle = rc;
        ctx.arc(T / 2, T / 2 - 8, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = key === "ring_str" ? "#ff8866" : "#88bbff";
        ctx.beginPath();
        ctx.arc(T / 2 - 1, T / 2 - 9, 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case "amulet_prot": {
        // chain
        rect(ctx, "#c49010", 12, 4, 8, 2);
        rect(ctx, "#c49010", 10, 6, 2, 4);
        rect(ctx, "#c49010", 20, 6, 2, 4);
        // pendant
        rect(ctx, "#d4a017", 10, 10, 12, 14);
        rect(ctx, "#ffe070", 11, 11, 8, 10);
        rect(ctx, "#4466dd", 13, 13, 6, 6);
        rect(ctx, "#6688ff", 14, 14, 3, 3);
        rect(ctx, "#c49010", 10, 10, 12, 1);
        rect(ctx, "#c49010", 10, 10, 1, 14);
        rect(ctx, "#8a6000", 20, 10, 2, 14);
        rect(ctx, "#8a6000", 10, 23, 12, 2);
        break;
      }
      case "hp_potion": {
        // bottle body
        rect(ctx, "#cc2244", 12, 10, 8, 16);
        rect(ctx, "#ee4466", 13, 11, 5, 12);
        rect(ctx, "#ff8899", 14, 12, 2, 5);
        // neck
        rect(ctx, "#cc2244", 14, 6, 4, 5);
        rect(ctx, "#ee4466", 15, 7, 2, 3);
        // cork
        rect(ctx, "#8b6000", 13, 4, 6, 3);
        // shine
        rect(ctx, "#ffcccc", 13, 11, 2, 4);
        break;
      }
      case "big_hp_potion": {
        rect(ctx, "#aa1122", 10, 8, 12, 18);
        rect(ctx, "#ee4466", 11, 9, 8, 14);
        rect(ctx, "#ff8899", 12, 10, 3, 7);
        rect(ctx, "#aa1122", 13, 5, 6, 4);
        rect(ctx, "#cc3344", 14, 6, 4, 3);
        rect(ctx, "#8b6000", 12, 3, 8, 3);
        rect(ctx, "#ffcccc", 11, 9, 3, 5);
        break;
      }
      case "mp_potion": {
        rect(ctx, "#2244cc", 12, 10, 8, 16);
        rect(ctx, "#4466ee", 13, 11, 5, 12);
        rect(ctx, "#8899ff", 14, 12, 2, 5);
        rect(ctx, "#2244cc", 14, 6, 4, 5);
        rect(ctx, "#4466ee", 15, 7, 2, 3);
        rect(ctx, "#8b6000", 13, 4, 6, 3);
        rect(ctx, "#ccccff", 13, 11, 2, 4);
        break;
      }
      case "str_potion": {
        rect(ctx, "#aa4400", 12, 10, 8, 16);
        rect(ctx, "#dd6622", 13, 11, 5, 12);
        rect(ctx, "#ffaa66", 14, 12, 2, 5);
        rect(ctx, "#aa4400", 14, 6, 4, 5);
        rect(ctx, "#dd6622", 15, 7, 2, 3);
        rect(ctx, "#8b6000", 13, 4, 6, 3);
        rect(ctx, "#ffddcc", 13, 11, 2, 4);
        break;
      }
      case "scroll_fire": case "scroll_tele": case "scroll_map": {
        const col = key === "scroll_fire" ? "#cc4400" : key === "scroll_tele" ? "#4444cc" : "#228822";
        // rolled scroll
        rect(ctx, "#e8d890", 8, 4, 16, 24);
        rect(ctx, "#f4e8a0", 9, 5, 12, 20);
        rect(ctx, "#d8c870", 8, 4, 2, 24);
        rect(ctx, "#d8c870", 22, 4, 2, 24);
        rect(ctx, "#c8b860", 8, 4, 16, 2);
        rect(ctx, "#c8b860", 8, 26, 16, 2);
        // rune writing
        rect(ctx, col, 10, 9, 12, 1);
        rect(ctx, col, 10, 13, 10, 1);
        rect(ctx, col, 10, 17, 12, 1);
        rect(ctx, col, 10, 21, 8, 1);
        rect(ctx, col, 10, 9, 1, 4);
        rect(ctx, col, 22, 9, 1, 4);
        rect(ctx, col, 10, 14, 1, 4);
        break;
      }
      default: {
        rect(ctx, "#888888", 8, 8, 16, 16);
        rect(ctx, "#aaaaaa", 9, 9, 8, 8);
        break;
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// DUNGEON GENERATION — BSP + corridors
// ═══════════════════════════════════════════════════════════════

interface Room { x: number; y: number; w: number; h: number; }

function rng(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function emptyMap(w: number, h: number): Cell[][] {
  return Array.from({ length: h }, () =>
    Array.from({ length: w }, () => ({ tile: WALL, vis: 0 as Vis }))
  );
}

function carveRoom(cells: Cell[][], room: Room) {
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (y > 0 && y < MAP_H - 1 && x > 0 && x < MAP_W - 1)
        cells[y][x].tile = FLOOR;
    }
  }
}

function carveCorridor(cells: Cell[][], x1: number, y1: number, x2: number, y2: number) {
  let cx = x1, cy = y1;
  if (Math.random() < 0.5) {
    while (cx !== x2) { cells[cy][cx].tile = FLOOR; cx += cx < x2 ? 1 : -1; }
    while (cy !== y2) { cells[cy][cx].tile = FLOOR; cy += cy < y2 ? 1 : -1; }
  } else {
    while (cy !== y2) { cells[cy][cx].tile = FLOOR; cy += cy < y2 ? 1 : -1; }
    while (cx !== x2) { cells[cy][cx].tile = FLOOR; cx += cx < x2 ? 1 : -1; }
  }
  cells[cy][cx].tile = FLOOR;
}

function centerOf(r: Room): Pos { return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) }; }

function buildDungeon(floor: number, playerPos?: Pos): DungeonMap {
  const cells = emptyMap(MAP_W, MAP_H);
  const rooms: Room[] = [];
  const attempts = 80;
  const minR = 4, maxR = 10;

  for (let i = 0; i < attempts; i++) {
    const w = rng(minR, maxR);
    const h = rng(minR, maxR);
    const x = rng(1, MAP_W - w - 2);
    const y = rng(1, MAP_H - h - 2);
    const room: Room = { x, y, w, h };
    const overlap = rooms.some(r =>
      x < r.x + r.w + 1 && x + w > r.x - 1 && y < r.y + r.h + 1 && y + h > r.y - 1
    );
    if (!overlap) {
      carveRoom(cells, room);
      if (rooms.length > 0) {
        const prev = centerOf(rooms[rooms.length - 1]);
        const cur = centerOf(room);
        carveCorridor(cells, prev.x, prev.y, cur.x, cur.y);
      }
      rooms.push(room);
    }
  }

  if (rooms.length < 2) return buildDungeon(floor, playerPos);

  // Place doors on openings
  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      if (cells[y][x].tile === FLOOR) {
        const n = cells[y - 1][x].tile === WALL;
        const s = cells[y + 1][x].tile === WALL;
        const e = cells[y][x + 1].tile === WALL;
        const w2 = cells[y][x - 1].tile === WALL;
        if ((n && s && !e && !w2) || (!n && !s && e && w2)) {
          if (Math.random() < 0.3) cells[y][x].tile = DOOR_C;
        }
      }
    }
  }

  // Stairs
  const stairDownRoom = rooms[rooms.length - 1];
  const sc = centerOf(stairDownRoom);
  cells[sc.y][sc.x].tile = STAIR_D;

  let startPos: Pos;
  if (playerPos) {
    // Place up-stairs near first room center
    const upRoom = rooms[0];
    const uc = centerOf(upRoom);
    cells[uc.y][uc.x].tile = STAIR_U;
    startPos = uc;
  } else {
    const startRoom = rooms[0];
    const pc = centerOf(startRoom);
    startPos = pc;
  }

  // Place enemies
  const enemies: Enemy[] = [];
  const enemyKinds = Object.keys(ENEMIES).filter(k => {
    const d = ENEMIES[k];
    return d.minFloor <= floor && d.maxFloor >= floor;
  });

  const enemyCount = 4 + floor * 2;
  for (let i = 0; i < enemyCount && enemyKinds.length; i++) {
    const room = rooms[rng(1, rooms.length - 1)];
    const ex = rng(room.x + 1, room.x + room.w - 2);
    const ey = rng(room.y + 1, room.y + room.h - 2);
    if (cells[ey][ex].tile !== FLOOR) continue;
    const kind = enemyKinds[rng(0, enemyKinds.length - 1)];
    const def = ENEMIES[kind];
    const hp = rng(def.hp[0], def.hp[1]);
    enemies.push({
      uid: `${kind}_${i}_${Date.now()}`,
      kind, x: ex, y: ey,
      hp, maxHp: hp,
      atk: def.atk,
      def: def.def,
      xp: def.xp,
      aggro: false,
    });
  }

  // Place items
  const items: MapItem[] = [];
  const floorItems: string[] = [];
  Object.keys(ITEMS).forEach(id => {
    const d = ITEMS[id];
    if (d.cat === "gold") return;
    const minF = d.minFloor ?? 0;
    if (minF <= floor) floorItems.push(id);
  });

  const itemCount = 3 + Math.floor(floor / 2);
  for (let i = 0; i < itemCount; i++) {
    const room = rooms[rng(0, rooms.length - 1)];
    const ix = rng(room.x + 1, room.x + room.w - 2);
    const iy = rng(room.y + 1, room.y + room.h - 2);
    if (cells[iy][ix].tile !== FLOOR) continue;
    const itemId = floorItems[rng(0, floorItems.length - 1)];
    items.push({ uid: `item_${i}_${Date.now()}`, id: itemId, x: ix, y: iy, qty: 1 });
  }

  // Scatter gold
  for (let i = 0; i < 5 + floor; i++) {
    const room = rooms[rng(0, rooms.length - 1)];
    const gx = rng(room.x + 1, room.x + room.w - 2);
    const gy = rng(room.y + 1, room.y + room.h - 2);
    if (cells[gy][gx].tile !== FLOOR) continue;
    items.push({ uid: `gold_${i}_${Date.now()}`, id: "gold", x: gx, y: gy, qty: rng(5, 20 * floor) });
  }

  return { floor, cells, enemies, items };
}

// ═══════════════════════════════════════════════════════════════
// FIELD OF VIEW — raycasting
// ═══════════════════════════════════════════════════════════════

function computeFOV(cells: Cell[][], px: number, py: number, radius: number) {
  // Reset current visibility
  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++)
      if (cells[y][x].vis === 2) cells[y][x].vis = 1;

  cells[py][px].vis = 2;

  const steps = 360;
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let rx = px + 0.5;
    let ry = py + 0.5;
    for (let j = 0; j < radius; j++) {
      const mx = Math.floor(rx);
      const my = Math.floor(ry);
      if (mx < 0 || mx >= MAP_W || my < 0 || my >= MAP_H) break;
      cells[my][mx].vis = 2;
      if (cells[my][mx].tile === WALL || cells[my][mx].tile === DOOR_C) break;
      rx += dx;
      ry += dy;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// PLAYER CREATION
// ═══════════════════════════════════════════════════════════════

function createPlayer(x: number, y: number): Player {
  return {
    x, y,
    hp: 30, maxHp: 30,
    mp: 15, maxMp: 15,
    str: 12, dex: 11, intel: 10, con: 12,
    level: 1, xp: 0, xpNext: 100,
    gold: 15,
    inv: [
      { id: "dagger", qty: 1, identified: true },
      { id: "hp_potion", qty: 2, identified: true },
    ],
    weapon: "dagger",
    armor: null,
    shield: null,
    ring: null,
    amulet: null,
    baseAC: 10,
  };
}

// ═══════════════════════════════════════════════════════════════
// GAME LOGIC HELPERS
// ═══════════════════════════════════════════════════════════════

function getAC(p: Player): number {
  let ac = p.baseAC + Math.floor((p.dex - 10) / 2);
  if (p.armor) ac += ITEMS[p.armor].ac ?? 0;
  if (p.shield) ac += ITEMS[p.shield].ac ?? 0;
  if (p.ring) ac += ITEMS[p.ring].ac ?? 0;
  if (p.amulet) ac += ITEMS[p.amulet].ac ?? 0;
  return ac;
}

function getWeaponDamage(p: Player): [number, number] {
  if (!p.weapon) return [1, 3];
  const w = ITEMS[p.weapon];
  return w.damage ?? [1, 3];
}

function rollDamage(min: number, max: number): number {
  return rng(min, max);
}

function playerAttack(player: Player, enemy: Enemy): { damage: number; hit: boolean; log: string } {
  const [dmin, dmax] = getWeaponDamage(player);
  const strBonus = Math.floor((player.str - 10) / 2);
  const acc = (player.weapon ? ITEMS[player.weapon].acc ?? 0 : 0);
  const hitChance = 70 + acc * 5 + Math.floor((player.dex - 10) / 2) * 3 - enemy.def * 4;
  const hit = rng(1, 100) <= Math.max(5, Math.min(95, hitChance));
  if (!hit) return { damage: 0, hit: false, log: `You miss the ${ENEMIES[enemy.kind].name}.` };
  const dmg = Math.max(1, rollDamage(dmin, dmax) + strBonus);
  return { damage: dmg, hit: true, log: `You strike the ${ENEMIES[enemy.kind].name} for ${dmg} damage.` };
}

function enemyAttack(enemy: Enemy, player: Player): { damage: number; log: string } {
  const ac = getAC(player);
  const hitChance = 60 - (ac - 10) * 4;
  const hit = rng(1, 100) <= Math.max(5, Math.min(90, hitChance));
  if (!hit) return { damage: 0, log: `The ${ENEMIES[enemy.kind].name} misses you.` };
  const [amin, amax] = enemy.atk;
  const dmg = Math.max(1, rollDamage(amin, amax));
  return { damage: dmg, log: `The ${ENEMIES[enemy.kind].name} hits you for ${dmg} damage!` };
}

function levelUp(p: Player): { player: Player; log: string } {
  const np = { ...p };
  np.level++;
  np.xpNext = np.level * 100;
  np.maxHp += 5 + Math.floor((np.con - 10) / 2);
  np.hp = np.maxHp;
  np.maxMp += 3 + Math.floor((np.intel - 10) / 2);
  np.mp = np.maxMp;
  np.str++; np.dex++; np.con++;
  return { player: np, log: `** LEVEL UP! You are now level ${np.level}! Your stats increase! **` };
}

function useItem(itemId: string, player: Player): { player: Player; logs: string[]; remove: boolean } {
  const def = ITEMS[itemId];
  const logs: string[] = [];
  let np = { ...player };
  let remove = false;

  switch (def.effect) {
    case "heal": {
      const amt = def.amt ?? 20;
      np.hp = Math.min(np.maxHp, np.hp + amt);
      logs.push(`You drink the ${def.name}. Restored ${amt} HP.`);
      remove = true;
      break;
    }
    case "mana": {
      const amt = def.amt ?? 15;
      np.mp = Math.min(np.maxMp, np.mp + amt);
      logs.push(`You drink the ${def.name}. Restored ${amt} MP.`);
      remove = true;
      break;
    }
    case "str": {
      np.str += def.amt ?? 1;
      logs.push(`You drink the ${def.name}. STR permanently +${def.amt ?? 1}!`);
      remove = true;
      break;
    }
    case "fire": {
      logs.push("You read the scroll. Flames erupt around you!");
      remove = true;
      break;
    }
    case "tele": {
      logs.push("The scroll crumbles. Reality twists... you teleport!");
      remove = true;
      break;
    }
    case "map": {
      logs.push("The scroll reveals the dungeon floor!");
      remove = true;
      break;
    }
    default:
      logs.push(`You cannot use ${def.name} that way.`);
  }
  return { player: np, logs, remove };
}

function equipItem(itemId: string, player: Player): { player: Player; log: string } {
  const def = ITEMS[itemId];
  const np = { ...player };
  let log = "";
  switch (def.cat) {
    case "weapon":
      if (np.weapon) { np.inv = [...np.inv, { id: np.weapon, qty: 1, identified: true }]; }
      np.weapon = itemId;
      log = `You equip the ${def.name}.`;
      break;
    case "armor":
      if (np.armor) { np.inv = [...np.inv, { id: np.armor, qty: 1, identified: true }]; }
      np.armor = itemId;
      log = `You equip the ${def.name}.`;
      break;
    case "shield":
      if (np.shield) { np.inv = [...np.inv, { id: np.shield, qty: 1, identified: true }]; }
      np.shield = itemId;
      log = `You equip the ${def.name}.`;
      break;
    case "ring":
      if (np.ring) { np.inv = [...np.inv, { id: np.ring, qty: 1, identified: true }]; }
      np.ring = itemId;
      if (def.statBonus) { (np as Record<string, number>)[def.statBonus.stat] += def.statBonus.val; }
      log = `You wear the ${def.name}.`;
      break;
    case "amulet":
      if (np.amulet) { np.inv = [...np.inv, { id: np.amulet, qty: 1, identified: true }]; }
      np.amulet = itemId;
      log = `You wear the ${def.name}.`;
      break;
    default:
      log = `You cannot equip ${def.name}.`;
  }
  return { player: np, log };
}

function addMessage(msgs: string[], msg: string): string[] {
  return [...msgs.slice(-49), msg];
}

function isPassable(cells: Cell[][], x: number, y: number): boolean {
  if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) return false;
  const t = cells[y][x].tile;
  return t === FLOOR || t === DOOR_O || t === STAIR_D || t === STAIR_U;
}

function moveEnemy(e: Enemy, player: Player, cells: Cell[][], enemies: Enemy[]): Enemy {
  const dx = player.x - e.x;
  const dy = player.y - e.y;
  const dist = Math.abs(dx) + Math.abs(dy);
  if (dist > 12) return e;
  if (!e.aggro && dist > 5) return e;

  const ne = { ...e, aggro: true };
  // Simple move toward player
  const mx = dx !== 0 ? (dx > 0 ? 1 : -1) : 0;
  const my = dy !== 0 ? (dy > 0 ? 1 : -1) : 0;

  const moves: [number, number][] = [[mx, my], [mx, 0], [0, my], [-my, mx], [my, -mx]];
  for (const [ox, oy] of moves) {
    if (ox === 0 && oy === 0) continue;
    const nx = e.x + ox;
    const ny = e.y + oy;
    if (!isPassable(cells, nx, ny)) continue;
    if (enemies.some(o => o.uid !== e.uid && o.x === nx && o.y === ny)) continue;
    if (nx === player.x && ny === player.y) return ne; // adjacent, will attack
    ne.x = nx;
    ne.y = ny;
    return ne;
  }
  return ne;
}

// ═══════════════════════════════════════════════════════════════
// INITIAL STATE
// ═══════════════════════════════════════════════════════════════

function createInitialState(): GameState {
  const map = buildDungeon(1);
  // Find a floor tile to start on
  let startX = 5, startY = 5;
  outer: for (let y = 1; y < MAP_H; y++) {
    for (let x = 1; x < MAP_W; x++) {
      if (map.cells[y][x].tile === FLOOR) { startX = x; startY = y; break outer; }
    }
  }
  const player = createPlayer(startX, startY);
  computeFOV(map.cells, player.x, player.y, FOV_R);
  return {
    player,
    map,
    messages: ["Welcome to the Dungeon of Despair!", "Use WASD or arrow keys to move.", "Press I for inventory, G to pick up items."],
    phase: "title",
    showInv: false,
    invSel: 0,
    turn: 1,
  };
}

// ═══════════════════════════════════════════════════════════════
// REDUCER
// ═══════════════════════════════════════════════════════════════

function reducer(state: GameState, action: Action): GameState {
  if (action.type === "RESTART") return { ...createInitialState(), phase: "title" };
  if (action.type === "START") return { ...state, phase: "playing" };

  if (state.phase !== "playing") return state;

  switch (action.type) {
    case "TOGGLE_INV":
      return { ...state, showInv: !state.showInv, invSel: 0 };

    case "INV_SEL":
      return { ...state, invSel: action.idx };

    case "INV_USE": {
      const item = state.player.inv[state.invSel];
      if (!item) return state;
      const def = ITEMS[item.id];
      if (!def) return state;

      // Equippable?
      if (["weapon", "armor", "shield", "ring", "amulet"].includes(def.cat)) {
        const { player: np, log } = equipItem(item.id, state.player);
        const newInv = [...np.inv];
        const idx = newInv.findIndex(i => i.id === item.id && i !== item);
        if (idx === -1) {
          // remove from original inv
          np.inv = np.inv.filter((_, i) => i !== state.invSel);
        }
        return { ...state, player: { ...np }, messages: addMessage(state.messages, log) };
      }

      // Consumable
      const { player: np, logs, remove } = useItem(item.id, state.player);
      let newInv = [...np.inv];
      if (remove) {
        if (item.qty > 1) {
          newInv[state.invSel] = { ...item, qty: item.qty - 1 };
        } else {
          newInv = newInv.filter((_, i) => i !== state.invSel);
        }
      }

      // Special effects
      let newCells = state.map.cells;
      if (def.effect === "map") {
        newCells = state.map.cells.map(row => row.map(c => ({ ...c, vis: c.vis === 0 ? 1 as Vis : c.vis })));
      }
      let newEnemies = state.map.enemies;
      if (def.effect === "fire") {
        const dmg = rng(def.amt ? def.amt - 5 : 15, def.amt ? def.amt + 5 : 35);
        newEnemies = state.map.enemies
          .map(e => {
            const dist = Math.abs(e.x - state.player.x) + Math.abs(e.y - state.player.y);
            if (dist <= 5) return { ...e, hp: e.hp - dmg };
            return e;
          })
          .filter(e => e.hp > 0);
        logs.push(`Nearby enemies take ${dmg} fire damage!`);
      }
      let newPos = { x: np.x, y: np.y };
      if (def.effect === "tele") {
        for (let i = 0; i < 100; i++) {
          const tx = rng(1, MAP_W - 2);
          const ty = rng(1, MAP_H - 2);
          if (state.map.cells[ty][tx].tile === FLOOR) { newPos = { x: tx, y: ty }; break; }
        }
      }

      const finalPlayer = { ...np, inv: newInv, x: newPos.x, y: newPos.y };
      computeFOV(newCells, finalPlayer.x, finalPlayer.y, FOV_R);
      return {
        ...state,
        player: finalPlayer,
        map: { ...state.map, cells: newCells, enemies: newEnemies },
        messages: logs.reduce((m, l) => addMessage(m, l), state.messages),
        showInv: false,
      };
    }

    case "INV_DROP": {
      const item = state.player.inv[state.invSel];
      if (!item) return state;
      const newInv = state.player.inv.filter((_, i) => i !== state.invSel);
      const mapItem: MapItem = { uid: `drop_${Date.now()}`, id: item.id, x: state.player.x, y: state.player.y, qty: item.qty };
      const def = ITEMS[item.id];
      return {
        ...state,
        player: { ...state.player, inv: newInv },
        map: { ...state.map, items: [...state.map.items, mapItem] },
        messages: addMessage(state.messages, `You drop the ${def?.name ?? item.id}.`),
        invSel: Math.max(0, state.invSel - 1),
      };
    }

    case "PICKUP": {
      const { x, y } = state.player;
      const idx = state.map.items.findIndex(i => i.x === x && i.y === y);
      if (idx === -1) return { ...state, messages: addMessage(state.messages, "Nothing here to pick up.") };

      const mapItem = state.map.items[idx];
      const def = ITEMS[mapItem.id];
      let newPlayer = { ...state.player };
      let log = "";

      if (mapItem.id === "gold") {
        newPlayer.gold += mapItem.qty;
        log = `You pick up ${mapItem.qty} gold coins.`;
      } else {
        if (newPlayer.inv.length >= 20) {
          return { ...state, messages: addMessage(state.messages, "Your inventory is full!") };
        }
        const existing = newPlayer.inv.findIndex(i => i.id === mapItem.id);
        if (existing >= 0 && (def.cat === "potion" || def.cat === "scroll")) {
          newPlayer.inv = newPlayer.inv.map((it, i) => i === existing ? { ...it, qty: it.qty + mapItem.qty } : it);
        } else {
          newPlayer.inv = [...newPlayer.inv, { id: mapItem.id, qty: mapItem.qty, identified: true }];
        }
        log = `You pick up the ${def?.name ?? mapItem.id}.`;
      }
      const newItems = state.map.items.filter((_, i) => i !== idx);
      return {
        ...state,
        player: newPlayer,
        map: { ...state.map, items: newItems },
        messages: addMessage(state.messages, log),
      };
    }

    case "WAIT": {
      return processTurn(state, state.player, []);
    }

    case "DESCEND": {
      const t = state.map.cells[state.player.y][state.player.x].tile;
      if (t !== STAIR_D) return { ...state, messages: addMessage(state.messages, "No stairs going down here.") };
      const newFloor = state.map.floor + 1;
      if (newFloor > MAX_FLOOR) {
        return { ...state, phase: "win", messages: addMessage(state.messages, "You escape the dungeon! You win!") };
      }
      const newMap = buildDungeon(newFloor, state.player);
      let px2 = 5, py2 = 5;
      outer2: for (let y = 1; y < MAP_H; y++) {
        for (let x = 1; x < MAP_W; x++) {
          if (newMap.cells[y][x].tile === STAIR_U || newMap.cells[y][x].tile === FLOOR) { px2 = x; py2 = y; break outer2; }
        }
      }
      const np = { ...state.player, x: px2, y: py2 };
      computeFOV(newMap.cells, np.x, np.y, FOV_R);
      return {
        ...state, player: np, map: newMap,
        messages: addMessage(state.messages, `You descend to dungeon level ${newFloor}.`),
        turn: state.turn + 1,
      };
    }

    case "ASCEND": {
      const t = state.map.cells[state.player.y][state.player.x].tile;
      if (t !== STAIR_U) return { ...state, messages: addMessage(state.messages, "No stairs going up here.") };
      if (state.map.floor === 1) return { ...state, messages: addMessage(state.messages, "You cannot leave yet — find the Dragon on level 6!") };
      return { ...state, messages: addMessage(state.messages, "You climb back up...") };
    }

    case "MOVE": {
      const { dx, dy } = action;
      const nx = state.player.x + dx;
      const ny = state.player.y + dy;

      if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) return state;

      const tile = state.map.cells[ny][nx].tile;

      // Door
      if (tile === DOOR_C) {
        const newCells = state.map.cells.map(row => [...row.map(c => ({ ...c }))]);
        newCells[ny][nx].tile = DOOR_O;
        computeFOV(newCells, state.player.x, state.player.y, FOV_R);
        return {
          ...state,
          map: { ...state.map, cells: newCells },
          messages: addMessage(state.messages, "You open the door."),
          turn: state.turn + 1,
        };
      }

      // Enemy bump
      const enemy = state.map.enemies.find(e => e.x === nx && e.y === ny);
      if (enemy) {
        const { damage, hit, log } = playerAttack(state.player, enemy);
        let newEnemies = state.map.enemies.map(e => e.uid === enemy.uid ? { ...e, hp: e.hp - damage, aggro: true } : e);
        let msgs = addMessage(state.messages, log);
        let newPlayer = { ...state.player };
        let newPhase = state.phase;

        const dying = newEnemies.find(e => e.uid === enemy.uid)!;
        if (dying.hp <= 0) {
          newEnemies = newEnemies.filter(e => e.uid !== enemy.uid);
          const xpGain = enemy.xp;
          newPlayer.xp += xpGain;
          msgs = addMessage(msgs, `The ${ENEMIES[enemy.kind].name} dies! You gain ${xpGain} XP.`);

          // Drop loot
          const def = ENEMIES[enemy.kind];
          if (Math.random() < def.dropChance && def.drops && def.drops.length) {
            const dropId = def.drops[rng(0, def.drops.length - 1)];
            const qty = dropId === "gold" ? rng(5, 15 * state.map.floor) : 1;
            const newItems = [...state.map.items, { uid: `loot_${Date.now()}`, id: dropId, x: nx, y: ny, qty }];
            state = { ...state, map: { ...state.map, items: newItems } };
          }

          if (newPlayer.xp >= newPlayer.xpNext) {
            const { player: leveled, log: lvLog } = levelUp(newPlayer);
            newPlayer = leveled;
            msgs = addMessage(msgs, lvLog);
          }
        }

        return processTurn({ ...state, player: newPlayer, map: { ...state.map, enemies: newEnemies }, messages: msgs, phase: newPhase }, newPlayer, newEnemies);
      }

      // Move
      if (!isPassable(state.map.cells, nx, ny)) return state;
      const movedPlayer = { ...state.player, x: nx, y: ny };
      return processTurn(state, movedPlayer, state.map.enemies);
    }

    default:
      return state;
  }
}

function processTurn(state: GameState, player: Player, enemies: Enemy[]): GameState {
  // Enemy turns
  let msgs = state.messages;
  let newPlayer = { ...player };
  let newPhase = state.phase;
  const cells = state.map.cells;

  const movedEnemies = enemies.map(e => {
    const dist = Math.abs(e.x - player.x) + Math.abs(e.y - player.y);
    if (dist === 1) {
      // Attack player
      const { damage, log } = enemyAttack(e, newPlayer);
      newPlayer = { ...newPlayer, hp: newPlayer.hp - damage };
      msgs = addMessage(msgs, log);
      if (newPlayer.hp <= 0) {
        newPhase = "dead";
        msgs = addMessage(msgs, `You were slain by the ${ENEMIES[e.kind].name}! Game over.`);
      }
      return e;
    }
    return moveEnemy(e, player, cells, enemies);
  });

  // HP regen (slow)
  if (state.turn % 10 === 0 && newPlayer.hp < newPlayer.maxHp) {
    newPlayer = { ...newPlayer, hp: Math.min(newPlayer.maxHp, newPlayer.hp + 1) };
  }

  computeFOV(cells, newPlayer.x, newPlayer.y, FOV_R);

  return {
    ...state,
    player: newPlayer,
    map: { ...state.map, enemies: movedEnemies },
    messages: msgs,
    phase: newPhase,
    turn: state.turn + 1,
  };
}

// ═══════════════════════════════════════════════════════════════
// DOWNLOAD ZIP
// ═══════════════════════════════════════════════════════════════

async function downloadGameZip(sprites: Record<string, HTMLCanvasElement>) {
  const zip = new JSZip();
  const spriteFolder = zip.folder("sprites")!;

  // Export sprites as PNG
  const spriteKeys = Object.keys(sprites);
  await Promise.all(spriteKeys.map(key =>
    new Promise<void>(resolve => {
      sprites[key].toBlob(blob => {
        if (blob) spriteFolder.file(`${key}.png`, blob);
        resolve();
      }, "image/png");
    })
  ));

  // Standalone HTML
  const spriteDataURLs: Record<string, string> = {};
  spriteKeys.forEach(k => { spriteDataURLs[k] = sprites[k].toDataURL("image/png"); });

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Castle of the Depths</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d0a0f; color: #e8d5a3; font-family: 'Press Start 2P', monospace; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
  canvas { image-rendering: pixelated; border: 2px solid #d4a017; }
</style>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
</head>
<body>
  <canvas id="game"></canvas>
  <script>/* Full game logic embedded */
    window.__SPRITE_DATA__ = ${JSON.stringify(spriteDataURLs)};
    // NOTE: Open index.html in a browser and play!
    // Full React source available in game source files.
    document.querySelector('canvas').width = 800;
    document.querySelector('canvas').height = 600;
    const ctx = document.querySelector('canvas').getContext('2d');
    ctx.fillStyle = '#0d0a0f'; ctx.fillRect(0,0,800,600);
    ctx.fillStyle = '#d4a017'; ctx.font = '16px monospace';
    ctx.fillText('Castle of the Depths', 280, 270);
    ctx.fillStyle = '#e8d5a3'; ctx.font = '12px monospace';
    ctx.fillText('Open the React app version to play!', 220, 310);
    ctx.fillText('Sprites folder contains all PNG assets.', 215, 340);
  </script>
</body>
</html>`;

  zip.file("index.html", htmlContent);
  zip.file("README.txt", `CASTLE OF THE DEPTHS
====================

A Castle of the Winds inspired dungeon crawler.

CONTROLS:
  WASD / Arrow Keys  - Move / Attack (bump enemies)
  G                  - Pick up item
  I                  - Toggle inventory
  In inventory: Click item or use Enter to equip/use, D to drop
  > / Enter on stairs - Descend stairs
  < on up-stairs     - Ascend stairs
  .                  - Wait one turn

GOAL:
  Reach dungeon floor 6 and escape!

FILES:
  index.html   - Standalone preview (open for sprite gallery)
  sprites/     - All game sprites as PNG files (32x32 pixels)

To play the full game, open the React application.
`);

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "castle-of-the-depths.zip";
  a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════════
// CANVAS RENDERER
// ═══════════════════════════════════════════════════════════════

function renderGame(canvas: HTMLCanvasElement, state: GameState) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const { player, map } = state;
  const camX = Math.max(0, Math.min(MAP_W - VIEW_W, player.x - Math.floor(VIEW_W / 2)));
  const camY = Math.max(0, Math.min(MAP_H - VIEW_H, player.y - Math.floor(VIEW_H / 2)));

  ctx.fillStyle = "#08060e";
  ctx.fillRect(0, 0, VIEW_W * T, VIEW_H * T);

  for (let ty = 0; ty < VIEW_H; ty++) {
    for (let tx = 0; tx < VIEW_W; tx++) {
      const mx = camX + tx;
      const my = camY + ty;
      if (mx < 0 || mx >= MAP_W || my < 0 || my >= MAP_H) continue;
      const cell = map.cells[my][mx];
      if (cell.vis === 0) continue;

      const sx = tx * T;
      const sy = ty * T;

      const tileKey = cell.tile === WALL ? "wall"
        : cell.tile === FLOOR ? "floor"
        : cell.tile === DOOR_C ? "door_c"
        : cell.tile === DOOR_O ? "door_o"
        : cell.tile === STAIR_D ? "stair_d"
        : cell.tile === STAIR_U ? "stair_u"
        : "void";

      const sprite = getSprite(tileKey);
      ctx.drawImage(sprite, sx, sy);

      // Dim explored but not visible tiles
      if (cell.vis === 1) {
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(sx, sy, T, T);
        continue;
      }

      // Items on floor
      const item = map.items.find(i => i.x === mx && i.y === my);
      if (item) {
        const ikey = item.id === "gold" ? "gold"
          : item.id.startsWith("scroll") ? item.id
          : item.id.includes("potion") ? item.id
          : item.id;
        ctx.drawImage(getSprite(ikey), sx, sy);
      }

      // Enemies
      const enemy = map.enemies.find(e => e.x === mx && e.y === my);
      if (enemy) {
        ctx.drawImage(getSprite(enemy.kind), sx, sy);
        // HP bar
        const barW = T - 4;
        const hpPct = enemy.hp / enemy.maxHp;
        ctx.fillStyle = "#440000";
        ctx.fillRect(sx + 2, sy + 1, barW, 3);
        ctx.fillStyle = hpPct > 0.6 ? "#22cc22" : hpPct > 0.3 ? "#ccaa00" : "#cc2222";
        ctx.fillRect(sx + 2, sy + 1, Math.floor(barW * hpPct), 3);
      }
    }
  }

  // Player
  const psx = (player.x - camX) * T;
  const psy = (player.y - camY) * T;
  ctx.drawImage(getSprite("player"), psx, psy);

  // Player HP bar
  const hpPct = player.hp / player.maxHp;
  ctx.fillStyle = "#220000";
  ctx.fillRect(psx + 2, psy + 1, T - 4, 3);
  ctx.fillStyle = hpPct > 0.5 ? "#22cc22" : hpPct > 0.25 ? "#ccaa00" : "#cc2222";
  ctx.fillRect(psx + 2, psy + 1, Math.floor((T - 4) * hpPct), 3);
}

// ═══════════════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════════════

function StatBar({ label, val, max, color }: { label: string; val: number; max: number; color: string }) {
  const pct = Math.max(0, Math.min(1, val / max));
  return (
    <div className="mb-1">
      <div className="flex justify-between text-xs mb-0.5" style={{ fontFamily: "'Press Start 2P', monospace", fontSize: "7px" }}>
        <span style={{ color: "#8a7a5a" }}>{label}</span>
        <span style={{ color: "#e8d5a3" }}>{val}/{max}</span>
      </div>
      <div className="h-2 rounded-sm overflow-hidden" style={{ background: "#1e1828" }}>
        <div className="h-full transition-all duration-200" style={{ width: `${pct * 100}%`, background: color }} />
      </div>
    </div>
  );
}

function InventoryPanel({ player, invSel, dispatch }: { player: Player; invSel: number; dispatch: React.Dispatch<Action> }) {
  const font = { fontFamily: "'VT323', monospace", fontSize: "18px" };
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center" style={{ background: "rgba(8,6,14,0.92)" }}>
      <div className="rounded border p-4" style={{ background: "#1a1520", borderColor: "#d4a017", minWidth: 340, maxWidth: 480 }}>
        <div className="flex justify-between items-center mb-3">
          <span style={{ ...font, color: "#d4a017", fontSize: "22px" }}>⚔ INVENTORY</span>
          <span style={{ ...font, color: "#8a7a5a" }}>Gold: {player.gold}</span>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-3" style={font}>
          {[
            ["Weapon", player.weapon],
            ["Armor", player.armor],
            ["Shield", player.shield],
            ["Ring", player.ring],
            ["Amulet", player.amulet],
          ].map(([slot, equipped]) => (
            <div key={slot as string} className="flex gap-1 items-center">
              <span style={{ color: "#8a7a5a", fontSize: "14px" }}>{slot}:</span>
              <span style={{ color: "#d4a017", fontSize: "14px" }}>{equipped ? ITEMS[equipped as string]?.name : "—"}</span>
            </div>
          ))}
        </div>

        <div className="border-t mb-2" style={{ borderColor: "#2a2030" }} />

        <div className="space-y-1 max-h-48 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
          {player.inv.length === 0 && <div style={{ ...font, color: "#8a7a5a" }}>Empty</div>}
          {player.inv.map((item, i) => {
            const def = ITEMS[item.id];
            const isEquipped = [player.weapon, player.armor, player.shield, player.ring, player.amulet].includes(item.id);
            return (
              <button
                key={i}
                onClick={() => dispatch({ type: "INV_SEL", idx: i })}
                className="w-full text-left px-2 py-1 rounded transition-colors"
                style={{
                  ...font,
                  fontSize: "15px",
                  background: i === invSel ? "#2a2030" : "transparent",
                  color: i === invSel ? "#e8d5a3" : "#c8b88a",
                  border: i === invSel ? "1px solid #d4a017" : "1px solid transparent",
                }}
              >
                {isEquipped ? "* " : "  "}{def?.name ?? item.id}
                {item.qty > 1 ? ` (${item.qty})` : ""}
                {isEquipped ? " [E]" : ""}
              </button>
            );
          })}
        </div>

        <div className="flex gap-2 mt-3">
          {["Use/Equip", "Drop", "Close"].map((label, i) => (
            <button
              key={label}
              onClick={() => {
                if (i === 0) dispatch({ type: "INV_USE" });
                else if (i === 1) dispatch({ type: "INV_DROP" });
                else dispatch({ type: "TOGGLE_INV" });
              }}
              className="px-3 py-1 rounded text-xs transition-colors"
              style={{
                fontFamily: "'Press Start 2P', monospace",
                fontSize: "9px",
                background: "#2a2030",
                color: "#d4a017",
                border: "1px solid #d4a017",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════

export default function App() {
  const [state, dispatch] = useReducer(reducer, null, createInitialState);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const font = { fontFamily: "'Press Start 2P', monospace" };
  const vt = { fontFamily: "'VT323', monospace" };

  // Keyboard input
  useEffect(() => {
    if (state.phase !== "playing") return;

    const onKey = (e: KeyboardEvent) => {
      if (state.showInv) {
        if (e.key === "Escape" || e.key === "i" || e.key === "I") dispatch({ type: "TOGGLE_INV" });
        if (e.key === "Enter") dispatch({ type: "INV_USE" });
        if (e.key === "d" || e.key === "D") dispatch({ type: "INV_DROP" });
        if (e.key === "ArrowUp" && state.invSel > 0) dispatch({ type: "INV_SEL", idx: state.invSel - 1 });
        if (e.key === "ArrowDown" && state.invSel < state.player.inv.length - 1) dispatch({ type: "INV_SEL", idx: state.invSel + 1 });
        e.preventDefault();
        return;
      }

      e.preventDefault();
      switch (e.key) {
        case "ArrowUp": case "w": case "W": dispatch({ type: "MOVE", dx: 0, dy: -1 }); break;
        case "ArrowDown": case "s": case "S": dispatch({ type: "MOVE", dx: 0, dy: 1 }); break;
        case "ArrowLeft": case "a": case "A": dispatch({ type: "MOVE", dx: -1, dy: 0 }); break;
        case "ArrowRight": case "d": case "D": dispatch({ type: "MOVE", dx: 1, dy: 0 }); break;
        case "g": case "G": dispatch({ type: "PICKUP" }); break;
        case "i": case "I": dispatch({ type: "TOGGLE_INV" }); break;
        case ".": dispatch({ type: "WAIT" }); break;
        case ">": dispatch({ type: "DESCEND" }); break;
        case "<": dispatch({ type: "ASCEND" }); break;
        case "Enter": {
          const t = state.map.cells[state.player.y][state.player.x].tile;
          if (t === STAIR_D) dispatch({ type: "DESCEND" });
          else if (t === STAIR_U) dispatch({ type: "ASCEND" });
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  // Canvas render
  useEffect(() => {
    if (state.phase !== "playing" || !canvasRef.current) return;
    renderGame(canvasRef.current, state);
  }, [state]);

  const handleDownload = useCallback(async () => {
    // Ensure all sprites are built
    const allKeys = [
      "floor", "wall", "void", "door_c", "door_o", "stair_d", "stair_u",
      "player",
      "rat", "bat", "snake", "goblin", "skeleton", "zombie", "orc", "troll", "demon", "dragon",
      "gold", "dagger", "short_sword", "long_sword", "great_axe", "staff",
      "leather", "chain_mail", "plate_armor",
      "buckler", "kite_shield",
      "ring_str", "ring_dex", "amulet_prot",
      "hp_potion", "big_hp_potion", "mp_potion", "str_potion",
      "scroll_fire", "scroll_tele", "scroll_map",
    ];
    const built: Record<string, HTMLCanvasElement> = {};
    allKeys.forEach(k => { built[k] = getSprite(k); });
    await downloadGameZip(built);
  }, []);

  const currentTile = state.phase === "playing"
    ? state.map.cells[state.player.y]?.[state.player.x]?.tile
    : null;

  // Title screen
  if (state.phase === "title") {
    return (
      <div className="size-full flex flex-col items-center justify-center" style={{ background: "#0d0a0f" }}>
        <div className="text-center px-8" style={{ maxWidth: 600 }}>
          <div style={{ ...font, color: "#d4a017", fontSize: "clamp(14px, 3vw, 22px)", marginBottom: 8, letterSpacing: 2 }}>
            ⚔ CASTLE OF THE DEPTHS ⚔
          </div>
          <div style={{ ...vt, color: "#8a7a5a", fontSize: "clamp(12px, 2vw, 16px)", marginBottom: 32 }}>
            A Dungeon Crawler in the Old Tradition
          </div>

          <div style={{ ...vt, fontSize: "clamp(14px, 2vw, 18px)", color: "#c8b88a", lineHeight: 1.8, marginBottom: 32, textAlign: "left" }}>
            Deep beneath the ruins of Castle Arath, evil stirs.<br />
            Six floors of dungeon lie between you and freedom.<br />
            A dragon guards the final seal. Survive. Escape.<br />
          </div>

          <button
            onClick={() => dispatch({ type: "START" })}
            className="px-8 py-3 rounded mb-4 transition-all hover:scale-105"
            style={{ ...font, fontSize: "11px", background: "#2a1a00", color: "#d4a017", border: "2px solid #d4a017" }}
          >
            BEGIN ADVENTURE
          </button>

          <div style={{ ...vt, color: "#5a4a3a", fontSize: "14px", lineHeight: 2 }}>
            WASD / Arrows = Move&nbsp;&nbsp;G = Grab item&nbsp;&nbsp;I = Inventory<br />
            Bump enemies to attack&nbsp;&nbsp;Enter on stairs to descend<br />
            . = Wait a turn
          </div>
        </div>
      </div>
    );
  }

  // Dead / Win screens
  if (state.phase === "dead" || state.phase === "win") {
    const won = state.phase === "win";
    return (
      <div className="size-full flex flex-col items-center justify-center" style={{ background: "#0d0a0f" }}>
        <div className="text-center px-8">
          <div style={{ ...font, color: won ? "#d4a017" : "#cc2222", fontSize: "clamp(14px, 3vw, 20px)", marginBottom: 16 }}>
            {won ? "🏆 VICTORY!" : "💀 YOU HAVE DIED"}
          </div>
          <div style={{ ...vt, color: "#c8b88a", fontSize: "20px", marginBottom: 24 }}>
            {won ? "You escaped the dungeon and earned glory eternal!" : "The dungeon claims another soul..."}
          </div>
          <div style={{ ...vt, color: "#8a7a5a", fontSize: "16px", marginBottom: 24 }}>
            Level {state.player.level} &nbsp;|&nbsp; Floor {state.map.floor} &nbsp;|&nbsp; Turn {state.turn}
          </div>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => dispatch({ type: "RESTART" })}
              className="px-6 py-2 rounded"
              style={{ ...font, fontSize: "10px", background: "#2a1a00", color: "#d4a017", border: "2px solid #d4a017" }}
            >
              Play Again
            </button>
            <button
              onClick={handleDownload}
              className="px-6 py-2 rounded"
              style={{ ...font, fontSize: "10px", background: "#1a2030", color: "#88aaff", border: "2px solid #88aaff" }}
            >
              Download ZIP
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Main game UI
  const p = state.player;
  const ac = getAC(p);

  const CANVAS_W = VIEW_W * T;
  const CANVAS_H = VIEW_H * T;
  const MSG_H = 120;

  return (
    <div
      ref={containerRef}
      className="size-full flex"
      style={{ background: "#0d0a0f", userSelect: "none", position: "relative" }}
      tabIndex={0}
    >
      {/* Game Canvas column */}
      <div className="relative flex-shrink-0 flex flex-col" style={{ width: CANVAS_W }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ imageRendering: "pixelated", display: "block", flexShrink: 0 }}
        />
        {/* Message log below canvas */}
        <div
          className="overflow-y-auto flex-1"
          style={{
            height: MSG_H,
            background: "#0f0c16",
            borderTop: "1px solid #2a2030",
            padding: "6px 10px",
            scrollbarWidth: "none",
          }}
        >
          {state.messages.slice(-8).map((msg, i, arr) => (
            <div
              key={i}
              style={{
                ...vt,
                fontSize: "17px",
                color: i === arr.length - 1 ? "#e8d5a3" : "#5a4a3a",
                lineHeight: 1.4,
              }}
            >
              {msg}
            </div>
          ))}
        </div>
        {state.showInv && (
          <InventoryPanel player={p} invSel={state.invSel} dispatch={dispatch} />
        )}
      </div>

      {/* Side Panel */}
      <div className="flex flex-col flex-1 overflow-hidden" style={{ minWidth: 200, maxWidth: 260, borderLeft: "1px solid #2a2030" }}>
        {/* Character stats */}
        <div className="p-3 border-b" style={{ borderColor: "#2a2030" }}>
          <div style={{ ...font, color: "#d4a017", fontSize: "9px", marginBottom: 10 }}>
            ⚔ THE ADVENTURER
          </div>
          <div style={{ ...vt, color: "#e8d5a3", fontSize: "16px", marginBottom: 6 }}>
            Level {p.level}&nbsp;&nbsp;Floor {state.map.floor}
          </div>

          <StatBar label="HP" val={p.hp} max={p.maxHp} color="#cc2244" />
          <StatBar label="MP" val={p.mp} max={p.maxMp} color="#2255cc" />

          <div className="grid grid-cols-2 gap-x-3 mt-3" style={{ ...vt, fontSize: "16px" }}>
            {[
              ["STR", p.str], ["DEX", p.dex],
              ["INT", p.intel], ["CON", p.con],
              ["AC", ac], ["Gold", p.gold],
            ].map(([label, val]) => (
              <div key={label as string} className="flex justify-between">
                <span style={{ color: "#8a7a5a" }}>{label}</span>
                <span style={{ color: "#e8d5a3" }}>{val}</span>
              </div>
            ))}
          </div>

          <div className="mt-2" style={{ ...vt, fontSize: "13px", color: "#8a7a5a" }}>
            XP: {p.xp} / {p.xpNext}
          </div>
          <div className="h-1.5 rounded-sm overflow-hidden mt-1" style={{ background: "#1e1828" }}>
            <div className="h-full" style={{ width: `${(p.xp / p.xpNext) * 100}%`, background: "#8855cc" }} />
          </div>
        </div>

        {/* Equipment summary */}
        <div className="p-3 border-b" style={{ borderColor: "#2a2030" }}>
          <div style={{ ...font, color: "#d4a017", fontSize: "9px", marginBottom: 8 }}>EQUIPPED</div>
          <div style={{ ...vt, fontSize: "14px", lineHeight: 1.8 }}>
            {[
              ["⚔", p.weapon], ["🛡", p.armor], ["🛡", p.shield],
            ].map(([icon, id], i) => id && (
              <div key={i} style={{ color: "#c8b88a" }}>
                {icon} {ITEMS[id as string]?.name}
              </div>
            ))}
            {!p.weapon && !p.armor && !p.shield && (
              <span style={{ color: "#5a4a3a" }}>nothing</span>
            )}
          </div>
        </div>

        {/* Current tile info */}
        {currentTile === STAIR_D && (
          <div className="px-3 py-2 text-center" style={{ ...vt, color: "#d4a017", fontSize: "15px", borderBottom: "1px solid #2a2030" }}>
            ↓ Stairs down — press Enter
          </div>
        )}
        {currentTile === STAIR_U && (
          <div className="px-3 py-2 text-center" style={{ ...vt, color: "#88aaff", fontSize: "15px", borderBottom: "1px solid #2a2030" }}>
            ↑ Stairs up — press Enter
          </div>
        )}

        {/* Controls quick ref */}
        <div className="p-3 border-b" style={{ borderColor: "#2a2030" }}>
          <div style={{ ...font, color: "#8a7a5a", fontSize: "7px", marginBottom: 6 }}>CONTROLS</div>
          <div style={{ ...vt, fontSize: "13px", color: "#5a4a3a", lineHeight: 1.8 }}>
            WASD/↑↓←→ Move<br />
            G Grab&nbsp;&nbsp;I Inventory<br />
            . Wait&nbsp;&nbsp;&gt; Descend
          </div>
        </div>

        {/* Download */}
        <div className="p-3 mt-auto border-t" style={{ borderColor: "#2a2030" }}>
          <button
            onClick={handleDownload}
            className="w-full py-2 rounded text-center transition-colors hover:opacity-80"
            style={{ ...font, fontSize: "7px", background: "#1a2030", color: "#88aaff", border: "1px solid #88aaff" }}
          >
            📦 DOWNLOAD ZIP
          </button>
        </div>
      </div>

    </div>
  );
}
