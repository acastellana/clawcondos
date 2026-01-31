"""Performance metrics models."""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class StrategyPerformance(BaseModel):
    """Performance metrics for a strategy."""
    
    strategy: str
    period: str  # daily, weekly, monthly, all_time
    start_date: datetime
    end_date: datetime
    
    # Trade counts
    total_trades: int = 0
    open_trades: int = 0
    resolved_trades: int = 0
    wins: int = 0
    losses: int = 0
    
    # Rates
    win_rate: float = 0.0  # wins / resolved_trades
    
    # Financial
    total_wagered: float = 0.0
    total_pnl: float = 0.0
    roi: float = 0.0  # total_pnl / total_wagered
    
    # CLV metrics (the real measure of edge)
    avg_clv: float = 0.0
    clv_positive_count: int = 0
    clv_positive_rate: float = 0.0  # % of trades that beat closing line
    
    # Risk metrics
    max_drawdown: float = 0.0
    sharpe_ratio: Optional[float] = None
    
    # By category breakdown
    by_category: dict[str, dict] = {}
    by_platform: dict[str, dict] = {}


class CalibrationPoint(BaseModel):
    """A point on the calibration curve."""
    
    price_bucket: str  # e.g., "0.00-0.10", "0.10-0.20"
    bucket_start: float
    bucket_end: float
    
    # Counts
    total_trades: int
    resolved_trades: int
    
    # Expected vs Actual
    avg_entry_price: float  # What we paid (implied probability)
    actual_win_rate: float  # How often we won
    
    # Calibration
    calibration_error: float  # actual_win_rate - avg_entry_price
    is_overpriced: bool  # We paid too much
    is_underpriced: bool  # We got value


class OverallPerformance(BaseModel):
    """Overall performance across all strategies."""
    
    period: str
    start_date: datetime
    end_date: datetime
    
    # Totals
    total_trades: int
    total_wagered: float
    total_pnl: float
    overall_roi: float
    
    # Best/worst
    best_strategy: str
    best_strategy_roi: float
    worst_strategy: str
    worst_strategy_roi: float
    
    # Calibration summary
    overall_calibration_error: float
    most_mispriced_bucket: str
    
    # Self-improvement
    improvement_suggestions: list[str]
    
    # Per-strategy breakdown
    strategies: dict[str, StrategyPerformance]


class TradeAnalysis(BaseModel):
    """Analysis of a single resolved trade."""
    
    trade_id: str
    strategy: str
    
    # Outcome
    won: bool
    pnl: float
    roi: float
    
    # CLV analysis
    entry_price: float
    closing_price: Optional[float]
    clv: Optional[float]
    beat_closing_line: Optional[bool]
    
    # Quality assessment
    was_good_entry: bool  # Based on CLV
    was_good_sizing: bool  # Based on Kelly or similar
    
    # Lessons
    what_went_right: list[str]
    what_went_wrong: list[str]
    suggested_improvements: list[str]
