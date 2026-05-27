# Deployment Guide — Beyond Bank Mortgage Tracker

**Flow:** Push to GitHub → GitHub Actions builds Docker image → pushes to ghcr.io → Dockhand pulls and runs it

No SSH keys, no server access needed. GitHub's built-in token handles authentication.

---

## Step 1 — Create the GitHub repo

1. Go to https://github.com/new
2. Name it `mortgage-tracker`, set to **Private**
3. Don't initialise with a README

---

## Step 2 — Push the app to GitHub

In this project folder on your local machine:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/mortgage-tracker.git
git push -u origin main
```

---

## Step 3 — Make the container image public (one-time)

After your first push, GitHub Actions will build and push the image to
GitHub Container Registry (ghcr.io). By default new packages are private —
you need to make it public so your server can pull it without logging in.

1. Go to https://github.com/YOUR_USERNAME?tab=packages
2. Click **mortgage-tracker**
3. Click **Package settings** (bottom right)
4. Scroll to **Danger Zone** → **Change visibility** → set to **Public**

> Alternatively you can leave it private and add a Personal Access Token to
> Dockhand — but public is easier for a personal homelab app.

---

## Step 4 — Create the stack in Dockhand

1. Open Dockhand in your browser
2. Click **Stacks** → **Create stack**
3. Name it `mortgage-tracker`
4. Paste this compose file — replace `YOUR_GITHUB_USERNAME` with your actual GitHub username:

```yaml
services:
  mortgage-tracker:
    image: ghcr.io/YOUR_GITHUB_USERNAME/mortgage-tracker:latest
    container_name: mortgage-tracker
    restart: unless-stopped
    ports:
      - "8765:80"
```

5. Click **Deploy**

The image will be pulled and the container will start.
Open `http://<your-server-ip>:8765` in your browser — or via Tailscale: `http://<tailscale-ip>:8765`

---

## Step 5 — Enable auto-update in Dockhand (optional)

If Dockhand has a **Watchtower** or **auto-pull** option, enable it for this stack.
It will check for a new `:latest` image and restart the container automatically
whenever you push a new version to GitHub.

If not, just click **Pull & restart** in Dockhand after each push.

---

## Updating the app

Just push to `main`:

```bash
git add .
git commit -m "Update mortgage details"
git push
```

GitHub Actions builds and pushes the new image (~1–2 min).
Then either Dockhand auto-updates, or you click Pull & restart manually.

---

## Port reference

| What            | Value |
|-----------------|-------|
| App (HTTP)      | 8765  |
| Container port  | 80    |
| Tailscale access | `http://<tailscale-ip>:8765` |

---

## Checking the GitHub Actions build

Go to your repo → **Actions** tab to watch the build.
First build takes ~1 min, subsequent builds are faster due to layer caching.
