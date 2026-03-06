# Security Checklist — Calendar Assistant (GCP Deployment)

Audit date: 2026-03-06
Auditor: Security Engineer Senior
Scope: Pre-deployment security review for GCP VM deployment

---

## 1. SSH Key Management

Two key pairs are required: one for git pull on the VM, one for GitHub Actions CI.

### Deploy Key (VM → GitHub read-only)

Generate a dedicated key **on the VM** (no passphrase for automated pull):

```bash
ssh-keygen -t ed25519 -C "calendar-bot-deploy-key" -f ~/.ssh/calendar_deploy_ed25519 -N ""
```

- Add the **public key** (`~/.ssh/calendar_deploy_ed25519.pub`) to GitHub → Settings → Deploy Keys (read-only).
- Set the private key permissions: `chmod 600 ~/.ssh/calendar_deploy_ed25519`
- Configure SSH to use this key for the repo host in `~/.ssh/config`.

### CI Key (GitHub Actions → VM)

Generate a dedicated key **locally** (not on the VM):

```bash
ssh-keygen -t ed25519 -C "calendar-bot-ci-key" -f ./ci_ed25519 -N ""
```

- Add the **public key** to `~/.ssh/authorized_keys` on the VM (append, one per line).
- Store the **private key** contents in GitHub → Settings → Secrets → `VM_SSH_KEY` (see section 4).
- Delete the local private key file after uploading to GitHub Secrets.

### Key Rotation

Rotate both key pairs if any of the following occur:
- Repository or VM is suspected compromised
- Team member with key access leaves
- Key has been committed or logged accidentally (treat as compromised immediately)

Rotation procedure: generate new key pair → add new public key → remove old public key → update GitHub Secret if applicable → verify SSH access → delete old key pair files.

---

## 2. VM .env Security

The `.env` file on the VM contains all runtime secrets. It must never leave the VM.

### File permissions

```bash
# Set ownership and restrict access to the service user only
sudo chown calendar:calendar /home/calendar/calendar-assistant/.env
chmod 600 /home/calendar/calendar-assistant/.env
```

- Owner: `calendar` (the dedicated service user)
- Mode: `600` — readable/writable by owner only, no group or world access
- Verify: `ls -la .env` must show `-rw-------`

### Rules

- **Never commit `.env` to git** — it is already in `.gitignore`; verify before every `git add`
- **Never copy `.env` to logs, stdout, or any debug output**
- **Never send `.env` contents via chat, email, or CI logs**
- If `.env` is suspected leaked: rotate all secrets inside it immediately (see section 5), then reissue the file on the VM

---

## 3. sudoers.d Scope

The `calendar` service user must only be allowed to restart and check the status of its own service. No broader sudo access.

Create `/etc/sudoers.d/calendar-bot` with exactly this line:

```
calendar ALL=(ALL) NOPASSWD: /bin/systemctl restart calendar-bot, /bin/systemctl status calendar-bot
```

Verification steps:
1. `sudo visudo -c -f /etc/sudoers.d/calendar-bot` — must report no syntax errors
2. `sudo -l -U calendar` — output must list only `restart calendar-bot` and `status calendar-bot`
3. Test that `sudo systemctl stop calendar-bot` is **denied** for the `calendar` user

Do not grant `ALL` commands, shell access, or `NOPASSWD` for any other binary to this user.

---

## 4. GitHub Secrets

Store the following secrets in GitHub → Repository → Settings → Secrets and variables → Actions:

| Secret name | Value | Notes |
|---|---|---|
| `VM_HOST` | IP address or hostname of the GCP VM | Rotate if VM is reprovisioned |
| `VM_SSH_KEY` | Private key contents for the CI key pair | PEM/OpenSSH format, full content |

### Rules

- **Never log these values** — do not use `echo $VM_SSH_KEY` or `env` in CI steps
- **Never print them in PR comments, issue bodies, or notifications**
- Use `secrets.VM_HOST` and `secrets.VM_SSH_KEY` exclusively via the GitHub Actions `${{ secrets.NAME }}` syntax
- Verify that workflow YAML does not expose secrets through `run: echo ...` or artifact uploads
- Limit secret access to the specific workflow jobs that require SSH — avoid passing them to third-party actions unnecessarily

---

## 5. Credential Rotation

### TELEGRAM_BOT_TOKEN

1. Open Telegram → BotFather → `/revoke` → select the bot → confirm
2. BotFather issues a new token
3. On the VM: edit `.env` and replace the `TELEGRAM_BOT_TOKEN` value
4. Restart the service: `sudo systemctl restart calendar-bot`
5. Verify: send a test message to the bot and confirm it responds

### OPENAI_API_KEY

1. Log in to platform.openai.com → API keys → select the compromised key → Delete
2. Create a new API key
3. On the VM: edit `.env` and replace the `OPENAI_API_KEY` value
4. Restart the service: `sudo systemctl restart calendar-bot`
5. Verify: trigger a calendar creation request and confirm the LLM responds correctly

### General rotation rule

Treat any credential as compromised if it:
- Appears in git history (even in a deleted file)
- Appears in any log output
- Is shared via insecure channel (chat, email, CI output)

Rotate immediately; do not wait to confirm misuse.

---

## 6. Git History Audit

Run the following commands from the project root to verify no secrets were ever committed:

```bash
# Check if .env was ever tracked
git log --all --oneline -- .env

# Check if credentials/ was ever tracked
git log --all --oneline -- credentials/

# Search all commit contents for common secret patterns
git log --all -p | grep -E "(TELEGRAM|OPENAI|sk-|token|password|secret|credential)" --ignore-case | head -50

# List all files currently tracked by git (verify credentials/ not present)
git ls-files | grep -E "(credential|\.env|secret|key\.json)"
```

**Expected output:** all commands should return empty output. Any match is a finding requiring immediate action:

1. Identify the commit hash
2. Rotate the exposed credential immediately
3. Use `git filter-repo` (or BFG Repo Cleaner) to rewrite history and remove the file
4. Force-push the cleaned history (coordinate with all collaborators)
5. Invalidate GitHub's cached objects via support if the repo is public

---

## Audit Results (2026-03-06)

| Check | Status | Notes |
|---|---|---|
| `.env` in `.gitignore` | PASS | Present on line 2 |
| `credentials/` in `.gitignore` | PASS | Present on line 3 |
| `node_modules/` in `.gitignore` | PASS | Present on line 1 |
| `git log -- .env` | PASS | No commits found — .env never tracked |
| `git log -- credentials/` | PASS | No commits found — credentials/ never tracked |
| `git ls-files credentials/` | PASS | No files in credentials/ are tracked by git |
| Hardcoded secrets in `creator.ts` | INFO | Email fallbacks only (`jgcalice@gmail.com`, `mepoupeze@gmail.com`) — technical debt, not secret credentials |
| Hardcoded secrets in `bot.ts` | INFO | `ALLOWED_CHAT_ID` fallback (`7131103597`) — a chat ID, not a secret; low risk, should be env-only in production |
