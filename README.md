# PES Token Contracts

This repository contains the on-chain implementation for the PES token launch:

- fixed-supply `PES` ERC-20 token
- buy/sell fee routing for LP, operations, and burn
- USDT presale package purchase
- transparent admin allocations for strategic/ecosystem packages
- vesting claim schedule: 20% at launch, then 2% per day for 40 days

## Business Parameters

| Item | Value |
| --- | --- |
| Token name | PES Token |
| Symbol | PES |
| Total supply | 21,000,000 PES |
| Liquidity allocation | 15,000,000 PES |
| Presale allocation | 6,000,000 PES |
| Package price | 300 USDT |
| PES per package | 3,000 PES |
| Total packages | 2,000 |
| Suggested public cap | 50 packages |
| Suggested strategic/ecosystem allocation | 1,950 packages |
| Initial release | 20% at launch |
| Linear release | 2% per day |
| Vesting duration | 40 days |
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
- calculates claimable PES from the configured launch time
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

Deploy to BSC mainnet:

```bash
npx hardhat run scripts/deploy.js --network bsc
```

After deploying both contracts, transfer `6,000,000 PES` to the `PESPresaleVesting` contract so claims can be paid.

## Operations

Fund the presale vesting contract:

```bash
npm run fund:presale -- --network bscTestnet
```

Grant strategic/ecosystem allocations from a JSON file:

```bash
npm run grant:allocations -- --network bscTestnet
```

`allocations.example.json` format:

```json
[
  { "account": "0x0000000000000000000000000000000000000001", "packages": 1 }
]
```

For 1,950 strategic accounts, keep `packages` as `1` per address or adjust per account as needed. The script sends allocations in chunks controlled by `ALLOCATIONS_CHUNK_SIZE`.

After creating the DEX pair and adding liquidity, set the AMM pair and enable trading:

```bash
npm run enable:trading -- --network bscTestnet
```

## Frontend

The React frontend provides two separated operating surfaces:

- user client at `/`: wallet connect, package purchase, payment token approval, vesting status, PES claim, and DEX link
- Admin console at `/admin`: contract address setup, sale window, launch time, package config, funds wallet, AMM pair, trading switch, fee wallets, buy/sell fee rates, strategic/ecosystem allocations, batch allocations, pause controls, and fee whitelist

Frontend contract addresses can be entered in the UI and saved to browser local storage, or prefilled through `.env` with the `VITE_*` variables.

## Launch Flow

1. Deploy `PESToken`.
2. Deploy `PESPresaleVesting` with USDT, package, sale window, and launch parameters.
3. Transfer `6,000,000 PES` to `PESPresaleVesting` with `npm run fund:presale`.
4. Grant strategic/ecosystem allocations if needed using `grantAllocation` or `grantAllocations`.
5. Open public purchase during `SALE_START` to `SALE_END`.
6. Add initial PES/USDT liquidity using the planned LP allocation.
7. Set the DEX pair and enable trading with `npm run enable:trading`.
8. Users claim vested PES from launch time onward.

## Notes

The `1,950` non-public packages are implemented as transparent admin allocations. This avoids fake purchase activity while keeping the same supply and release mechanics.
