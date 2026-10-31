# Test the Memos lifecycle with Stately

Run a bounded model-based campaign against a local Memos service. The campaign creates a fresh memo for each session, drives the real HTTP API, reads it as owner and anonymous reader, and deletes its own fixtures.

<!-- campaign requirements, model states, event descriptors, and assumptions from memo.campaign.mjs -->

The model covers private and public memos, archive and restore, repeated operations, and visibility changes while archived. Five named obligations check content, private access, public reads, archive state, and restored state. The public API comments in `proto/api/memo_service.proto` and the README's sharing promise supply the intended behavior. The checks are authored interpretations, not maintainer-approved requirements.

Each session owns its memo. The campaign shares one in-memory owner token and does not change account settings. Anonymous readability of archived public memos is outside the acceptance contract. Browser drafts, concurrent editors, non-admin users, invalid payloads, network retries, and time-dependent behavior remain untested.

<!-- installation and scripts from package.json and pnpm-lock.yaml -->

## Run the campaign

1. Start a dedicated local Memos instance from this checkout. Create a throwaway administrator through the first-run page. Set its credentials in the campaign terminal:

   ```sh
   export MEMOS_USERNAME=weekend-admin
   read -s MEMOS_PASSWORD
   export MEMOS_PASSWORD
   ```

2. From `dogfood/`, use Node 24 or later and install the pinned dependency:

   ```sh
   pnpm install --frozen-lockfile
   ```

3. Run the campaign:

   ```sh
   pnpm test
   ```

   The default service is `http://127.0.0.1:8081`. Override `MEMOS_BASE_URL` for another dedicated test instance. The script requests 20 property trials, at most 12 commands per trial, seed 42, and a 120-second deadline. Both graph paths and property phases must pass. The JSON report is `.output/campaign.json`.

   Requests have a 100 ms delay. Memos limits authenticated requests to 600 per minute and anonymous requests to 300 per minute in `internal/ratelimit/ratelimit.go`. A larger unpaced run hit HTTP 429 and returned inconclusive. The adapter does not retry refusals or disable application limits. All five obligations remain required.

4. If a discrepancy produces `.output/replay.json`, keep the campaign and expected behavior unchanged, fix the application, and run:

   ```sh
   pnpm replay
   ```

   A passing campaign produces no failure fixture. Remove or move an older fixture before a new exploratory run so it cannot be mistaken for a newly generated failure. Inspect fixture provenance before replay.

## Interpret the result

Exit 0 means the recorded checks passed within the declared model and budgets. Exit 1 means a discrepancy. Exit 2 means infrastructure or incomplete evidence. A discrepancy can reflect the app, model, or adapter. Inspect actual values before assigning blame.

The report records executed requirements and the exploration budget. State or transition coverage applies to this authored model, not all Memos behavior. No payload generation, browser proof, exhaustive model checking, adopted-baseline enforcement, or hosted CI is claimed by this campaign.

The implementation is additive. Memos's existing tests remain unchanged. Deliberate application mutations used to validate this campaign must be labeled as seeded regressions and kept out of the product branch.

## Replay the seeded archive control

<!-- fixture identity and event from fixtures/seeded-archive-noop.replay.json and mutation from fixtures/seeded-archive-noop.patch -->

`fixtures/seeded-archive-noop.patch` records a deliberate application regression: `UpdateMemo` always stores `NORMAL`, so archiving does nothing. It was built as a separate local binary with a separate SQLite database. The application source in this branch does not include that mutation. The patch has zero context lines. Use `git apply --unidiff-zero` only in a separate control worktree based on the recorded upstream revision.

The campaign detected the regression and produced `fixtures/seeded-archive-noop.replay.json`, containing one `ARCHIVE` event. The property failure required zero shrink steps. The same fixture passed against the unchanged application. This is a seeded control, not a discovered upstream bug.

With the unchanged local service running and credentials set, replay the checked fixture:

```sh
pnpm exec statelyai test memo.campaign.mjs --replay fixtures/seeded-archive-noop.replay.json --report .output/seeded-replay.json
```

A replay checks only its recorded sequence. It does not close the other campaign obligations.

## Start the local application

From the repository root, start the SQLite backend with the Go version required by `go.mod`:

```sh
GOTOOLCHAIN=auto go run -buildvcs=true ./cmd/memos --addr 127.0.0.1 --port 8081 --data /tmp/memos-stately-dogfood --instance-url http://127.0.0.1:3001
```

In another terminal, start the frontend:

```sh
cd web
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1 --port 3001 --strictPort
```

Open `http://127.0.0.1:3001` to create the first account and exercise the browser workflow. Keep this disposable database separate from personal notes.
