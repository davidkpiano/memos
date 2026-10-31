import assert from 'node:assert/strict';
import { createMachine, defineCampaign, defineRequirements, fc } from 'statelyai/testing';

const base = process.env.MEMOS_BASE_URL ?? 'http://127.0.0.1:8081';
const password = process.env.MEMOS_PASSWORD;
if (!password) throw new Error('Set MEMOS_PASSWORD for the local throwaway account.');
const content = 'Stately weekend dogfood: lifecycle and privacy #stately';
const login = await fetch(`${base}/api/auth/signin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ passwordCredentials: {
    username: process.env.MEMOS_USERNAME ?? 'weekend-admin', password,
  } }),
});
if (!login.ok) throw new Error(`Local sign-in failed: HTTP ${login.status}`);
const { accessToken } = await login.json();
if (!accessToken) throw new Error('Sign-in omitted accessToken.');

async function request(path, method = 'GET', body, authenticated = true) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(authenticated ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const requirements = defineRequirements({
  'MEMO-CONTENT': ['content.preserved'],
  'MEMO-PRIVATE': ['private.denies-anonymous'],
  'MEMO-PUBLIC': ['public.matches-owner'],
  'MEMO-ARCHIVE': ['archive.state'],
  'MEMO-RESTORE': ['restore.state'],
});

const transitions = {
  private: { PUBLISH: 'public', UNPUBLISH: 'private', ARCHIVE: 'archivedPrivate', RESTORE: 'private' },
  public: { PUBLISH: 'public', UNPUBLISH: 'private', ARCHIVE: 'archivedPublic', RESTORE: 'public' },
  archivedPrivate: { PUBLISH: 'archivedPublic', UNPUBLISH: 'archivedPrivate', ARCHIVE: 'archivedPrivate', RESTORE: 'restoredPrivate' },
  archivedPublic: { PUBLISH: 'archivedPublic', UNPUBLISH: 'archivedPrivate', ARCHIVE: 'archivedPublic', RESTORE: 'restoredPublic' },
  restoredPrivate: { PUBLISH: 'public', UNPUBLISH: 'private', ARCHIVE: 'archivedPrivate', RESTORE: 'restoredPrivate' },
  restoredPublic: { PUBLISH: 'public', UNPUBLISH: 'private', ARCHIVE: 'archivedPublic', RESTORE: 'restoredPublic' },
};

export default defineCampaign({
  id: 'memos-local-lifecycle',
  intent: 'Owner memo content survives visibility and archive transitions; normal public memos are readable anonymously, and private memos are not.',
  scope: 'Real local Memos HTTP service, one fresh memo per session. Browser drafts and concurrent users are outside this campaign.',
  assumptions: [
    'The dedicated local instance allows public access.',
    'The supplied account is a throwaway local administrator.',
    'Anonymous readability of archived PUBLIC memos is observed but not specified here.',
  ],
  evidence: [
    'usememos/memos b620ae2b5ee1beb92f3d06e1a14f58c32c6314cf',
    'proto/api/memo_service.proto: GetMemo, CreateMemo, UpdateMemo, Memo.visibility and Memo.state',
    'README.md: Sharing you control; the private/public acceptance checks are authored from that product promise.',
  ],
  modelVersion: 'memos-b620ae2-lifecycle-v1',
  requirements,
  model: createMachine({
    initial: 'private',
    states: Object.fromEntries(Object.entries(transitions).map(([state, events]) => [state, {
      on: Object.fromEntries(Object.entries(events).map(([event, target]) => [event, () => ({ target })])),
    }])),
  }),
  options: {
    events: Object.fromEntries(['PUBLISH', 'UNPUBLISH', 'ARCHIVE', 'RESTORE'].map((type) => [type, [
      { case: type.toLowerCase(), generate: fc.constant({}) },
    ]])),
    sut: {
      async create() {
        const created = await request('/api/memos', 'POST', { content, visibility: 'PRIVATE' });
        if (!created.ok) throw new Error(`CreateMemo failed: HTTP ${created.status}`);
        const memo = await created.json();
        const memoPath = `/api/${memo.name}`;
        return {
          async send(event) {
            const patches = {
              PUBLISH: { visibility: 'PUBLIC' }, UNPUBLISH: { visibility: 'PRIVATE' },
              ARCHIVE: { state: 'ARCHIVED' }, RESTORE: { state: 'NORMAL' },
            };
            const patch = patches[event.type];
            if (!patch) throw new Error(`Unsupported event ${event.type}`);
            const updated = await request(`${memoPath}?updateMask=${Object.keys(patch).join(',')}`, 'PATCH', patch);
            if (!updated.ok) throw new Error(`UpdateMemo failed: HTTP ${updated.status}`);
          },
          async read() {
            const owner = await request(memoPath);
            if (!owner.ok) throw new Error(`Owner GetMemo failed: HTTP ${owner.status}`);
            const stored = await owner.json();
            const anonymous = await request(memoPath, 'GET', undefined, false);
            const anonymousBody = await anonymous.text();
            const publicMemo = anonymous.ok ? JSON.parse(anonymousBody) : null;
            return {
              ownerContent: stored.content, state: stored.state, visibility: stored.visibility,
              anonymousStatus: anonymous.status, anonymousBody, anonymousContent: publicMemo?.content ?? null,
            };
          },
          async dispose() {
            const deleted = await request(memoPath, 'DELETE');
            if (!deleted.ok) throw new Error(`Fixture cleanup failed: HTTP ${deleted.status}`);
          },
        };
      },
    },
    states: {
      '*': async (snapshot, session) => {
        const actual = await session.read();
        const state = snapshot.value;
        const archived = state.startsWith('archived');
        const isPublic = state === 'public' || state.endsWith('Public');
        await requirements.assert('content.preserved', () => {
          assert.equal(actual.ownerContent, content);
          assert.equal(actual.visibility, isPublic ? 'PUBLIC' : 'PRIVATE');
          assert.equal(actual.state, archived ? 'ARCHIVED' : 'NORMAL');
        });
        if (!isPublic) await requirements.assert('private.denies-anonymous', () => {
          assert.ok([401, 403, 404].includes(actual.anonymousStatus), `Unexpected anonymous status ${actual.anonymousStatus}`);
          assert.equal(actual.anonymousContent, null);
          assert.equal(actual.anonymousBody.includes(content), false, 'Denied response leaked the private memo content');
        });
        if (isPublic && !archived) await requirements.assert('public.matches-owner', () => {
          assert.equal(actual.anonymousStatus, 200);
          assert.equal(actual.anonymousContent, content);
        });
        if (archived) await requirements.assert('archive.state', () => assert.equal(actual.state, 'ARCHIVED'));
        if (state.startsWith('restored')) await requirements.assert('restore.state', () => assert.equal(actual.state, 'NORMAL'));
      },
    },
  },
});
