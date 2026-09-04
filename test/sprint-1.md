# Sprint 1 Manual Testing Guide: GitHub App & Webhook Ingestion

This guide describes how to manually test the **Sprint 1: GitHub App & Webhook System** implementation. This includes testing the webhook signature verification, ingestion endpoint, and the BullMQ integration with Redis.

---

## 📋 Prerequisites

Before starting, ensure that:
1. The project dependencies are installed:
   ```bash
   npm install
   ```
2. The infrastructure containers (PostgreSQL and Redis) are running:
   ```bash
   docker-compose up -d
   ```
3. Your local `.env` file contains the `GITHUB_WEBHOOK_SECRET` used for signature verification (default: `baby-koko-lazy-issue-resolver`).

---

## 🏃 Step 1: Start the Application

Start the NestJS application in development mode:
```bash
npm run start:dev
```
Ensure that the server starts successfully on port `3000` and outputs:
* `GitHub App initialized successfully` (if valid keys are present, or a warning if they are not)
* NestJS successfully maps `POST /webhooks/github`

---

## 🧪 Step 2: Trigger Webhook via curl (With Signature Verification)

Since the webhook controller validates the payload signature using the `x-hub-signature-256` header, we must sign the JSON body with the webhook secret using `HMAC-SHA256`.

You can use the following bash snippet to automate payload generation, sign it, and send it to your local server:

```bash
#!/usr/bin/env bash

# Configuration
WEBHOOK_SECRET="baby-koko-lazy-issue-resolver"
URL="http://localhost:3000/webhooks/github"

# 1. Construct Mock GitHub webhook payload (issues.opened)
PAYLOAD='{
  "action": "opened",
  "issue": {
    "number": 42,
    "title": "Fix bug in branch-resolver",
    "body": "branch: main\nPlease fix the bug.",
    "labels": [
      {"name": "bug"},
      {"name": "branch:main"}
    ]
  },
  "repository": {
    "id": 999999,
    "name": "lazy-issue-resolver",
    "full_name": "test-owner/lazy-issue-resolver"
  },
  "installation": {
    "id": 123456
  }
}'

# 2. Compute HMAC-SHA256 signature
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | cut -d' ' -f2)

# 3. Send POST request
curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "x-github-event: issues.opened" \
  -H "x-github-delivery: $(uuidgen 2>/dev/null || echo 'test-delivery-id')" \
  -H "x-hub-signature-256: sha256=$SIGNATURE" \
  -d "$PAYLOAD"
```

### Expected Response:
```
OK
```
If the signature is incorrect or missing, you will receive `Webhook error` (400 Bad Request) or `Signature missing` (410 Unauthorized).

---

## 🔍 Step 3: Verify BullMQ & Redis Ingestion

When the webhook is successfully processed, the event payload is pushed onto the Redis queue `issue-processing`.

### 1. Verification via RedisInsight (UI-based)
1. Open your browser and navigate to RedisInsight: `http://localhost:8001`.
2. Connect to the local Redis instance (`host: redis`, `port: 6379`).
3. You will see BullMQ keys under `bull:issue-processing:*`.

### 2. Verification via redis-cli
Run the following command to check if the job was queued in Redis:
```bash
docker exec -it lazydev-redis redis-cli KEYS "bull:issue-processing:*"
```
You should see output similar to:
```
1) "bull:issue-processing:id"
2) "bull:issue-processing:wait"
3) "bull:issue-processing:events"
```

To see the job details queued inside Redis:
```bash
docker exec -it lazydev-redis redis-cli HGETALL "bull:issue-processing:1"
```
*(Replace `1` with the active job ID listed in Redis)*
Check that the payload attributes (`repository`, `issueNumber`, `title`, `body`, `action`) match the webhook payload sent via `curl`.
