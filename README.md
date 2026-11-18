# Letters Apart

A two-player postcard game built with Phaser and FastAPI. One Python process
serves the built frontend, photo API, and game WebSockets. SQLite and uploaded
photos live on disk.

## Run locally

```sh
docker compose up --build
```

Open <http://localhost:8000> in two browser tabs and choose different homes.
The Compose volume preserves postcards and photos across container restarts.
Local Compose is open and bound to loopback. Optional local settings are
documented in `.env.example`.

## Deploy to Railway

See [the Railway deployment guide](docs/railway.md) for the volume, environment
variables, public URL, automatic deployment with **Wait for CI**, and verification
steps. The repository includes `railway.json` and a production Dockerfile; no
separate frontend or database service is required.
Production requires two private player passphrases in Railway's variables. Each
person signs in with their own passphrase, which unlocks only their home and
keeps their browser signed in for 90 days. Add
`POSTCARD_ACCESS_LEFT` and `POSTCARD_ACCESS_RIGHT` before deploying; see the guide
for choosing and sharing the passphrases.
