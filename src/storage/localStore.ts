import {
  INITIAL_ENGINE_STATE,
  castVote,
  readAdminSnapshot,
  readAudit,
  readSession,
  setAdminStatus,
  type EngineConfig,
  type EngineState,
} from '../domain/engine';
import { canonicalEmail } from '../domain/email';
import { VoteError, toVoteError } from '../domain/errors';
import type {
  AdminSnapshot,
  AdminStatus,
  AuditRecord,
  AuditRow,
  ContestantId,
  EventState,
  PublicSession,
  VoteReceipt,
  VoterIdentity,
} from '../domain/types';
import { effectiveStatus } from '../domain/voting';
import type { KeyValueStorage } from './keyValue';
import type { DemoClockPhase, DemoControls, VoteStore } from './VoteStore';

export interface LocalStoreOptions {
  config: EngineConfig;
  storage: KeyValueStorage;
  storageKey?: string;
  /** The real clock. The pretend clock is this plus a stored offset. */
  now?: () => Date;
  /** Artificial latency so loading and saving states are visible in the demo. */
  latencyMs?: number;
  /** Cross-tab notifications. Omitted in tests. */
  channel?: Pick<BroadcastChannel, 'postMessage' | 'addEventListener' | 'removeEventListener'>;
  random?: () => number;
  /** Where the pretend clock starts on a fresh browser. */
  initialClock?: DemoClockPhase;
}

interface DemoState {
  engine: EngineState;
  clock: DemoClockPhase;
  clockOffsetMs: number;
  /** Counter behind the made-up crowd of voters and their request ids. */
  sequence: number;
  /** How many sample addresses (visitor1@example.com, ...) have been handed out. */
  samples: number;
  /** Which stand-in IP the current visitor has (see visitorIp). Absent in older demo data. */
  ipIndex?: number;
}

const DEFAULT_KEY = 'imc4-voting-demo-v3';
const SAMPLE_DOMAIN = 'example.com';

/**
 * SIMULATED. Stands in for the keyed hash the real backend makes, so that the
 * demo's vote state (the part kept in browser storage) never holds a readable
 * address either. It is a plain checksum, not
 * cryptography: good enough to tell demo voters apart, useless as protection.
 */
export function simulatedVoterKey(canonical: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b + code, 0x85ebca6b) >>> 0;
    b = ((b << 13) | (b >>> 19)) >>> 0;
  }
  const hex = (value: number): string => value.toString(16).padStart(8, '0');
  return `sim${hex(a)}${hex(b)}${hex((a ^ b) >>> 0)}`;
}
const HOUR = 60 * 60 * 1000;

/**
 * SIMULATED IP addresses, all from the ranges reserved for documentation
 * (RFC 5737), so nobody can mistake them for real ones. The audit export labels
 * every one "simulated (demo)".
 *   203.0.113.x  the person clicking through the demo, one per demo visitor
 *   198.51.100.x the simulated crowd
 *   192.0.2.77   the "many votes from one network" simulation
 */
const visitorIp = (index: number): string => `203.0.113.${10 + (index % 240)}`;
const crowdIp = (n: number): string => `198.51.100.${1 + (n % 250)}`;
const SHARED_NETWORK_IP = '192.0.2.77';

function isDemoState(value: unknown): value is DemoState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DemoState>;
  const engine = candidate.engine as Partial<EngineState> | undefined;
  return (
    typeof engine === 'object' &&
    engine !== null &&
    (engine.adminStatus === 'pending' ||
      engine.adminStatus === 'open' ||
      engine.adminStatus === 'closed') &&
    Array.isArray(engine.votes) &&
    (candidate.clock === 'real' ||
      candidate.clock === 'before' ||
      candidate.clock === 'during' ||
      candidate.clock === 'after') &&
    typeof candidate.clockOffsetMs === 'number' &&
    typeof candidate.sequence === 'number' &&
    typeof candidate.samples === 'number' &&
    (candidate.ipIndex === undefined || typeof candidate.ipIndex === 'number')
  );
}

/**
 * DEMO store. Runs the voting engine in the browser and keeps state in
 * localStorage, so the draft is fully clickable with no credentials.
 *
 * It is not a voting system. State is per-browser, the clock can be moved by
 * hand, and anyone can edit any of it from dev tools. Nothing here may be used
 * for the real vote.
 */
export class LocalVoteStore implements VoteStore, DemoControls {
  readonly kind = 'local' as const;
  readonly isDemo = true;
  readonly demoPasscode: string;

  private readonly config: EngineConfig;
  private readonly storage: KeyValueStorage;
  private readonly storageKey: string;
  private readonly realNow: () => Date;
  private readonly latencyMs: number;
  private readonly channel: LocalStoreOptions['channel'];
  private readonly random: () => number;
  private readonly initialClock: DemoClockPhase;
  private readonly listeners = new Set<() => void>();
  /**
   * AUDIT RECORDS (readable email, IP) by vote id. IN MEMORY ONLY, never written
   * to browser storage: a readable email must not be left on the device. So in
   * the demo they last until the page is reloaded; votes from before a reload
   * show in the audit export with blanks ("not kept").
   */
  private readonly audit = new Map<number, AuditRecord>();

  constructor(options: LocalStoreOptions) {
    this.config = options.config;
    this.demoPasscode = options.config.passcode;
    this.storage = options.storage;
    this.storageKey = options.storageKey ?? DEFAULT_KEY;
    this.realNow = options.now ?? (() => new Date());
    this.latencyMs = options.latencyMs ?? 0;
    this.channel = options.channel;
    this.random = options.random ?? Math.random;
    this.initialClock = options.initialClock ?? 'real';
  }

  // ---------------------------------------------------------------- state

  private fresh(): DemoState {
    return {
      engine: INITIAL_ENGINE_STATE,
      clock: this.initialClock,
      clockOffsetMs: this.offsetFor(this.initialClock),
      sequence: 0,
      samples: 0,
    };
  }

  private read(): DemoState {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (isDemoState(parsed)) return parsed;
      }
    } catch {
      // Corrupt or outdated demo data is dropped rather than crashing the page.
    }
    // Pin the starting offset, so the pretend clock ticks forward from here on.
    const state = this.fresh();
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(state));
    } catch {
      // Storage blocked: the demo still works, it just starts over on each read.
    }
    return state;
  }

  private write(state: DemoState): void {
    this.storage.setItem(this.storageKey, JSON.stringify(state));
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
    this.channel?.postMessage('changed');
  }

  private now(state: DemoState): Date {
    return new Date(this.realNow().getTime() + state.clockOffsetMs);
  }

  /** How far to shift the clock so that "now" lands in the requested part of the window. */
  private offsetFor(phase: DemoClockPhase): number {
    const opensAt = this.config.window.opensAt === null ? NaN : Date.parse(this.config.window.opensAt);
    const closesAt =
      this.config.window.closesAt === null ? NaN : Date.parse(this.config.window.closesAt);
    const real = this.realNow().getTime();

    let target = real;
    if (phase === 'before' && !Number.isNaN(opensAt)) target = opensAt - 26 * HOUR;
    if (phase === 'after' && !Number.isNaN(closesAt)) target = closesAt + HOUR;
    if (phase === 'during') {
      if (!Number.isNaN(opensAt) && !Number.isNaN(closesAt)) {
        target = opensAt + (closesAt - opensAt) * 0.4;
      } else if (!Number.isNaN(opensAt)) target = Math.max(real, opensAt + HOUR);
      else if (!Number.isNaN(closesAt)) target = Math.min(real, closesAt - HOUR);
    }
    return target - real;
  }

  // ------------------------------------------------------------- identity

  /** The demo's stand-in for the backend's identity resolver. Same rule for what counts as one voter. */
  private identify(email: unknown): VoterIdentity {
    const canonical = canonicalEmail(email);
    if (canonical === null) throw new VoteError('invalid_email');
    return { voterKey: simulatedVoterKey(canonical) };
  }

  private nextRequestId(sequence: number): string {
    return `sim-${sequence}-${Math.floor(this.random() * 1e9).toString(36)}`;
  }

  // ------------------------------------------------------------ VoteStore

  private async run<T>(operation: () => T): Promise<T> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    try {
      return operation();
    } catch (error) {
      throw toVoteError(error);
    }
  }

  getSession(): Promise<PublicSession> {
    return this.run(() => {
      const state = this.read();
      return readSession(state.engine, this.config, this.now(state));
    });
  }

  castVote(contestantId: ContestantId, email: string, requestId: string): Promise<VoteReceipt> {
    return this.run(() => {
      const state = this.read();
      const result = castVote(
        state.engine,
        this.config,
        this.identify(email),
        contestantId,
        requestId,
        this.now(state),
      );
      this.recordAudit(state.engine, result.state, email, visitorIp(state.ipIndex ?? 0));
      if (result.state !== state.engine) this.write({ ...state, engine: result.state });
      return result.receipt;
    });
  }

  /** Records the audit row for a vote the engine has just added, if it added one. */
  private recordAudit(before: EngineState, after: EngineState, email: string, ip: string): void {
    if (after.votes.length <= before.votes.length) return;
    const added = after.votes.reduce((latest, vote) => (vote.id > latest.id ? vote : latest));
    this.audit.set(added.id, {
      emailTyped: email.trim(),
      emailNormalised: canonicalEmail(email) ?? '',
      ip,
      ipSource: 'simulated (demo)',
    });
  }

  adminGetSnapshot(passcode: string): Promise<AdminSnapshot> {
    return this.run(() => {
      const state = this.read();
      return readAdminSnapshot(state.engine, this.config, passcode, this.now(state), this.audit);
    });
  }

  adminGetAudit(passcode: string): Promise<AuditRow[]> {
    return this.run(() => readAudit(this.read().engine, this.config, passcode, this.audit));
  }

  adminSetStatus(passcode: string, status: AdminStatus): Promise<EventState> {
    return this.run(() => {
      const state = this.read();
      const engine = setAdminStatus(state.engine, this.config, passcode, status);
      this.write({ ...state, engine });
      return readSession(engine, this.config, this.now(state)).state;
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    const onMessage = (): void => listener();
    this.channel?.addEventListener('message', onMessage);
    return () => {
      this.listeners.delete(listener);
      this.channel?.removeEventListener('message', onMessage);
    };
  }

  // --------------------------------------------------------- DemoControls

  nextSampleEmail(options: { sameNetwork?: boolean } = {}): Promise<string> {
    return this.run(() => {
      const state = this.read();
      const samples = state.samples + 1;
      // A new visitor gets a new stand-in IP, unless they are on the same wifi.
      const ipIndex = options.sameNetwork === true ? (state.ipIndex ?? 0) : samples;
      this.write({ ...state, samples, ipIndex });
      return `visitor${samples}@${SAMPLE_DOMAIN}`;
    });
  }

  demoVisitorIp(): string {
    return visitorIp(this.read().ipIndex ?? 0);
  }

  lastSampleEmail(): string | null {
    const { samples } = this.read();
    return samples === 0 ? null : `visitor${samples}@${SAMPLE_DOMAIN}`;
  }

  demoClock(): DemoClockPhase {
    return this.read().clock;
  }

  setDemoClock(phase: DemoClockPhase): Promise<void> {
    return this.run(() => {
      this.write({ ...this.read(), clock: phase, clockOffsetMs: this.offsetFor(phase) });
    });
  }

  /**
   * Casts votes from made-up voters, through the same engine rules as a real
   * vote, at times spread across the voting so far. Returns how many were cast.
   */
  simulateVotes(count: number): Promise<number> {
    return this.run(() => {
      const ids = this.config.contestantIds;
      return this.simulate(count, (now) => {
        const opensAt =
          this.config.window.opensAt === null ? NaN : Date.parse(this.config.window.opensAt);
        const earliest = Number.isNaN(opensAt) ? now - 6 * HOUR : Math.max(opensAt, now - 36 * HOUR);
        // Skewed so the demo ranking has a visible shape instead of a flat line.
        const pick = ids[Math.floor(Math.pow(this.random(), 1.6) * ids.length)];
        // A few simulated voters share a network, as households do.
        const ip = crowdIp(Math.floor(this.random() * 60));
        return { contestantId: pick, at: earliest + this.random() * (now - earliest), ip };
      });
    });
  }

  simulateBurst(count: number): Promise<number> {
    return this.run(() => {
      const ids = this.config.contestantIds;
      const target = ids[Math.floor(this.random() * ids.length)];
      return this.simulate(count, (now) => ({
        contestantId: target,
        at: now - this.random() * 3 * 60_000,
        ip: crowdIp(100 + Math.floor(this.random() * 150)),
      }));
    });
  }

  /**
   * Casts `count` votes from different made-up voters who all share one IP
   * address, mostly for one or two contestants: what an office or campus
   * network looks like. For seeing the "many votes from one network" flag.
   */
  simulateSharedNetwork(count: number): Promise<number> {
    return this.run(() => {
      const ids = this.config.contestantIds;
      const main = ids[Math.floor(this.random() * ids.length)];
      const second = ids[Math.floor(this.random() * ids.length)];
      return this.simulate(count, (now) => ({
        contestantId: this.random() < 0.7 ? main : second,
        at: now - this.random() * 20 * 60_000,
        ip: SHARED_NETWORK_IP,
      }));
    });
  }

  private simulate(
    count: number,
    plan: (nowMs: number) => { contestantId: ContestantId | undefined; at: number; ip: string },
  ): number {
    let state = this.read();
    const now = this.now(state);
    if (effectiveStatus(state.engine.adminStatus, this.config.window, now) !== 'open') return 0;

    let cast = 0;
    for (let index = 0; index < Math.max(0, count); index += 1) {
      const sequence = state.sequence + 1;
      const { contestantId, at, ip } = plan(now.getTime());
      const email = `crowd${sequence}@simulated.${SAMPLE_DOMAIN}`;
      const result = castVote(
        state.engine,
        this.config,
        this.identify(email),
        contestantId,
        this.nextRequestId(sequence),
        new Date(at),
      );
      this.recordAudit(state.engine, result.state, email, ip);
      state = { ...state, engine: result.state, sequence };
      cast += 1;
    }
    if (cast > 0) this.write(state);
    return cast;
  }

  reset(): Promise<void> {
    return this.run(() => {
      this.storage.removeItem(this.storageKey);
      this.audit.clear();
      this.notify();
    });
  }
}
