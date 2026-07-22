// src/rules/nineball.js — Two-player 9-ball ruleset.
//
// Standard (WPA-style) 9-ball, common casual subset:
//   - Balls 1-9 racked in a diamond, the 1 at the foot spot and the 9 in the
//     centre. Play is "rotation": the cue ball must always strike the
//     LOWEST-numbered ball on the table first.
//   - Any ball pocketed on a legal shot stays down and the shooter continues.
//   - Pocketing the 9 on a legal shot wins the game.
//   - Wrong ball first, no rail after contact (and nothing pocketed), scratch,
//     or driving a ball off the table are fouls → opponent gets ball in hand.
//
// Simplifications: shots are not called (slop counts, incl. the 9 on a combo);
// a ball driven off the table is spotted by the caller and counts as a foul;
// and pocketing the 9 on a foul is scored as a loss rather than being spotted
// (keeps the game decisive without extra respotting machinery).
import { R } from '../constants.js';
import { shuffle } from './util.js';

// Reads the room's live balls off the match so each game instance is isolated.
function numbersOnTable(match) {
  return match.balls.filter(b => b.number != null).map(b => b.number);
}
function lowestOnTable(match) {
  const ns = numbersOnTable(match);
  return ns.length ? Math.min(...ns) : null;
}

// --- Rack: 1 at the apex, 9 in the centre, 2-8 shuffled around them. ---------
function rack({ tableW }) {
  const layout = [{ x: -tableW * 0.25, z: 0, number: null, style: 'cue', color: '#ffffff', jitter: 0 }];

  const gap = 1.005;
  const dx = Math.sqrt(3) * R * gap;
  const dz = 2 * R * gap;
  const apexX = tableW * 0.25;

  // Diamond: row sizes 1,2,3,2,1 (centre row holds the 9).
  const rows = [1, 2, 3, 2, 1];
  const spots = [];
  rows.forEach((k, r) => {
    const x = apexX + r * dx;
    const totalWidth = (k - 1) * dz;
    for (let i = 0; i < k; i++) spots.push({ x, z: -totalWidth / 2 + i * dz, isCentre: k === 3 && i === 1 });
  });

  const others = shuffle([2, 3, 4, 5, 6, 7, 8]);
  let oi = 0;
  spots.forEach((sp, idx) => {
    const n = idx === 0 ? 1 : sp.isCentre ? 9 : others[oi++];
    layout.push({ x: sp.x, z: sp.z, number: n, jitter: 0.001 });
  });

  return layout;
}

function init(match) {
  match.phase = 'break';
  match.message = `${match.players[0].name} 开球。`;
}

// The legal target is the lowest ball on the table at the moment of the shot.
function snapshot(match) {
  return { lowest: lowestOnTable(match) };
}

// Which numbers may the cue ball legally contact first right now? Rotation, so
// always the lowest ball on the table.
//
// Consumed by the shot chooser (src/server/ai.js), NOT by resolve() — it is a
// planning aid, not the legality judge. Deliberately STRICTER than resolve on
// the break, where resolve skips the lowest-ball check entirely: hitting the
// lowest ball is legal in every phase, so the bot never needs the exception,
// and keeping it uniform means break play does not depend on this function.
function legalTargets(match) {
  const low = lowestOnTable(match);
  return low == null ? [] : [low];
}

function over(match, winnerIdx, why) {
  return {
    gameOver: true,
    winner: winnerIdx,
    message: `${match.players[winnerIdx].name} 获胜 — ${why}。`,
  };
}

function resolve(s, match) {
  const me = match.current;
  const opp = 1 - me;
  const P = match.players;

  const pocketed = s.pocketed;
  const ninePocketed = pocketed.includes(9);
  const objectOff = s.ballsOffTable.length > 0;

  // ---- Foul detection ----
  let foul = false, reason = '';
  if (s.cueScratch) { foul = true; reason = '白球落袋（犯规）'; }
  else if (s.firstHit == null) { foul = true; reason = '未触球'; }
  else if (!s.isBreak && s.pre.lowest != null && s.firstHit !== s.pre.lowest) {
    foul = true; reason = `必须先击中 ${s.pre.lowest} 号球`;
  } else if (!s.railAfterContact && pocketed.length === 0) {
    foul = true; reason = '未碰库边';
  } else if (objectOff) {
    foul = true; reason = '球被打出球台';
  }

  // Break-specific legality: pocket a ball OR drive ≥4 balls to a rail.
  if (s.isBreak && !foul && pocketed.length === 0 && s.railedBalls.size < 4) {
    foul = true; reason = '非法开球（需让4球碰库或进球）';
  }

  // After the break, it's normal rotation play.
  if (s.isBreak && match.phase !== 'over') match.phase = 'play';

  // ---- 9-ball win / loss ----
  if (ninePocketed) {
    if (!foul) return over(match, me, '打进9号球');
    return over(match, opp, `${P[me].name} 犯规打进9号球`);
  }

  // ---- Fouls: pass turn + ball in hand ----
  if (foul) {
    return { foul: true, reason, message: `${reason}。${P[opp].name} 获得手中球。` };
  }

  // ---- No foul: pocketing any ball keeps the shooter at the table. ----
  const continues = pocketed.length > 0;
  if (continues) return { continues: true, message: `${P[me].name} 继续击球。` };
  return { continues: false, message: `轮到 ${P[opp].name}。` };
}

function hud(match) {
  const chips = [];
  for (let i = 0; i < 2; i++) {
    chips.push({
      text: match.players[i].name,
      active: i === match.current && match.phase !== 'over',
    });
  }
  const low = lowestOnTable(match);
  const status = match.phase === 'break' ? '开球'
    : match.phase === 'over' ? '游戏结束'
    : low != null ? `顺序击球 — 先打 ${low} 号` : '顺序击球';
  return { chips, status };
}

export const nineBall = {
  meta: { id: '9ball', name: '9球' },
  rack, init, snapshot, resolve, hud, legalTargets,
};
