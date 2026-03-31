# x402 Paid Chat - Implementation Plan

**Goal:** Add a paid chat feature to the OpenClaw Ecosystem page where users pay per message using x402.

**Condo:** personal | **Goal ID:** goal_fbbfb763aaff5f2d1dd83c97

---

## Overview

Users visiting the ecosystem page can chat with an AI assistant. Each message costs a small amount (e.g., $0.01 USDC) paid instantly via x402 protocol on Base network.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Frontend      │────▶│  Ecosystem API   │────▶│  CDP Facilitator│
│   (React/JS)    │◀────│  + x402 middleware│◀────│  (verification) │
└─────────────────┘     └──────────────────┘     └─────────────────┘
        │                        │
        │ wallet signs           │ calls AI
        ▼                        ▼
┌─────────────────┐     ┌──────────────────┐
│  User Wallet    │     │  Claude/OpenAI   │
│  (Base USDC)    │     │  (chat backend)  │
└─────────────────┘     └──────────────────┘
```

## Flow

1. **User sends message** → Frontend POSTs to `/api/chat`
2. **Server returns 402** with `PAYMENT-REQUIRED` header containing:
   - Price: 0.01 USDC
   - Network: Base (eip155:8453)
   - Recipient wallet address
3. **Client SDK handles payment** → User's wallet signs
4. **Client retries with PAYMENT-SIGNATURE** header
5. **Server verifies via facilitator** → If valid, processes chat
6. **AI responds** → Server returns response to client

## Tech Stack

### Backend (Node.js)
```bash
npm install express @x402/core @x402/express
```

### Frontend
```bash
npm install @x402/fetch wagmi viem @coinbase/wallet-sdk
```

## Pricing Strategy

| Tier | Price | Notes |
|------|-------|-------|
| Per message | $0.01 USDC | Simple, predictable |
| Alternative: per token | $0.0001/token | More complex |

Recommended: **$0.01/message** to start (simple UX).

## Tasks Breakdown

### Phase 1: Backend Setup (2-3 hours)
- [ ] Convert server.js from vanilla HTTP to Express
- [ ] Install x402 dependencies
- [ ] Add payment middleware to `/api/chat`
- [ ] Create wallet for receiving payments
- [ ] Test 402 response manually

### Phase 2: Chat Backend (1-2 hours)
- [ ] Implement chat logic (call Claude API or forward to OpenClaw)
- [ ] Simple in-memory history (or stateless)
- [ ] Error handling

### Phase 3: Frontend Chat UI (3-4 hours)
- [ ] Chat widget component
- [ ] Message list + input
- [ ] Wallet connect button
- [ ] x402 client integration
- [ ] Payment flow handling

### Phase 4: Testing & Polish (2 hours)
- [ ] End-to-end test on Base testnet
- [ ] Production deploy
- [ ] UX polish

**Total estimate: 8-11 hours**

## Key Resources

- x402 Seller Quickstart: https://docs.cdp.coinbase.com/x402/quickstart-for-sellers
- x402 GitHub: https://github.com/coinbase/x402
- Express middleware: https://github.com/coinbase/x402/tree/main/typescript/packages/express
- Base network: Chain ID 8453

## Configuration Needed

```javascript
// Example middleware config
const paymentConfig = {
  "POST /api/chat": {
    price: "$0.01",
    network: "base",
    asset: "USDC",
    recipient: "0x...", // Your wallet address
    description: "Chat message"
  }
};
```

## Questions to Decide

1. **Wallet for receiving payments** - Create new or use existing?
2. **Chat backend** - Direct Claude API or route through OpenClaw gateway?
3. **Chat history** - Ephemeral or persist?
4. **Testnet first?** - Base Sepolia for testing?

---

*Created: 2026-02-08*
*Status: Planning - Not started*
