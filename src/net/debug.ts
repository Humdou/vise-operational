import type { Cmd } from '../game/commands';

type EconomyAction = 'place' | 'queueUnit' | 'harvest';

interface CommandContext {
  uid?: string;
  from?: string;
  localPlayer?: number;
  playerId: number;
  command: Cmd['k'];
  round?: number;
}

interface EconomyLog {
  action: EconomyAction;
  owner: number;
  oreBefore: number;
  cost: number;
  oreAfter: number;
  subject?: string;
}

let currentCommand: CommandContext | null = null;
let localPlayerForDebug: number | null = null;
let uidByPlayer = new Map<number, string>();
let debugSeq = 0;

export function mpDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return /[?&](mpdebug|net=local)(?:[=&]|$)/.test(window.location.search);
}

export function mpDebug(label: string, data: Record<string, unknown>) {
  if (!mpDebugEnabled()) return;
  console.log(`[MPDEBUG] ${label} ${JSON.stringify({
    seq: ++debugSeq,
    at: Math.round(performance.now()),
    wall: Date.now(),
    ...data,
  })}`);
}

export function mpDebugSetCommandContext(ctx: CommandContext | null) {
  currentCommand = ctx;
}

export function mpDebugSetPlayerContext(localPlayer: number, players: { player: number; uid?: string }[]) {
  localPlayerForDebug = localPlayer;
  uidByPlayer = new Map(players.map(p => [p.player, p.uid ?? `ai:${p.player}`]));
}

export function mpDebugEconomy(log: EconomyLog) {
  if (!mpDebugEnabled()) return;
  const ctx = currentCommand;
  const uid = ctx?.uid ?? uidByPlayer.get(log.owner) ?? null;
  console.log(`[MPDEBUG] economy ${JSON.stringify({
    uid,
    from: ctx?.from ?? uid,
    localPlayer: ctx?.localPlayer ?? localPlayerForDebug,
    playerId: ctx?.playerId ?? log.owner,
    owner: log.owner,
    action: log.action,
    command: ctx?.command ?? null,
    round: ctx?.round ?? null,
    subject: log.subject ?? null,
    oreBefore: Math.round(log.oreBefore),
    cost: Math.round(log.cost),
    oreAfter: Math.round(log.oreAfter),
  })}`);
}
