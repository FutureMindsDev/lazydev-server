# Sprint 3 Manual Testing Guide: Docker Sandbox & Validation Engine

This guide describes how to manually test the core workflow implemented in **Sprint 3: Docker Sandbox & Validation Engine**. This includes testing language auto-detection, Docker-isolated execution, resource limits, and network options.

---

## 📋 Prerequisites

1. Ensure the PostgreSQL and Redis containers are running:
   ```bash
   docker-compose up -d
   ```
2. Verify that Docker is installed and running on your local machine, as the SandboxService requires access to the Docker daemon.
3. Node.js dependencies installed (`npm install`).

---

## 🏃 Step 1: Start the Application

Start the application:
```bash
npm run start:dev
```
Observe the log output to make sure it establishes a database connection.

---

## 🧪 Step 2: Testing Language Auto-Detection

We need to verify that `LanguageDetector` correctly identifies project languages based on their root files.

1. **Setup Dummy Worktrees**:
   Create temporary directories to simulate different project types:
   ```bash
   mkdir -p /tmp/lazydev-test-node && touch /tmp/lazydev-test-node/package.json
   mkdir -p /tmp/lazydev-test-python && touch /tmp/lazydev-test-python/requirements.txt
   mkdir -p /tmp/lazydev-test-go && touch /tmp/lazydev-test-go/go.mod
   ```

2. **Trigger Detection**:
   You can use `ts-node` to run a quick inline script to test the detection logic against the directories you just created:
   ```bash
   npx ts-node -e "import { LanguageDetector } from './src/validation/language-detector'; async function run() { console.log('Node:', await LanguageDetector.detectLanguage('/tmp/lazydev-test-node')); console.log('Python:', await LanguageDetector.detectLanguage('/tmp/lazydev-test-python')); console.log('Go:', await LanguageDetector.detectLanguage('/tmp/lazydev-test-go')); } run();"
   ```
   *Expected Result*: The script will output:
   ```
   Node: NODEJS
   Python: PYTHON
   Go: GO
   ```

---

## 🔍 Step 3: Verify Docker Sandbox Execution

1. **Test Node.js Validation**:
   Create a basic Node.js test project.
   ```bash
   mkdir -p /tmp/lazydev-sandbox-node
   cat << 'EOF' > /tmp/lazydev-sandbox-node/package.json
   {
     "name": "test",
     "scripts": {
       "test": "echo \"Running tests...\" && exit 0"
     }
   }
   EOF
   ```

2. **Run Validation via Code**:
   Trigger the `ValidationService` to run on `/tmp/lazydev-sandbox-node`.
   ```bash
   npx ts-node -e "
   import { NestFactory } from '@nestjs/core';
   import { AppModule } from './src/app.module';
   import { ValidationService } from './src/validation/validation.service';

   async function bootstrap() {
     const app = await NestFactory.createApplicationContext(AppModule);
     const service = app.get(ValidationService);
     const result = await service.validateWorktree('/tmp/lazydev-sandbox-node');
     console.log('Validation Result:', result);
     await app.close();
     process.exit(0);
   }
   bootstrap();
   "
   ```
   *Expected Result*:
   - Logs should indicate `Detected language: NODEJS`.
   - The sandbox command executed should be `docker run --rm --network=bridge --memory=512m --cpus=1.0 -v "/tmp/lazydev-sandbox-node:/workspace" -w /workspace node:20-alpine sh -c "npm install && npm test"`.
   - The container spins up, runs the test, exits `0`, and automatically removes itself due to `--rm`.

---

## 🔒 Step 4: Verify Resource Constraints & Network Flags

1. **Check CPU and Memory Limits**:
   While a validation job is running, execute `docker stats` in another terminal.
   ```bash
   docker stats
   ```
   *Expected Result*: The spawned container (using image `node:20-alpine` or similar) should show a `MEM LIMIT` of `512MiB`.

2. **Test Network Mode Config**:
   Update your `.env` file to include:
   ```env
   SANDBOX_NETWORK_MODE=none
   ```
   Restart the NestJS app and trigger validation on a project that requires `npm install`.
   *Expected Result*: The validation should **fail** because `npm install` cannot reach the internet to download packages.
   
3. **Revert Network Mode**:
   Remove or set `SANDBOX_NETWORK_MODE=bridge` in `.env` and restart.
   *Expected Result*: `npm install` should succeed.
