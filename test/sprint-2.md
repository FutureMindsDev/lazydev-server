# Sprint 2 Manual Testing Guide: Repository Cache & Git Operations

This guide describes how to manually test the core workflow implemented in **Sprint 2: Repository Cache & Git Operations**. This includes distributed locking via Redlock, branch resolution priority, local git cloning/fetching, and worktree isolation.

---

## 📋 Prerequisites

1. Ensure the PostgreSQL and Redis containers are running:
   ```bash
   docker-compose up -d
   ```
2. Verify that your `.env` contains valid GitHub App credentials (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_PATH`, and a valid installation ID).
   > [!NOTE]
   > For git clone/fetch operations to work against real private repositories, your GitHub App must be installed on the target repository, and you must use a valid installation ID in the webhook payload.

---

## 🏃 Step 1: Start the Application

Start the application:
```bash
npm run start:dev
```
Observe the log output to make sure it establishes a database connection and connects to the BullMQ Redis instance.

---

## 🧪 Step 2: Triggering the Processing Flow

You can trigger a job using the webhook ingestion endpoint (similar to Sprint 1). Make sure the payload contains a valid `installation.id` that has access to the target repository.

### Script: Send Test Webhook

Use this script to trigger the worker with a target repository and branch options.

```bash
#!/usr/bin/env bash

# Configuration
WEBHOOK_SECRET="baby-koko-lazy-issue-resolver"
URL="http://localhost:3000/webhooks/github"

# Payload targeting a repository you have access to.
# Replace repository name and installation ID with your real credentials.
PAYLOAD='{
  "action": "opened",
  "issue": {
    "number": 101,
    "title": "Fix repository cache service",
    "body": "branch: main\nLet us test the branch resolution.",
    "labels": [
      {"name": "branch:main"}
    ]
  },
  "repository": {
    "id": 1234567890,
    "name": "repo-name",
    "full_name": "test-owner/repo-name"
  },
  "installation": {
    "id": 123456789
  }
}'

SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | cut -d' ' -f2)

curl -X POST "$URL" -H "Content-Type: application/json" -H "x-github-event: issues.opened" -H "x-github-delivery: test-delivery-id" -H "x-hub-signature-256: sha256=$SIGNATURE" -d "$PAYLOAD"

```

---

## 🔍 Step 3: Verify Workflow Orchestration

Watch the NestJS console logs as the issue is processed. You should verify the following sequential events:

1. **Issue Lock Acquired**: Logs show `Acquiring issue lock for #101`.
2. **Branch Resolution**: Logs show `Target branch resolved: "feature/sprint-2-repo-cache" (source: body)`.
   * *Test variation*: Remove `branch: <name>` from the body and verify it falls back to parsing labels, then the GitHub API (default branch), and finally `LAZYDEV_DEFAULT_BRANCH`.
3. **Repository Lock Acquired**: Logs show `Acquiring repo lock for test-owner/lazy-issue-resolver`.
4. **Repository Cloning/Fetching**:
   * **First time**: You should see a full clone being executed into `./repo-cache/test-owner/lazy-issue-resolver`.
   * **Subsequent times**: Observe that it skips cloning and instead executes `git fetch --all --prune` on the cached directory.
5. **Branch Lock Acquired & Checked Out**: Branch lock is acquired to prevent conflicts, and checkout is performed.
6. **Worktree Creation**: An isolated worktree is created under `os.tmpdir()`. You should see the log `Worktree ready at: <temp_path>`.
7. **Lock Release**: Branch and Repository locks are released immediately so other concurrent tasks can use the cache.
8. **Lock Heartbeat**: If you add a delay or breakpoint, watch Redis to verify that the Redlock heartbeat extends the lock TTL (every 20 seconds).
9. **Cleanup**: After execution, the worktree is cleaned up and removed from disk. The final logs should indicate `All locks released` and `Worktree cleaned up`.

---

## 🔒 Step 4: Verify Distributed Locking in Redis

During the run, you can inspect the acquired locks inside Redis using `redis-cli`:

```bash
docker exec -it lazydev-redis redis-cli KEYS "locks:*"
```

Expected keys during processing:
* `locks:issue:test-owner:lazy-issue-resolver:101`
* `locks:repo:test-owner:lazy-issue-resolver`
* `locks:branch:test-owner:lazy-issue-resolver:feature/sprint-2-repo-cache`
