# Real-world BaaS benchmark

A Node.js and TypeScript runner for realistic project-management workloads against Supabase, PocketBase, and TrailBase through their official JavaScript clients.

## Requirements

- Node.js 22 or newer

## Setup

```sh
npm install
npm test
```

## Commands

```sh
npm run bench -- doctor
npm run bench -- up --backend pocketbase
npm run bench -- reset --backend pocketbase --dataset small --seed 42
npm run bench -- correctness --backend pocketbase
npm run bench -- run --backend pocketbase --config configs/quick.json
npm run bench -- compare --config configs/full.json
npm run bench -- down --backend pocketbase
npm run bench -- report results/<run>.json
```

Run `npm run bench -- --help` to list commands. Backend adapters and benchmark workloads will be added in subsequent tasks.
