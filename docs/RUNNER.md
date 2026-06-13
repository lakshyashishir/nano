# Nano Claude Code Runner (Docker)

Runs the polling adapter in a container — ready for **Cloudflare Containers**, Fly.io, Railway, or any VM.

## Build

```bash
docker build -f docker/runner.Dockerfile -t nano-runner .
```

## Run

```bash
docker run --rm -it \
  -e NANO_URL=https://nano.lakshyashishir1.workers.dev \
  -e NANO_API_KEY=nano_... \
  -e GITHUB_TOKEN=ghp_... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e RUNNER_WAKE_PORT=8080 \
  -p 8080:8080 \
  nano-runner
```

Register first (prints API key if `NANO_API_KEY` is unset):

```bash
docker run --rm nano-runner
```

## Wake URL (scale-to-zero)

When the runner exposes port 8080, set on the **Worker**:

```bash
npx wrangler secret put RUNNER_WAKE_URL
# e.g. https://your-runner.example.com/wake
```

Nano POSTs here when a `runner=local` task is created so the container can wake without waiting for the poll interval.

## Cloudflare Containers (when you have credits)

1. Push image to a registry Cloudflare can pull
2. Add container binding in `wrangler.toml` (see [Containers docs](https://developers.cloudflare.com/containers/))
3. Route `RUNNER_WAKE_URL` to the container's Worker proxy URL
4. Set secrets: `GITHUB_TOKEN`, wire Anthropic auth for Claude Code inside the image

## Notes

- Claude Code in Docker needs `ANTHROPIC_API_KEY` (headless; no browser OAuth).
- Workspace clones live in `/root/.nano/workspaces` — use a volume if you want persistence across restarts.
- **lite** instance (256 MiB) is too small; use **basic** (1 GiB) or larger for Claude Code.
