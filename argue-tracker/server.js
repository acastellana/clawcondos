const express = require('express');
const fs = require('fs');
const path = require('path');
const { createPublicClient, http, parseAbi, formatUnits } = require('viem');
const { base } = require('viem/chains');

const app = express();
const PORT = process.env.PORT || 9032;

// ── Constants ────────────────────────────────────────────────────────────────
const WALLET    = '0x6090b242366C5543064b2cc9C4ed27E6B53Ac917';
const FACTORY   = '0x0692eC85325472Db274082165620829930f2c1F9';
const ARGUE     = '0x7FFd8f91b0b1b5c7A2E6c7c9efB8Be0A71885b07';
const LARGUE    = '0x2FA376c24d5B7cfAC685d3BB6405f1af9Ea8EE40';
const PORTFOLIO = '0xa128d9416C7b5f1b27e0E15F55915ca635e953c1';

const EXPERIMENT_FILE = '/home/albert/clawd/projects/arguefun-agent/experiment_state.json';
const PLAYBOOK_FILE   = '/home/albert/clawd/projects/arguefun-agent/playbook.md';

const STATUS_LABEL = { 0: 'Active', 1: 'Resolving', 2: 'Resolved', 3: 'Undetermined' };

// ── viem client ──────────────────────────────────────────────────────────────
const client = createPublicClient({
  chain: base,
  transport: http('https://mainnet.base.org'),
});

// ── ABIs (unnamed returns — viem returns arrays) ──────────────────────────────
const portfolioAbi = parseAbi([
  // Returns [Position[], total] where each Position is an array of 18 fields:
  // [0]=debate [1]=statement [2]=sideAName [3]=sideBName [4]=status [5]=endDate
  // [6]=userLockedA [7]=userUnlockedA [8]=userLockedB [9]=userUnlockedB
  // [10]=totalA [11]=totalB [12]=totalBounty [13]=isSideAWinner [14]=claimed
  // [15]=hasClaimedBountyRefund [16]=userOnSideA [17]=bountyContribution
  'function getPortfolio(address,address,uint256,uint256) view returns ((address,string,string,string,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool,bool,bool,uint256)[],uint256)',

  // Returns [argueBalance, lockedArgueBalance, argueAllowance, lockedArgueAllowance,
  //          totalWageredActive, totalClaimable, debateCount, ethBalance]
  'function getWalletHealth(address,address,address,address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',

  // Returns [totalBets, totalWinnings, totalClaimed, netProfit,
  //          debatesParticipated, debatesWon, winRateBps, avgReturnBps]
  'function getUserPerformance(address,address) view returns (uint256,uint256,uint256,int256,uint256,uint256,uint256,uint256)',

  // Returns ClaimEstimate[] — each is an array:
  // [0]=debate [1]=status [2]=isWinner [3]=lockedReturn [4]=unlockedReturn
  // [5]=unlockedWinnings [6]=convertedWinnings [7]=totalPayout
  // [8]=originalStake [9]=profitLoss [10]=bountyRefundAvailable
  'function getClaimable(address,address) view returns ((address,uint8,bool,uint256,uint256,uint256,uint256,uint256,uint256,int256,uint256)[])',

  // batchStatus: [debate, status, claimed, userTotalBet][]
  'function batchStatus(address[],address) view returns ((address,uint8,bool,uint256)[])',
]);

// ── Cache ────────────────────────────────────────────────────────────────────
const cache = new Map();
function getCache(key, ttlMs = 300_000) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  return null;
}
function setCache(key, data) { cache.set(key, { ts: Date.now(), data }); }

// ── Helpers ──────────────────────────────────────────────────────────────────
const f18 = v => parseFloat(formatUnits(BigInt(v.toString()), 18));
const num  = v => Number(v);

// Parse a Position array (18 fields) into a clean JSON object
function positionToJSON(p, claimableMap) {
  // p is an array: [debate, statement, sideAName, sideBName, status, endDate,
  //                 userLockedA, userUnlockedA, userLockedB, userUnlockedB,
  //                 totalA, totalB, totalBounty, isSideAWinner, claimed,
  //                 hasClaimedBountyRefund, userOnSideA, bountyContribution]
  const debate        = p[0];
  const statement     = p[1];
  const sideAName     = p[2];
  const sideBName     = p[3];
  const statusCode    = num(p[4]);
  const endDate       = num(p[5]);
  const userLockedA   = f18(p[6]);
  const userUnlockedA = f18(p[7]);
  const userLockedB   = f18(p[8]);
  const userUnlockedB = f18(p[9]);
  const totalA        = f18(p[10]);
  const totalB        = f18(p[11]);
  const bounty        = f18(p[12]);
  const isSideAWinner = p[13];
  const claimed       = p[14];

  const userTotalA = userLockedA + userUnlockedA;
  const userTotalB = userLockedB + userUnlockedB;

  const side = userTotalA > 0 && userTotalB === 0 ? 'YES'
             : userTotalB > 0 && userTotalA === 0 ? 'NO'
             : userTotalA > 0 && userTotalB > 0   ? 'BOTH'
             : null;

  const stake = side === 'YES' ? userTotalA
              : side === 'NO'  ? userTotalB
              : userTotalA + userTotalB;

  // Win/loss
  let won = null, roi = null, payout = null;

  const claim = claimableMap?.get(debate.toLowerCase());
  if (claim) {
    // [7]=totalPayout  [8]=originalStake  [9]=profitLoss  [2]=isWinner
    payout = f18(claim[7]);
    const pl = parseFloat(formatUnits(BigInt(claim[9].toString()), 18));
    roi    = stake > 0 ? (pl / stake) * 100 : 0;
    won    = Boolean(claim[2]);
  } else if (statusCode === 2 && side !== null) {
    const userBetWon = (isSideAWinner && userTotalA > 0) || (!isSideAWinner && userTotalB > 0);
    won = userBetWon;
    if (won) {
      const winPool  = isSideAWinner ? totalA : totalB;
      const losePool = isSideAWinner ? totalB : totalA;
      const userBet  = isSideAWinner ? userTotalA : userTotalB;
      if (winPool > 0) {
        payout = userBet + (userBet / winPool) * (losePool * 0.99 + bounty);
        roi    = ((payout - userBet) / userBet) * 100;
      }
    } else {
      roi    = -100;
      payout = 0;
    }
  }

  return {
    address: debate,
    statement,
    sideA: sideAName,
    sideB: sideBName,
    status: STATUS_LABEL[statusCode] ?? `Status${statusCode}`,
    statusCode,
    endDate: endDate > 0 ? new Date(endDate * 1000).toISOString() : null,
    side,
    stake,
    userTotalA,
    userTotalB,
    userLockedA,
    userUnlockedA,
    userLockedB,
    userUnlockedB,
    totalA,
    totalB,
    bounty,
    isSideAWinner,
    claimed,
    won,
    payout,
    roi: roi != null ? Math.round(roi * 10) / 10 : null,
  };
}

// ── /api/wallet ───────────────────────────────────────────────────────────────
app.get('/api/wallet', async (req, res) => {
  const cached = getCache('wallet', 60_000);
  if (cached) return res.json(cached);
  try {
    const h = await client.readContract({
      address: PORTFOLIO, abi: portfolioAbi,
      functionName: 'getWalletHealth',
      args: [ARGUE, LARGUE, FACTORY, WALLET],
    });
    // h = [argueBalance, lockedArgueBalance, argueAllowance, lockedArgueAllowance,
    //       totalWageredActive, totalClaimable, debateCount, ethBalance]
    const result = {
      argue:          f18(h[0]),
      largue:         f18(h[1]),
      totalAtRisk:    f18(h[4]),
      totalClaimable: f18(h[5]),
      debateCount:    num(h[6]),
      updatedAt:      Date.now(),
    };
    setCache('wallet', result);
    res.json(result);
  } catch (err) {
    console.error('/api/wallet error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/debates ──────────────────────────────────────────────────────────────
app.get('/api/debates', async (req, res) => {
  const cached = getCache('debates');
  if (cached) return res.json(cached);
  try {
    const [portRaw, claimRaw, perfRaw] = await Promise.all([
      client.readContract({
        address: PORTFOLIO, abi: portfolioAbi,
        functionName: 'getPortfolio',
        args: [FACTORY, WALLET, 0n, 50n],
      }),
      client.readContract({
        address: PORTFOLIO, abi: portfolioAbi,
        functionName: 'getClaimable',
        args: [FACTORY, WALLET],
      }),
      client.readContract({
        address: PORTFOLIO, abi: portfolioAbi,
        functionName: 'getUserPerformance',
        args: [FACTORY, WALLET],
      }),
    ]);

    const [positions] = portRaw;   // portRaw = [Position[], total]
    const claimableMap = new Map(claimRaw.map(c => [c[0].toLowerCase(), c]));

    const debates = positions.map(p => positionToJSON(p, claimableMap));

    // perfRaw = [totalBets, totalWinnings, totalClaimed, netProfit,
    //            debatesParticipated, debatesWon, winRateBps, avgReturnBps]
    const stats = {
      total:          num(perfRaw[4]),
      wins:           num(perfRaw[5]),
      losses:         num(perfRaw[4]) - num(perfRaw[5]),
      winRate:        num(perfRaw[6]) / 100,       // percent
      totalBets:      f18(perfRaw[0]),
      totalWinnings:  f18(perfRaw[1]),
      totalClaimed:   f18(perfRaw[2]),
      netProfit:      parseFloat(formatUnits(BigInt(perfRaw[3].toString()), 18)),
      avgReturnBps:   num(perfRaw[7]),
      activeCount:    debates.filter(d => d.statusCode === 0).length,
      resolved:       debates.filter(d => d.statusCode === 2).length,
      claimable:      claimRaw.length,
    };

    const result = { debates, stats, updatedAt: Date.now() };
    setCache('debates', result);
    res.json(result);
  } catch (err) {
    console.error('/api/debates error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/experiment ───────────────────────────────────────────────────────────
app.get('/api/experiment', async (req, res) => {
  try {
    const state = JSON.parse(fs.readFileSync(EXPERIMENT_FILE, 'utf8'));
    const addrs = state.debates.map(d => d.debate);

    const batchRaw = await client.readContract({
      address: PORTFOLIO, abi: portfolioAbi,
      functionName: 'batchStatus',
      args: [addrs, WALLET],
    });
    // each item = [debate, status, claimed, userTotalBet]
    const statusMap = new Map(batchRaw.map(r => [r[0].toLowerCase(), r]));

    // Parse bet_per_debate from state (e.g. "40000 ARGUE (38000 lARGUE for 1B)")
    // Parse "40000 ARGUE (38000 lARGUE for 1B)" → { ARGUE: 40000, lARGUE: 38000 }
    const betStr = state.bet_per_debate || '';
    const betAmounts = {};
    for (const [, amt, token] of betStr.matchAll(/([\d,]+)\s+(ARGUE|lARGUE)/g)) {
      betAmounts[token] = parseFloat(amt.replace(/,/g, ''));
    }
    const betPerDebate = betAmounts['ARGUE'] || 0;

    const enriched = state.debates.map(d => {
      const r = statusMap.get(d.debate.toLowerCase());
      const statusCode = r ? num(r[1]) : -1;
      const onChainBet = r ? f18(r[3]) : 0;
      // If the on-chain bet for this wallet is 0, bets were placed from agent wallet
      // Fall back to the token type and amount from state file
      const tokenType   = d.token || 'ARGUE';
      const stateAmount = betAmounts[tokenType] || betPerDebate;
      const fromAgent   = onChainBet === 0 && stateAmount > 0;
      return {
        ...d,
        statusCode,
        statusLabel:  r ? (STATUS_LABEL[statusCode] ?? `Status${statusCode}`) : 'Unknown',
        claimed:      r ? Boolean(r[2]) : false,
        userTotalBet: fromAgent ? stateAmount : onChainBet,
        tokenType,
        fromAgentWallet: fromAgent,
      };
    });

    const pairs = {};
    for (const d of enriched) {
      if (!pairs[d.pair]) pairs[d.pair] = [];
      pairs[d.pair].push(d);
    }

    const pairResults = Object.entries(pairs)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([pairId, members]) => {
        const a = members.find(m => m.label?.endsWith('A'));
        const b = members.find(m => m.label?.endsWith('B'));
        const aRes = a?.statusCode === 2;
        const bRes = b?.statusCode === 2;
        const biasStatus = (aRes && bRes)
          ? (a.isSideAWinner && b.isSideAWinner ? 'BIAS CONFIRMED' : 'BIAS REJECTED')
          : 'PENDING';
        return { pairId, a, b, biasStatus };
      });

    res.json({ ...state, debates: enriched, pairs: pairResults });
  } catch (err) {
    console.error('/api/experiment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/playbook ─────────────────────────────────────────────────────────────
app.get('/api/playbook', (req, res) => {
  try {
    res.type('text/plain').send(fs.readFileSync(PLAYBOOK_FILE, 'utf8'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () =>
  console.log(`argue-tracker listening on http://localhost:${PORT}`)
);
