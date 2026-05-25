# PES Token Contracts

This repository contains the on-chain implementation for the PES token launch:

- fixed-supply `PES` ERC-20 token
- buy/sell fee routing for LP, operations, and burn
- USDT presale package purchase
- transparent admin allocations for strategic/ecosystem packages
- vesting claim schedule: 20% after the first elapsed period, then the remaining 80% linearly by configured period count

## Business Parameters

| Item | Value |
| --- | --- |
| Token name | PES Token |
| Symbol | PES |
| Total supply | 21,000,000 PES |
| Liquidity allocation | 15,000,000 PES |
| Presale allocation | 3,000,000 PES |
| Package price | 300 USDT |
| PES per package | 3,000 PES |
| Total packages | 1,000 |
| Public remaining counter | 1,000 total packages minus all purchased and owner-issued packages |
| Owner-issued strategic/ecosystem target | 950 packages |
| Initial release | 20% after the first elapsed period |
| Linear release | Remaining 80% / configured period count |
| Default vesting duration | 41 days |
| Buy fee | 1.5% |
| Sell fee | 1.5% |
| Default fee split | 0.5% LP, 0.5% operations, 0.5% burn |

## Contracts

`contracts/PESToken.sol`

- mints `21,000,000 PES` to the owner
- supports AMM pair detection for buy/sell fees
- blocks non-exempt AMM trades until trading is enabled
- lets the owner configure fee wallets, fee rates, fee exemptions, and AMM pairs
- caps total buy/sell fee at 10%

`contracts/PESPresaleVesting.sol`

- sells packages using an ERC-20 payment token such as USDT
- transfers payment directly to the configured funds wallet
- records user allocations instead of transferring all PES immediately
- supports owner-granted transparent strategic/ecosystem allocations
- calculates claimable PES from the owner-configured elapsed vesting period count
- protects allocated PES from accidental owner recovery

## Setup

```bash
npm install
npm test
```

Run the frontend locally:

```bash
npm run dev
```

The default frontend URLs are:

- user client: `http://127.0.0.1:6284/`
- Admin console: `http://127.0.0.1:6284/admin`

Copy `.env.example` to `.env` and fill deployment values:

```bash
cp .env.example .env
```

Important deployment variables:

- `PRIVATE_KEY`: deployer wallet private key
- `BSC_RPC_URL` / `BSC_TESTNET_RPC_URL`: target RPC URL
- `USDT_ADDRESS`: payment token address
- `PES_OWNER`: owner/admin wallet, defaults to deployer if blank
- `PRESALE_FUNDS_WALLET`: wallet receiving USDT
- `SALE_START`, `SALE_END`, `LAUNCH_TIME`: Unix timestamps

## Deploy

Deploy to local Hardhat:

```bash
npm run deploy
```

Deploy to BSC testnet:

```bash
npx hardhat run scripts/deploy.js --network bscTestnet
```

Deploy a replacement BSC testnet presale using an existing PES token and a specific ERC-20 payment token, then run a live purchase/claim smoke test:

```bash
PES_ADDRESS=0x... USDT_ADDRESS=0x... npm run deploy:presale-payment:test
```

Deploy to BSC mainnet:

```bash
npx hardhat run scripts/deploy.js --network bsc
```

After deploying both contracts, transfer `3,000,000 PES` to the `PESPresaleVesting` contract so claims can be paid.

## Operations

Fund the presale vesting contract:

```bash
npm run fund:presale -- --network bscTestnet
```

Grant strategic/ecosystem allocations from a JSON file:

```bash
npm run grant:allocations -- --network bscTestnet
```

Simulate the same Admin batch allocation against the current BSC testnet chain state without sending a transaction:

```bash
npm run simulate:admin-batch
```

The simulation uses `eth_call` and `eth_estimateGas`, so it does not sign or change chain state. It mirrors the chunking flow used by the real grant script. Set `ALLOCATIONS_FILE=path/to/file.json` to simulate a specific batch file, `ALLOCATIONS_CHUNK_SIZE` or `SIM_CHUNK_SIZE` to choose chunk size, or `SIM_BATCH_SIZE` and `SIM_PACKAGES_PER_ADDRESS` to generate a temporary batch.

Configure the current BSC mainnet presale schedule without sending transactions:

```bash
npm run configure:presale:schedule
```

The default schedule is Beijing time: sale opens `2026-05-26 00:00`, sale closes and launch time is set to `2026-05-28 15:00`, first release is planned for `2026-05-29 00:00`, and the remaining 80% releases across `40` daily periods. Per package, this is `600 PES` first, then `60 PES` per daily period until fully released at elapsed period `41`.

To execute the owner-only mainnet updates, set `PRIVATE_KEY`, `BSC_RPC_URL`, and `EXECUTE=true` only in the current shell session, then run the same command. The script verifies chain ID `56` and rejects execution unless the signer is the presale owner. `ELAPSED_VESTING_PERIODS` can be set explicitly, otherwise the script computes the target period from `FIRST_RELEASE_TIME` and the latest block timestamp.

`allocations.example.json` format:

```json
[
  { "account": "0x0000000000000000000000000000000000000001", "packages": 1 }
]
```

For 950 strategic accounts, keep `packages` as `1` per address or adjust per account as needed. The script sends allocations in chunks controlled by `ALLOCATIONS_CHUNK_SIZE`.

After creating the DEX pair and adding liquidity, set the AMM pair and enable trading:

```bash
npm run enable:trading -- --network bscTestnet
```

## Frontend

The React frontend provides two separated operating surfaces:

- user client at `/`: wallet connect, package purchase, payment token approval, vesting status, PES claim, and DEX link
- Admin console at `/admin`: contract address setup, sale window, launch time, package config, funds wallet, AMM pair, trading switch, fee wallets, buy/sell fee rates, strategic/ecosystem allocations, batch allocations, pause controls, and fee whitelist

Frontend contract addresses can be entered in the UI and saved to browser local storage, or prefilled through `.env` with the `VITE_*` variables. The user client reads recent `PackagesPurchased` and `AdminAllocationGranted` events to show a scrolling purchase/allocation feed and a live remaining counter.

Wallet connection uses RainbowKit and Wagmi. Set `VITE_WALLETCONNECT_PROJECT_ID` for WalletConnect mobile/deep-link wallet support; injected wallets can still connect through the RainbowKit modal during local testing. `VITE_READ_RPC_URL` is used for read-only balance and event queries, while writes are signed through the connected wallet. `VITE_EVENT_QUERY_BLOCK_RANGE` controls event query chunk size; keep it low enough for the selected public RPC.

## Launch Flow

1. Deploy `PESToken`.
2. Deploy `PESPresaleVesting` with USDT, package, sale window, and launch parameters.
3. Transfer `3,000,000 PES` to `PESPresaleVesting` with `npm run fund:presale`.
4. Grant strategic/ecosystem allocations if needed using `grantAllocation` or `grantAllocations`.
5. Open public purchase during `SALE_START` to `SALE_END`.
6. Add initial PES/USDT liquidity using the planned LP allocation.
7. Set the DEX pair and enable trading with `npm run enable:trading`.
8. Owner/Admin updates the elapsed vesting period count as release periods pass; users claim vested PES from that configured progress.

## Notes

The `950` owner-issued packages are implemented as transparent admin allocations. They reduce the same 1,000-package remaining counter as public purchases, while keeping the purchase and release mechanics visible on-chain.
