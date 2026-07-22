// src/rules/eightball.js — Two-player 8-ball ruleset.
//
// Implements a faithful subset of standard (WPA/BCA-style) 8-ball:
//   - Open table after the break; groups (solids 1-7 / stripes 9-15) are
//     assigned on the first legal pocket after the break.
//   - You must contact one of your own group first (the 8 only once your
//     group is cleared). Wrong ball first, no rail after contact, no ball
//     hit, scratch, or driving a ball off the table are all fouls.
//   - A foul gives the opponent ball-in-hand (place the cue ball anywhere).
//   - Pocketing one of your own balls (no foul) lets you keep shooting.
//   - Sinking the 8 legally (group cleared, no foul) wins; sinking it early,
//     off the table, or with a foul loses.
//
// Simplification vs. the full rulebook: shots are not "called" (slop counts),
// which is the common casual convention. Everything else follows the rules.
//
// This module is the reference implementation of the ruleset interface (see
// src/game.js). Per-player group is stored on match.players[i].group; phase is
// 'break' | 'open' | 'play' | 'over'.
import { BALL_COLORS, ballStyle } from '../balldefs.js';
import { R } from '../constants.js';
import { shuffle } from './util.js';

export function groupOf(n) {
  if (n === 8) return 'eight';
  if (n >= 1 && n <= 7) return 'solid';
  if (n >= 9 && n <= 15) return 'stripe';
  return null; // cue or unknown
}

// Count balls of a group still on the table. Reads the room's live balls array
// off the match (match.balls) so each game instance is self-contained.
function countGroupRemaining(match, g) {
  let n = 0;
  for (const b of match.balls) if (b.number != null && groupOf(b.number) === g) n++;
  return n;
}

function groupLabel(g) {
  if (g === 'solid') return '实色 (1-7)';
  if (g === 'stripe') return '花色 (9-15)';
  return '—';
}

// --- Rack: randomized triangle with the 8 in the centre and one ball of each
// group in the two back corners (standard racking constraints). --------------
function rack({ tableW }) {
  const layout = [{ x: -tableW * 0.25, z: 0, number: null, style: 'cue', color: '#ffffff', jitter: 0 }];

  const gap = 1.005;
  const dx = Math.sqrt(3) * R * gap;
  const dz = 2 * R * gap;
  const apexX = tableW * 0.25;
  const apexZ = 0;

  const push = (x, z, n) =>
    layout.push({ x, z, number: n, style: ballStyle(n), color: BALL_COLORS[n], jitter: 0.001 });
  const placeRow = (k, rowIndex, numbers) => {
    const x = apexX + rowIndex * dx;
    const totalWidth = (k - 1) * dz;
    for (let i = 0; i < k; i++) push(x, apexZ - totalWidth / 2 + i * dz, numbers[i]);
  };

  const remaining = Array.from({ length: 15 }, (_, i) => i + 1).filter(n => n !== 8);
  const solids = shuffle(remaining.filter(n => n <= 7));
  const stripes = shuffle(remaining.filter(n => n >= 9));
  const solidOnLeft = Math.random() < 0.5;
  const bottomSolid = solids.pop();
  const bottomStripe = stripes.pop();

  const pool = shuffle(remaining.filter(n => (n <= 7 ? n !== bottomSolid : n !== bottomStripe)));
  const cornerL = solidOnLeft ? bottomSolid : bottomStripe;
  const cornerR = solidOnLeft ? bottomStripe : bottomSolid;

  placeRow(1, 0, [pool.pop()]);
  placeRow(2, 1, [pool.pop(), pool.pop()]);
  placeRow(3, 2, [pool.pop(), 8, pool.pop()]);
  placeRow(4, 3, [pool.pop(), pool.pop(), pool.pop(), pool.pop()]);
  placeRow(5, 4, [cornerL, pool.pop(), pool.pop(), pool.pop(), cornerR]);

  return layout;
}

function init(match) {
  match.players[0].group = null;
  match.players[1].group = null;
  match.phase = 'break';
  match.message = `${match.players[0].name} 开球。`;
}

// Pre-shot snapshot: legality of a shot depends on the state *before* it, so
// capture whether the shooter was on the 8 (their group already cleared).
function snapshot(match) {
  const myGroup = match.players[match.current].group;
  return {
    myGroup,
    wasOnEight: myGroup != null && countGroupRemaining(match, myGroup) === 0,
  };
}

function over(match, winnerIdx, why) {
  return {
    gameOver: true,
    winner: winnerIdx,
    message: `${match.players[winnerIdx].name} 获胜 — ${why}。`,
  };
}

// Which numbers may the cue ball legally contact first right now?
//
// Consumed by the shot chooser (src/server/ai.js), NOT by resolve() — it is a
// planning aid, not the legality judge. That is why it is deliberately STRICTER
// than resolve on the break: resolve allows any first contact there, but a bot
// gains nothing by breaking off the 8, so the 8 is excluded. Widening this to
// match resolve exactly would change how the bot breaks; don't do it casually.
function legalTargets(match) {
  const onTable = match.balls.filter(b => b.number != null).map(b => b.number);
  if (match.phase === 'play') {
    const grp = match.players[match.current].group;
    const mine = onTable.filter(n => groupOf(n) === grp);
    return mine.length ? mine : onTable.filter(n => n === 8);   // group cleared → on the 8
  }
  // break / open table: anything but the 8 is always safe to contact first.
  const open = onTable.filter(n => n !== 8);
  return open.length ? open : onTable;
}

function resolve(s, match) {
  const me = match.current;
  const opp = 1 - me;
  const P = match.players;
  const myGroup = P[me].group;

  const pocketed = s.pocketed;
  const eightPocketed = pocketed.includes(8);
  const eightOff = s.ballsOffTable.includes(8);
  const objectOff = s.ballsOffTable.length > 0;

  // ---- Foul detection (any single condition → foul) ----
  let foul = false, reason = '';
  if (s.cueScratch) { foul = true; reason = '白球落袋（犯规）'; }
  else if (s.firstHit == null) { foul = true; reason = '未触球'; }
  else if (!s.railAfterContact && pocketed.length === 0) {
    foul = true; reason = '未碰库边';
  } else if (objectOff) {
    foul = true; reason = '球被打出球台';
  } else {
    const fhGroup = groupOf(s.firstHit);
    if (s.isBreak) {
      // Any first contact is legal on the break.
    } else if (match.phase === 'open') {
      if (fhGroup === 'eight') { foul = true; reason = '开放台面击中8号球'; }
    } else { // groups assigned ('play')
      if (s.pre.wasOnEight) {
        if (fhGroup !== 'eight') { foul = true; reason = '必须先击中8号球'; }
      } else if (fhGroup !== myGroup) {
        const groupName = myGroup === 'solid' ? '实色' : '花色';
        foul = true; reason = `必须先击中 ${groupName} 球`;
      }
    }
  }

  // Break-specific legality: pocket a ball OR drive ≥4 balls to a rail.
  if (s.isBreak && !foul && pocketed.length === 0 && s.railedBalls.size < 4) {
    foul = true; reason = '非法开球（需让4球碰库或进球）';
  }

  // ---- 8-ball win / loss ----
  if (eightOff) {
    return over(match, opp, `${P[me].name} 将8号球打出球台`);
  }
  if (eightPocketed && !s.isBreak) {
    if (s.pre.wasOnEight && !foul) return over(match, me, '打进8号球');
    return over(match, opp, `${P[me].name} 非法打进8号球`);
  }

  // ---- Group assignment (open table only, non-break, legal shot) ----
  let assignedNow = false;
  if (!foul && match.phase === 'open' && !s.isBreak) {
    const madeSolid = pocketed.some(n => groupOf(n) === 'solid');
    const madeStripe = pocketed.some(n => groupOf(n) === 'stripe');
    if (madeSolid !== madeStripe) { // exactly one group pocketed
      const g = madeSolid ? 'solid' : 'stripe';
      P[me].group = g;
      P[opp].group = g === 'solid' ? 'stripe' : 'solid';
      match.phase = 'play';
      assignedNow = true;
    }
    // Both groups (or none) → table stays open.
  }

  // The table is always open immediately after the break.
  if (s.isBreak && match.phase !== 'over') match.phase = 'open';

  // ---- Fouls: pass turn + ball in hand ----
  if (foul) {
    return { foul: true, reason, message: `${reason}。${P[opp].name} 获得手中球。` };
  }

  // ---- No foul: does the shooter keep the table? ----
  let continues;
  if (s.isBreak) {
    continues = pocketed.length > 0;              // pocketed on the break → shoot again
  } else if (match.phase === 'open' || assignedNow) {
    continues = pocketed.length > 0;
  } else if (match.phase === 'play') {
    continues = pocketed.some(n => groupOf(n) === myGroup);
  } else {
    continues = pocketed.length > 0;
  }

  if (continues) return { continues: true, message: `${P[me].name} 继续击球。` };
  return { continues: false, message: `轮到 ${P[opp].name}。` };
}

function hud(match) {
  const chips = [];
  for (let i = 0; i < 2; i++) {
    const g = match.players[i].group;
    const onEight = g && countGroupRemaining(match, g) === 0;
    chips.push({
      text: match.players[i].name +
        (g ? ` · ${g === 'solid' ? '实色' : '花色'}` : '') +
        (onEight ? ' · 目标8号' : ''),
      active: i === match.current && match.phase !== 'over',
    });
  }
  const status = match.phase === 'break' ? '开球'
    : match.phase === 'open' ? '台面开放 — 尚未分配分组'
    : match.phase === 'over' ? '游戏结束'
    : `你的分组: ${groupLabel(match.players[match.current].group)}`;
  return { chips, status };
}

export const eightBall = {
  meta: { id: '8ball', name: '8球' },
  rack, init, snapshot, resolve, hud, legalTargets,
};
