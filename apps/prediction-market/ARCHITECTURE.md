# Prediction Market Agent - Architecture

## Overview

A self-improving prediction market trading agent that:
1. Implements multiple strategies (from research)
2. Logs all trades with full context
3. Tracks market resolutions
4. Analyzes performance after resolution
5. Self-improves based on results
6. Integrates with Sharp dashboard

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Sharp Dashboard                               │
│                        (prediction-market app)                       │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐ │
│  │  Trade Log   │  │  Strategy    │  │  Performance Analysis      │ │
│  │  Viewer      │  │  Monitor     │  │  (after resolution)        │ │
│  └──────────────┘  └──────────────┘  └────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────-┘
                              │
                              │ REST API / WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Backend Service (Python)                         │
│                     Port: 8765                                       │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Strategy Engine                            │   │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ │   │
│  │  │ Nothing    │ │ Arbitrage  │ │ News       │ │ CLV        │ │   │
│  │  │ Ever       │ │ Scanner    │ │ Correlation│ │ Tracker    │ │   │
│  │  │ Happens    │ │            │ │            │ │            │ │   │
│  │  └────────────┘ └────────────┘ └────────────┘ └────────────┘ │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Platform Adapters                          │   │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐                │   │
│  │  │ Polymarket │ │ Kalshi     │ │ Limitless  │                │   │
│  │  │ (pmxt)     │ │ (pmxt)     │ │ (pmxt)     │                │   │
│  │  └────────────┘ └────────────┘ └────────────┘                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Data Layer                                 │   │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐                │   │
│  │  │ Trade Log  │ │ Market     │ │ Calibration│                │   │
│  │  │ (SQLite)   │ │ Tracker    │ │ Scores     │                │   │
│  │  └────────────┘ └────────────┘ └────────────┘                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Self-Improvement Engine                    │   │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐                │   │
│  │  │ Resolution │ │ Strategy   │ │ Parameter  │                │   │
│  │  │ Analyzer   │ │ Evaluator  │ │ Tuner      │                │   │
│  │  └────────────┘ └────────────┘ └────────────┘                │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Data Models

### Trade Log
```python
class Trade:
    id: str                    # UUID
    timestamp: datetime        # When trade executed
    platform: str              # polymarket, kalshi, limitless
    market_id: str             # Platform's market ID
    market_question: str       # Human readable question
    side: str                  # yes, no
    price: float               # Entry price (0.01 - 0.99)
    amount: float              # Dollar amount
    strategy: str              # nothing_ever_happens, arbitrage, etc.
    
    # Context at time of trade
    entry_context: dict        # News, signals, strategy params
    
    # Resolution tracking
    status: str                # open, resolved_win, resolved_loss
    resolution_date: datetime  # When market resolved
    resolution_outcome: str    # yes, no
    pnl: float                 # Profit/loss after resolution
    
    # Self-improvement
    clv: float                 # Closing line value (entry vs closing price)
    was_good_trade: bool       # Did we beat CLV?
    lessons: str               # What we learned (filled post-resolution)
```

### Market
```python
class Market:
    platform: str
    market_id: str
    question: str
    category: str              # sports, politics, crypto, etc.
    end_date: datetime
    
    # Current state
    yes_price: float
    no_price: float
    volume: float
    
    # Our analysis
    our_probability: float     # What we think true probability is
    expected_value: float      # EV of betting
    strategy_signals: dict     # Which strategies flagged this
    
    # Resolution
    resolved: bool
    resolution_outcome: str
```

### Strategy Performance
```python
class StrategyPerformance:
    strategy: str
    period: str               # daily, weekly, monthly, all_time
    
    # Core metrics
    trades: int
    wins: int
    losses: int
    win_rate: float
    
    # Financial
    total_wagered: float
    total_pnl: float
    roi: float
    
    # CLV metrics (the real measure)
    avg_clv: float            # Avg closing line value
    clv_positive_rate: float  # % of trades that beat closing
    
    # By category
    performance_by_category: dict
```

---

## API Endpoints

### Trade Management
```
POST /api/trades              - Log a new trade
GET  /api/trades              - List trades (with filters)
GET  /api/trades/{id}         - Get specific trade
PUT  /api/trades/{id}         - Update trade (resolution)
```

### Markets
```
GET  /api/markets             - List markets across platforms
GET  /api/markets/{id}        - Get market details
POST /api/markets/scan        - Scan for opportunities
```

### Strategies
```
GET  /api/strategies          - List all strategies
GET  /api/strategies/{name}   - Get strategy config & performance
PUT  /api/strategies/{name}   - Update strategy parameters
POST /api/strategies/{name}/run - Execute strategy
```

### Analysis
```
GET  /api/performance         - Overall performance metrics
GET  /api/performance/{strategy} - Strategy-specific metrics
GET  /api/calibration         - Calibration curve data
POST /api/analyze/resolution  - Analyze resolved markets
```

### Self-Improvement
```
POST /api/improve/analyze     - Run self-improvement analysis
GET  /api/improve/suggestions - Get improvement suggestions
POST /api/improve/apply       - Apply suggested changes
```

---

## Strategies to Implement

### 1. Nothing Ever Happens (NEH)
```python
class NothingEverHappensStrategy:
    """
    Systematically bet NO on sensational/dramatic predictions.
    Academic evidence: Only ~22% of dramatic YES bets resolve YES.
    """
    
    config = {
        "max_yes_price": 0.10,        # Only bet on low-probability YES
        "min_volume": 1000,           # Minimum market volume
        "excluded_categories": ["crypto_price"],  # Skip price predictions
        "position_size": 50,          # Dollar amount per bet
        "max_positions": 20,          # Max concurrent positions
    }
    
    def scan(self) -> List[Market]:
        """Find markets matching NEH criteria."""
        pass
    
    def should_bet(self, market: Market) -> bool:
        """Check if market fits strategy."""
        pass
    
    def execute(self, market: Market) -> Trade:
        """Place the trade."""
        pass
```

### 2. Cross-Platform Arbitrage
```python
class ArbitrageStrategy:
    """
    Find price discrepancies between platforms.
    Buy YES on one, NO on other when combined < $1.00.
    """
    
    config = {
        "min_spread": 0.03,           # Minimum profit margin
        "max_position": 500,          # Max per arb
        "platforms": ["polymarket", "kalshi"],
    }
```

### 3. CLV Tracker
```python
class CLVStrategy:
    """
    Bet early on markets, track closing line value.
    Focus on categories where we historically beat CLV.
    """
    
    config = {
        "min_edge": 0.05,             # Min perceived edge
        "track_categories": ["sports", "politics", "finance"],
    }
```

### 4. Yield Farming (Absurd NO)
```python
class YieldFarmingStrategy:
    """
    Bet NO on absurd predictions for yield-like returns.
    Examples: "Jesus returns in 2026", "USD collapses to zero"
    """
    
    config = {
        "min_no_price": 0.95,         # Very high NO probability
        "absurdity_keywords": ["alien", "jesus", "collapse", "world war"],
    }
```

---

## Self-Improvement System

### 1. Resolution Analyzer
When a market resolves:
```python
def analyze_resolution(trade: Trade, outcome: str):
    # 1. Calculate P&L
    trade.pnl = calculate_pnl(trade, outcome)
    
    # 2. Calculate CLV
    trade.clv = trade.price - closing_price
    trade.was_good_trade = trade.clv > 0
    
    # 3. Generate lessons
    trade.lessons = generate_lessons(trade)
    
    # 4. Update strategy stats
    update_strategy_performance(trade)
    
    # 5. Check for pattern
    check_for_improvement_opportunity(trade)
```

### 2. Strategy Evaluator
Periodically analyze strategies:
```python
def evaluate_strategy(strategy: str, period: str = "weekly"):
    performance = get_performance(strategy, period)
    
    # Is strategy profitable?
    if performance.roi < 0:
        flag_underperforming(strategy)
    
    # Are we beating CLV?
    if performance.clv_positive_rate < 0.5:
        suggest_timing_improvement(strategy)
    
    # Which categories work?
    for category, stats in performance.by_category.items():
        if stats.roi < 0:
            suggest_category_exclusion(strategy, category)
```

### 3. Parameter Tuner
Auto-adjust parameters based on results:
```python
def tune_parameters(strategy: str):
    # Analyze historical trades
    trades = get_trades(strategy, last_n=100)
    
    # Find optimal price thresholds
    optimal_max_price = find_optimal_threshold(trades, "entry_price")
    
    # Find optimal categories
    best_categories = rank_categories_by_roi(trades)
    
    # Generate suggestions
    return {
        "suggested_max_price": optimal_max_price,
        "suggested_categories": best_categories[:5],
        "confidence": calculate_confidence(trades),
    }
```

---

## Dashboard Views

### 1. Trade Log View
- Sortable/filterable table of all trades
- Columns: Time, Platform, Market, Side, Price, Amount, Strategy, Status, P&L
- Click to expand with full context

### 2. Strategy Monitor
- Card per strategy showing:
  - Current positions
  - Recent performance
  - Win rate, ROI, CLV
  - On/Off toggle

### 3. Performance Analysis
- Charts:
  - Cumulative P&L over time
  - Win rate by category
  - CLV distribution
  - Calibration curve
- Comparison between strategies

### 4. Resolution Review
- List of recently resolved markets
- For each: Was trade good? What did we learn?
- Simple 👍/👎 quick rating
- Lessons learned summary

### 5. Self-Improvement Panel
- Current suggestions
- Pending parameter changes
- History of improvements applied
- A/B test results

---

## File Structure

```
prediction-market/
├── backend/
│   ├── __init__.py
│   ├── main.py                 # FastAPI app
│   ├── config.py               # Configuration
│   ├── models/
│   │   ├── __init__.py
│   │   ├── trade.py
│   │   ├── market.py
│   │   └── performance.py
│   ├── strategies/
│   │   ├── __init__.py
│   │   ├── base.py
│   │   ├── nothing_ever_happens.py
│   │   ├── arbitrage.py
│   │   ├── clv_tracker.py
│   │   └── yield_farming.py
│   ├── platforms/
│   │   ├── __init__.py
│   │   ├── base.py
│   │   ├── polymarket.py
│   │   └── kalshi.py
│   ├── analysis/
│   │   ├── __init__.py
│   │   ├── resolution.py
│   │   ├── performance.py
│   │   └── improvement.py
│   └── db/
│       ├── __init__.py
│       ├── database.py
│       └── migrations/
├── frontend/
│   ├── index.html
│   ├── css/
│   │   └── styles.css
│   └── js/
│       ├── app.js
│       ├── trades.js
│       ├── strategies.js
│       └── analysis.js
├── data/
│   ├── trades.db               # SQLite database
│   └── config.json             # Strategy configs
├── logs/
│   └── trades.jsonl            # Append-only trade log
├── requirements.txt
├── start.sh
└── ARCHITECTURE.md             # This file
```

---

## Integration with Sharp

### App Registry Entry
```json
{
  "id": "prediction-market",
  "name": "Prediction Market Agent",
  "description": "Self-improving prediction market trading agent",
  "port": 8765,
  "path": "/home/albert/clawd/projects/sharp/apps/prediction-market",
  "startCommand": "cd backend && uvicorn main:app --port 8765",
  "icon": "🎰",
  "files": {
    "entry": "backend/main.py",
    "config": "data/config.json"
  },
  "logs": "logs/app.log",
  "stack": "Python, FastAPI, SQLite"
}
```

### Clawdbot Agent Integration
The agent can:
1. Be triggered via cron to scan for opportunities
2. Be asked to analyze performance
3. Run specific strategies on demand
4. Report on self-improvement suggestions

---

## Development Phases

### Phase 1: Core Infrastructure (This Sprint)
- [ ] Backend skeleton (FastAPI)
- [ ] Database models
- [ ] Trade logging
- [ ] Basic dashboard (trade list)

### Phase 2: Strategy Implementation
- [ ] Platform adapters (pmxt)
- [ ] Nothing Ever Happens strategy
- [ ] Trade execution (paper trading first)

### Phase 3: Analysis & Improvement
- [ ] Resolution tracking
- [ ] Performance metrics
- [ ] Self-improvement engine

### Phase 4: Live Trading
- [ ] Real money integration
- [ ] Risk management
- [ ] Alerts & notifications

---

## Security Considerations

1. **Keys**: Store API keys in environment variables, never in code
2. **Self-custody**: Use wallet-based auth, never store private keys in DB
3. **Position limits**: Hard-coded max position sizes
4. **Kill switch**: Ability to halt all trading instantly
5. **Audit log**: Immutable append-only trade log
