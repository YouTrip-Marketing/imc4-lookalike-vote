/**
 * The local (demo) adapter: the engine plus made-up voters and a pretend clock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../src/storage/keyValue';
import { LocalVoteStore, type LocalStoreOptions } from '../src/storage/localStore';
import { hasDemoControls } from '../src/storage/VoteStore';
import { clearVoteMarker, readVoteMarker, writeVoteMarker } from '../src/storage/voteMarker';
import { DURING, PASSCODE, makeConfig, requestId } from './fixtures';

const ALICE = 'alice@example.com';
const BEN = 'ben@example.com';

let storage: MemoryStorage;

function makeStore(overrides: Partial<LocalStoreOptions> = {}): LocalVoteStore {
  return new LocalVoteStore({
    config: makeConfig(),
    storage,
    now: () => DURING,
    random: () => 0.5,
    ...overrides,
  });
}

beforeEach(() => {
  storage = new MemoryStorage();
});

describe('voting through the demo adapter', () => {
  it('accepts a vote', async () => {
    const store = makeStore();
    const receipt = await store.castVote('c02', ALICE, requestId());
    expect(receipt).toMatchObject({ contestantId: 'c02', replaced: false });
  });

  it('rejects a second vote from the same email, with the plain message', async () => {
    const store = makeStore();
    await store.castVote('c02', ALICE, requestId());
    await expect(store.castVote('c03', ALICE, requestId())).rejects.toMatchObject({
      code: 'duplicate_vote',
      message: 'A vote has already been counted for this email.',
    });
  });

  it('treats the same address typed differently as the same voter', async () => {
    const store = makeStore();
    await store.castVote('c02', 'jane.doe@gmail.com', requestId());
    await expect(store.castVote('c03', '  JaneDoe+again@GMAIL.com ', requestId())).rejects.toMatchObject({
      code: 'duplicate_vote',
    });
  });

  it('accepts a second person on the same device with a different email', async () => {
    const store = makeStore();
    await store.castVote('c02', ALICE, requestId());
    await expect(store.castVote('c02', BEN, requestId())).resolves.toMatchObject({ contestantId: 'c02' });

    const snapshot = await store.adminGetSnapshot(PASSCODE);
    expect(snapshot.votes).toHaveLength(2);
    expect(new Set(snapshot.votes.map((vote) => vote.voterRef)).size).toBe(2);
  });

  it.each(['', 'alice', 'alice@example', '+tag@gmail.com'])(
    'refuses "%s" as invalid_email, and it uses up nothing',
    async (email) => {
      const store = makeStore();
      await expect(store.castVote('c01', email, requestId())).rejects.toMatchObject({
        code: 'invalid_email',
      });
      expect((await store.adminGetSnapshot(PASSCODE)).votes).toHaveLength(0);
    },
  );

  it('never keeps a readable email address in its vote state, the snapshot or browser storage', async () => {
    const store = makeStore();
    await store.castVote('c01', 'alice.tan@example.com', requestId());
    const everything = JSON.stringify([
      await store.adminGetSnapshot(PASSCODE),
      storage.getItem('imc4-voting-demo-v3'),
    ]);
    expect(everything).not.toContain('alice');
  });

  it('keeps votes across a reload, and shares them with another tab', async () => {
    await makeStore().castVote('c01', ALICE, requestId());
    const reloaded = makeStore();
    await expect(reloaded.castVote('c02', ALICE, requestId())).rejects.toMatchObject({
      code: 'duplicate_vote',
    });
  });

  it('starts clean if the stored demo data is corrupt', async () => {
    storage.setItem('imc4-voting-demo-v3', '{"engine": "nonsense"');
    const store = makeStore();
    await expect(store.getSession()).resolves.toMatchObject({ state: { status: 'open' } });
    expect((await store.adminGetSnapshot(PASSCODE)).votes).toHaveLength(0);
  });

  it('turns any failure into a VoteError the views can switch on', async () => {
    await expect(makeStore().castVote('not-a-contestant', ALICE, requestId())).rejects.toMatchObject({
      name: 'VoteError',
      code: 'invalid_vote',
    });
  });
});

describe('the audit record in the demo (simulated, in memory only)', () => {
  it('records the typed email, the normalised email and a simulated documentation-range IP', async () => {
    const store = makeStore();
    await store.castVote('c01', '  Jane.Doe+x@Gmail.com ', requestId());
    const [row] = await store.adminGetAudit(PASSCODE);
    expect(row).toMatchObject({
      emailTyped: 'Jane.Doe+x@Gmail.com',
      emailNormalised: 'janedoe@gmail.com',
      ip: '203.0.113.10',
      ipSource: 'simulated (demo)',
      votesFromIp: 1,
    });
  });

  it('needs the passcode', async () => {
    await expect(makeStore().adminGetAudit('guess')).rejects.toMatchObject({ code: 'bad_passcode' });
  });

  it('never writes a readable email or IP to browser storage', async () => {
    const store = makeStore();
    await store.castVote('c01', 'alice.tan@example.com', requestId());
    await store.nextSampleEmail({ sameNetwork: true });
    await store.simulateSharedNetwork(5);
    const stored = storage.getItem('imc4-voting-demo-v3') ?? '';
    expect(stored).not.toMatch(/alice|@|203\.0\.113|192\.0\.2|198\.51\.100/);
    expect((await store.adminGetAudit(PASSCODE)).length).toBe(6);
  });

  it('the admin snapshot (behind the publishable exports) holds no email or IP', async () => {
    const store = makeStore();
    await store.castVote('c01', 'alice.tan@example.com', requestId());
    await store.simulateSharedNetwork(3);
    const text = JSON.stringify(await store.adminGetSnapshot(PASSCODE));
    expect(text).not.toMatch(/alice|@|203\.0\.113|192\.0\.2/);
  });

  it('a new visitor gets a new simulated IP; "same wifi" keeps it', async () => {
    const store = makeStore();
    expect(store.demoVisitorIp()).toBe('203.0.113.10');
    await store.nextSampleEmail();
    expect(store.demoVisitorIp()).toBe('203.0.113.11');
    await store.nextSampleEmail({ sameNetwork: true });
    expect(store.demoVisitorIp()).toBe('203.0.113.11');
  });

  it('two visitors on the same wifi both vote, and the audit shows they share an IP', async () => {
    const store = makeStore();
    await store.castVote('c01', await store.nextSampleEmail(), requestId());
    await expect(store.castVote('c02', await store.nextSampleEmail({ sameNetwork: true }), requestId())).resolves.toBeDefined();
    const rows = await store.adminGetAudit(PASSCODE);
    expect(rows.map((row) => [row.ip, row.votesFromIp])).toEqual([
      ['203.0.113.11', 2],
      ['203.0.113.11', 2],
    ]);
  });

  it('simulated votes from one network show up as a shared-address group, without the address', async () => {
    const store = makeStore();
    expect(await store.simulateSharedNetwork(12)).toBe(12);
    const { sharedAddresses } = await store.adminGetSnapshot(PASSCODE);
    expect(sharedAddresses[0]?.votes).toBe(12);
    expect(sharedAddresses[0]?.contestants.reduce((sum, c) => sum + c.votes, 0)).toBe(12);
    expect((await store.adminGetAudit(PASSCODE)).every((row) => row.ip === '192.0.2.77')).toBe(true);
  });

  it('after a reload the votes remain but their audit records do not ("not kept")', async () => {
    await makeStore().castVote('c01', ALICE, requestId());
    const reloaded = makeStore();
    const [row] = await reloaded.adminGetAudit(PASSCODE);
    expect(row).toMatchObject({ emailTyped: '', ip: '', ipSource: 'not kept' });
  });

  it('reset clears the audit records too', async () => {
    const store = makeStore();
    await store.castVote('c01', ALICE, requestId());
    await store.reset();
    expect(await store.adminGetAudit(PASSCODE)).toEqual([]);
  });
});

describe('the pretend clock', () => {
  it('follows the real clock unless told otherwise', async () => {
    const before = makeStore({ now: () => new Date('2026-09-28T10:00:00+08:00') });
    expect((await before.getSession()).state.status).toBe('not_open');
    await expect(before.castVote('c01', ALICE, requestId())).rejects.toMatchObject({
      code: 'voting_not_open',
    });
  });

  it('can start inside the voting window, whatever today is', async () => {
    const store = makeStore({
      now: () => new Date('2026-09-28T10:00:00+08:00'),
      initialClock: 'during',
    });
    expect(store.demoClock()).toBe('during');
    expect((await store.getSession()).state.status).toBe('open');
    await expect(store.castVote('c01', ALICE, requestId())).resolves.toBeDefined();
  });

  it('moves before, during and after the window on request', async () => {
    const store = makeStore({ now: () => new Date('2026-09-28T10:00:00+08:00') });

    await store.setDemoClock('before');
    expect((await store.getSession()).state.status).toBe('not_open');

    await store.setDemoClock('during');
    expect((await store.getSession()).state.status).toBe('open');

    await store.setDemoClock('after');
    expect((await store.getSession()).state.status).toBe('closed');
    await expect(store.castVote('c01', ALICE, requestId())).rejects.toMatchObject({ code: 'voting_closed' });

    await store.setDemoClock('real');
    expect((await store.getSession()).state.status).toBe('not_open');
  });

  it('keeps ticking after it has been moved', async () => {
    let real = new Date('2026-09-28T10:00:00+08:00').getTime();
    const store = makeStore({ now: () => new Date(real), initialClock: 'during' });
    const first = Date.parse((await store.getSession()).state.serverTime);
    real += 90_000;
    const second = Date.parse((await store.getSession()).state.serverTime);
    expect(second - first).toBe(90_000);
  });
});

describe('admin through the demo adapter', () => {
  it('refuses a wrong passcode', async () => {
    await expect(makeStore().adminGetSnapshot('guess')).rejects.toMatchObject({ code: 'bad_passcode' });
    await expect(makeStore().adminSetStatus('guess', 'closed')).rejects.toMatchObject({
      code: 'bad_passcode',
    });
  });

  it('closing stops votes, reopening allows them again', async () => {
    const store = makeStore();
    expect((await store.adminSetStatus(PASSCODE, 'closed')).status).toBe('closed');
    await expect(store.castVote('c01', ALICE, requestId())).rejects.toMatchObject({ code: 'voting_closed' });
    expect((await store.adminSetStatus(PASSCODE, 'open')).status).toBe('open');
    await expect(store.castVote('c01', ALICE, requestId())).resolves.toBeDefined();
  });

  it('tells subscribers when something changes, and stops when they unsubscribe', async () => {
    const store = makeStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await store.castVote('c01', ALICE, requestId());
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await store.adminSetStatus(PASSCODE, 'closed');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('demo tools', () => {
  it('is recognised as a demo store', () => {
    const store = makeStore();
    expect(store.isDemo).toBe(true);
    expect(hasDemoControls(store)).toBe(true);
  });

  it('simulates votes from distinct made-up voters, inside the window', async () => {
    let seed = 0;
    const store = makeStore({ random: () => ((seed += 0.37) % 1) });
    expect(await store.simulateVotes(25)).toBe(25);

    const { votes } = await store.adminGetSnapshot(PASSCODE);
    expect(votes).toHaveLength(25);
    expect(new Set(votes.map((vote) => vote.voterRef)).size).toBe(25);
    for (const vote of votes) {
      expect(Date.parse(vote.castAt)).toBeGreaterThanOrEqual(Date.parse('2026-11-03T12:00:00+08:00'));
      expect(Date.parse(vote.castAt)).toBeLessThanOrEqual(DURING.getTime());
    }
  });

  it('simulated votes do not use up the vote of the person clicking', async () => {
    const store = makeStore();
    await store.simulateVotes(10);
    await expect(store.castVote('c01', ALICE, requestId())).resolves.toBeDefined();
  });

  it('simulates a burst: one contestant, a few minutes', async () => {
    const store = makeStore();
    expect(await store.simulateBurst(15)).toBe(15);
    const { votes } = await store.adminGetSnapshot(PASSCODE);
    expect(new Set(votes.map((vote) => vote.contestantId)).size).toBe(1);
    const times = votes.map((vote) => Date.parse(vote.castAt));
    expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(3 * 60_000);
  });

  it('simulates nothing while voting is not open, as a real vote would be refused', async () => {
    const store = makeStore();
    await store.setDemoClock('after');
    expect(await store.simulateVotes(10)).toBe(0);
    expect((await store.adminGetSnapshot(PASSCODE)).votes).toHaveLength(0);
  });

  it('hands out fresh sample addresses at example.com, and remembers the last one', async () => {
    const store = makeStore();
    expect(store.lastSampleEmail()).toBeNull();
    expect(await store.nextSampleEmail()).toBe('visitor1@example.com');
    expect(await store.nextSampleEmail()).toBe('visitor2@example.com');
    expect(store.lastSampleEmail()).toBe('visitor2@example.com');
  });

  it('a sample address votes once, and the same address again is refused', async () => {
    const store = makeStore();
    const sample = await store.nextSampleEmail();
    await store.castVote('c01', sample, requestId());
    await expect(store.castVote('c02', store.lastSampleEmail() ?? '', requestId())).rejects.toMatchObject({
      code: 'duplicate_vote',
    });
    await expect(store.castVote('c02', await store.nextSampleEmail(), requestId())).resolves.toBeDefined();
  });

  it('reset clears the votes and the sample addresses', async () => {
    const store = makeStore();
    await store.castVote('c01', ALICE, requestId());
    await store.nextSampleEmail();
    await store.reset();
    expect(store.lastSampleEmail()).toBeNull();
    expect((await store.adminGetSnapshot(PASSCODE)).votes).toHaveLength(0);
  });
});

describe('the "you voted" marker', () => {
  it('remembers the vote for this event only', () => {
    writeVoteMarker(storage, 'event-a', { contestantId: 'c07', votedAt: DURING.toISOString() });
    expect(readVoteMarker(storage, 'event-a')).toEqual({
      contestantId: 'c07',
      votedAt: DURING.toISOString(),
    });
    expect(readVoteMarker(storage, 'event-b')).toBeNull();
  });

  it('can be cleared', () => {
    writeVoteMarker(storage, 'event-a', { contestantId: 'c07', votedAt: DURING.toISOString() });
    clearVoteMarker(storage, 'event-a');
    expect(readVoteMarker(storage, 'event-a')).toBeNull();
  });

  it.each(['', 'not json', '42', 'null', '{"contestantId": 7}', '[]'])(
    'ignores a damaged marker (%s)',
    (raw) => {
      storage.setItem('imc4-voted:event-a', raw);
      expect(readVoteMarker(storage, 'event-a')).toBeNull();
    },
  );

  it('survives storage that throws, as a locked-down in-app browser might', () => {
    const hostile = {
      getItem: (): string | null => {
        throw new Error('SecurityError');
      },
      setItem: (): void => {
        throw new Error('QuotaExceededError');
      },
      removeItem: (): void => {
        throw new Error('SecurityError');
      },
    };
    expect(readVoteMarker(hostile, 'event-a')).toBeNull();
    expect(() =>
      writeVoteMarker(hostile, 'event-a', { contestantId: 'c01', votedAt: '' }),
    ).not.toThrow();
    expect(() => clearVoteMarker(hostile, 'event-a')).not.toThrow();
  });

  it('is not what stops a second vote: clearing it changes nothing on the server side', async () => {
    const store = makeStore();
    const receipt = await store.castVote('c01', ALICE, requestId());
    writeVoteMarker(storage, 'event-a', { contestantId: 'c01', votedAt: receipt.castAt });

    clearVoteMarker(storage, 'event-a');
    await expect(store.castVote('c02', ALICE, requestId())).rejects.toMatchObject({ code: 'duplicate_vote' });
  });
});
